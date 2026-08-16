package main

// Where a restored session belongs.
//
// Grouping survives most deaths on its own: the per-user layout keeps a
// project's session names whether or not those sessions are alive, so a session
// the OOM killer took comes back into its project the moment it exists again.
// Two cases have nothing left to place them by:
//
//   - a kill through the UI, which drops the layout reference deliberately
//     (killSession) — a later point-in-time restore then finds no arrangement;
//   - a restore that has to rename, when the name is taken by a different
//     conversation and the session returns as `<name>-<HHMM>` — a name no
//     layout has ever seen.
//
// This file holds the small memory that covers the first case, the resolver
// that answers "which project should this row join", and the layout placement
// that puts the restored name where the answer says. Design:
// docs/plans/2026-08-16-restore-diff-first-and-project-memory-design.md.

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Assignment is one remembered "this session was in this project when you
// killed it". Project is "" when it was Ungrouped, which is an opinion worth
// keeping: un-grouping a session and then killing it must not be undone by a
// restore.
type Assignment struct {
	Name    string `json:"name"`
	Project string `json:"project"`
	At      int64  `json:"at"`
}

// AssignmentSet is one user's memory, oldest entry first.
type AssignmentSet struct {
	Version int          `json:"version"`
	Entries []Assignment `json:"entries"`
}

const (
	assignmentsVersion = 1
	// assignmentsKeep bounds the file. At the kill rate seen on the devvm
	// (27 tombstones over two days) this is roughly a month of history.
	assignmentsKeep = 500
	assignmentsDir  = "/var/lib/tmux-api/assignments"
)

// assignmentStore persists one document per OS user, mirroring layoutStore:
// mutex-guarded, whole-document, atomic (tmp+rename), 0600.
type assignmentStore struct {
	mu  sync.Mutex
	dir string
}

func newAssignmentStore(dir string) *assignmentStore { return &assignmentStore{dir: dir} }

var assignmentStoreInstance = newAssignmentStore(assignmentsDir)

func (s *assignmentStore) path(osUser string) string {
	return filepath.Join(s.dir, osUser+".json")
}

func emptyAssignmentSet() AssignmentSet {
	return AssignmentSet{Version: assignmentsVersion, Entries: []Assignment{}}
}

// load returns the user's memory, or an empty one when none was ever written.
// A corrupt file reads as empty rather than as an error: this is a convenience
// layered on the layout, and losing it degrades placement instead of failing a
// kill or a restore.
func (s *assignmentStore) load(osUser string) (AssignmentSet, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked(osUser)
}

func (s *assignmentStore) loadLocked(osUser string) (AssignmentSet, error) {
	raw, err := os.ReadFile(s.path(osUser))
	if errors.Is(err, os.ErrNotExist) {
		return emptyAssignmentSet(), nil
	}
	if err != nil {
		return emptyAssignmentSet(), err
	}
	var set AssignmentSet
	if err := json.Unmarshal(raw, &set); err != nil {
		return emptyAssignmentSet(), fmt.Errorf("corrupt assignment memory for %s: %w", osUser, err)
	}
	if set.Entries == nil {
		set.Entries = []Assignment{}
	}
	set.Version = assignmentsVersion
	return set, nil
}

// remember records name → project, replacing any earlier entry for that name so
// a session killed twice is placed by the LATEST project it was in. Entries stay
// in write order, so the prune drops the oldest without needing a clock.
func (s *assignmentStore) remember(osUser, name, project string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	set, err := s.loadLocked(osUser)
	if err != nil {
		return err
	}
	kept := make([]Assignment, 0, len(set.Entries)+1)
	for _, e := range set.Entries {
		if e.Name != name {
			kept = append(kept, e)
		}
	}
	kept = append(kept, Assignment{Name: name, Project: project, At: time.Now().Unix()})
	if len(kept) > assignmentsKeep {
		kept = kept[len(kept)-assignmentsKeep:]
	}
	set.Entries = kept
	return s.saveLocked(osUser, set)
}

// rename follows a session rename so a later restore still knows which project
// the session belonged to. Entries keep their position and their timestamp —
// only the name they are filed under changes, and being renamed is not the same
// event as being killed again.
func (s *assignmentStore) rename(osUser, oldName, newName string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	set, err := s.loadLocked(osUser)
	if err != nil {
		return err
	}
	changed := false
	for i := range set.Entries {
		if set.Entries[i].Name == oldName {
			set.Entries[i].Name = newName
			changed = true
		}
	}
	if !changed {
		return nil // this session was never killed out of a project
	}
	return s.saveLocked(osUser, set)
}

