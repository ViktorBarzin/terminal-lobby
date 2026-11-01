package main

// T3 rows in the session list (docs/plans/2026-10-31-t3-hosts-claude-design.md,
// "The list", ADR-0046).
//
// Each lobby user has a `t3 serve` of their own, and the threads in it list
// beside the user's tmux sessions. tmux-api reads them in the background, for
// each user who has asked for the session list in the last two minutes: every
// ten seconds, t3_thread_list over T3's MCP endpoint, bounded at five seconds.
// buildSessionsBody appends the last good result, so a slow or stopped T3
// never holds up the list. A T3 that times out keeps its last rows for a
// minute; one that refuses, or whose sign-in fails, loses them at once, and its
// user's tmux sessions list as before.
//
// A row's name is a lobby alias (t3client.Alias), because T3's thread ids do
// not fit the session-name rule. The poller keeps the alias-to-thread map the
// T3 routes (t3_routes.go) resolve against.
//
// T3 rows are added to the GET /sessions body and nowhere else: the push
// sender reads userSessions, so lobby push never fires for a T3 thread
// (decision 14).

import (
	"context"
	"errors"
	"log"
	"net"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"time"

	"terminal-lobby/t3client"
)

const (
	t3PollInterval = 10 * time.Second
	t3PollTimeout  = 5 * time.Second
	// t3AskWindow is how long after a user's last session-list request their
	// T3 is still polled.
	t3AskWindow = 2 * time.Minute
	// t3StaleAfter is how long a T3 that keeps timing out still shows its
	// last good rows.
	t3StaleAfter = time.Minute
	// t3ProjectsTTL is how long the project list (for each row's workspace
	// root) is reused. A thread in a project the poller has not seen reads it
	// again at once.
	t3ProjectsTTL = 5 * time.Minute
	// backendT3 marks a T3 row on the wire.
	backendT3 = "t3"
)

// t3API is what the lobby asks of users' T3 servers. *t3client.Client
// provides it through t3ClientAPI; tests fake it.
type t3API interface {
	// HasT3 reports whether the user has a T3 server at all.
	HasT3(user string) bool
	Locate(ctx context.Context, user string) (t3client.Location, error)
	ListThreads(ctx context.Context, user string) ([]t3client.Thread, error)
	ListProjects(ctx context.Context, user string) ([]t3client.Project, error)
	ProjectForDir(ctx context.Context, user, dir string) (t3client.Project, error)
	Launch(ctx context.Context, user string, r t3client.LaunchRequest) (t3client.Launched, error)
	Rename(ctx context.Context, user, threadID, title string) error
	Archive(ctx context.Context, user, threadID string) error
}

// t3ClientAPI adapts *t3client.Client to t3API.
type t3ClientAPI struct{ *t3client.Client }

func (c t3ClientAPI) HasT3(user string) bool {
	_, err := c.Locator().BaseURL(user)
	return err == nil
}

func (c t3ClientAPI) Locate(ctx context.Context, user string) (t3client.Location, error) {
	return c.Locator().Locate(ctx, user)
}

// t3Snapshot is one user's last good poll.
type t3Snapshot struct {
	loc     t3client.Location
	threads []t3client.Thread
	// roots maps a project id to its workspace root.
	roots map[string]string
	at    time.Time
}

// t3Health is what the poller last logged about a user's T3, so it logs a
// change once rather than every ten seconds.
type t3Health string

const (
	t3OK   t3Health = "ok"
	t3Slow t3Health = "slow"
	t3Down t3Health = "down"
)

type t3UserState struct {
	asked   time.Time
	running bool
	kick    chan struct{}
	snap    *t3Snapshot
	roots   map[string]string
	rootsAt time.Time
	// launched holds threads started from the lobby that no poll has seen
	// yet, by alias, so a rename or archive right after New resolves.
	launched map[string]string
	health   t3Health
}

// t3Poller keeps each asking user's T3 threads. A nil *t3Poller is inert:
// no T3 rows, no aliases.
type t3Poller struct {
	api         t3API
	interval    time.Duration
	timeout     time.Duration
	window      time.Duration
	staleAfter  time.Duration
	projectsTTL time.Duration
	now         func() time.Time
	logf        func(format string, args ...any)
	// changed is told when a user's rows change, so their cached session
	// list is dropped and the change shows on the next request.
	changed func(user string)

	mu    sync.Mutex
	users map[string]*t3UserState
}

func newT3Poller(api t3API) *t3Poller {
	return &t3Poller{
		api:         api,
		interval:    t3PollInterval,
		timeout:     t3PollTimeout,
		window:      t3AskWindow,
		staleAfter:  t3StaleAfter,
		projectsTTL: t3ProjectsTTL,
		now:         time.Now,
		logf:        log.Printf,
		users:       map[string]*t3UserState{},
	}
}

// t3PollerInstance is nil until main wires it, so tests that never set it
// see no T3 rows.
var t3PollerInstance *t3Poller

