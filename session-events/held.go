package main

// Prompts the lobby sends while Claude's main turn runs are held here and sent
// when the turn ends, so the person can take them back to edit them (Up in the
// Text view) or have Stop hand them back.
//
// WHY HERE. Claude's mod submits a prompt with $.prompt.submit, which queues
// it behind a running turn where nothing can take it back: the mod API lists
// no queue and removes nothing, and Up in the pane does not pop it (measured on
// Claude Code 2.1.289, 2026-10-05). Held in this process, the queue is a list
// under a lock, it works with every mod already running, and the turn's end
// sends what is left.
//
// A held prompt can also reach Claude before the turn ends: the mod takes
// what is held at the turn's next tool boundary and delivers it into the
// running turn (steermain.go). Until Claude stores it the prompt is held
// here as steering, and the file keeps it.
//
// Held prompts are written to a file per conversation as well, since this
// process restarts with every release and a turn can outlast that. Not a tmux
// option, as most of this service's state is: tmux refuses a command longer
// than about 16 KB (measured the same day), and a queued paste is often
// longer.

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"terminal-lobby/sessionio"
	"terminal-lobby/telemetry"
)

// heldFiles keeps each conversation's held prompts in <dir>/<user>/<sid>.json.
// An empty dir keeps nothing on disk.
type heldFiles struct{ dir string }

// heldName is what a user or conversation id may be to name a file.
var heldName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

func (s heldFiles) path(user, sid string) string {
	if s.dir == "" || !heldName.MatchString(user) || !heldName.MatchString(sid) {
		return ""
	}
	return filepath.Join(s.dir, user, sid+".json")
}

// waitPath names the file listing which of a conversation's held prompts
// wait for the turn's end (modConn.waiting). A file of its own beside the
// texts, so the texts file keeps the shape an older build reads: rolled back,
// it holds every prompt again and only forgets which ones were to wait.
func (s heldFiles) waitPath(user, sid string) string {
	p := s.path(user, sid)
	if p == "" {
		return ""
	}
	return strings.TrimSuffix(p, ".json") + ".wait.json"
}

func (s heldFiles) load(user, sid string) []string {
	return readTexts(s.path(user, sid))
}

// loadWaiting is which of the loaded texts wait for the turn's end.
func (s heldFiles) loadWaiting(user, sid string) []string {
	return readTexts(s.waitPath(user, sid))
}

func readTexts(p string) []string {
	if p == "" {
		return nil
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return nil
	}
	var texts []string
	if err := json.Unmarshal(b, &texts); err != nil {
		log.Printf("held prompts %s: %v", p, err)
		return nil
	}
	return texts
}

// saveWaiting writes which held prompts wait for the turn's end, or removes
// the file when none do.
func (s heldFiles) saveWaiting(user, sid string, texts []string) {
	writeTexts(s.waitPath(user, sid), texts)
}

// save writes the conversation's held prompts, or removes the file when there
// are none. A failure is logged: the prompts are still held in memory.
func (s heldFiles) save(user, sid string, texts []string) {
	writeTexts(s.path(user, sid), texts)
}

func writeTexts(p string, texts []string) {
	if p == "" {
		return
	}
	if len(texts) == 0 {
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			log.Printf("held prompts %s: %v", p, err)
		}
		return
	}
	b, err := json.Marshal(texts)
	if err == nil {
		err = os.MkdirAll(filepath.Dir(p), 0o700)
	}
	if err == nil {
		tmp := p + ".tmp"
		if err = os.WriteFile(tmp, b, 0o600); err == nil {
			err = os.Rename(tmp, p)
		}
	}
	if err != nil {
		log.Printf("held prompts %s: %v", p, err)
	}
}

func (s heldFiles) move(user, from, to string, texts, waiting []string) {
	s.save(user, from, nil)
	s.saveWaiting(user, from, nil)
	s.save(user, to, texts)
	s.saveWaiting(user, to, waiting)
}

// keep writes everything a connection holds: every pending prompt, and which
// of them wait for the turn's end.
func (s heldFiles) keep(user, sid string, pending, waiting []string) {
	s.save(user, sid, pending)
	s.saveWaiting(user, sid, waiting)
}

