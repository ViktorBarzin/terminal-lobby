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
	"sync"
)

const (
	titlesVersion = 1
	titlesDir     = "/var/lib/tmux-api/titles"
)

// TitleSet is one user's remembered titles, keyed by session name.
type TitleSet struct {
	Version int               `json:"version"`
	Titles  map[string]string `json:"titles"`
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
	return TitleSet{Version: titlesVersion, Titles: map[string]string{}}
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
	return set.Titles[name]
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
	return set.Titles
}

// set records a title, or REMOVES the entry when title is empty. Clearing a
// title is how a session goes back to showing its name, so storing "" would
// make a later restore re-stamp an empty option and hide that choice.
func (s *titleStore) set(osUser, name, title string) error {
	return s.update(osUser, func(titles map[string]string) {
		if title == "" {
			delete(titles, name)
			return
		}
		titles[name] = title
	})
}

// rename carries a title from one name to the other. A session with no
// remembered title renames to nothing, which is not an error — most sessions
// have never been titled.
func (s *titleStore) rename(osUser, oldName, newName string) error {
	return s.update(osUser, func(titles map[string]string) {
		title, ok := titles[oldName]
		if !ok {
			return
		}
		delete(titles, oldName)
		titles[newName] = title
	})
}

// forget drops one session's title — a deliberate kill, mirroring what
// killSession already does to the layout and the persist manifest.
func (s *titleStore) forget(osUser, name string) error {
	return s.update(osUser, func(titles map[string]string) { delete(titles, name) })
}

// prune keeps only the names still worth remembering: those live now, plus
// those a snapshot can still restore. A name that is merely not running is NOT
// droppable — that is exactly the session a restore is about to bring back.
func (s *titleStore) prune(osUser string, keep map[string]bool) error {
	return s.update(osUser, func(titles map[string]string) {
		for name := range titles {
			if !keep[name] {
				delete(titles, name)
			}
		}
	})
}

func (s *titleStore) update(osUser string, mutate func(map[string]string)) error {
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
	return s.saveLocked(osUser, set)
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
		set.Titles = map[string]string{}
	}
	set.Version = titlesVersion
	return set, nil
}

func (s *titleStore) saveLocked(osUser string, set TitleSet) error {
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