// state returns the user's entry, creating it. Callers hold p.mu.
func (p *t3Poller) state(user string) *t3UserState {
	st, ok := p.users[user]
	if !ok {
		st = &t3UserState{health: t3OK}
		p.users[user] = st
	}
	return st
}

// has reports whether the user has a T3 server.
func (p *t3Poller) has(user string) bool {
	return p != nil && p.api.HasT3(user)
}

// touch records that the user asked for the session list, and starts their
// poll when it is not running. A user without a T3 server is ignored.
func (p *t3Poller) touch(user string) {
	if !p.has(user) {
		return
	}
	p.mu.Lock()
	st := p.state(user)
	st.asked = p.now()
	start := !st.running
	if start {
		st.running = true
		st.kick = make(chan struct{}, 1)
	}
	kick := st.kick
	p.mu.Unlock()
	if start {
		go p.loop(user, kick)
	}
}

// kick asks a running poll to read now rather than at its next tick.
func (p *t3Poller) kick(user string) {
	if p == nil {
		return
	}
	p.mu.Lock()
	st, ok := p.users[user]
	var kick chan struct{}
	if ok && st.running {
		kick = st.kick
	}
	p.mu.Unlock()
	if kick != nil {
		select {
		case kick <- struct{}{}:
		default:
		}
	}
}

// polling reports whether the user's poll is running.
func (p *t3Poller) polling(user string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	st, ok := p.users[user]
	return ok && st.running
}

func (p *t3Poller) loop(user string, kick chan struct{}) {
	timer := time.NewTimer(p.interval)
	defer timer.Stop()
	for {
		p.poll(user)
		if !p.stillAsked(user) {
			return
		}
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(p.interval)
		select {
		case <-timer.C:
		case <-kick:
		}
		if !p.stillAsked(user) {
			return
		}
	}
}

// stillAsked reports whether the user asked within the window, and marks
// the poll stopped when not, under one lock so a touch racing the stop
// starts a fresh poll.
func (p *t3Poller) stillAsked(user string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	st := p.state(user)
	if p.now().Sub(st.asked) > p.window {
		st.running = false
		return false
	}
	return true
}

// poll reads the user's threads once and applies the result.
func (p *t3Poller) poll(user string) {
	ctx, cancel := context.WithTimeout(context.Background(), p.timeout)
	defer cancel()

	loc, err := p.api.Locate(ctx, user)
	var threads []t3client.Thread
	if err == nil {
		threads, err = p.api.ListThreads(ctx, user)
	}

	p.mu.Lock()
	st := p.state(user)
	roots, rootsAt := st.roots, st.rootsAt
	p.mu.Unlock()
	if err == nil && p.needRoots(threads, roots, rootsAt) {
		// A failed project list costs the rows their grouping, not the rows.
		if ps, perr := p.api.ListProjects(ctx, user); perr == nil {
			roots = make(map[string]string, len(ps))
			for _, pr := range ps {
				roots[pr.ID] = pr.WorkspaceRoot
			}
			rootsAt = p.now()
		}
	}

	p.mu.Lock()
	now := p.now()
	prev := st.snap
	health := t3OK
	switch {
	case err == nil:
		st.snap = &t3Snapshot{loc: loc, threads: threads, roots: roots, at: now}
		st.roots, st.rootsAt = roots, rootsAt
		for _, t := range threads {
			delete(st.launched, t3client.Alias(t.ThreadID))
		}
	case isTimeout(err) && prev != nil && now.Sub(prev.at) < p.staleAfter:
		health = t3Slow
	default:
		health = t3Down
		st.snap = nil
		st.launched = nil
	}
	logChange := health != st.health
	st.health = health
	changed := !sameSnapshot(prev, st.snap)
	p.mu.Unlock()

	if logChange {
		switch health {
		case t3OK:
			p.logf("t3: %s's T3 is answering again", user)
		case t3Slow:
			p.logf("t3: %s's T3 timed out (%v); showing its last rows for up to %v", user, err, p.staleAfter)
		case t3Down:
			p.logf("t3: %s's T3 rows are left out: %v", user, err)
		}
	}
	if changed && p.changed != nil {
		p.changed(user)
	}
}

// needRoots reports whether the project list should be read again.
func (p *t3Poller) needRoots(threads []t3client.Thread, roots map[string]string, at time.Time) bool {
	if roots == nil || p.now().Sub(at) > p.projectsTTL {
		return true
	}
	for _, t := range threads {
		if _, ok := roots[t.ProjectID]; !ok && t.ProjectID != "" {
			return true
		}
	}
	return false
}

func isTimeout(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

func sameSnapshot(a, b *t3Snapshot) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.loc == b.loc && reflect.DeepEqual(a.threads, b.threads) && reflect.DeepEqual(a.roots, b.roots)
}

