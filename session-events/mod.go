package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"terminal-lobby/sessionio"
	"terminal-lobby/telemetry"
)

// The server side of the lobby's Claude Code mod (ADR-0036).
//
// Every interactive Claude on the box loads the mod. It says hello once, posts
// what happens in the session as events, and long-polls here for commands.
// This file holds those three routes and the per-session connection behind
// them: the event log the Text view reads, the tmux options the sidebar reads,
// the dialog waiting on a person, and the commands waiting for the mod.

// modPollHold is how long a poll is held open. Claude Code caps a mod's fetch
// at 30 s, so the answer has to leave well inside that.
const modPollHold = 25 * time.Second

// modExpiry is how long a connection lives without hearing from its mod. A mod
// polls every modPollHold, so three missed polls means the Claude is gone
// (killed, or the pane closed) without a bye.
const modExpiry = 90 * time.Second

// modLiveGap is how long a mod holding no poll can stay silent and still count
// as connected for the agent API (modConn.alive). A live mod polls again the
// moment a poll returns, so a gap this long means its Claude is gone, well
// before modExpiry drops the connection.
const modLiveGap = 10 * time.Second

// modEventsLimit bounds one events request. A history event carries a whole
// conversation's text, which runs to megabytes on a long session.
const modEventsLimit = 64 << 20

// modFollowWait bounds how long opening a renamed session's stream waits for
// its mod to say hello under the new name. The mod's held poll answers at
// once, so the hello normally lands in well under a second.
const modFollowWait = 5 * time.Second

// modAckWait bounds how long a route waits for the mod to act on a command.
const modAckWait = 10 * time.Second

var (
	modSidRe     = regexp.MustCompile(`^[0-9a-fA-F-]{8,64}$`)
	modSessionRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	modPaneRe    = regexp.MustCompile(`^%[0-9]{1,8}$`)
)

// modHello is the mod's first request.
type modHello struct {
	SID        string `json:"sid"`
	Pane       string `json:"pane"`
	Tmux       string `json:"tmux"`
	Session    string `json:"session"`
	CWD        string `json:"cwd"`
	Transcript string `json:"transcript"`
	Model      string `json:"model"`
	Version    string `json:"version"`
	Mod        string `json:"mod"`
}

// modCommand is one command for the mod. One struct for every op.
type modCommand struct {
	Op          string            `json:"op"`
	ID          string            `json:"id"`
	Text        string            `json:"text,omitempty"`
	ToolID      string            `json:"toolId,omitempty"`
	Answers     map[string]string `json:"answers,omitempty"`
	Annotations json.RawMessage   `json:"annotations,omitempty"`
	Chat        *string           `json:"chat,omitempty"`
	Decision    string            `json:"decision,omitempty"`
	Reason      string            `json:"reason,omitempty"`
	Model       string            `json:"model,omitempty"`
	Effort      string            `json:"effort,omitempty"`
}

// modAck is the mod's answer to a command.
type modAck struct {
	OK    bool
	Error string
}

// modDialog is a dialog a session is waiting on a person for, with what it
// shows: enough for a program to read it without the pane.
type modDialog struct {
	kind      string // "ask", "plan" or "permission"
	toolID    string
	questions []heldQuestion
	raw       json.RawMessage // the questions exactly as asked

	plan, planFilePath string // a plan's text and file

	tool, title, reason string   // a permission prompt's tool, heading and why it asks
	detail              []string // what the tool will do
}

// modConn is one Claude session's link to its mod.
type modConn struct {
	hub  *modHub
	user string
	sid  string

	mu         sync.Mutex
	session    string
	pane       string
	transcript string
	token      string
	ls         *liveSource
	cmds       []modCommand
	// inflight are commands a poll has handed over and the mod has not acked.
	// A reload can take a module away with a command in hand, so they go out
	// again to the module that says hello next.
	inflight map[string]modCommand
	wake     chan struct{}
	acks     map[string]chan modAck
	// dialogs open, oldest first. Claude asks several questions at once more
	// often than not, and a subagent's prompt can open beside the main one.
	dialogs  []*modDialog
	st       stampState
	lastSeen time.Time
	nextID   int
	// polls is how many of this mod's polls are held right now. A poll ends
	// with its connection when the Claude dies, so a held poll is the one
	// reading that says the process is still there.
	polls int
}

// alive reports whether the mod is still there to keep the session's state
// current: a poll is held, or it was heard from within modLiveGap.
//
// Registered is not enough. Measured live on 2026-10-02 (rv-par-6): the idle
// sweep killed a Claude, its mod said a last hello on the way out, and the
// connection stayed registered for over a minute while the resumed Claude in
// the same session had no mod at all. The agent API read that as a mod with
// nothing open and trusted the stale "done" the resume put back.
func (c *modConn) alive(now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.polls > 0 || now.Sub(c.lastSeen) < modLiveGap
}

