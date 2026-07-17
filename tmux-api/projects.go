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
	"sort"
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

// visibleRef is a foreign session the caller may see/attach, with the access
// mode and (optional) project it comes through.
type visibleRef struct {
	Owner   string
	Name    string
	Access  string // "ro" | "rw"
	Project string
}

// projectNameOf returns the name of the project containing session (owner,name),
// or "" when it belongs to none.
func projectNameOf(ps ProjectSet, owner, name string) string {
	ref := SessionRef{Owner: owner, Name: name}
	for _, p := range ps.Projects {
		for _, s := range p.Sessions {
			if s == ref {
				return p.Name
			}
		}
	}
	return ""
}

// foreignRefsFor computes the sessions owned by OTHER users that the caller may
// see — via membership in a shared project (blanket attach mode) or a direct
// session share — deduped by (owner,name) with rw beating ro and a project
// annotation preferred. Pure: no tmux, so it is unit-testable.
func foreignRefsFor(caller string, ps ProjectSet, ss ShareSet) []visibleRef {
	best := map[SessionRef]*visibleRef{}
	upsert := func(owner, name, access, project string) {
		if owner == caller {
			return // the caller's own session is not foreign
		}
		if access == "" {
			access = projectAttachRO
		}
		k := SessionRef{Owner: owner, Name: name}
		if v := best[k]; v != nil {
			if v.Access == projectAttachRO && access == projectAttachRW {
				v.Access = projectAttachRW
			}
			if v.Project == "" && project != "" {
				v.Project = project
			}
			return
		}
		best[k] = &visibleRef{Owner: owner, Name: name, Access: access, Project: project}
	}
	for _, p := range ps.Projects {
		if !projectMember(p, caller) {
			continue
		}
		for _, s := range p.Sessions {
			upsert(s.Owner, s.Name, p.AttachMode, p.Name)
		}
	}
	for _, sh := range ss.Shares {
		if sh.Guest == caller {
			upsert(sh.Owner, sh.Name, sh.Mode, "")
		}
	}
	out := make([]visibleRef, 0, len(best))
	for _, v := range best {
		out = append(out, *v)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Owner != out[j].Owner {
			return out[i].Owner < out[j].Owner
		}
		return out[i].Name < out[j].Name
	})
	return out
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

var (
	errProjectNotFound = errors.New("project not found")
	errNotMember       = errors.New("not a project member")
	errSessionTaken    = errors.New("session already assigned to a project")
)

func indexByID(ps *ProjectSet, id string) int {
	for i := range ps.Projects {
		if ps.Projects[i].ID == id {
			return i
		}
	}
	return -1
}

// projectErrStatus maps an update() error to an HTTP response. Sentinels become
// 404/403; anything else is an opaque 500 (input is pre-validated in the handler
// so a validation failure here would be a genuine surprise).
func projectErrStatus(w http.ResponseWriter, osUser, action string, err error) {
	switch {
	case errors.Is(err, errProjectNotFound):
		http.Error(w, "project not found", http.StatusNotFound)
	case errors.Is(err, errNotMember):
		http.Error(w, "not a project member", http.StatusForbidden)
	default:
		logAndFail(w, "%s for %s failed: %v", action, osUser, err)
	}
}

// handleProjectByID serves per-project operations under /projects/<id> (and its
// sub-resources /members, /sessions added in later slices).
func handleProjectByID(w http.ResponseWriter, r *http.Request) {
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}
	path := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/projects/"), "/")
	parts := strings.Split(path, "/")
	id := parts[0]
	if id == "" {
		http.Error(w, "missing project id", http.StatusBadRequest)
		return
	}
	if len(parts) == 1 {
		switch r.Method {
		case http.MethodPatch:
			patchProject(w, r, osUser, id)
		case http.MethodDelete:
			deleteProject(w, osUser, id)
		default:
			http.Error(w, "PATCH or DELETE only", http.StatusMethodNotAllowed)
		}
		return
	}
	switch parts[1] {
	case "members":
		handleProjectMembers(w, r, osUser, id, parts[2:])
	case "sessions":
		handleProjectSessions(w, r, osUser, id, parts[2:])
	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}

