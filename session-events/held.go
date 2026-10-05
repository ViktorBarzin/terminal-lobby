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

func (s heldFiles) load(user, sid string) []string {
	p := s.path(user, sid)
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

// save writes the conversation's held prompts, or removes the file when there
// are none. A failure is logged: the prompts are still held in memory.
func (s heldFiles) save(user, sid string, texts []string) {
	p := s.path(user, sid)
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

func (s heldFiles) move(user, from, to string, texts []string) {
	s.save(user, from, nil)
	s.save(user, to, texts)
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
	sid   string
	texts []string
}

// known reports whether the fold says what the session is doing: the snapshot
// a hello asks for has been folded. Before that a running turn may read as
// none. Called with c.mu held.
func (c *modConn) knownLocked() bool {
	return c.stamps && c.ls != nil && !c.historyOwed && !c.fullOnState
}

// hold keeps a prompt behind the running main turn and shows it queued. False
// when no main turn is known to run: the caller sends it now.
func (c *modConn) hold(text string) bool {
	// Ordered against apply, so a turn end being folded either sees this
	// prompt and sends it, or comes first and this sends it now.
	c.applyMu.Lock()
	defer c.applyMu.Unlock()
	c.mu.Lock()
	if !c.knownLocked() || !c.st.turnOpen {
		c.mu.Unlock()
		return false
	}
	c.held = append(c.held, text)
	held, ls, user, sid := slices.Clone(c.held), c.ls, c.user, c.sid
	c.mu.Unlock()
	c.hub.files.save(user, sid, held)
	ls.fs.Queue(text, c.hub.now().UnixMilli())
	return true
}

// takeHeld hands back every held prompt, oldest first, and takes them off the
// stream's queue.
func (c *modConn) takeHeld() []string {
	c.applyMu.Lock()
	defer c.applyMu.Unlock()
	c.mu.Lock()
	out, ls, user, sid := c.held, c.ls, c.user, c.sid
	c.held = nil
	c.mu.Unlock()
	if len(out) == 0 {
		return []string{}
	}
	c.hub.files.save(user, sid, nil)
	if ls != nil {
		ls.fs.Unqueue(out, c.hub.now().UnixMilli())
	}
	return out
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
	held, ls, user, sid := slices.Clone(c.held), c.ls, c.user, c.sid
	c.mu.Unlock()
	c.hub.files.save(user, sid, held)
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
	held, ls := slices.Clone(c.held), c.ls
	c.mu.Unlock()
	if ls == nil {
		return
	}
	at := c.hub.now().UnixMilli()
	for _, t := range held {
		ls.fs.Queue(t, at)
	}
}

// releaseHeld sends what is held once no main turn runs. Called from apply,
// under applyMu. The sends wait for acks that arrive through apply, so they go
// on their own goroutine.
func (c *modConn) releaseHeld() {
	c.mu.Lock()
	if len(c.held) == 0 || !c.knownLocked() || c.st.turnOpen {
		c.mu.Unlock()
		return
	}
	out, ls, user, sid := c.held, c.ls, c.user, c.sid
	c.held = nil
	c.mu.Unlock()
	c.hub.files.save(user, sid, nil)
	go c.submitHeld(out, ls)
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
	held, pane, user, sid := c.held, c.pane, c.user, c.sid
	c.held = nil
	c.mu.Unlock()
	if len(held) == 0 || pane == "" {
		return
	}
	h.carry[hubKey(user, pane)] = heldCarry{sid: sid, texts: held}
}

// adoptLocked gives a new connection what its conversation held before this
// process started, and what the last conversation in its pane left. Called
// with h.mu held, from hello.
func (h *modHub) adoptLocked(c *modConn, pane string) {
	held := h.files.load(c.user, c.sid)
	if carried, ok := h.carry[hubKey(c.user, pane)]; ok && carried.sid != c.sid {
		delete(h.carry, hubKey(c.user, pane))
		held = append(held, carried.texts...)
		h.files.move(c.user, carried.sid, c.sid, held)
	}
	c.held = held
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
			out = c.takeHeld()
		}
		if len(out) > 0 {
			events.Emit("claude.queue_taken", osUser, telemetry.Attrs{
				"tl.session": session, "tl.count": len(out), "tl.via": "edit",
			})
		}
		writeJSON(w, takeReply{Restored: len(out) > 0, Queue: out})
	}
}