// modHub holds every connection, by token, by Claude session and by tmux
// session.
type modHub struct {
	rg    *registry
	stamp sessionio.Options
	// unset clears tmux options; nil in tests that do not care.
	unset func(osUser, session string, names []string) error
	// paneSession names the tmux session a pane is in now, "" when the pane
	// is gone; nil in tests that do not care. A write that fails on the
	// name the mod said hello with asks it, because tmux-api renames a
	// session from its first turn and the mod only notices at its next
	// turn start.
	paneSession func(osUser, pane string) string
	// sessionPanes lists the panes in a tmux session; nil in tests that do
	// not care. A stream opened on a name no mod said hello with asks it, so
	// a session renamed after its last turn is followed (follow).
	sessionPanes func(osUser, session string) []string
	// paneProcs lists each pane's foreground command and start command; nil
	// in tests that do not care. It tells a starting Claude from a shell and
	// from one that exited (whyNoStream).
	paneProcs func(osUser, session string) []paneProc
	now       func() time.Time

	mu        sync.Mutex
	byToken   map[string]*modConn
	bySID     map[string]*modConn // user\x00sid
	bySession map[string]*modConn // user\x00session
	// waiting are streams opened on a session before its mod said hello
	// (the "nomod" frame), closed when one does.
	waiting map[string][]chan struct{}
	// greeted are the OS users some mod has said hello for, which is the
	// evidence that a restarted Claude of theirs will load one.
	greeted map[string]bool
}

func newModHub(rg *registry, stamp sessionio.Options) *modHub {
	return &modHub{
		rg: rg, stamp: stamp, now: time.Now,
		byToken: map[string]*modConn{}, bySID: map[string]*modConn{},
		bySession: map[string]*modConn{}, waiting: map[string][]chan struct{}{},
		greeted: map[string]bool{},
	}
}

// hasGreeted reports whether any mod has said hello for the user since this
// process started.
func (h *modHub) hasGreeted(osUser string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.greeted[osUser]
}

func hubKey(a, b string) string { return a + "\x00" + b }

func newToken() string {
	var b [24]byte
	if _, err := rand.Read(b[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return hex.EncodeToString(b[:])
}

// conn is the connection serving a tmux session, nil when its Claude has no
// mod talking to the lobby.
func (h *modHub) conn(osUser, session string) *modConn {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.bySession[hubKey(osUser, session)]
}

// live is the mod-fed source for a tmux session.
func (h *modHub) live(osUser, session string) (*liveSource, bool) {
	c := h.conn(osUser, session)
	if c == nil {
		return nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ls, c.ls != nil
}

// follow is live for a session no mod said hello with yet, when the Claude
// in one of its panes said hello under another name: tmux-api's autotitle
// renamed the session after the mod's last write, and the mod learns new
// names only at a turn start or a refused request. Its token is revoked so its
// held poll is refused and it says hello under the new name, and follow waits
// up to `wait` for that. A session no mod's pane is in returns at once.
func (h *modHub) follow(ctx context.Context, osUser, session string, wait time.Duration) (*liveSource, bool) {
	if ls, ok := h.live(osUser, session); ok {
		return ls, true
	}
	if h.sessionPanes == nil {
		return nil, false
	}
	panes := h.sessionPanes(osUser, session)
	if len(panes) == 0 {
		return nil, false
	}
	in := make(map[string]bool, len(panes))
	for _, p := range panes {
		in[p] = true
	}
	type found struct {
		c             *modConn
		session, pane string
	}
	var cands []found
	h.mu.Lock()
	for _, c := range h.bySID {
		if c.user != osUser {
			continue
		}
		c.mu.Lock()
		if in[c.pane] && c.session != session {
			cands = append(cands, found{c, c.session, c.pane})
		}
		c.mu.Unlock()
	}
	h.mu.Unlock()
	if len(cands) == 0 {
		return nil, false
	}
	hello, stop := h.awaitHello(osUser, session)
	defer stop()
	asked := false
	for _, f := range cands {
		if f.c.followRename(osUser, f.session, f.pane) == session {
			asked = true
		}
	}
	if !asked {
		return h.live(osUser, session)
	}
	t := time.NewTimer(wait)
	defer t.Stop()
	select {
	case <-hello:
	case <-t.C:
	case <-ctx.Done():
	}
	return h.live(osUser, session)
}

// connFollow is conn for a session renamed under its mod, by way of follow:
// the mod in the session's pane is asked to say hello under the new name, and
// the connection is returned once it has. Measured live on 2026-10-02: a
// permission prompt opened in a conversation's first turn, autotitle renamed
// the session, and the dialog routes answered 404 under the new name, so the
// agent API could neither read nor answer the prompt. A session no mod's pane
// is in returns nil at once.
func (h *modHub) connFollow(ctx context.Context, osUser, session string) *modConn {
	if _, ok := h.follow(ctx, osUser, session, modFollowWait); !ok {
		return nil
	}
	return h.conn(osUser, session)
}

// awaitHello returns a channel closed once a mod says hello for the session,
// and a func that stops waiting.
func (h *modHub) awaitHello(osUser, session string) (<-chan struct{}, func()) {
	ch := make(chan struct{})
	k := hubKey(osUser, session)
	h.mu.Lock()
	h.waiting[k] = append(h.waiting[k], ch)
	h.mu.Unlock()
	return ch, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		list := h.waiting[k]
		for i, c := range list {
			if c == ch {
				h.waiting[k] = append(list[:i], list[i+1:]...)
				break
			}
		}
		if len(h.waiting[k]) == 0 {
			delete(h.waiting, k)
		}
	}
}

// handleHello serves POST /mod/v1/hello.
func (h *modHub) handleHello() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b modHello
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, hookBodyLimit)).Decode(&b) != nil ||
			!modSidRe.MatchString(b.SID) || !modSessionRe.MatchString(b.Session) || !modPaneRe.MatchString(b.Pane) {
			http.Error(w, "bad body (need sid, session, pane)", http.StatusBadRequest)
			return
		}
		who, err := peerUser(r)
		if err != nil {
			log.Printf("mod hello for %s: cannot identify the caller: %v", b.Session, err)
			http.Error(w, "cannot identify the calling account", http.StatusForbidden)
			return
		}
		token, history := h.hello(who, b)
		writeJSON(w, map[string]any{"token": token, "history": history})
	}
}