func (s *assignmentStore) saveLocked(osUser string, set AssignmentSet) error {
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return err
	}
	raw, err := json.Marshal(set)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(s.dir, osUser+".*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(raw, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), s.path(osUser))
}

// assignmentProjectOf reads the memory. The bool separates "remembered as
// Ungrouped" from "never seen", which is what stops an older shared-store
// reference from re-grouping a session the user deliberately pulled out.
func assignmentProjectOf(set AssignmentSet, name string) (string, bool) {
	for i := len(set.Entries) - 1; i >= 0; i-- {
		if set.Entries[i].Name == name {
			return set.Entries[i].Project, true
		}
	}
	return "", false
}

// rememberKilledAssignment stores what killSession is about to drop. A layout
// with no opinion writes nothing: "" would then outrank the shared project
// store, which may still hold a perfectly good answer.
func rememberKilledAssignment(osUser, name string) {
	l, err := layoutStoreInstance.load(osUser)
	if err != nil {
		log.Printf("assignment memory: layout load for %s failed: %v", osUser, err)
		return
	}
	project, ok := layoutProjectOf(l, name)
	if !ok {
		return
	}
	if err := assignmentStoreInstance.remember(osUser, name, project); err != nil {
		log.Printf("assignment memory: remembering %s for %s failed: %v", name, osUser, err)
	}
}

// layoutProjectOf reports which list holds a session name: a project's name, or
// "" for Ungrouped. The bool is "the layout has an opinion at all".
func layoutProjectOf(l Layout, name string) (string, bool) {
	for _, p := range l.Projects {
		for _, s := range p.Sessions {
			if s == name {
				return p.Name, true
			}
		}
	}
	for _, s := range l.Ungrouped {
		if s == name {
			return "", true
		}
	}
	return "", false
}

// resolveRestoreProject answers which project a restored session should join.
//
// The layout goes first because it is the arrangement the user can see, and it
// still holds references to sessions that merely died. The kill memory comes
// next: it exists precisely for the names the layout was asked to forget, and
// it is stamped at kill time, so it is fresher than the shared store. The
// global project store answers last, for sessions grouped only by sharing.
//
// "" means Ungrouped, which is also where an unrecognised name ends up.
func resolveRestoreProject(l Layout, mem AssignmentSet, ps ProjectSet, owner, name string) string {
	if p, ok := layoutProjectOf(l, name); ok {
		return p
	}
	if p, ok := assignmentProjectOf(mem, name); ok {
		return p
	}
	return projectNameOf(ps, owner, name)
}

// placeRestored puts the name a restore produced (`target`) into the layout,
// given the row it came from (`origin`) and the project resolved for it.
// Returns the new layout and whether anything changed.
//
// A renamed restore follows its origin — same list, directly after it — so the
// recovered conversation sits next to the one that took its name rather than at
// the bottom of the project. Everything else appends to the resolved project.
func placeRestored(l Layout, origin, target, project string) (Layout, bool) {
	if _, placed := layoutProjectOf(l, target); placed {
		return l, false // the reference survived the death; nothing to do
	}

	out := l
	out.Projects = make([]Project, len(l.Projects))
	copy(out.Projects, l.Projects)

	insertAfter := func(list []string, after, name string) ([]string, bool) {
		for i, s := range list {
			if s == after {
				next := make([]string, 0, len(list)+1)
				next = append(next, list[:i+1]...)
				next = append(next, name)
				next = append(next, list[i+1:]...)
				return next, true
			}
		}
		return list, false
	}

	if target != origin {
		for i, p := range out.Projects {
			if next, ok := insertAfter(p.Sessions, origin, target); ok {
				out.Projects[i].Sessions = next
				return out, true
			}
		}
		if next, ok := insertAfter(l.Ungrouped, origin, target); ok {
			out.Ungrouped = next
			return out, true
		}
	}

	if project == "" {
		return l, false // Ungrouped is where unplaced sessions already fall
	}
	for i, p := range out.Projects {
		if p.Name == project {
			out.Projects[i].Sessions = append(append([]string{}, p.Sessions...), target)
			return out, true
		}
	}
	// A project the layout does not render (deleted, or shared but never
	// arranged). Creating it here would put a group in the sidebar the user
	// never made, so the session stays Ungrouped.
	return l, false
}