// defaultHeldDir is where held prompts live unless -held-dir says otherwise:
// this service's own cache directory.
func defaultHeldDir() string {
	base, err := os.UserCacheDir()
	if err != nil {
		return ""
	}
	return filepath.Join(base, "terminal-lobby", "held")
}

// heldCarry is what a connection held when it ended, for the next
// conversation in the same pane: a /clear ends one conversation and starts
// another in the same Claude.
type heldCarry struct {
	sid     string
	texts   []string
	waiting []string // which of texts wait for the turn's end
}

// known reports whether the fold says what the session is doing: the snapshot
// a hello asks for has been folded. Before that a running turn may read as
// none. Called with c.mu held.
func (c *modConn) knownLocked() bool {
	return c.stamps && c.ls != nil && !c.historyOwed && !c.fullOnState
}

// pendingLocked is every prompt waiting on Claude, oldest first: those the
// mod took and Claude has not stored, then those held. The file keeps this
// set, so a restart holds again what nothing confirmed. Called with c.mu held.
func (c *modConn) pendingLocked() []string {
	return append(append(slices.Clone(c.steering), c.held...), c.waiting...)
}

// hold keeps a prompt behind the running main turn and shows it queued. False
// when no main turn is known to run, or for a slash command, which runs as one
// and leaves no prompt row to take it off the queue: the caller sends it now.
// wait keeps it for the turn's end: the mod is not handed it at a tool
// boundary to steer the turn (steermain.go).
func (c *modConn) hold(text string, wait bool) bool {
	if strings.HasPrefix(strings.TrimSpace(text), "/") {
		return false
	}
	// Ordered against apply, so a turn end being folded either sees this
	// prompt and sends it, or comes first and this sends it now.
	c.applyMu.Lock()
	defer c.applyMu.Unlock()
	c.mu.Lock()
	if !c.knownLocked() || !c.turnAheadLocked() {
		c.mu.Unlock()
		return false
	}
	if wait {
		c.waiting = append(c.waiting, text)
	} else {
		c.held = append(c.held, text)
	}
	pending, waiting, ls, user, sid := c.pendingLocked(), slices.Clone(c.waiting), c.ls, c.user, c.sid
	c.mu.Unlock()
	c.hub.files.keep(user, sid, pending, waiting)
	ls.fs.Queue(text, c.hub.now().UnixMilli())
	return true
}

// takeHeld hands back every held prompt, oldest first, and takes them off the
// stream's queue. withSteering takes those the mod took and Claude has not
// stored as well: a Stop's abort can land before their context does, and the
// turn's end would then send them after the person stopped it.
func (c *modConn) takeHeld(withSteering bool) []string {
	c.applyMu.Lock()
	defer c.applyMu.Unlock()
	c.mu.Lock()
	out, ls, user, sid := append(slices.Clone(c.held), c.waiting...), c.ls, c.user, c.sid
	if withSteering {
		out = c.pendingLocked()
		c.steering = nil
	}
	c.held, c.waiting = nil, nil
	pending := c.pendingLocked()
	c.mu.Unlock()
	if len(out) == 0 {
		return []string{}
	}
	c.hub.files.keep(user, sid, pending, nil)
	if ls != nil {
		ls.fs.Unqueue(out, c.hub.now().UnixMilli())
	}
	return out
}

// cancelHeld drops the first held prompt whose text, trimmed, is text, and
// takes it off the stream's queue. False when nothing held matches: Claude
// has it already, or another device took it.
func (c *modConn) cancelHeld(text string) (string, bool) {
	text = strings.TrimSpace(text)
	c.applyMu.Lock()
	defer c.applyMu.Unlock()
	c.mu.Lock()
	match := func(h string) bool { return strings.TrimSpace(h) == text }
	var gone string
	if at := slices.IndexFunc(c.held, match); text != "" && at >= 0 {
		gone = c.held[at]
		c.held = slices.Delete(slices.Clone(c.held), at, at+1)
	} else if at := slices.IndexFunc(c.waiting, match); text != "" && at >= 0 {
		gone = c.waiting[at]
		c.waiting = slices.Delete(slices.Clone(c.waiting), at, at+1)
	} else {
		c.mu.Unlock()
		return "", false
	}
	pending, waiting, ls, user, sid := c.pendingLocked(), slices.Clone(c.waiting), c.ls, c.user, c.sid
	c.mu.Unlock()
	c.hub.files.keep(user, sid, pending, waiting)
	if ls != nil {
		ls.fs.Unqueue([]string{gone}, c.hub.now().UnixMilli())
	}
	return gone, true
}

