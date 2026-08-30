package main

// Titles that outlive their sessions.
//
// A session's display title lives in its @title tmux option, which is the right
// home for it: reading costs nothing (it rides the list-sessions poll), and a
// guest attaching a shared session sees the same title its owner set.
//
// Options die with the session, though, and that is the one property a title
// must not have. tmux-persist recreates sessions after a reboot or an OOM from
// a snapshot of names, cwds and claude uuids — a title is none of those, so
// without this file every recovery would hand back a sidebar full of slugs.
//
// So: the same shape as the killed-assignment memory next door (assignments.go)
// — one small JSON document per OS user, holding the one fact that has to
// survive the session's death. Written whenever a title is set or a session is
// renamed; read on the restore path, where placeRestoredSessions already runs,
// to re-stamp @title on each session that came back.
//
// The alternative was a fourth column in the tmux-persist snapshot, which is
// structurally tidier — the snapshot already carries the facts that outlive a
// session. It was not chosen because tmux-persist lives in the infra repo,
// whose master auto-applies, and it would mean a snapshot-format migration
// across two repos for one string. Design:
// docs/plans/2026-08-16-session-titles-design.md.

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	titlesVersion = 1
	titlesDir     = "/var/lib/tmux-api/titles"
	// titlesKeep bounds the file, mirroring assignmentsKeep next door.
	//
	// An entry is removed when its session is deliberately killed, so what
	// accumulates here is titles of sessions that died WITHOUT a kill — an OOM,
	// a reboot — and were never restored. That is a slow trickle rather than a
	// growth rate, but "slow" is not "bounded", and the oldest entries are the
	// least likely to be restored.
	titlesKeep = 500
)

// TitleSet is one user's remembered titles, keyed by session name.
type TitleSet struct {
	Version int              `json:"version"`
	Titles  map[string]Title `json:"titles"`
}

// Title is a remembered display title and when it was last written.
//
// The timestamp exists to order the prune: a map has no order of its own, so
// without it there is no way to say which entries are the oldest. NANOSECONDS,
// not seconds — a restore re-stamps a whole batch inside one second, and at
// second granularity those writes are mutually unordered, so a prune would
// evict an arbitrary subset of them rather than the oldest.
type Title struct {
	Title string `json:"title"`
	At    int64  `json:"atNs"`
}

// titleStore persists one document per OS user, mirroring assignmentStore:
// mutex-guarded, whole-document, atomic (tmp+rename), 0600.
type titleStore struct {
	mu  sync.Mutex
	dir string
}

func newTitleStore(dir string) *titleStore { return &titleStore{dir: dir} }

var titleStoreInstance = newTitleStore(titlesDir)

func (s *titleStore) path(osUser string) string {
	return filepath.Join(s.dir, osUser+".json")
}

func emptyTitleSet() TitleSet {
	return TitleSet{Version: titlesVersion, Titles: map[string]Title{}}
}

// get returns the remembered title for a session, or "" when there is none.
//
// This is NOT what the session list reads — that comes from @title on the live
// session, which is authoritative because someone may have set it from a shell.
// This is the copy a restore re-stamps from.
func (s *titleStore) get(osUser, name string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	set, err := s.loadLocked(osUser)
	if err != nil {
		log.Printf("title memory: load for %s failed: %v", osUser, err)
		return ""
	}
	return set.Titles[name].Title
}

// all returns every remembered title for a user. Used by the restore path,
// which re-stamps a whole batch at once.
func (s *titleStore) all(osUser string) map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	set, err := s.loadLocked(osUser)
	if err != nil {
		log.Printf("title memory: load for %s failed: %v", osUser, err)
		return map[string]string{}
	}
	out := make(map[string]string, len(set.Titles))
	for name, t := range set.Titles {
		out[name] = t.Title
	}
	return out
}

// set records a title, or REMOVES the entry when title is empty. Clearing a
// title is how a session goes back to showing its name, so storing "" would
// make a later restore re-stamp an empty option and hide that choice.
func (s *titleStore) set(osUser, name, title string) error {
	return s.update(osUser, func(titles map[string]Title) {
		if title == "" {
			delete(titles, name)
			return
		}
		titles[name] = Title{Title: title, At: time.Now().UnixNano()}
	})
}

// rename carries a title from one name to the other. A session with no
// remembered title renames to nothing, which is not an error — most sessions
// have never been titled.
func (s *titleStore) rename(osUser, oldName, newName string) error {
	return s.update(osUser, func(titles map[string]Title) {
		title, ok := titles[oldName]
		if !ok {
			return
		}
		delete(titles, oldName)
		titles[newName] = title // keeps its timestamp: renaming is not rewriting
	})
}