// threadFor resolves a T3 row's alias to its thread id.
func (p *t3Poller) threadFor(user, alias string) (string, bool) {
	if p == nil || !t3client.IsAlias(alias) {
		return "", false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	st, ok := p.users[user]
	if !ok {
		return "", false
	}
	if id, ok := st.launched[alias]; ok {
		return id, true
	}
	if st.snap != nil {
		for _, t := range st.snap.threads {
			if t3client.Alias(t.ThreadID) == alias {
				return t.ThreadID, true
			}
		}
	}
	return "", false
}

// remember records a thread the lobby just launched, so its alias resolves
// before the next poll lists it.
func (p *t3Poller) remember(user, threadID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	st := p.state(user)
	if st.launched == nil {
		st.launched = map[string]string{}
	}
	st.launched[t3client.Alias(threadID)] = threadID
}

// retitle applies a rename to the snapshot, so the list shows it before
// the next poll.
func (p *t3Poller) retitle(user, threadID, title string) {
	p.editThreads(user, func(ts []t3client.Thread) []t3client.Thread {
		out := append([]t3client.Thread(nil), ts...)
		for i := range out {
			if out[i].ThreadID == threadID {
				out[i].Title = title
			}
		}
		return out
	})
}

// forget drops an archived thread from the snapshot.
func (p *t3Poller) forget(user, threadID string) {
	p.editThreads(user, func(ts []t3client.Thread) []t3client.Thread {
		out := make([]t3client.Thread, 0, len(ts))
		for _, t := range ts {
			if t.ThreadID != threadID {
				out = append(out, t)
			}
		}
		return out
	})
	p.mu.Lock()
	if st, ok := p.users[user]; ok {
		delete(st.launched, t3client.Alias(threadID))
	}
	p.mu.Unlock()
}

func (p *t3Poller) editThreads(user string, fn func([]t3client.Thread) []t3client.Thread) {
	p.mu.Lock()
	defer p.mu.Unlock()
	st, ok := p.users[user]
	if !ok || st.snap == nil {
		return
	}
	snap := *st.snap
	snap.threads = fn(snap.threads)
	st.snap = &snap
}

// rows is the user's T3 rows from the last good poll, grouped against their
// layout's projects. Nil when there is no poll result.
func (p *t3Poller) rows(user string, projects []Project) []Session {
	if p == nil {
		return nil
	}
	p.mu.Lock()
	var snap *t3Snapshot
	if st, ok := p.users[user]; ok {
		snap = st.snap
	}
	p.mu.Unlock()
	if snap == nil {
		return nil
	}
	return t3Rows(user, snap, projects)
}

// t3Rows maps a snapshot onto session rows. Pure.
//
// The row carries what the sidebar reads off a tmux row: a title, a state, the
// Claude mark, created and last-used times for sorting and the relative time,
// and `user` as its origin, since a person's own T3 thread belongs in the
// person's own list rather than in System. Project is the layout project whose
// directory holds the thread's workspace root, so a thread lands beside the
// tmux sessions of the same repository; the layout still wins wherever it
// places the alias itself.
func t3Rows(osUser string, snap *t3Snapshot, projects []Project) []Session {
	out := make([]Session, 0, len(snap.threads))
	for _, t := range snap.threads {
		created := t3Time(t.CreatedAt)
		updated := t3Time(t.UpdatedAt)
		if updated == 0 {
			updated = created
		}
		root := snap.roots[t.ProjectID]
		out = append(out, Session{
			Name:         t3client.Alias(t.ThreadID),
			Title:        t.Title,
			State:        t.LobbyState(),
			Tool:         "claude",
			Owner:        osUser,
			Origin:       originUser,
			Project:      layoutProjectFor(root, projects),
			Cwd:          root,
			Created:      created,
			LastActivity: updated,
			LastDrive:    updated,
			Backend:      backendT3,
			T3ThreadID:   t.ThreadID,
			URL:          snap.loc.WebURL(t.ThreadID),
			AppURL:       snap.loc.AppURL(t.ThreadID),
		})
	}
	return out
}

// t3Time reads T3's ISO timestamps as unix seconds, 0 when unreadable.
func t3Time(s string) int64 {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return 0
	}
	return t.Unix()
}

// layoutProjectFor is the layout project a workspace root belongs to: the
// one whose directory is the root, else the deepest one whose directory holds
// it. "" when none does.
func layoutProjectFor(root string, projects []Project) string {
	if root == "" {
		return ""
	}
	root = filepath.Clean(root)
	best, bestLen := "", -1
	for _, p := range projects {
		if p.Dir == "" {
			continue
		}
		d := filepath.Clean(p.Dir)
		if d == root {
			return p.Name
		}
		if strings.HasPrefix(root, strings.TrimSuffix(d, "/")+"/") && len(d) > bestLen {
			best, bestLen = p.Name, len(d)
		}
	}
	return best
}

// t3RowsFor is the user's T3 rows for the session list, grouped against
// their layout. A layout that cannot be read leaves the rows ungrouped.
func t3RowsFor(osUser string) []Session {
	if t3PollerInstance == nil {
		return nil
	}
	var projects []Project
	if l, err := layoutStoreInstance.load(osUser); err == nil {
		projects = l.Projects
	}
	return t3PollerInstance.rows(osUser, projects)
}
