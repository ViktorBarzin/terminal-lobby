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
	"slices"
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
// and the commands waiting for the mod. The dialogs waiting on a person and
// their answers are in moddialogs.go.

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
	modNameRe    = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
)

// modSessionMax bounds the session name a mod may say hello under. A pre-warm
// slot is named for its directory past the 64 characters a client may address
// (tmux-api/prewarm.go), so its mod has to be let in under a longer name than
// any route accepts: ~/code/terminal-lobby's slot is 69. Refused, the slot's
// mod said no hello in any of 141 warm-ups (2026-09-26 to 2026-10-03), and a
// claimed slot's first prompt waited on its backoff, up to 23s.
const modSessionMax = 4096

// validModSession reports whether a mod may say hello under name.
func validModSession(name string) bool {
	return len(name) <= modSessionMax && modNameRe.MatchString(name)
}

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
	// Instance is random per module load (mod 0.3.0). A different one under
	// the same conversation is a module that forgot what it knew: a reload
	// or a worker respawn. Older mods send none.
	Instance string `json:"instance"`
	// Dropped is how many events the mod's queue has shed since it loaded
	// (mod 0.3.0), so a loss in a long outage shows up somewhere.
	Dropped int `json:"dropped"`
	// Ops are the command ops this mod runs. A mod from before the field
	// sends none, and is sent nothing it would answer "unknown op" to.
	Ops []string `json:"ops"`
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
	// Feedback rides a plan approval to a mod whose ops include
	// decide-feedback, which hands it to Claude with the approval itself.
	Feedback string `json:"feedback,omitempty"`
	Model    string `json:"model,omitempty"`
	Effort   string `json:"effort,omitempty"`
	// AgentID is the subagent a steer is for (steer.go).
	AgentID string `json:"agentId,omitempty"`
}

// modAck is the mod's answer to a command.
type modAck struct {
	OK    bool
	Error string
	// ID is the command's id, which a later command_failed names.
	ID string
}

// modConn is one Claude session's link to its mod.
type modConn struct {
	hub  *modHub
	user string
	sid  string

	// applyMu serializes apply: an event batch is folded and written as one
	// step, so two overlapping batches (a reloaded module's last POST beside
	// the new one's, or a POST resent after the fetch cap) cannot land their
	// tmux writes in the reverse order of the fold.
	applyMu sync.Mutex

	mu         sync.Mutex
	session    string
	pane       string
	transcript string
	ops        []string // the hello's: what this mod can be sent
	instance   string   // the hello's module instance, "" from mods before 0.3.0
	token      string
	ls         *liveSource
	// historyOwed is set from the moment ls is made until a final history
	// chunk has been applied, and every hello answers it. A history answer
	// the mod dropped (a rehello while the hello was in flight) is asked for
	// again by the next hello instead of being lost until the next restart.
	historyOwed bool
	// historyChunks counts the chunks of an owed history applied so far.
	historyChunks int
	// stamps is false for a second live Claude in a tmux session another
	// connection holds: it keeps its token, but writes no options and has no
	// stream, so the two do not take the session from each other.
	stamps bool
	// fullOnState makes the first state-bearing apply after a hello (a
	// level, or an old mod's last history chunk) write all four state
	// options, and fullNext the first apply after a failed write.
	fullOnState, fullNext bool
	cmds                  []modCommand
	// inflight are commands a poll has handed over and the mod has not acked.
	// A reload can take a module away with a command in hand, so they go out
	// again to the module that says hello next.
	inflight map[string]modCommand
	wake     chan struct{}
	acks     map[string]chan modAck
	// st is the fold of the mod's events: the options, and the dialogs open,
	// oldest first. Claude asks several questions at once more often than
	// not, and a subagent's prompt can open beside the main one.
	st       stampState
	lastSeen time.Time
	nextID   int
	// polls is how many of this mod's polls are held right now. A poll ends
	// with its connection when the Claude dies, so a held poll is the one
	// reading that says the process is still there.
	polls int
	// firstPrompts are composer first prompts the mod accepted and Claude has
	// not yet recorded, oldest first (firstprompt.go).
	firstPrompts []firstPromptMark
	// held are the lobby's prompts waiting behind the running main turn,
	// oldest first (held.go).
	held []string
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
	// files keeps held prompts across a restart, and carry what an ended
	// conversation held for the next one in its pane (held.go).
	files heldFiles
	carry map[string]heldCarry // user\x00pane
}

