package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"

	"terminal-lobby/telemetry"
)

// Layout is a user's sidebar arrangement: ordered projects with ordered
// member sessions, plus the order of ungrouped sessions. Stored as one
// JSON document per OS user under layoutDir; mutations are whole-document
// PUTs, last-writer-wins (see docs/adr/0002-layout-store-in-tmux-api.md).
//
// Member lists may reference sessions that are not currently alive: only
// an explicit UI kill removes an entry, so sessions recreated under the
// same name (tmux-persist restore after an OOM) land back in their
// project. The frontend renders live sessions only.
type Layout struct {
	Version   int       `json:"version"`
	Projects  []Project `json:"projects"`
	Ungrouped []string  `json:"ungrouped"`
	// UngroupedIndex is the Ungrouped section's slot among the rendered
	// groups: it renders before Projects[UngroupedIndex] (len(Projects)
	// = last). Absent in pre-field documents -> 0, the historic pinned-
	// top position.
	UngroupedIndex int `json:"ungroupedIndex"`
	// Dock is the Ctrl+J bottom-panel scratch shell (frontend
	// docs/2026-07-17-ctrl-j-shell-dock-design.md). A pointer so it is
	// omitted entirely when nothing is docked. It MUST be a real struct
	// field: without it, decoding a PUT silently dropped the client's dock
	// and GET never returned it, so the panel only survived the client's 4s
	// grace and then vanished on the next poll — the "auto-close" bug. It
	// rides the same whole-document PUT/GET as the rest of the layout, so it
	// roams across devices and survives mutations (mutateSessions preserves,
	// renames, or clears it in lockstep with the session it names).
	Dock *DockState `json:"dock,omitempty"`
}

// DockState mirrors the frontend layout.dock shape: the docked session's
// name, whether the panel is expanded, and the launch dir used only when the
// shell is (re)created.
type DockState struct {
	Session string `json:"session"`
	Visible bool   `json:"visible"`
	Dir     string `json:"dir,omitempty"`
}

type Project struct {
	Name     string   `json:"name"`
	Sessions []string `json:"sessions"`
	// Dir is the base working directory for sessions CREATED inside this
	// project — passed through to `tmux new-session -c`. Optional: empty
	// means the user's $HOME, exactly as before projects had a dir. It only
	// affects a session at creation time; moving a live session into a
	// project cannot change its cwd, and existence is checked as the target
	// user at attach time (a stale dir falls back to $HOME there).
	Dir string `json:"dir,omitempty"`
}

const (
	layoutDir     = "/var/lib/tmux-api/layout"
	layoutVersion = 1
	maxProjects   = 100
	maxLayoutBody = 64 * 1024
	// maxDirLen caps a project's Dir — comfortably past Linux PATH_MAX so a
	// real path never trips it, while bounding a hostile/garbage document.
	maxDirLen = 4096
)

type layoutStore struct {
	mu  sync.Mutex
	dir string
}

func newLayoutStore(dir string) *layoutStore {
	return &layoutStore{dir: dir}
}

var layoutStoreInstance = newLayoutStore(layoutDir)

func (s *layoutStore) path(osUser string) string {
	return filepath.Join(s.dir, osUser+".json")
}

func emptyLayout() Layout {
	return Layout{Version: layoutVersion, Projects: []Project{}, Ungrouped: []string{}}
}

// load returns the user's layout, or an empty default when none was ever
// saved. A corrupt file is an error — better a 500 than silently wiping
// the user's arrangement on the next PUT.
func (s *layoutStore) load(osUser string) (Layout, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked(osUser)
}

func (s *layoutStore) loadLocked(osUser string) (Layout, error) {
	raw, err := os.ReadFile(s.path(osUser))
	if errors.Is(err, os.ErrNotExist) {
		return emptyLayout(), nil
	}
	if err != nil {
		return Layout{}, err
	}
	var l Layout
	if err := json.Unmarshal(raw, &l); err != nil {
		return Layout{}, fmt.Errorf("corrupt layout for %s: %w", osUser, err)
	}
	if l.Projects == nil {
		l.Projects = []Project{}
	}
	if l.Ungrouped == nil {
		l.Ungrouped = []string{}
	}
	for i := range l.Projects {
		if l.Projects[i].Sessions == nil {
			l.Projects[i].Sessions = []string{}
		}
	}
	return l, nil
}

func (s *layoutStore) save(osUser string, l Layout) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveLocked(osUser, l)
}

// saveLocked writes atomically (tmp + rename) so a crash mid-write can't
// leave a truncated document behind.
func (s *layoutStore) saveLocked(osUser string, l Layout) error {
	return writeAtomicJSON(s.dir, osUser+".*.tmp", s.path(osUser), l)
}

// removeSession drops a session from every list — called ONLY on an
// explicit UI kill (deaths outside the API keep their assignment so a
// restore regroups them).
func (s *layoutStore) removeSession(osUser, name string) error {
	return s.mutateSessions(osUser, func(sess string) (string, bool) {
		if sess == name {
			return "", false
		}
		return sess, true
	})
}

// renameSession follows a tmux rename so the assignment sticks.
func (s *layoutStore) renameSession(osUser, oldName, newName string) error {
	return s.mutateSessions(osUser, func(sess string) (string, bool) {
		if sess == oldName {
			return newName, true
		}
		return sess, true
	})
}