// handleProjectMembers: POST /projects/{id}/members adds; DELETE
// /projects/{id}/members/{osUser} removes (leave or, co-equally, remove another).
func handleProjectMembers(w http.ResponseWriter, r *http.Request, osUser, id string, rest []string) {
	switch {
	case len(rest) == 0 && r.Method == http.MethodPost:
		addMember(w, r, osUser, id)
	case len(rest) == 1 && r.Method == http.MethodDelete:
		removeMember(w, osUser, id, rest[0])
	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}

// handleProjectSessions: POST /projects/{id}/sessions assigns; DELETE
// /projects/{id}/sessions/{owner}/{name} unassigns.
func handleProjectSessions(w http.ResponseWriter, r *http.Request, osUser, id string, rest []string) {
	switch {
	case len(rest) == 0 && r.Method == http.MethodPost:
		addSession(w, r, osUser, id)
	case len(rest) == 2 && r.Method == http.MethodDelete:
		removeSession(w, osUser, id, rest[0], rest[1])
	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}

// handleUsers (GET /users) returns the mapped OS users, sorted — the candidate
// set for the share / add-member pickers. Requires a valid caller.
func handleUsers(w http.ResponseWriter, r *http.Request) {
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	users := mappedOSUsers()
	sort.Strings(users)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(users)
}

// isMappedOSUser reports whether osUser is a valid terminal account (a target
// in the Authentik→OS-user map) — the population that may be added to projects.
func isMappedOSUser(osUser string) bool {
	for _, u := range loadUserMap() {
		if u == osUser {
			return true
		}
	}
	return false
}

// addMember adds a mapped user to the project (caller must be a member).
// Idempotent: adding an existing member is a no-op.
func addMember(w http.ResponseWriter, r *http.Request, osUser, id string) {
	var body struct {
		OSUser string `json:"osUser"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxLayoutBody)).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	target := strings.TrimSpace(body.OSUser)
	if !sessionNameRe.MatchString(target) || !isMappedOSUser(target) {
		http.Error(w, "unknown or unmapped user", http.StatusBadRequest)
		return
	}
	err := projectStoreInstance.update(func(ps *ProjectSet) error {
		i := indexByID(ps, id)
		if i < 0 {
			return errProjectNotFound
		}
		if !projectMember(ps.Projects[i], osUser) {
			return errNotMember
		}
		if !projectMember(ps.Projects[i], target) {
			ps.Projects[i].Members = append(ps.Projects[i].Members, Member{OSUser: target, AddedBy: osUser})
		}
		return nil
	})
	if err != nil {
		projectErrStatus(w, osUser, "add member", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// removeMember drops a member and their session refs from the project (any
// member may, co-equal). If the last member leaves, the project dissolves.
func removeMember(w http.ResponseWriter, osUser, id, target string) {
	err := projectStoreInstance.update(func(ps *ProjectSet) error {
		i := indexByID(ps, id)
		if i < 0 {
			return errProjectNotFound
		}
		if !projectMember(ps.Projects[i], osUser) {
			return errNotMember
		}
		members := ps.Projects[i].Members[:0]
		for _, m := range ps.Projects[i].Members {
			if m.OSUser != target {
				members = append(members, m)
			}
		}
		ps.Projects[i].Members = members
		sessions := ps.Projects[i].Sessions[:0]
		for _, s := range ps.Projects[i].Sessions {
			if s.Owner != target {
				sessions = append(sessions, s)
			}
		}
		ps.Projects[i].Sessions = sessions
		if len(ps.Projects[i].Members) == 0 {
			ps.Projects = append(ps.Projects[:i], ps.Projects[i+1:]...)
		}
		return nil
	})
	if err != nil {
		projectErrStatus(w, osUser, "remove member", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// addSession assigns the caller's OWN session to the project. A session may
// belong to at most one project (409 otherwise).
func addSession(w http.ResponseWriter, r *http.Request, osUser, id string) {
	var body struct {
		Owner string `json:"owner"`
		Name  string `json:"name"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxLayoutBody)).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	owner := strings.TrimSpace(body.Owner)
	name := strings.TrimSpace(body.Name)
	if owner != osUser {
		http.Error(w, "you can only assign your own sessions", http.StatusForbidden)
		return
	}
	if !sessionNameRe.MatchString(owner) || !sessionNameRe.MatchString(name) {
		http.Error(w, "invalid session ref", http.StatusBadRequest)
		return
	}
	ref := SessionRef{Owner: owner, Name: name}
	err := projectStoreInstance.update(func(ps *ProjectSet) error {
		i := indexByID(ps, id)
		if i < 0 {
			return errProjectNotFound
		}
		if !projectMember(ps.Projects[i], osUser) {
			return errNotMember
		}
		for pi := range ps.Projects {
			for _, s := range ps.Projects[pi].Sessions {
				if s == ref {
					return errSessionTaken
				}
			}
		}
		ps.Projects[i].Sessions = append(ps.Projects[i].Sessions, ref)
		return nil
	})
	if err != nil {
		if errors.Is(err, errSessionTaken) {
			http.Error(w, "session already assigned to a project", http.StatusConflict)
			return
		}
		projectErrStatus(w, osUser, "assign session", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// removeSession unassigns a session (any member may). It never kills the tmux
// session — only the grouping.
func removeSession(w http.ResponseWriter, osUser, id, owner, name string) {
	ref := SessionRef{Owner: owner, Name: name}
	err := projectStoreInstance.update(func(ps *ProjectSet) error {
		i := indexByID(ps, id)
		if i < 0 {
			return errProjectNotFound
		}
		if !projectMember(ps.Projects[i], osUser) {
			return errNotMember
		}
		out := ps.Projects[i].Sessions[:0]
		for _, s := range ps.Projects[i].Sessions {
			if s != ref {
				out = append(out, s)
			}
		}
		ps.Projects[i].Sessions = out
		return nil
	})
	if err != nil {
		projectErrStatus(w, osUser, "unassign session", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// patchProject updates the provided fields (PATCH semantics: only fields present
// in the body change). Any member may edit (co-equal governance). Values are
// pre-validated for a clean 400.
func patchProject(w http.ResponseWriter, r *http.Request, osUser, id string) {
	var body struct {
		Name       *string `json:"name"`
		Dir        *string `json:"dir"`
		AttachMode *string `json:"attachMode"`
		CoOwned    *bool   `json:"coOwned"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxLayoutBody)).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if body.Name != nil && !sessionNameRe.MatchString(strings.TrimSpace(*body.Name)) {
		http.Error(w, "invalid project name", http.StatusBadRequest)
		return
	}
	if body.Dir != nil && *body.Dir != "" && (!filepath.IsAbs(*body.Dir) || len(*body.Dir) > maxDirLen) {
		http.Error(w, "project dir must be an absolute path", http.StatusBadRequest)
		return
	}
	if body.AttachMode != nil {
		switch *body.AttachMode {
		case "", projectAttachRO, projectAttachRW:
		default:
			http.Error(w, "invalid attach mode", http.StatusBadRequest)
			return
		}
	}
	var updated GlobalProject
	err := projectStoreInstance.update(func(ps *ProjectSet) error {
		i := indexByID(ps, id)
		if i < 0 {
			return errProjectNotFound
		}
		if !projectMember(ps.Projects[i], osUser) {
			return errNotMember
		}
		if body.Name != nil {
			ps.Projects[i].Name = strings.TrimSpace(*body.Name)
		}
		if body.Dir != nil {
			ps.Projects[i].Dir = *body.Dir
		}
		if body.AttachMode != nil {
			ps.Projects[i].AttachMode = *body.AttachMode
		}
		if body.CoOwned != nil {
			ps.Projects[i].CoOwned = *body.CoOwned
		}
		updated = ps.Projects[i]
		return nil
	})
	if err != nil {
		projectErrStatus(w, osUser, "patch project", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(updated)
}

// deleteProject removes the project (any member may, co-equal). It dissolves the
// grouping only — sessions are tmux state and are never touched here.
func deleteProject(w http.ResponseWriter, osUser, id string) {
	err := projectStoreInstance.update(func(ps *ProjectSet) error {
		i := indexByID(ps, id)
		if i < 0 {
			return errProjectNotFound
		}
		if !projectMember(ps.Projects[i], osUser) {
			return errNotMember
		}
		ps.Projects = append(ps.Projects[:i], ps.Projects[i+1:]...)
		return nil
	})
	if err != nil {
		projectErrStatus(w, osUser, "delete project", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
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
