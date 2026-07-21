package main

import (
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"sync"
	"time"
)

// userState holds one OS user's session map and live sources. The service runs
// as a privileged user but isolates each mapped user's transcripts by absolute
// path under their home; there is no cross-user access path.
type userState struct {
	osUser string
	root   string // /home/<osUser>/.claude/projects
	sm     *sessionMap
	mu     sync.Mutex
	srcs   map[string]*fileSource // key: tmux session name
}

// registry lazily manages per-user state and per-session sources.
type registry struct {
	mu       sync.Mutex
	users    map[string]*userState
	ctx      context.Context
	poll     time.Duration
	homeBase string // "/home" (overridable for tests)
}

func newRegistry(ctx context.Context, poll time.Duration, homeBase string) *registry {
	return &registry{users: map[string]*userState{}, ctx: ctx, poll: poll, homeBase: homeBase}
}

func (rg *registry) user(osUser string) *userState {
	rg.mu.Lock()
	defer rg.mu.Unlock()
	us, ok := rg.users[osUser]
	if !ok {
		root := filepath.Join(rg.homeBase, osUser, ".claude", "projects")
		us = &userState{osUser: osUser, root: root, sm: newSessionMap(root), srcs: map[string]*fileSource{}}
		rg.users[osUser] = us
	}
	return us
}

// source returns the live fileSource for a registered session, lazily creating +
// starting its tail. ok=false if the session was never registered (SessionStart).
func (rg *registry) source(osUser, session string) (*fileSource, bool) {
	us := rg.user(osUser)
	us.mu.Lock()
	defer us.mu.Unlock()
	if fs, ok := us.srcs[session]; ok {
		return fs, true
	}
	info, ok := us.sm.get(session)
	if !ok {
		return nil, false
	}
	fs := newFileSource(session, info.Transcript, rg.poll)
	us.srcs[session] = fs
	go fs.Run(rg.ctx)
	return fs, true
}

// handleSessionStart records the (user, tmux session) → transcript mapping from
// the SessionStart hook. Localhost only (hooks run as the OS user on the box).
func (rg *registry) handleSessionStart() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b sessionStartBody
		if json.NewDecoder(r.Body).Decode(&b) != nil || b.User == "" || b.SessionID == "" || b.TmuxSession == "" {
			http.Error(w, "bad body (need user, session_id, tmux_session)", http.StatusBadRequest)
			return
		}
		rg.user(b.User).sm.put(sessionInfo{TmuxSession: b.TmuxSession, CWD: b.CWD, ClaudeID: b.SessionID})
		w.WriteHeader(http.StatusNoContent)
	}
}