// mutateSessions applies fn to every session reference; fn returns the
// (possibly changed) name and whether to keep the entry. The file is only
// rewritten when something changed.
func (s *layoutStore) mutateSessions(osUser string, fn func(string) (string, bool)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	l, err := s.loadLocked(osUser)
	if err != nil {
		return err
	}
	changed := false
	apply := func(list []string) []string {
		out := list[:0]
		for _, sess := range list {
			name, keep := fn(sess)
			if !keep || name != sess {
				changed = true
			}
			if keep {
				out = append(out, name)
			}
		}
		return out
	}
	for i := range l.Projects {
		l.Projects[i].Sessions = apply(l.Projects[i].Sessions)
	}
	l.Ungrouped = apply(l.Ungrouped)
	// The dock names a session too — keep it in lockstep: a UI kill of the
	// docked shell clears the dock; a rename follows it. Without this a kill
	// would leave the dock pointing at a dead session (and a rename would
	// silently un-dock it).
	if l.Dock != nil {
		if name, keep := fn(l.Dock.Session); !keep {
			l.Dock = nil
			changed = true
		} else if name != l.Dock.Session {
			l.Dock.Session = name
			changed = true
		}
	}
	if !changed {
		return nil
	}
	return s.saveLocked(osUser, l)
}

// validateLayout enforces the document invariants: known version, sane
// counts, project/session names in the same charset as tmux session names,
// unique project names, and each session referenced at most once.
func validateLayout(l Layout) error {
	if l.Version != layoutVersion {
		return fmt.Errorf("unsupported layout version %d", l.Version)
	}
	if len(l.Projects) > maxProjects {
		return fmt.Errorf("too many projects (%d > %d)", len(l.Projects), maxProjects)
	}
	if l.UngroupedIndex < 0 || l.UngroupedIndex > len(l.Projects) {
		return fmt.Errorf("ungroupedIndex %d out of range [0,%d]", l.UngroupedIndex, len(l.Projects))
	}
	projectNames := map[string]bool{}
	seenSession := map[string]bool{}
	checkSession := func(name string) error {
		if !sessionNameRe.MatchString(name) {
			return fmt.Errorf("invalid session name %q", name)
		}
		if seenSession[name] {
			return fmt.Errorf("session %q listed more than once", name)
		}
		seenSession[name] = true
		return nil
	}
	for _, p := range l.Projects {
		if !sessionNameRe.MatchString(p.Name) {
			return fmt.Errorf("invalid project name %q", p.Name)
		}
		if projectNames[p.Name] {
			return fmt.Errorf("duplicate project %q", p.Name)
		}
		projectNames[p.Name] = true
		if p.Dir != "" {
			if len(p.Dir) > maxDirLen {
				return fmt.Errorf("project %q dir too long (%d > %d)", p.Name, len(p.Dir), maxDirLen)
			}
			if !filepath.IsAbs(p.Dir) {
				return fmt.Errorf("project %q dir must be an absolute path: %q", p.Name, p.Dir)
			}
		}
		for _, sess := range p.Sessions {
			if err := checkSession(sess); err != nil {
				return err
			}
		}
	}
	for _, sess := range l.Ungrouped {
		if err := checkSession(sess); err != nil {
			return err
		}
	}
	// The dock names a live scratch shell that is deliberately NOT listed in
	// projects/ungrouped (it's hidden from the sidebar), so it is validated on
	// its own rather than through checkSession's uniqueness map.
	if l.Dock != nil {
		if !sessionNameRe.MatchString(l.Dock.Session) {
			return fmt.Errorf("invalid dock session name %q", l.Dock.Session)
		}
		if l.Dock.Dir != "" {
			if len(l.Dock.Dir) > maxDirLen {
				return fmt.Errorf("dock dir too long (%d > %d)", len(l.Dock.Dir), maxDirLen)
			}
			if !filepath.IsAbs(l.Dock.Dir) {
				return fmt.Errorf("dock dir must be an absolute path: %q", l.Dock.Dir)
			}
		}
	}
	return nil
}

// handleLayout serves GET/PUT /layout for the calling user's sidebar
// arrangement. Same no-store rationale as /sessions: the browser must not
// cache what it just changed.
func handleLayout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPut {
		http.Error(w, "GET or PUT only", http.StatusMethodNotAllowed)
		return
	}
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}

	if r.Method == http.MethodGet {
		l, err := layoutStoreInstance.load(osUser)
		if err != nil {
			logAndFail(w, "layout load for %s failed: %v", osUser, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(l)
		return
	}

	var l Layout
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxLayoutBody))
	if err := dec.Decode(&l); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if err := validateLayout(l); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := layoutStoreInstance.save(osUser, l); err != nil {
		logAndFail(w, "layout save for %s failed: %v", osUser, err)
		return
	}
	// /sessions bodies embed the project field — a layout change makes the
	// cached copy stale.
	sessionsCacheInstance.invalidate(osUser)
	events.Emit("layout.reordered", osUser, telemetry.Attrs{
		"tl.count": len(l.Projects), "tl.client": "api",
	})
	w.WriteHeader(http.StatusNoContent)
}