// forget drops one session's title — a deliberate kill, mirroring what
// killSession already does to the layout and the persist manifest.
func (s *titleStore) forget(osUser, name string) error {
	return s.update(osUser, func(titles map[string]Title) { delete(titles, name) })
}

// pruneLocked drops the oldest entries once the file is over budget.
//
// Bounding by COUNT rather than by "is this session still restorable" is the
// deliberate choice. Answering the latter needs every snapshot the persist
// wrapper holds, read per user through sudo — a lot of work to decide the fate
// of a few hundred bytes. A name that is merely not running is never dropped
// while it is anywhere near the budget, which is what a restore actually needs.
func pruneLocked(titles map[string]Title) {
	if len(titles) <= titlesKeep {
		return
	}
	type row struct {
		name string
		at   int64
	}
	rows := make([]row, 0, len(titles))
	for name, t := range titles {
		rows = append(rows, row{name, t.At})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].at < rows[j].at })
	for _, r := range rows[:len(rows)-titlesKeep] {
		delete(titles, r.name)
	}
}

// restoreRememberedTitles re-stamps @title on sessions a restore just brought
// back under their own names.
func restoreRememberedTitles(osUser string, names []string) {
	same := make(map[string]string, len(names))
	for _, n := range names {
		same[n] = n
	}
	restoreRememberedTitlesAs(osUser, same)
}

// restoreRememberedTitlesAs re-stamps titles for sessions that came back, where
// each key is the name the title was remembered under and each value is the
// name the session actually returned as.
//
// The two differ when a restore has to rename: a name taken by a different
// conversation brings the session back as <name>-<HHMM>. The title follows the
// session to whatever it is now called, and is re-remembered there so a second
// restore does not have to go looking under the original name.
//
// Best-effort throughout, matching placeRestoredSessions next door: the
// sessions are already back by the time this runs, so a stamp that will not
// land costs a title, never the recovery.
func restoreRememberedTitlesAs(osUser string, restored map[string]string) {
	if len(restored) == 0 {
		return
	}
	remembered := titleStoreInstance.all(osUser)
	if len(remembered) == 0 {
		return
	}
	for origin, target := range restored {
		title := remembered[origin]
		if title == "" {
			continue // never titled — no call to make
		}
		out, err := tmuxCmd(osUser, "set-option", "-t", exactPane(target),
			sessionTitleOption, title).CombinedOutput()
		if err != nil {
			log.Printf("restore: re-stamping %s on %s/%s failed: %v: %s",
				sessionTitleOption, osUser, target, err, strings.TrimSpace(string(out)))
			continue
		}
		if target != origin {
			if err := titleStoreInstance.rename(osUser, origin, target); err != nil {
				log.Printf("restore: title memory rename %s→%s for %s failed: %v",
					origin, target, osUser, err)
			}
		}
	}
}

func (s *titleStore) update(osUser string, mutate func(map[string]Title)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	set, err := s.loadLocked(osUser)
	if err != nil {
		// A corrupt document reads as empty (loadLocked) and is then written
		// over. Failing here instead would wedge every future retitle behind a
		// file nobody can repair from the UI.
		log.Printf("title memory: load for %s failed, starting fresh: %v", osUser, err)
		set = emptyTitleSet()
	}
	mutate(set.Titles)
	pruneLocked(set.Titles)
	return s.saveLocked(osUser, set)
}

// loadForTest exposes the whole document to the test suite, which needs to
// count entries rather than read them one at a time.
func (s *titleStore) loadForTest(osUser string) (TitleSet, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked(osUser)
}

func (s *titleStore) loadLocked(osUser string) (TitleSet, error) {
	raw, err := os.ReadFile(s.path(osUser))
	if errors.Is(err, os.ErrNotExist) {
		return emptyTitleSet(), nil
	}
	if err != nil {
		return emptyTitleSet(), err
	}
	var set TitleSet
	if err := json.Unmarshal(raw, &set); err != nil {
		return emptyTitleSet(), fmt.Errorf("corrupt title memory for %s: %w", osUser, err)
	}
	if set.Titles == nil {
		set.Titles = map[string]Title{}
	}
	set.Version = titlesVersion
	return set, nil
}

func (s *titleStore) saveLocked(osUser string, set TitleSet) error {
	return writeAtomicJSON(s.dir, osUser+".*.tmp", s.path(osUser), set)
}
