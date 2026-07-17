package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
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
)

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