// putBack holds again, ahead of anything held since, prompts a Stop took
// whose interrupt then failed, and shows them queued again.
func (c *modConn) putBack(texts []string) {
	if len(texts) == 0 {
		return
	}
	c.applyMu.Lock()
	defer c.applyMu.Unlock()
	c.mu.Lock()
	c.held = append(slices.Clone(texts), c.held...)
	pending, waiting, ls, user, sid := c.pendingLocked(), slices.Clone(c.waiting), c.ls, c.user, c.sid
	c.mu.Unlock()
	c.hub.files.keep(user, sid, pending, waiting)
	if ls != nil {
		at := c.hub.now().UnixMilli()
		for _, t := range texts {
			ls.fs.Queue(t, at)
		}
	}
	c.releaseHeld()
}

// showHeld puts what is held on a new stream's queue. Called from apply once
// the history that rebuilt the stream has been folded.
func (c *modConn) showHeld() {
	c.mu.Lock()
	held, ls := c.pendingLocked(), c.ls
	c.mu.Unlock()
	if ls == nil {
		return
	}
	at := c.hub.now().UnixMilli()
	for _, t := range held {
		ls.fs.Queue(t, at)
	}
}

// turnStartWait bounds how long a prompt sent while idle holds what follows
// before its turn starts. Claude reports the turn once its prompt hooks have
// run (5 seconds measured on 2026-10-11); a prompt that starts no turn lets
// go of what it held after this.
var turnStartWait = 20 * time.Second

// turnAheadLocked reports whether a main turn runs or a prompt sent to an idle
// Claude is about to start one. Called with c.mu held.
func (c *modConn) turnAheadLocked() bool {
	return c.st.turnOpen || c.starting != 0
}

// startingLocked marks a prompt sent to an idle Claude: what the lobby sends
// next is held for the turn it starts, to be taken at that turn's first tool
// boundary (steermain.go) instead of waiting behind it in Claude. The wait
// ends when the turn is reported (apply) or after turnStartWait.
// Called with c.mu held.
func (c *modConn) startingLocked() {
	if c.st.turnOpen {
		return
	}
	c.starts++
	n := c.starts
	c.starting = n
	time.AfterFunc(turnStartWait, func() {
		c.applyMu.Lock()
		defer c.applyMu.Unlock()
		c.mu.Lock()
		if c.starting == n {
			c.starting = 0
		}
		c.mu.Unlock()
		c.releaseHeld()
	})
}

// turnBound reports whether ev starts or ends a main-thread turn.
func turnBound(ev sessionio.ModEvent) bool {
	return ev.AgentID == "" && (ev.Type == sessionio.ModTurnStartEvent || ev.Type == sessionio.ModTurnEndEvent)
}

// markStarting marks a prompt the mod accepted while no turn ran (startingLocked).
// Not a slash command: it may run without a model turn (/clear, /model).
func (c *modConn) markStarting(text string) {
	if strings.HasPrefix(strings.TrimSpace(text), "/") {
		return
	}
	c.applyMu.Lock()
	defer c.applyMu.Unlock()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.knownLocked() {
		c.startingLocked()
	}
}

// releaseHeld sends what is held once no main turn runs. Called from apply,
// under applyMu. The sends wait for acks that arrive through apply, so they go
// on their own goroutine.
//
// What the mod took and no row confirmed goes too, first: its request timed
// out, or the call it rode on ended before its result was stored. Claude
// stores the row before the turn ends, and apply folds the mod's events in
// order, so by the turn's end a delivered prompt has been confirmed.
func (c *modConn) releaseHeld() {
	c.mu.Lock()
	if (len(c.held) == 0 && len(c.steering) == 0 && len(c.waiting) == 0) || !c.knownLocked() || c.turnAheadLocked() {
		c.mu.Unlock()
		return
	}
	out, ls, user, sid := c.pendingLocked(), c.ls, c.user, c.sid
	c.held, c.steering, c.waiting = nil, nil, nil
	c.startingLocked()
	c.mu.Unlock()
	c.hub.files.keep(user, sid, nil, nil)
	go c.submitHeld(out, ls)
}