// hello registers a mod and returns its token, and whether it should send the
// session's history because this process holds no log for it.
func (h *modHub) hello(osUser string, b modHello) (string, bool) {
	us := h.rg.user(osUser)
	// tmux-persist, suspend and the agent API read @claude_transcript to know
	// which conversation a tmux session holds, so the mod's hello keeps it
	// stamped as the SessionStart hook did.
	if b.Transcript != "" {
		if err := us.sm.Put(sessionio.SessionInfo{TmuxSession: b.Session, CWD: b.CWD,
			ClaudeID: b.SID, Transcript: b.Transcript}); err != nil {
			log.Printf("mod hello %s/%s: transcript stamp: %v", osUser, b.Session, err)
			b.Transcript = ""
		}
	}

	h.mu.Lock()
	h.greeted[osUser] = true
	c := h.bySID[hubKey(osUser, b.SID)]
	history := false
	var retired *liveSource
	if c == nil {
		c = &modConn{hub: h, user: osUser, sid: b.SID, wake: make(chan struct{}, 1),
			acks: map[string]chan modAck{}, inflight: map[string]modCommand{}}
		h.bySID[hubKey(osUser, b.SID)] = c
		history = true
	}
	c.mu.Lock()
	if c.token != "" {
		delete(h.byToken, c.token)
	}
	c.token = newToken()
	h.byToken[c.token] = c
	// Commands the previous module took and never acked go to this one,
	// ahead of anything queued since. Only those a route still waits on.
	var again []modCommand
	for id, cmd := range c.inflight {
		if _, waiting := c.acks[id]; waiting {
			again = append(again, cmd)
		}
	}
	sort.Slice(again, func(i, j int) bool { return cmdSeq(again[i].ID) < cmdSeq(again[j].ID) })
	c.inflight = map[string]modCommand{}
	if len(again) > 0 {
		c.cmds = append(again, c.cmds...)
		select {
		case c.wake <- struct{}{}:
		default:
		}
	}
	if c.session != b.Session {
		if c.session != "" && h.bySession[hubKey(osUser, c.session)] == c {
			delete(h.bySession, hubKey(osUser, c.session))
			// Renamed: streams on the old name end, so readers reconnect.
			retired = c.ls
			c.ls = nil
		}
		c.session = b.Session
	}
	// Another Claude that held this tmux session before is over.
	if prev := h.bySession[hubKey(osUser, b.Session)]; prev != nil && prev != c {
		h.dropLocked(prev)
	}
	h.bySession[hubKey(osUser, b.Session)] = c
	// The first hello comes before Claude has written its transcript, and the
	// mod says hello again naming it once the first row lands. The source
	// built on the first one kept an empty path for the life of the session,
	// so no picture could be read back, a subagent's included, and the agent
	// panel had no directory to list: a phone re-rendering 34 such pictures
	// drew 421 404s and the edge banned it (2026-10-03). The log is kept.
	if c.ls != nil && b.Transcript != "" && c.ls.fs.Path() != b.Transcript {
		c.ls.fs.SetPath(b.Transcript)
		c.ls.agents.SetDir(sessionio.SessionDir(b.Transcript))
	}
	c.pane, c.transcript = b.Pane, b.Transcript
	if c.ls == nil {
		c.ls = h.rg.startMod(b.Session, b.Transcript, us.reader, us.agents)
		if !history {
			// A rename keeps the conversation but not this process's log of
			// it under the old name, so the new source asks for history.
			history = true
		}
	}
	c.lastSeen = h.now()
	token := c.token
	c.mu.Unlock()
	for _, ch := range h.waiting[hubKey(osUser, b.Session)] {
		close(ch)
	}
	delete(h.waiting, hubKey(osUser, b.Session))
	h.mu.Unlock()
	if retired != nil {
		retired.stop()
		retired.fs.Close()
		retired.drills.close()
	}
	events.Emit("mod.hello", osUser, telemetry.Attrs{
		"tl.session": b.Session, "tl.version": b.Version, "tl.mod": b.Mod, "tl.history": history,
	})
	return token, history
}

