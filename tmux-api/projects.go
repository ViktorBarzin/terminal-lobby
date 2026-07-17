package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// GlobalProject is a first-class, multi-owner project. Unlike the per-user
// layout Project (a sidebar grouping keyed by name within one user's document),
// a GlobalProject has a stable opaque ID, an explicit member set spanning OS
// users, a blanket session-attach mode, and a co-ownership flag — so it lives
// in one global document, not any single user's layout. See
// docs/plans/2026-07-17-shared-multiuser-projects-and-sessions.md.
type GlobalProject struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Dir is the base working directory for sessions created in the project
	// (as in the per-user Project.Dir); absolute, optional.
	Dir string `json:"dir,omitempty"`
	// AttachMode is the blanket mode for attaching OTHER members' sessions in
	// this project: "ro" (watch) or "rw" (drive-as-owner). "" means "ro" (the
	// safe default). A member always drives their own sessions regardless.
	AttachMode string `json:"attachMode,omitempty"`
	// CoOwned records whether filesystem ACL co-ownership has been applied to
	// Dir for the members. Independent of AttachMode.
	CoOwned bool `json:"coOwned,omitempty"`
	// CreatedBy is the OS user who created the project (audit only; governance
	// is co-equal so it grants no special rights).
	CreatedBy string       `json:"createdBy,omitempty"`
	Members   []Member     `json:"members"`
	Sessions  []SessionRef `json:"sessions"`
}

// Member is an OS user belonging to a project.
type Member struct {
	OSUser  string `json:"osUser"`
	AddedBy string `json:"addedBy,omitempty"`
}

// SessionRef identifies a session globally. tmux session names are unique only
// within one user's server, so a cross-user reference needs the owner too.
type SessionRef struct {
	Owner string `json:"owner"`
	Name  string `json:"name"`
}

// ProjectSet is the whole global project document.
type ProjectSet struct {
	Version  int             `json:"version"`
	Projects []GlobalProject `json:"projects"`
}

const (
	projectsVersion = 1
	// projectAttachRO/RW are the two AttachMode values; "" is treated as RO.
	projectAttachRO = "ro"
	projectAttachRW = "rw"
	// projectsPath is the single global project document, alongside the
	// per-user layout files under /var/lib/tmux-api.
	projectsPath = "/var/lib/tmux-api/projects.json"
)

var projectStoreInstance = newProjectStore(projectsPath)

// mappedOSUsers returns the distinct OS users from the Authentik→OS-user map —
// the population whose per-user layouts are imported at first-run migration.
func mappedOSUsers() []string {
	seen := map[string]bool{}
	out := []string{}
	for _, u := range loadUserMap() {
		if !seen[u] {
			seen[u] = true
			out = append(out, u)
		}
	}
	return out
}

// projectStore persists the single global ProjectSet document. Mutations are
// whole-document, mutex-guarded, atomic (tmp+rename) — mirroring layoutStore.
type projectStore struct {
	mu   sync.Mutex
	path string
}

func newProjectStore(path string) *projectStore { return &projectStore{path: path} }

func emptyProjectSet() ProjectSet {
	return ProjectSet{Version: projectsVersion, Projects: []GlobalProject{}}
}

// load returns the global project set, or an empty default when none was ever
// saved. A corrupt file is an error (better a 500 than silently wiping shared
// state on the next save).
func (s *projectStore) load() (ProjectSet, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked()
}

func (s *projectStore) loadLocked() (ProjectSet, error) {
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return emptyProjectSet(), nil
	}
	if err != nil {
		return ProjectSet{}, err
	}
	var ps ProjectSet
	if err := json.Unmarshal(raw, &ps); err != nil {
		return ProjectSet{}, fmt.Errorf("corrupt project store: %w", err)
	}
	if ps.Projects == nil {
		ps.Projects = []GlobalProject{}
	}
	for i := range ps.Projects {
		if ps.Projects[i].Members == nil {
			ps.Projects[i].Members = []Member{}
		}
		if ps.Projects[i].Sessions == nil {
			ps.Projects[i].Sessions = []SessionRef{}
		}
	}
	return ps, nil
}

