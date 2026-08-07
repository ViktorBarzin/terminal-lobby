package main

import (
	"context"
	"encoding/json"
	"log"
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
	srcs   map[string]*liveSource // key: tmux session name
}

// liveSource is a running fileSource plus the handle that stops its tail. A
// source is evicted when the tmux name it is keyed by starts pointing at a
// different transcript, and eviction has to stop the goroutine or every reused
// session name leaks one tailer for the life of the process. done is closed
// once that goroutine has returned, which is what makes the stop observable.
type liveSource struct {
	fs   *fileSource
	stop context.CancelFunc
	done <-chan struct{}
}

// registry lazily manages per-user state and per-session sources.
type registry struct {
	mu       sync.Mutex
	users    map[string]*userState
	ctx      context.Context
	poll     time.Duration
	homeBase string // "/home" (overridable for tests)
	opts     tmuxOptions
}

func newRegistry(ctx context.Context, poll time.Duration, homeBase string, opts tmuxOptions) *registry {
	return &registry{
		users: map[string]*userState{}, ctx: ctx,
		poll: poll, homeBase: homeBase, opts: opts,
	}
}

func (rg *registry) user(osUser string) *userState {
	rg.mu.Lock()
	defer rg.mu.Unlock()
	us, ok := rg.users[osUser]
	if !ok {
		root := filepath.Join(rg.homeBase, osUser, ".claude", "projects")
		us = &userState{
			osUser: osUser, root: root,
			sm:   newSessionMap(osUser, root, rg.opts),
			srcs: map[string]*liveSource{},
		}
		rg.users[osUser] = us
	}
	return us
}

// source returns the live fileSource for a registered session, lazily creating +
// starting its tail. ok=false if the session was never registered (SessionStart).
//
// The cache is keyed by tmux session name, but a name outlives the Claude
// session that claimed it: kill a session and start another in the same window
// and SessionStart re-registers the name against a new transcript. A
// fileSource's path is fixed at construction, so the cached entry is only still
// valid while it points at the transcript the sessionMap currently holds —
// otherwise it is a tailer on a dead session's file and has to be replaced.
func (rg *registry) source(osUser, session string) (*fileSource, bool) {
	us := rg.user(osUser)
	us.mu.Lock()
	defer us.mu.Unlock()
	info, ok := us.sm.get(session)
	if !ok {
		// The mapping is gone (the tmux session was killed, or a plain shell
		// took its name). Anything still tailing the old transcript is reading
		// a dead session's file — stop it rather than leak the goroutine.
		if ls, cached := us.srcs[session]; cached {
			ls.stop()
			delete(us.srcs, session)
		}
		return nil, false
	}
	if ls, ok := us.srcs[session]; ok {
		if ls.fs.path == info.Transcript {
			return ls.fs, true
		}
		ls.stop()
		delete(us.srcs, session)
	}
	ls := rg.start(session, info.Transcript)
	us.srcs[session] = ls
	return ls.fs, true
}

// start builds a fileSource and runs its tail under a context of its own, so
// this one source can be stopped without taking down the rest of the process.
func (rg *registry) start(session, transcript string) *liveSource {
	ctx, stop := context.WithCancel(rg.ctx)
	fs := newFileSource(session, transcript, rg.poll)
	done := make(chan struct{})
	go func() {
		defer close(done)
		fs.Run(ctx)
	}()
	return &liveSource{fs: fs, stop: stop, done: done}
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
		if err := rg.user(b.User).sm.put(sessionInfo{
			TmuxSession: b.TmuxSession, CWD: b.CWD, ClaudeID: b.SessionID,
		}); err != nil {
			log.Printf("session-start %s/%s: %v", b.User, b.TmuxSession, err)
			http.Error(w, "cannot record session", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
