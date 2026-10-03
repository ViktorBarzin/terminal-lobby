package main

import (
	"context"
	"sync"
	"time"

	"terminal-lobby/sessionio"
)

// userState holds one OS user's session map and the readers for their files.
// The service runs as a privileged user but isolates each mapped user's files
// by absolute path under their home; there is no cross-user access path.
type userState struct {
	osUser string
	root   string // /home/<osUser>/.claude/projects
	sm     *sessionio.SessionMap
	mu     sync.Mutex

	// How this user's files are read. The service's own user is read directly;
	// everyone else goes through a child running as them, because a home is
	// 0750 and this process cannot open what is inside one. priv is nil for the
	// former and is the same object as reader for the latter — it is kept
	// separately because the slash-command catalogue is not a sessionio read.
	//
	// Since the mod (ADR-0036) no transcript is tailed. What is still read off
	// disk is read on demand: a picture by its row id, the agent files the
	// agent panel lists, and an agent's transcript a reader drills into.
	reader sessionio.Reader
	priv   *privReader
	// agents reaches the agent files beside each transcript, the same two ways:
	// LocalReader for the service's own user, priv for everyone else.
	agents sessionio.AgentReader
}

// liveSource is a session's event log plus the agent watch and drill-ins that
// run beside it. Its log is fed by the session's mod (mod.go); stopping it
// ends the watch and the drill-ins, and done is closed once they have
// returned.
type liveSource struct {
	fs *sessionio.FileSource
	// agents follows the session's subagents for the agent panel, under the
	// same context, so retiring the source stops it.
	agents *agentWatch
	// drills are the agent transcripts somebody opened from the panel
	// (drill.go), tailed under ctx like the rest.
	drills *drills
	ctx    context.Context
	stop   context.CancelFunc
	done   <-chan struct{} // closed once the agent watch has returned
}

// stampReader reads a tmux session option.
type stampReader interface {
	Option(osUser, session, name string) (string, bool)
}

// registry holds per-user state and finds a session's source through the mod
// hub.
type registry struct {
	mu       sync.Mutex
	users    map[string]*userState
	ctx      context.Context
	poll     time.Duration
	homeBase string // "/home" (overridable for tests)
	opts     sessionio.Options
	self     string // the OS user this process runs as

	// mods holds every Claude session's mod connection; the sources live
	// there.
	mods *modHub

	// now is the clock the drill sweep measures against. A seam so a test can
	// age a drill without waiting; production leaves it as time.Now.
	now func() time.Time
	// agentEvery is how often a watched session's agent files are listed,
	// AgentScanInterval outside tests.
	agentEvery time.Duration
	// prompts sends each first prompt's request id once (promptonce.go).
	prompts *promptOnce
}

func newRegistry(ctx context.Context, poll time.Duration, homeBase string, opts sessionio.Options, self string) *registry {
	rg := &registry{
		users: map[string]*userState{}, ctx: ctx,
		poll: poll, homeBase: homeBase, opts: opts, self: self,
		now: time.Now, agentEvery: AgentScanInterval,
		prompts: newPromptOnce(),
	}
	rg.mods = newModHub(rg, opts)
	return rg
}

func (rg *registry) user(osUser string) *userState {
	rg.mu.Lock()
	defer rg.mu.Unlock()
	us, ok := rg.users[osUser]
	if !ok {
		root := sessionio.ProjectsRoot(rg.homeBase, osUser)
		us = &userState{
			osUser: osUser, root: root,
			sm: sessionio.NewSessionMap(osUser, root, rg.opts),
		}
		if osUser == rg.self {
			us.reader = sessionio.LocalReader{}
			us.agents = sessionio.LocalReader{}
		} else {
			us.priv = newPrivReader(osUser)
			us.reader = us.priv
			us.agents = us.priv
		}
		rg.users[osUser] = us
	}
	return us
}

// source returns the event log of a session whose mod is connected.
// ok=false when no mod has said hello for it.
func (rg *registry) source(osUser, session string) (*sessionio.FileSource, bool) {
	ls, ok := rg.live(osUser, session)
	if !ok {
		return nil, false
	}
	return ls.fs, true
}

// live is source with everything the session's entry holds, for a handler that
// needs more than the log: the event stream takes the agent watch too, and
// serving one agent's transcript resolves it through the watch's listing.
func (rg *registry) live(osUser, session string) (*liveSource, bool) {
	return rg.mods.live(osUser, session)
}

// idleGrace is how long a drill-in with no readers is kept before its tail is
// stopped and its buffer released: long enough to cover a reload, short enough
// that an agent opened once is not still being read at the end of the day.
const idleGrace = 2 * time.Minute

// SweepInterval is how often the drill-ins and the mod connections are
// checked for readers and for life.
const SweepInterval = 5 * time.Second

// sweep retires drill-ins nobody reads and connections whose mod went quiet.
func (rg *registry) sweep() {
	rg.mods.sweep()
	rg.mods.mu.Lock()
	var lives []*liveSource
	for _, c := range rg.mods.bySID {
		c.mu.Lock()
		if c.ls != nil {
			lives = append(lives, c.ls)
		}
		c.mu.Unlock()
	}
	rg.mods.mu.Unlock()
	for _, ls := range lives {
		ls.drills.sweep(rg.now())
	}
}

// sweepEvery runs sweep on a ticker until ctx is done.
func (rg *registry) sweepEvery(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			rg.sweep()
		}
	}
}

// startMod builds the source a mod feeds and the session's agent watch, under
// a context of their own so this one session can be stopped without taking
// down the rest of the process. transcript is where Claude is writing, which
// the agent watch lists beside and pictures are read back from; "" until the
// mod can name it, which a later hello does (see modHub.hello).
func (rg *registry) startMod(session, transcript string, reader sessionio.Reader, agents sessionio.AgentReader) *liveSource {
	ctx, stop := context.WithCancel(rg.ctx)
	done := make(chan struct{})
	dir := ""
	if transcript != "" {
		dir = sessionio.SessionDir(transcript)
	}
	aw := newAgentWatch(dir, agents)
	aw.every = rg.agentEvery
	go func() {
		defer close(done)
		aw.run(ctx)
	}()
	fs := sessionio.NewModSource(session, transcript, reader)
	return &liveSource{fs: fs, agents: aw, drills: newDrills(), ctx: ctx, stop: stop, done: done}
}
