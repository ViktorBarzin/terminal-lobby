package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"terminal-lobby/sessionio"
)

// userState holds one OS user's session map and live sources. The service runs
// as a privileged user but isolates each mapped user's transcripts by absolute
// path under their home; there is no cross-user access path.
type userState struct {
	osUser string
	root   string // /home/<osUser>/.claude/projects
	sm     *sessionio.SessionMap
	mu     sync.Mutex
	srcs   map[string]*liveSource // key: tmux session name

	// How this user's files are read. The service's own user is read directly;
	// everyone else goes through a child running as them, because a home is
	// 0750 and this process cannot open what is inside one. priv is nil for the
	// former and is the same object as reader for the latter — it is kept
	// separately because the slash-command catalogue is not a sessionio read.
	reader sessionio.Reader
	priv   *privReader
}

// liveSource is a running FileSource plus the handle that stops its tail. A
// source is evicted when the tmux name it is keyed by starts pointing at a
// different transcript, and eviction has to stop the goroutine or every reused
// session name leaks one tailer for the life of the process. done is closed
// once that goroutine has returned, which is what makes the stop observable.
type liveSource struct {
	fs   *sessionio.FileSource
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
	opts     sessionio.Options
	self     string // the OS user this process runs as
}

func newRegistry(ctx context.Context, poll time.Duration, homeBase string, opts sessionio.Options, self string) *registry {
	return &registry{
		users: map[string]*userState{}, ctx: ctx,
		poll: poll, homeBase: homeBase, opts: opts, self: self,
	}
}

func (rg *registry) user(osUser string) *userState {
	rg.mu.Lock()
	defer rg.mu.Unlock()
	us, ok := rg.users[osUser]
	if !ok {
		root := sessionio.ProjectsRoot(rg.homeBase, osUser)
		us = &userState{
			osUser: osUser, root: root,
			sm:   sessionio.NewSessionMap(osUser, root, rg.opts),
			srcs: map[string]*liveSource{},
		}
		if osUser == rg.self {
			us.reader = sessionio.LocalReader{}
		} else {
			us.priv = newPrivReader(osUser)
			us.reader = us.priv
		}
		rg.users[osUser] = us
	}
	return us
}

// source returns the live FileSource for a registered session, lazily creating +
// starting its tail. ok=false if the session was never registered (SessionStart).
//
// The cache is keyed by tmux session name, but a name outlives the Claude
// session that claimed it: kill a session and start another in the same window
// and SessionStart re-registers the name against a new transcript. A
// FileSource's path is fixed at construction, so the cached entry is only still
// valid while it points at the transcript the sessionMap currently holds —
// otherwise it is a tailer on a dead session's file and has to be replaced.
func (rg *registry) source(osUser, session string) (*sessionio.FileSource, bool) {
	us := rg.user(osUser)
	us.mu.Lock()
	defer us.mu.Unlock()
	info, ok := us.sm.Get(session)
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
		if ls.fs.Path() == info.Transcript {
			return ls.fs, true
		}
		ls.stop()
		delete(us.srcs, session)
	}
	ls := rg.start(session, info.Transcript, us.reader)
	us.srcs[session] = ls
	return ls.fs, true
}

// start builds a FileSource and runs its tail under a context of its own, so
// this one source can be stopped without taking down the rest of the process.
//
// The FIRST read of the transcript happens here, synchronously, before the
// source is handed to anyone. Left to the tail goroutine it raced every caller:
// a client that opened the stream in that window replayed an EMPTY log and then
// received the entire transcript through the live subscription instead — which
// is not a slow path but a wrong one, because the replay window (the last N
// turns) only governs the replay. Measured on a 20.8 MB transcript: 3,396
// events and 3.9 MB arrived on an open that should have carried 20 turns.
//
// The cost is that the first request for a session waits for its transcript to
// be parsed, once per session per process — the same work, moved to where its
// result is actually used.
func (rg *registry) start(session, transcript string, reader sessionio.Reader) *liveSource {
	ctx, stop := context.WithCancel(rg.ctx)
	fs := sessionio.NewFileSourceWith(session, transcript, rg.poll, reader)
	fs.TailOnce()
	done := make(chan struct{})
	go func() {
		defer close(done)
		fs.Run(ctx)
	}()
	return &liveSource{fs: fs, stop: stop, done: done}
}

// sessionStartBody is the SessionStart hook's payload.
type sessionStartBody struct {
	User        string `json:"user"`
	SessionID   string `json:"session_id"`
	CWD         string `json:"cwd"`
	TmuxSession string `json:"tmux_session"`
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
		if err := rg.user(b.User).sm.Put(sessionio.SessionInfo{
			TmuxSession: b.TmuxSession, CWD: b.CWD, ClaudeID: b.SessionID,
		}); err != nil {
			log.Printf("session-start %s/%s: %v", b.User, b.TmuxSession, err)
			http.Error(w, "cannot record session", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