// annotateRowProjects fills in each snapshot row's destination project, so the
// picker previews where a restore would put it using the same resolution the
// restore itself performs.
func annotateRowProjects(osUser string, rows []SnapshotRow) []SnapshotRow {
	if len(rows) == 0 {
		return rows
	}
	l, err := layoutStoreInstance.load(osUser)
	if err != nil {
		log.Printf("snapshot rows for %s: layout load failed (serving without projects): %v", osUser, err)
		return rows
	}
	mem, err := assignmentStoreInstance.load(osUser)
	if err != nil {
		log.Printf("snapshot rows for %s: assignment memory unreadable: %v", osUser, err)
		mem = emptyAssignmentSet()
	}
	ps, err := projectStoreInstance.load()
	if err != nil {
		log.Printf("snapshot rows for %s: project load failed: %v", osUser, err)
		ps = emptyProjectSet()
	}
	for i := range rows {
		rows[i].Project = resolveRestoreProject(l, mem, ps, osUser, rows[i].Name)
	}
	return rows
}

// placeRestoredSessions puts everything a picker restore just recreated into
// the project it belongs to. Best-effort by design: the sessions are already
// back by the time this runs, so a store that will not write costs the user a
// placement, never the recovery.
func placeRestoredSessions(osUser string, rows []SnapshotRow, selected []string) {
	want := map[string]bool{}
	for _, n := range selected {
		want[n] = true
	}

	l, err := layoutStoreInstance.load(osUser)
	if err != nil {
		log.Printf("restore placement for %s: layout load failed: %v", osUser, err)
		return
	}
	mem, err := assignmentStoreInstance.load(osUser)
	if err != nil {
		mem = emptyAssignmentSet()
	}
	ps, err := projectStoreInstance.load()
	if err != nil {
		ps = emptyProjectSet()
	}

	changed := false
	restoredTitles := map[string]string{}
	for _, row := range rows {
		if !want[row.Name] {
			continue
		}
		// skip: already live. in_place: resumed inside the pane it already
		// has, so its name — and its slot — never moved.
		if row.Action == "skip" || row.Action == "in_place" {
			continue
		}
		target := row.Target
		if target == "" {
			target = row.Name
		}
		next, did := placeRestored(l, row.Name, target, resolveRestoreProject(l, mem, ps, osUser, row.Name))
		if did {
			l = next
			changed = true
		}
		if target != row.Name {
			mirrorRenamedIntoSharedProject(osUser, row.Name, target)
		}
		// The session is back but its @title is not: options die with the
		// session, and the snapshot never carried one. Re-stamp from the
		// titles store, under whatever name it actually returned as.
		restoredTitles[row.Name] = target
	}
	restoreRememberedTitlesAs(osUser, restoredTitles)
	if !changed {
		return
	}
	if err := validateLayout(l); err != nil {
		log.Printf("restore placement for %s produced an invalid layout: %v", osUser, err)
		return
	}
	if err := layoutStoreInstance.save(osUser, l); err != nil {
		log.Printf("restore placement for %s: layout save failed: %v", osUser, err)
	}
}

// mirrorRenamedIntoSharedProject keeps a renamed restore visible to the other
// members of a shared project: they see sessions through the global store's
// refs, which know nothing of the new name.
func mirrorRenamedIntoSharedProject(osUser, origin, target string) {
	err := projectStoreInstance.update(func(ps *ProjectSet) error {
		if projectNameOf(*ps, osUser, target) != "" {
			return errNoProjectChange
		}
		for i := range ps.Projects {
			for _, s := range ps.Projects[i].Sessions {
				if s.Owner == osUser && s.Name == origin {
					ps.Projects[i].Sessions = append(ps.Projects[i].Sessions,
						SessionRef{Owner: osUser, Name: target})
					return nil
				}
			}
		}
		return errNoProjectChange
	})
	if err != nil && !errors.Is(err, errNoProjectChange) {
		log.Printf("restore placement for %s: sharing %s failed: %v", osUser, target, err)
	}
}

// errNoProjectChange aborts a projectStore.update without saving — the shared
// store has nothing to say about this session.
var errNoProjectChange = errors.New("no project change")