// queueSettleWait is how long a session stays idle before what its stream
// still shows queued is cleared (settleQueue). Long enough for a held prompt
// sent at the turn's end to open its turn (5 seconds measured, turnStartWait).
var queueSettleWait = 30 * time.Second

// settleQueue clears the stream's queue once the session has stayed idle for
// queueSettleWait with nothing held. Claude runs what it has queued as soon
// as it is idle, so an entry left by then has gone and only its departure was
// missed: a ghost the person could no longer cancel, because nothing held it
// (Viktor, 2026-10-20). Called from apply, under applyMu.
func (c *modConn) settleQueue() {
	c.mu.Lock()
	if c.settling || !c.settledLocked() {
		c.mu.Unlock()
		return
	}
	fs, turns := c.ls.fs, c.turns
	c.mu.Unlock()
	if len(fs.Queued()) == 0 {
		return
	}
	c.mu.Lock()
	c.settling = true
	c.mu.Unlock()
	time.AfterFunc(queueSettleWait, func() {
		c.applyMu.Lock()
		defer c.applyMu.Unlock()
		c.mu.Lock()
		c.settling = false
		still := turns == c.turns && c.settledLocked()
		user, session := c.user, c.session
		c.mu.Unlock()
		if !still {
			// A turn ran in between: wait again from now if it has ended.
			c.settleQueue()
			return
		}
		if gone := fs.ClearQueue(c.hub.now().UnixMilli()); len(gone) > 0 {
			log.Printf("mod %s/%s: cleared %d queued after going idle", user, session, len(gone))
			events.Emit("claude.queue_settled", user, telemetry.Attrs{"tl.session": session, "tl.count": len(gone)})
		}
	})
}

// settledLocked reports whether the session is known idle with nothing held,
// so nothing can be waiting on its queue. Called with c.mu held.
func (c *modConn) settledLocked() bool {
	return c.ls != nil && c.knownLocked() && !c.turnAheadLocked() &&
		len(c.held) == 0 && len(c.steering) == 0 && len(c.waiting) == 0
}

// submitHeld sends held prompts to the mod in one batch, oldest first, so they
// reach Claude together. One the mod does not confirm is shown as an error
// row naming it: it may still run (a command in hand goes out again to the
// next hello), so it is not sent again from here.
func (c *modConn) submitHeld(texts []string, ls *liveSource) {
	cmds := make([]modCommand, len(texts))
	for i, t := range texts {
		cmds[i] = modCommand{Op: "prompt", Text: t}
	}
	for i, r := range c.sendAll(context.Background(), cmds) {
		why := r.ack.Error
		if r.err != nil {
			why = "it did not confirm it"
		}
		if r.err == nil && r.ack.OK {
			continue
		}
		ls.fs.Unqueue(texts[i:i+1], c.hub.now().UnixMilli())
		ls.fs.Feed(sessionio.ModEvent{
			Type: sessionio.ModCommandFailedEvent, T: c.hub.now().UnixMilli(), Op: "prompt",
			Error: why + ". It was queued as: " + quoteStart(texts[i]),
		})
	}
	c.mu.Lock()
	session := c.session
	c.mu.Unlock()
	events.Emit("claude.prompt_sent", c.user, telemetry.Attrs{
		"tl.session": session, "tl.count": len(texts), "tl.client": "mod", "tl.held": true,
	})
}

// quoteStart is a prompt's first 80 characters, quoted, for an error row.
func quoteStart(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	if utf8.RuneCountInString(text) > 80 {
		r := []rune(text)
		text = string(r[:80]) + "…"
	}
	return `"` + text + `"`
}