func newModHub(rg *registry, stamp sessionio.Options) *modHub {
	return &modHub{
		rg: rg, stamp: stamp, now: time.Now,
		byToken: map[string]*modConn{}, bySID: map[string]*modConn{},
		bySession: map[string]*modConn{}, waiting: map[string][]chan struct{}{},
		greeted: map[string]bool{}, carry: map[string]heldCarry{},
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

// newToken is a fresh random token. crypto/rand does not fail on Linux; if it
// ever did, a guessable token would let any local process speak for a
// session, so the process stops instead.
func newToken() string {
	var b [24]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("crypto/rand: " + err.Error())
	}
	return hex.EncodeToString(b[:])
}

// modConnsPerUser bounds the connections one OS user holds. Each is a live
// source and an agent watch, so a process posting hellos with fresh sids in a
// loop, a bug as easily as intent, would otherwise slow the service for every
// user. A person runs a few dozen Claudes at most.
const modConnsPerUser = 64

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
			!modSidRe.MatchString(b.SID) || !validModSession(b.Session) || !modPaneRe.MatchString(b.Pane) {
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
// session's history because this connection's log does not have it yet.
func (h *modHub) hello(osUser string, b modHello) (string, bool) {
	us := h.rg.user(osUser)
	// tmux-persist, suspend and the agent API read @claude_transcript to know
	// which conversation a tmux session holds, so the mod's hello keeps it
	// stamped as the SessionStart hook did. A second Claude in a session
	// another one holds stamps nothing.
	if b.Transcript != "" && !h.yields(osUser, b) {
		if err := us.sm.Put(sessionio.SessionInfo{TmuxSession: b.Session, CWD: b.CWD,
			ClaudeID: b.SID, Transcript: b.Transcript}); err != nil {
			log.Printf("mod hello %s/%s: transcript stamp: %v", osUser, b.Session, err)
			b.Transcript = ""
		}
	}

	h.mu.Lock()
	h.greeted[osUser] = true
	c := h.bySID[hubKey(osUser, b.SID)]
	created := c == nil
	var retired []*liveSource
	if created {
		h.capLocked(osUser)
		c = &modConn{hub: h, user: osUser, sid: b.SID, wake: make(chan struct{}, 1),
			acks: map[string]chan modAck{}, inflight: map[string]modCommand{}}
		h.bySID[hubKey(osUser, b.SID)] = c
		h.adoptLocked(c, b.Pane)
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
	// A new module instance under the same conversation forgot what it knew,
	// so the fold starts over and the session's snapshot is asked for again,
	// into a fresh log. So is a history this connection was halfway through:
	// the half already in the log would otherwise be drawn twice.
	fresh := false
	if !created && b.Instance != "" && b.Instance != c.instance {
		c.st = stampState{written: c.st.written}
		fresh = true
	}
	if b.Instance != "" && c.historyOwed && c.historyChunks > 0 {
		fresh = true
	}
	c.instance = b.Instance
	if c.session != b.Session {
		if c.session != "" && h.bySession[hubKey(osUser, c.session)] == c {
			delete(h.bySession, hubKey(osUser, c.session))
			// Renamed: streams on the old name end, so readers reconnect.
			fresh = true
		}
		c.session = b.Session
	}
	c.pane, c.transcript, c.ops = b.Pane, b.Transcript, b.Ops
	c.stamps = !h.yieldsLocked(osUser, b, c)
	if prev := h.bySession[hubKey(osUser, b.Session)]; c.stamps && prev != nil && prev != c {
		// Another Claude that held this tmux session before is over.
		h.dropLocked(prev)
	}
	if (fresh || !c.stamps) && c.ls != nil {
		retired = append(retired, c.ls)
		c.ls = nil
	}
	c.lastSeen = h.now()
	c.fullOnState = c.stamps
	built := false
	if c.stamps {
		h.bySession[hubKey(osUser, b.Session)] = c
		// The first hello comes before Claude has written its transcript, and
		// the mod says hello again naming it once the first row lands. The
		// source built on the first one kept an empty path for the life of the
		// session, so no picture could be read back, a subagent's included,
		// and the agent panel had no directory to list: a phone re-rendering
		// 34 such pictures drew 421 404s and the edge banned it (2026-10-03).
		// The log is kept.
		if c.ls != nil && b.Transcript != "" && c.ls.fs.Path() != b.Transcript {
			c.ls.fs.SetPath(b.Transcript)
			c.ls.agents.SetDir(sessionio.SessionDir(b.Transcript))
		}
		if c.ls == nil {
			// A new log, for a new connection, a rename, or a new module: it
			// is rebuilt from the history this hello asks for.
			c.ls = h.rg.startMod(b.Session, b.Transcript, us.reader, us.agents)
			c.historyOwed, c.historyChunks = true, 0
			built = true
		}
		c.ls.agents.SetSteer(slices.Contains(b.Ops, "steer"))
	} else {
		c.historyOwed, c.historyChunks = false, 0
		log.Printf("mod %s/%s: a second Claude (pane %s) said hello in a session another one holds; it writes nothing", osUser, b.Session, b.Pane)
	}
	// A mod from before 0.3.0 puts a history it is sent ahead of everything
	// it has queued, a history it was sent before included, so asking it
	// again would draw the conversation twice: it is asked only by the hello
	// that built the log, as before. A 0.3.0 mod drops its queue at the
	// snapshot, and is asked for as long as the history is owed.
	history := c.historyOwed
	if b.Instance == "" {
		history = built
	}
	ls, token, stamps := c.ls, c.token, c.stamps
	c.mu.Unlock()
	if stamps {
		for _, ch := range h.waiting[hubKey(osUser, b.Session)] {
			close(ch)
		}
		delete(h.waiting, hubKey(osUser, b.Session))
	}
	h.mu.Unlock()
	for _, r := range retired {
		r.stop()
		r.fs.Close()
		r.drills.close()
	}
	// Mod rows carry no model, so a log built after a restart would show none
	// until someone switched model. The hello names it.
	if built && b.Model != "" {
		ls.fs.Feed(sessionio.ModEvent{Type: sessionio.ModModelEvent, T: h.now().UnixMilli(), Model: b.Model})
	}
	if b.Dropped > 0 {
		log.Printf("mod %s/%s: its queue has shed %d events since it loaded", osUser, b.Session, b.Dropped)
	}
	events.Emit("mod.hello", osUser, telemetry.Attrs{
		"tl.session": b.Session, "tl.version": b.Version, "tl.mod": b.Mod, "tl.history": history,
		"tl.count": b.Dropped,
	})
	return token, history
}

// yields reports whether a hello comes from a second Claude in a tmux session
// another live Claude holds from another pane (yieldsLocked).
func (h *modHub) yields(osUser string, b modHello) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.yieldsLocked(osUser, b, h.bySID[hubKey(osUser, b.SID)])
}

// yieldsLocked reports whether the connection c saying hello b must leave the
// session to the connection that holds it: one on another pane whose mod is
// still alive. A holder on the same pane is a Claude that pane ran before,
// and one gone quiet is over; either is replaced. Caller holds h.mu.
func (h *modHub) yieldsLocked(osUser string, b modHello, c *modConn) bool {
	holder := h.bySession[hubKey(osUser, b.Session)]
	if holder == nil || holder == c {
		return false
	}
	holder.mu.Lock()
	pane := holder.pane
	holder.mu.Unlock()
	return pane != b.Pane && holder.alive(h.now())
}

// capLocked makes room for one more of the user's connections, dropping the
// longest-silent ones past modConnsPerUser. Caller holds h.mu.
func (h *modHub) capLocked(osUser string) {
	var mine []*modConn
	for _, c := range h.bySID {
		if c.user == osUser {
			mine = append(mine, c)
		}
	}
	if len(mine) < modConnsPerUser {
		return
	}
	seen := func(c *modConn) time.Time {
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.lastSeen
	}
	sort.Slice(mine, func(i, j int) bool { return seen(mine[i]).Before(seen(mine[j])) })
	for _, c := range mine[:len(mine)-modConnsPerUser+1] {
		log.Printf("mod %s/%s: over %d connections for the user, dropping the longest silent", c.user, c.session, modConnsPerUser)
		h.dropLocked(c)
	}
}

// dropLocked forgets a connection and ends its streams. Caller holds h.mu.
func (h *modHub) dropLocked(c *modConn) {
	h.carryLocked(c)
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

// apply feeds a batch of events to the session: the log, the dialogs and the
// tmux options. The option writes are merged across the batch so a burst of
// events costs one tmux call.
func (c *modConn) apply(evs []sessionio.ModEvent) {
	c.applyMu.Lock()
	defer c.applyMu.Unlock()
	h := c.hub
	c.mu.Lock()
	ls, sid, stamps, newMod := c.ls, c.sid, c.stamps, c.instance != ""
	c.mu.Unlock()
	if ls == nil {
		if !stamps {
			c.claimIfFree()
		}
		return
	}
	fs := ls.fs
	var merged stampWrite
	// state says the batch carries the session's whole state: a level, or the
	// last history chunk of a mod from before levels. moved says the fold's
	// state left what was last written at some step, even if it came back.
	bye, state, moved, rebuilt := false, false, false, false
	for _, ev := range evs {
		if modOwnDialog(ev) {
			continue
		}
		switch ev.Type {
		case sessionio.ModHistoryEvent:
			// Only the last chunk of a long history may close the last turn.
			fs.FeedHistory(ev.Messages, ev.Running || ev.More)
			c.mu.Lock()
			if ev.More {
				c.historyChunks++
			} else {
				rebuilt = c.historyOwed
				c.historyOwed, c.historyChunks = false, 0
				// A 0.3.0 mod's snapshot ends in its level, which may come in
				// the next batch with the dialogs: the history alone would
				// write a session with a dialog open as done in between.
				state = !newMod
			}
			c.mu.Unlock()
		case sessionio.ModAckEvent:
			c.deliver(ev.ID, modAck{OK: ev.OK, Error: ev.Error})
			continue
		case sessionio.ModByeEvent:
			// A bye still queued from before a /clear names the conversation
			// it ends, which is not this one (mod 0.3.0; older mods name none).
			if ev.Sid != "" && ev.Sid != sid {
				log.Printf("mod %s/%s: ignored a bye for conversation %s", c.user, c.sessionName(), ev.Sid)
				continue
			}
			bye = true
		case sessionio.ModRowEvent:
			c.firstPromptShown(ev, h.now())
		case sessionio.ModAgentsEvent:
			// The engine's own list decides who can be messaged (steer.go).
			ls.agents.SetEngine(ev.Agents)
		case sessionio.ModLevelEvent:
			ls.agents.SetEngine(ev.Agents)
			state = true
		case sessionio.ModCommandFailedEvent:
			c.commandFailed(ev)
		}
		fs.Feed(ev)
		c.mu.Lock()
		w := c.st.apply(ev, h.now())
		if c.st.state != c.st.written.state {
			moved = true
		}
		c.mu.Unlock()
		merged = mergeWrites(merged, w)
	}
	c.showDialogs(fs)
	// The four state options are diffed against what was last written, and
	// written in full on the first state-bearing apply after a hello, after a
	// failed write, and on a bye. A manual state therefore lasts until the
	// derived state next changes: nothing re-asserts an unchanged value. A
	// change that came back within the batch (a whole turn in one POST) is
	// a change, and writes the state.
	//
	// After a 0.3.0 mod's hello nothing is written until its level: the
	// fold rebuilt from part of a snapshot is not the session's state.
	c.mu.Lock()
	full := bye || c.fullNext || (state && c.fullOnState)
	hold := newMod && c.fullOnState && !state && !bye
	if state {
		c.fullOnState = false
	}
	opts := c.st.opts()
	var flush stampWrite
	if !hold {
		flush = c.st.flush(full)
		if moved && opts.state != "" {
			flush.put(sessionio.OptionState, opts.state)
		}
	} else {
		opts = c.st.written
	}
	c.mu.Unlock()
	merged = mergeWrites(merged, flush)
	merged.from, merged.to = flush.from, flush.to
	ok := c.write(merged)
	c.mu.Lock()
	if ok {
		c.st.written, c.fullNext = opts, false
	} else {
		c.fullNext = true
	}
	c.mu.Unlock()
	if bye {
		h.mu.Lock()
		h.dropLocked(c)
		h.mu.Unlock()
		return
	}
	// A stream rebuilt from history shows what is held as queued again, and
	// what is held goes out once no turn runs.
	if rebuilt {
		c.showHeld()
	}
	c.releaseHeld()
}

// source is the log this connection feeds, nil before its hello built one.
func (c *modConn) source() *sessionio.FileSource {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ls == nil {
		return nil
	}
	return c.ls.fs
}

func (c *modConn) sessionName() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.session
}

// claimIfFree asks a connection that yielded its session to a second live
// Claude to say hello again once that Claude is gone: its token is revoked,
// so its next request is refused and its hello takes the session.
func (c *modConn) claimIfFree() {
	h := c.hub
	h.mu.Lock()
	c.mu.Lock()
	session := c.session
	c.mu.Unlock()
	holder := h.bySession[hubKey(c.user, session)]
	free := holder == nil || (holder != c && !holder.alive(h.now()))
	revoked := false
	c.mu.Lock()
	if free && c.token != "" {
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
	}
}

// commandFailed records a command the mod acked and then could not carry out:
// a prompt a hook dropped, a slash command that failed. The route had already
// answered that it was sent, so the log line, the event and the notice in the
// session's Text view (sessionio.FileSource) are what say otherwise.
func (c *modConn) commandFailed(ev sessionio.ModEvent) {
	session := c.sessionName()
	log.Printf("mod %s/%s: command %s (%s) failed after its ack: %s", c.user, session, ev.ID, ev.Op, ev.Error)
	events.Emit("mod.command_failed", c.user, telemetry.Attrs{"tl.session": session, "tl.kind": ev.Op})
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
// transition the way the hook script did. It reports whether every change
// landed.
//
// A write that fails because the session was renamed under the mod is made
// again under the name the mod's pane has now, and the mod is asked to say
// hello again so everything else moves too (followRename).
func (c *modConn) write(w stampWrite) bool {
	if w.empty() {
		return true
	}
	ok := true
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
			ok = false
			log.Printf("mod %s/%s: set %s: %v", user, session, name, err)
		}
	}
	if h.unset != nil && len(w.unset) > 0 {
		err := h.unset(user, session, w.unset)
		if err != nil && follow() {
			err = h.unset(user, session, w.unset)
		}
		if err != nil {
			ok = false
			log.Printf("mod %s/%s: unset %v: %v", user, session, w.unset, err)
		}
	}
	if st, ok := w.set[sessionio.OptionState]; ok && st != w.from {
		events.Emit("claude.state_changed", user, telemetry.Attrs{
			"tl.session": session, "tl.from": orNone(w.from), "tl.to": st, "tl.client": "mod",
		})
	}
	return ok
}

// setAll stamps every option, stopping at the first failure: a session that
// cannot take one cannot take the rest. It returns the name that failed.
//
// @claude_state goes last. The push sender sends its "finished" push when it
// reads done, with @claude_reply as the body, so a state written before the
// reply beside it could carry the previous turn's reply.
func (c *modConn) setAll(user, session string, set map[string]string) (string, error) {
	names := make([]string, 0, len(set))
	for name := range set {
		names = append(names, name)
	}
	sort.Slice(names, func(i, j int) bool {
		if (names[i] == sessionio.OptionState) != (names[j] == sessionio.OptionState) {
			return names[j] == sessionio.OptionState
		}
		return names[i] < names[j]
	})
	for _, name := range names {
		if err := c.hub.stamp.SetOption(user, session, name, set[name]); err != nil {
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
	if now == "" || now == session || !validModSession(now) {
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
		expired := false
		for {
			c.mu.Lock()
			// A newer hello replaced this token: the module that holds it was
			// reloaded away, and a command handed to it would never run. The
			// wake this poll may have taken was meant for the poll that holds
			// the current token, so it is passed on.
			if c.token != token {
				wake := c.wake
				c.mu.Unlock()
				select {
				case wake <- struct{}{}:
				default:
				}
				http.Error(w, "superseded by a newer hello", http.StatusConflict)
				return
			}
			// Only commands a route still waits on: one it gave up on would
			// act on whatever the session is doing by the time it ran.
			cmds := []modCommand{}
			for _, cmd := range c.cmds {
				if _, waiting := c.acks[cmd.ID]; waiting {
					cmds = append(cmds, cmd)
					c.inflight[cmd.ID] = cmd
				}
			}
			c.cmds = nil
			wake := c.wake
			c.mu.Unlock()
			if len(cmds) > 0 || expired {
				writeJSON(w, map[string]any{"commands": cmds})
				return
			}
			select {
			case <-wake:
			case <-t.C:
				// Look once more: a command queued as the timer fired goes now.
				expired = true
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
		a.ID = cmd.ID
		return a, nil
	case <-t.C:
		c.forget(cmd.ID)
		return modAck{}, context.DeadlineExceeded
	case <-ctx.Done():
		c.forget(cmd.ID)
		return modAck{}, ctx.Err()
	}
}

// sendResult is one command's outcome in a sendAll.
type sendResult struct {
	ack modAck
	err error
}

// sendAll queues commands together, in order, so one poll hands the mod all
// of them, and waits for every ack.
func (c *modConn) sendAll(ctx context.Context, cmds []modCommand) []sendResult {
	chans := make([]chan modAck, len(cmds))
	c.mu.Lock()
	for i := range cmds {
		c.nextID++
		cmds[i].ID = "c" + strconv.Itoa(c.nextID) + "." + bootID
		chans[i] = make(chan modAck, 1)
		c.acks[cmds[i].ID] = chans[i]
		c.cmds = append(c.cmds, cmds[i])
	}
	c.mu.Unlock()
	select {
	case c.wake <- struct{}{}:
	default:
	}
	t := time.NewTimer(modAckWait)
	defer t.Stop()
	out := make([]sendResult, len(cmds))
	for i, ch := range chans {
		select {
		case a, ok := <-ch:
			if !ok {
				out[i].err = errModGone
			} else {
				out[i].ack = a
			}
		case <-t.C:
			out[i].err = context.DeadlineExceeded
		case <-ctx.Done():
			out[i].err = ctx.Err()
		}
		if out[i].err != nil {
			for _, cmd := range cmds[i:] {
				c.forget(cmd.ID)
			}
			for j := i + 1; j < len(out); j++ {
				out[j].err = out[i].err
			}
			break
		}
	}
	return out
}

// forget drops a command its route stopped waiting on, wherever it is: not
// yet polled, or handed over and not acked.
func (c *modConn) forget(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.acks, id)
	delete(c.inflight, id)
	c.cmds = slices.DeleteFunc(c.cmds, func(cmd modCommand) bool { return cmd.ID == id })
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
		c.mu.Lock()
		user, session, stamps := c.user, c.session, c.stamps
		c.mu.Unlock()
		if !stamps {
			continue
		}
		// A Claude that left the pane without a bye (killed, or out of
		// memory) left every option behind: skills-api would refuse to
		// restart a session still reading running. One still running may
		// only have lost its link, and its state and work are left as they
		// were.
		names := []string{sessionio.OptionAsk, sessionio.OptionTool}
		if h.paneProcs != nil {
			if procs := h.paneProcs(user, session); procs != nil && !claudeRunning(procs) {
				names = []string{sessionio.OptionState, sessionio.OptionAsk, sessionio.OptionTool, sessionio.OptionBackground}
			}
		}
		c.write(stampWrite{unset: names})
	}
}