func (s *projectStore) save(ps ProjectSet) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveLocked(ps)
}

// update loads the set, applies fn, validates the result, and saves — all under
// the lock, so a mutation on the shared document is atomic and never persists an
// invariant-violating set. fn returning an error aborts without saving.
func (s *projectStore) update(fn func(*ProjectSet) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	ps, err := s.loadLocked()
	if err != nil {
		return err
	}
	if err := fn(&ps); err != nil {
		return err
	}
	if err := validateProjectSet(ps); err != nil {
		return err
	}
	return s.saveLocked(ps)
}

// saveLocked writes atomically (tmp + rename) so a crash mid-write can't leave
// a truncated document behind.
func (s *projectStore) saveLocked(ps ProjectSet) error {
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	raw, err := json.Marshal(ps)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "projects.*.tmp")
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
	return os.Rename(tmp.Name(), s.path)
}

// validateProjectSet enforces the global-document invariants: known version,
// bounded count, unique non-empty ids, project/member/session names in the
// tmux name charset, absolute dirs, a valid attach mode, at least one member
// per project, and each session (owner,name) referenced by at most one project.
// Project NAMES are deliberately NOT required unique — two owners may each have
// a "work" project (identity is the id).
func validateProjectSet(ps ProjectSet) error {
	if ps.Version != projectsVersion {
		return fmt.Errorf("unsupported project set version %d", ps.Version)
	}
	if len(ps.Projects) > maxProjects {
		return fmt.Errorf("too many projects (%d > %d)", len(ps.Projects), maxProjects)
	}
	ids := map[string]bool{}
	sessionSeen := map[SessionRef]bool{}
	for _, p := range ps.Projects {
		if p.ID == "" {
			return fmt.Errorf("project %q has empty id", p.Name)
		}
		if ids[p.ID] {
			return fmt.Errorf("duplicate project id %q", p.ID)
		}
		ids[p.ID] = true
		if !sessionNameRe.MatchString(p.Name) {
			return fmt.Errorf("invalid project name %q", p.Name)
		}
		if p.Dir != "" {
			if len(p.Dir) > maxDirLen {
				return fmt.Errorf("project %q dir too long (%d > %d)", p.Name, len(p.Dir), maxDirLen)
			}
			if !filepath.IsAbs(p.Dir) {
				return fmt.Errorf("project %q dir must be an absolute path: %q", p.Name, p.Dir)
			}
		}
		switch p.AttachMode {
		case "", projectAttachRO, projectAttachRW:
		default:
			return fmt.Errorf("project %q invalid attach mode %q", p.Name, p.AttachMode)
		}
		if len(p.Members) == 0 {
			return fmt.Errorf("project %q has no members", p.Name)
		}
		for _, m := range p.Members {
			if !sessionNameRe.MatchString(m.OSUser) {
				return fmt.Errorf("project %q invalid member %q", p.Name, m.OSUser)
			}
		}
		for _, s := range p.Sessions {
			if !sessionNameRe.MatchString(s.Owner) || !sessionNameRe.MatchString(s.Name) {
				return fmt.Errorf("project %q invalid session ref %+v", p.Name, s)
			}
			if sessionSeen[s] {
				return fmt.Errorf("session %+v listed in more than one project", s)
			}
			sessionSeen[s] = true
		}
	}
	return nil
}

// projectMember reports whether osUser is a member of p.
func projectMember(p GlobalProject, osUser string) bool {
	for _, m := range p.Members {
		if m.OSUser == osUser {
			return true
		}
	}
	return false
}

// handleProjects serves the collection endpoint: GET lists the caller's member
// projects, POST creates one. Per-project operations live under /projects/.
func handleProjects(w http.ResponseWriter, r *http.Request) {
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}
	switch r.Method {
	case http.MethodGet:
		listProjects(w, osUser)
	case http.MethodPost:
		createProject(w, r, osUser)
	default:
		http.Error(w, "GET or POST only", http.StatusMethodNotAllowed)
	}
}