// carryLocked keeps what an ending connection held for the next conversation
// in its pane. Called with h.mu held, from dropLocked.
func (h *modHub) carryLocked(c *modConn) {
	c.mu.Lock()
	held, waiting, pane, user, sid := c.pendingLocked(), slices.Clone(c.waiting), c.pane, c.user, c.sid
	c.held, c.steering, c.waiting = nil, nil, nil
	c.mu.Unlock()
	if len(held) == 0 || pane == "" {
		return
	}
	h.carry[hubKey(user, pane)] = heldCarry{sid: sid, texts: held, waiting: waiting}
}

// adoptLocked gives a new connection what its conversation held before this
// process started, and what the last conversation in its pane left. Called
// with h.mu held, from hello.
func (h *modHub) adoptLocked(c *modConn, pane string) {
	held := h.files.load(c.user, c.sid)
	waiting := h.files.loadWaiting(c.user, c.sid)
	if carried, ok := h.carry[hubKey(c.user, pane)]; ok && carried.sid != c.sid {
		delete(h.carry, hubKey(c.user, pane))
		held = append(held, carried.texts...)
		waiting = append(waiting, carried.waiting...)
		h.files.move(c.user, carried.sid, c.sid, held, waiting)
	}
	c.held, c.waiting = splitWaiting(held, waiting)
}

// splitWaiting takes the prompts named in waiting out of held, one for one by
// text, oldest first: what a restart reads back is every pending prompt and,
// separately, which of them wait for the turn's end.
func splitWaiting(held, waiting []string) (steer, wait []string) {
	left := slices.Clone(waiting)
	for _, t := range held {
		if i := slices.Index(left, t); i >= 0 {
			left = slices.Delete(left, i, i+1)
			wait = append(wait, t)
			continue
		}
		steer = append(steer, t)
	}
	return steer, wait
}

// takeReply is POST /prompt/{session}/unqueue's answer, and the queue a Stop
// hands back: whether anything came back, and what, oldest first.
type takeReply struct {
	Restored bool     `json:"restored"`
	Queue    []string `json:"queue"`
}

// handleUnqueue hands back every prompt held behind the session's running
// turn, for the Text view's Up to put in the field to edit. Nothing is sent to
// Claude: the prompts never reached it. A session with nothing held, or no
// mod, answers restored false with an empty queue.
//
// Under /prompt/ because the proxies in front of session-events forward only
// the path prefixes they name.
func handleUnqueue(rg *registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		osUser, session := osUserFrom(r.Context()), r.PathValue("session")
		out := []string{}
		if c := rg.mods.conn(osUser, session); c != nil {
			out = c.takeHeld(false)
		}
		if len(out) > 0 {
			events.Emit("claude.queue_taken", osUser, telemetry.Attrs{
				"tl.session": session, "tl.count": len(out), "tl.via": "edit",
			})
		}
		writeJSON(w, takeReply{Restored: len(out) > 0, Queue: out})
	}
}

// handleCancelQueued drops one held prompt, {"text": ...}, cancelled from its
// queued bubble in the Text view; the rest stay held. It answers as unqueue
// does, with the prompt it dropped, or restored false when nothing held
// matches (Claude has it already, or the session has no mod).
//
// A route of its own rather than a body on unqueue: a session-events from
// before this ignores unqueue's body and hands back every held prompt, so a
// newer page cancelling one would lose them all. This route answers 404
// there instead.
func handleCancelQueued(rg *registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		osUser, session := osUserFrom(r.Context()), r.PathValue("session")
		var body struct {
			Text string `json:"text"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, cancelBodyLimit)).Decode(&body) != nil ||
			strings.TrimSpace(body.Text) == "" {
			http.Error(w, "body must name the prompt: {\"text\": ...}", http.StatusBadRequest)
			return
		}
		out := []string{}
		if c := rg.mods.conn(osUser, session); c != nil {
			if gone, ok := c.cancelHeld(body.Text); ok {
				out = []string{gone}
			}
		}
		if len(out) > 0 {
			events.Emit("claude.queue_taken", osUser, telemetry.Attrs{
				"tl.session": session, "tl.count": 1, "tl.via": "cancel",
			})
		}
		writeJSON(w, takeReply{Restored: len(out) > 0, Queue: out})
	}
}