// dropLocked forgets a connection and ends its streams. Caller holds h.mu.
func (h *modHub) dropLocked(c *modConn) {
	c.mu.Lock()
	delete(h.byToken, c.token)
	if h.bySID[hubKey(c.user, c.sid)] == c {
		delete(h.bySID, hubKey(c.user, c.sid))
	}
	if h.bySession[hubKey(c.user, c.session)] == c {
		delete(h.bySession, hubKey(c.user, c.session))
	}
	ls := c.ls
	c.ls = nil
	for id, ch := range c.acks {
		close(ch)
		delete(c.acks, id)
	}
	c.mu.Unlock()
	if ls != nil {
		ls.stop()
		ls.fs.Close()
		ls.drills.close()
	}
}

// byTokenOf finds the connection a request's token names and marks it seen.
func (h *modHub) byTokenOf(token string) *modConn {
	h.mu.Lock()
	defer h.mu.Unlock()
	c := h.byToken[token]
	if c != nil {
		c.mu.Lock()
		c.lastSeen = h.now()
		c.mu.Unlock()
	}
	return c
}

// handleEvents serves POST /mod/v1/events.
func (h *modHub) handleEvents() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Events are decoded one at a time. The mod resends a refused batch
		// until it is taken and holds everything after it, so one event this
		// build cannot read would otherwise stop the session's log for good.
		var b struct {
			Token  string            `json:"token"`
			Events []json.RawMessage `json:"events"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, modEventsLimit)).Decode(&b); err != nil {
			log.Printf("mod events: refused a batch: %v", err)
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		c := h.byTokenOf(b.Token)
		if c == nil {
			// This process restarted, or the session was dropped: the mod
			// says hello again.
			http.Error(w, "unknown token", http.StatusConflict)
			return
		}
		evs := make([]sessionio.ModEvent, 0, len(b.Events))
		for _, raw := range b.Events {
			var ev sessionio.ModEvent
			if err := json.Unmarshal(raw, &ev); err != nil {
				var head struct {
					Type string `json:"type"`
				}
				_ = json.Unmarshal(raw, &head)
				c.mu.Lock()
				who := c.user + "/" + c.session
				c.mu.Unlock()
				log.Printf("mod %s: skipped a %q event this build cannot read (%d bytes): %v", who, head.Type, len(raw), err)
				continue
			}
			evs = append(evs, ev)
		}
		c.apply(evs)
		w.WriteHeader(http.StatusNoContent)
	}
}

// apply feeds a batch of events to the session: the log, the dialog and the
// tmux options. The option writes are merged across the batch so a burst of
// events costs one tmux call.
func (c *modConn) apply(evs []sessionio.ModEvent) {
	h := c.hub
	c.mu.Lock()
	ls := c.ls
	c.mu.Unlock()
	if ls == nil {
		return
	}
	fs := ls.fs
	var merged stampWrite
	from := ""
	first := true
	bye := false
	for _, ev := range evs {
		if modOwnDialog(ev) {
			continue
		}
		switch ev.Type {
		case sessionio.ModHistoryEvent:
			// Only the last chunk of a long history may close the last turn.
			fs.FeedHistory(ev.Messages, ev.Running || ev.More)
			continue
		case sessionio.ModAckEvent:
			c.deliver(ev.ID, modAck{OK: ev.OK, Error: ev.Error})
			continue
		case sessionio.ModAskEvent, sessionio.ModPlanEvent, sessionio.ModPermissionEvent:
			if ev.AgentID == "" {
				c.openDialog(fs, ev)
			}
		case sessionio.ModSettledEvent:
			c.closeDialog(fs, ev.ToolID)
		case sessionio.ModTurnEndEvent:
			if ev.AgentID == "" {
				c.closeDialog(fs, "")
			}
		case sessionio.ModByeEvent:
			c.closeDialog(fs, "")
			bye = true
		}
		fs.Feed(ev)
		c.mu.Lock()
		w := c.st.apply(ev, h.now())
		c.mu.Unlock()
		if first && w.from != w.to {
			from, first = w.from, false
		}
		merged = mergeWrites(merged, w)
	}
	if !first {
		merged.from = from
	}
	c.write(merged)
	if bye {
		h.mu.Lock()
		h.dropLocked(c)
		h.mu.Unlock()
	}
}

// pluginToolPrefix starts the id of a tool call a plugin made rather than the
// model: the mod's own Allow / Deny and plan dialogs are AskUserQuestion calls
// of this kind, drawn by $.ui.ask.
const pluginToolPrefix = "toolu_plugin_"

// modOwnDialog reports an event about the mod's own dialog. The dialog stands
// for a plan approval or a permission prompt the session already has on the
// wire, so it is not a question of its own.
func modOwnDialog(ev sessionio.ModEvent) bool {
	switch ev.Type {
	case sessionio.ModAskEvent, sessionio.ModSettledEvent, sessionio.ModResultEvent:
		return strings.HasPrefix(ev.ToolID, pluginToolPrefix)
	}
	return false
}

// mergeWrites folds b over a: a later set or unset of a name wins.
func mergeWrites(a, b stampWrite) stampWrite {
	for _, name := range b.unset {
		delete(a.set, name)
		if !containsStr(a.unset, name) {
			a.unset = append(a.unset, name)
		}
	}
	for name, v := range b.set {
		a.put(name, v)
		for i, u := range a.unset {
			if u == name {
				a.unset = append(a.unset[:i], a.unset[i+1:]...)
				break
			}
		}
	}
	if b.to != "" || b.from != "" {
		a.to = b.to
	}
	return a
}

func containsStr(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// write applies option changes to the tmux session and records a state
// transition the way the hook script did.
//
// A write that fails because the session was renamed under the mod is made
// again under the name the mod's pane has now, and the mod is asked to say
// hello again so everything else moves too (followRename).
func (c *modConn) write(w stampWrite) {
	if w.empty() {
		return
	}
	h := c.hub
	c.mu.Lock()
	user, session, pane := c.user, c.session, c.pane
	c.mu.Unlock()
	followed := false
	follow := func() bool {
		if followed {
			return false
		}
		followed = true
		if moved := c.followRename(user, session, pane); moved != "" {
			session = moved
			return true
		}
		return false
	}
	if h.stamp != nil && len(w.set) > 0 {
		name, err := c.setAll(user, session, w.set)
		if err != nil && follow() {
			name, err = c.setAll(user, session, w.set)
		}
		if err != nil {
			log.Printf("mod %s/%s: set %s: %v", user, session, name, err)
		}
	}
	if h.unset != nil && len(w.unset) > 0 {
		err := h.unset(user, session, w.unset)
		if err != nil && follow() {
			err = h.unset(user, session, w.unset)
		}
		if err != nil {
			log.Printf("mod %s/%s: unset %v: %v", user, session, w.unset, err)
		}
	}
	if st, ok := w.set[sessionio.OptionState]; ok && st != w.from {
		events.Emit("claude.state_changed", user, telemetry.Attrs{
			"tl.session": session, "tl.from": orNone(w.from), "tl.to": st, "tl.client": "mod",
		})
	}
}

// setAll stamps every option, stopping at the first failure: a session that
// cannot take one cannot take the rest. It returns the name that failed.
func (c *modConn) setAll(user, session string, set map[string]string) (string, error) {
	for name, v := range set {
		if err := c.hub.stamp.SetOption(user, session, name, v); err != nil {
			return name, err
		}
	}
	return "", nil
}

// followRename finds the session the mod's pane is in now, and returns its
// name when that is not the one the mod said hello with. The mod's token is
// revoked so its next request is refused and it says hello again; the hello
// then moves the connection, its stream and its transcript stamp to the new
// name, which is the path a rename noticed at turn start already takes. ""
// when the pane is gone or the name has not changed.
func (c *modConn) followRename(user, session, pane string) string {
	h := c.hub
	if h.paneSession == nil || pane == "" {
		return ""
	}
	now := h.paneSession(user, pane)
	if now == "" || now == session || !modSessionRe.MatchString(now) {
		return ""
	}
	h.mu.Lock()
	c.mu.Lock()
	revoked := false
	if c.session == session && c.token != "" {
		delete(h.byToken, c.token)
		c.token = ""
		revoked = true
	}
	wake := c.wake
	c.mu.Unlock()
	h.mu.Unlock()
	if revoked {
		select {
		case wake <- struct{}{}:
		default:
		}
		log.Printf("mod %s/%s: the session is now %s; asking the mod to say hello again", user, session, now)
	}
	return now
}

func orNone(s string) string {
	if s == "" {
		return "none"
	}
	return s
}

// openDialog records a dialog waiting on a person and puts it on the wire in
// the shape the Text view's cards already read: a held call for a question
// (ADR-0034's `held`), a reading for a plan or a permission prompt (`asking`).
func (c *modConn) openDialog(fs *sessionio.FileSource, ev sessionio.ModEvent) {
	d := &modDialog{toolID: ev.ToolID}
	switch ev.Type {
	case sessionio.ModAskEvent:
		d.kind, d.raw = "ask", ev.Questions
		_ = json.Unmarshal(ev.Questions, &d.questions)
	case sessionio.ModPlanEvent:
		d.kind, d.plan, d.planFilePath = "plan", ev.Plan, ev.PlanFilePath
	case sessionio.ModPermissionEvent:
		d.kind, d.tool, d.reason = "permission", ev.Tool, ev.Reason
		d.title, d.detail = permissionTitle(ev.Tool), permissionDetail(ev.Input)
	default:
		return
	}
	c.mu.Lock()
	c.dialogs = append(withoutDialog(c.dialogs, d.toolID), d)
	c.mu.Unlock()
	c.showDialogs(fs)
}

// closeDialog takes a dialog off the wire, and the next one of its kind takes
// its place. An empty toolID closes every open dialog.
func (c *modConn) closeDialog(fs *sessionio.FileSource, toolID string) {
	c.mu.Lock()
	if toolID == "" {
		c.dialogs = nil
	} else {
		c.dialogs = withoutDialog(c.dialogs, toolID)
	}
	c.mu.Unlock()
	c.showDialogs(fs)
}

func withoutDialog(ds []*modDialog, toolID string) []*modDialog {
	kept := ds[:0:0]
	for _, d := range ds {
		if d.toolID != toolID {
			kept = append(kept, d)
		}
	}
	return kept
}

// showDialogs puts the open dialogs on the wire in the shapes the Text view's
// cards already read: the held calls for questions (ADR-0034's `held`, oldest
// first, the card answers the first), and a reading for the oldest plan or
// permission prompt (`asking`). The source skips a body it already sent.
func (c *modConn) showDialogs(fs *sessionio.FileSource) {
	c.mu.Lock()
	var calls []map[string]json.RawMessage
	var first json.RawMessage
	var asking *modDialog
	for _, d := range c.dialogs {
		switch {
		case d.kind == "ask":
			if first == nil {
				first = d.raw
			}
			calls = append(calls, map[string]json.RawMessage{"questions": d.raw})
		case asking == nil:
			asking = d
		}
	}
	c.mu.Unlock()
	held := ""
	if first != nil {
		body, _ := json.Marshal(map[string]any{"questions": first, "calls": calls})
		held = string(body)
	}
	fs.SetHeld(held)
	reading := ""
	switch {
	case asking == nil:
	case asking.kind == "plan":
		body, _ := json.Marshal(sessionio.Dialog{
			Kind:        sessionio.DialogKindPlan,
			Options:     []sessionio.PlanOption{{Number: 1, Label: "Yes, approve the plan"}},
			FeedbackRow: 2, PlanPath: asking.planFilePath,
		})
		reading = string(body)
	default:
		body, _ := json.Marshal(sessionio.Dialog{
			Kind: sessionio.DialogKindPermission, Title: asking.title,
			Detail: asking.detail, Prompt: "Do you want to proceed?",
			Options: []sessionio.PlanOption{{Number: 1, Label: "Yes"}, {Number: 2, Label: "No"}},
		})
		reading = string(body)
	}
	fs.SetAsking(reading)
}

// permissionTitle is the card's heading for a tool, in the words Claude's own
// prompt uses for the common ones.
func permissionTitle(tool string) string {
	switch tool {
	case "Bash":
		return "Bash command"
	case "Edit", "MultiEdit":
		return "Edit file"
	case "Write":
		return "Create file"
	case "Read":
		return "Read file"
	case "WebFetch":
		return "Fetch"
	}
	return tool
}

// permissionDetail is what the tool will do, as a few lines: the command, the
// file, or failing those the input's fields.
func permissionDetail(input json.RawMessage) []string {
	var in map[string]any
	if json.Unmarshal(input, &in) != nil {
		return nil
	}
	for _, k := range []string{"command", "file_path", "url", "path", "pattern"} {
		if s, ok := in[k].(string); ok && s != "" {
			lines := strings.Split(s, "\n")
			if d, ok := in["description"].(string); ok && d != "" {
				lines = append(lines, d)
			}
			return capLines(lines)
		}
	}
	var lines []string
	for k, v := range in {
		b, _ := json.Marshal(v)
		lines = append(lines, k+": "+string(b))
	}
	return capLines(lines)
}

func capLines(lines []string) []string {
	const most, width = 12, 400
	if len(lines) > most {
		lines = append(lines[:most], "…")
	}
	for i, l := range lines {
		if len(l) > width {
			lines[i] = strings.ToValidUTF8(l[:width], "") + "…"
		}
	}
	return lines
}

// handlePoll serves GET /mod/v1/poll: the commands waiting for the mod, held
// open until there is one or modPollHold passes.
func (h *modHub) handlePoll() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := r.URL.Query().Get("token")
		c := h.byTokenOf(token)
		if c == nil {
			http.Error(w, "unknown token", http.StatusConflict)
			return
		}
		c.mu.Lock()
		c.polls++
		c.mu.Unlock()
		defer func() {
			c.mu.Lock()
			c.polls--
			// A poll answered is a mod about to poll again; one that ended
			// with its connection is not heard from, so alive lapses.
			if r.Context().Err() == nil {
				c.lastSeen = h.now()
			}
			c.mu.Unlock()
		}()
		t := time.NewTimer(modPollHold)
		defer t.Stop()
		for {
			c.mu.Lock()
			// A newer hello replaced this token: the module that holds it was
			// reloaded away, and a command handed to it would never run.
			if c.token != token {
				c.mu.Unlock()
				http.Error(w, "superseded by a newer hello", http.StatusConflict)
				return
			}
			cmds := c.cmds
			c.cmds = nil
			for _, cmd := range cmds {
				c.inflight[cmd.ID] = cmd
			}
			wake := c.wake
			c.mu.Unlock()
			if len(cmds) > 0 {
				writeJSON(w, map[string]any{"commands": cmds})
				return
			}
			select {
			case <-wake:
			case <-t.C:
				writeJSON(w, map[string]any{"commands": []modCommand{}})
				return
			case <-r.Context().Done():
				return
			}
		}
	}
}

var errModGone = errors.New("the session's mod is not connected")

// send queues a command and waits for its ack.
func (c *modConn) send(ctx context.Context, cmd modCommand) (modAck, error) {
	c.mu.Lock()
	c.nextID++
	cmd.ID = "c" + strconv.Itoa(c.nextID) + "." + bootID
	ch := make(chan modAck, 1)
	c.acks[cmd.ID] = ch
	c.cmds = append(c.cmds, cmd)
	c.mu.Unlock()
	select {
	case c.wake <- struct{}{}:
	default:
	}
	t := time.NewTimer(modAckWait)
	defer t.Stop()
	select {
	case a, ok := <-ch:
		if !ok {
			return modAck{}, errModGone
		}
		return a, nil
	case <-t.C:
		c.mu.Lock()
		delete(c.acks, cmd.ID)
		delete(c.inflight, cmd.ID)
		c.mu.Unlock()
		return modAck{}, context.DeadlineExceeded
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.acks, cmd.ID)
		delete(c.inflight, cmd.ID)
		c.mu.Unlock()
		return modAck{}, ctx.Err()
	}
}

// cmdSeq is a command id's sequence number ("c12" is 12), which orders
// commands sent again after a hello.
func cmdSeq(id string) int {
	seq, _, _ := strings.Cut(strings.TrimPrefix(id, "c"), ".")
	n, _ := strconv.Atoi(seq)
	return n
}

// bootID tells this process's command ids from the last one's. A mod outlives
// a restart of this service and ignores an id it has already run, so an id
// that started again at c1 would be taken for a repeat and never run.
var bootID = newToken()[:8]

// deliver hands an ack to the route waiting for it. A second ack for the same
// command finds nobody and is dropped.
func (c *modConn) deliver(id string, a modAck) {
	c.mu.Lock()
	ch, ok := c.acks[id]
	delete(c.acks, id)
	delete(c.inflight, id)
	c.mu.Unlock()
	if ok {
		ch <- a
	}
}

// dialogNow is the dialog the session is waiting on, nil when none.
func (c *modConn) dialogNow() *modDialog {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.dialogs) == 0 {
		return nil
	}
	return c.dialogs[0]
}

// dialogFor finds the dialog an answer is for: the one it names, or else the
// oldest open dialog of its kind. A named dialog of another kind is nil.
func (c *modConn) dialogFor(kind, toolID string) *modDialog {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, d := range c.dialogs {
		if toolID != "" && d.toolID == toolID {
			if d.kind != kind {
				return nil
			}
			return d
		}
		if toolID == "" && d.kind == kind {
			return d
		}
	}
	return nil
}

// answer turns a card's answer into the command that settles the dialog.
func (c *modConn) answer(ctx context.Context, req sessionio.AnswerRequest) sessionio.AnswerResponse {
	var cmds []modCommand
	switch {
	case req.Answers != nil || req.Chat != nil:
		d := c.dialogFor("ask", req.ToolID)
		if d == nil {
			return sessionio.AnswerResponse{Reason: sessionio.AnswerNotHeld}
		}
		cmd := modCommand{Op: "answer", ToolID: d.toolID}
		if req.Chat != nil {
			msg := chatMessage(*req.Chat)
			cmd.Chat = &msg
		} else {
			answers, ok := answersFor(d.questions, req.Answers)
			if !ok {
				return sessionio.AnswerResponse{Reason: sessionio.AnswerIncomplete}
			}
			cmd.Answers = answers
		}
		cmds = append(cmds, cmd)
	case req.Plan != nil:
		d := c.dialogFor("plan", req.ToolID)
		if d == nil {
			return sessionio.AnswerResponse{Reason: sessionio.AnswerNotDrawn}
		}
		p := req.Plan
		switch {
		case p.Option == 1:
			cmds = append(cmds, modCommand{Op: "decide", ToolID: d.toolID, Decision: "allow"})
		case p.Option == 2 && strings.TrimSpace(p.Feedback) == "":
			// Keep planning, with no words: the mod sends its own message.
			cmds = append(cmds, modCommand{Op: "decide", ToolID: d.toolID, Decision: "deny"})
		case strings.TrimSpace(p.Feedback) != "" && p.Approve:
			cmds = append(cmds, modCommand{Op: "decide", ToolID: d.toolID, Decision: "allow"},
				modCommand{Op: "prompt", Text: p.Feedback})
		case strings.TrimSpace(p.Feedback) != "":
			cmds = append(cmds, modCommand{Op: "decide", ToolID: d.toolID, Decision: "deny", Reason: p.Feedback})
		default:
			return sessionio.AnswerResponse{Reason: sessionio.AnswerUnknownOption}
		}
	case req.Permission != nil:
		d := c.dialogFor("permission", req.ToolID)
		if d == nil {
			return sessionio.AnswerResponse{Reason: sessionio.AnswerNotDrawn}
		}
		p := req.Permission
		switch {
		case p.Option == 1:
			cmds = append(cmds, modCommand{Op: "decide", ToolID: d.toolID, Decision: "allow"})
		case p.Option == 2:
			cmds = append(cmds, modCommand{Op: "decide", ToolID: d.toolID, Decision: "deny",
				Reason: "The user declined this tool call."})
		case strings.TrimSpace(p.Decline) != "":
			cmds = append(cmds, modCommand{Op: "decide", ToolID: d.toolID, Decision: "deny", Reason: p.Decline})
		default:
			return sessionio.AnswerResponse{Reason: sessionio.AnswerUnknownOption}
		}
	default:
		return sessionio.AnswerResponse{Reason: sessionio.AnswerNotHeld}
	}
	for _, cmd := range cmds {
		a, err := c.send(ctx, cmd)
		if err != nil {
			return sessionio.AnswerResponse{Reason: sessionio.AnswerUnverified}
		}
		if !a.OK {
			// The dialog was settled elsewhere a moment ago.
			return sessionio.AnswerResponse{Reason: sessionio.AnswerNotHeld}
		}
	}
	return sessionio.AnswerResponse{Applied: true, Done: true}
}

// sweep drops connections whose mod has gone quiet.
func (h *modHub) sweep() {
	cut := h.now().Add(-modExpiry)
	h.mu.Lock()
	var stale []*modConn
	for _, c := range h.bySID {
		c.mu.Lock()
		old := c.lastSeen.Before(cut)
		c.mu.Unlock()
		if old {
			stale = append(stale, c)
		}
	}
	for _, c := range stale {
		log.Printf("mod %s/%s: no word for %s, dropping", c.user, c.session, modExpiry)
		h.dropLocked(c)
	}
	h.mu.Unlock()
	for _, c := range stale {
		c.write(stampWrite{unset: []string{sessionio.OptionAsk, sessionio.OptionTool}})
	}
}

// heldQuestion is the part of an AskUserQuestion question an answer is checked
// against.
type heldQuestion struct {
	Question    string `json:"question"`
	MultiSelect bool   `json:"multiSelect,omitempty"`
}

// answersFor builds Claude's answer map from the card's, keyed by the question
// text, or reports that a question is left without an answer. Claude reads a
// missing answer as a skipped question, so a partial map is refused rather than
// sent. A multi-select's picks go as one "A, B" string: an array reaches the
// model as "A,B" and the terminal draws no answer row for it (ADR-0034).
func answersFor(qs []heldQuestion, got map[string][]string) (map[string]string, bool) {
	out := make(map[string]string, len(qs))
	for _, q := range qs {
		var picks []string
		for _, p := range got[q.Question] {
			if p = strings.TrimSpace(p); p != "" {
				picks = append(picks, p)
			}
		}
		if len(picks) == 0 {
			return nil, false
		}
		out[q.Question] = strings.Join(picks, ", ")
	}
	return out, true
}

// chatMessage is what Claude reads when the reader declines the question to
// talk instead. Claude shows a refusal as an error, so the words say plainly
// that this is the reader's choice and what to do next.
func chatMessage(words string) string {
	words = strings.TrimSpace(words)
	if words == "" {
		return "The user chose not to answer these questions and wants to talk about them instead. " +
			"Do not ask them again; wait for the user's next message."
	}
	return "The user chose not to pick an answer and replied instead: " + words
}