// listProjects returns the projects the caller is a member of (a multi-owner
// project appears for every member; a non-member sees nothing).
func listProjects(w http.ResponseWriter, osUser string) {
	set, err := projectStoreInstance.load()
	if err != nil {
		logAndFail(w, "project load for %s failed: %v", osUser, err)
		return
	}
	mine := make([]GlobalProject, 0)
	for _, p := range set.Projects {
		if projectMember(p, osUser) {
			mine = append(mine, p)
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(mine)
}

// createProject makes a new project with the caller as its sole member and
// createdBy. Name/dir are validated for a clean 400; the store's update then
// re-validates the whole document under the lock.
func createProject(w http.ResponseWriter, r *http.Request, osUser string) {
	var body struct {
		Name string `json:"name"`
		Dir  string `json:"dir"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxLayoutBody)).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	name := strings.TrimSpace(body.Name)
	if !sessionNameRe.MatchString(name) {
		http.Error(w, "invalid project name", http.StatusBadRequest)
		return
	}
	if body.Dir != "" && (!filepath.IsAbs(body.Dir) || len(body.Dir) > maxDirLen) {
		http.Error(w, "project dir must be an absolute path", http.StatusBadRequest)
		return
	}
	p := GlobalProject{
		ID:        newProjectID(),
		Name:      name,
		Dir:       body.Dir,
		CreatedBy: osUser,
		Members:   []Member{{OSUser: osUser, AddedBy: osUser}},
		Sessions:  []SessionRef{},
	}
	if err := projectStoreInstance.update(func(ps *ProjectSet) error {
		ps.Projects = append(ps.Projects, p)
		return nil
	}); err != nil {
		logAndFail(w, "create project for %s failed: %v", osUser, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(p)
}

// migrateAllLayouts builds the initial global project set from every mapped
// user's per-user layout, but only if the global store does not yet exist.
// Returns true when it performed the one-shot import, false when the store was
// already present (a no-op). Runs once at startup, so no locking is needed
// around the existence check.
func migrateAllLayouts(ls *layoutStore, ps *projectStore, users []string) (bool, error) {
	if _, err := os.Stat(ps.path); err == nil {
		return false, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	set := emptyProjectSet()
	for _, u := range users {
		l, err := ls.load(u)
		if err != nil {
			return false, fmt.Errorf("migrate layout for %s: %w", u, err)
		}
		set.Projects = append(set.Projects, migrateUserLayout(u, l, newProjectID)...)
	}
	if err := ps.save(set); err != nil {
		return false, err
	}
	return true, nil
}

// newProjectID returns a short, opaque, collision-resistant project id.
func newProjectID() string {
	var b [9]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand should never fail; if it does, a panic is safer than
		// silently minting a predictable/duplicate id into shared state.
		panic("newProjectID: " + err.Error())
	}
	return "p_" + base64.RawURLEncoding.EncodeToString(b[:])
}

// migrateUserLayout converts one user's per-user layout groupings into
// single-member global projects owned by that user: the user is the sole
// member, every session is owned by that user, Dir carries over, AttachMode
// stays "" (the RO default). Ungrouped sessions are NOT pulled into a project
// — they remain in the per-user layout. idgen supplies fresh IDs (injected so
// migration is testable against a known expectation).
func migrateUserLayout(osUser string, l Layout, idgen func() string) []GlobalProject {
	out := make([]GlobalProject, 0, len(l.Projects))
	for _, p := range l.Projects {
		sessions := make([]SessionRef, 0, len(p.Sessions))
		for _, name := range p.Sessions {
			sessions = append(sessions, SessionRef{Owner: osUser, Name: name})
		}
		out = append(out, GlobalProject{
			ID:        idgen(),
			Name:      p.Name,
			Dir:       p.Dir,
			CreatedBy: osUser,
			Members:   []Member{{OSUser: osUser, AddedBy: osUser}},
			Sessions:  sessions,
		})
	}
	return out
}
