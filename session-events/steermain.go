package main

// A prompt the lobby holds behind Claude's running main turn (held.go) can
// reach Claude before the turn ends, the way a prompt typed in the pane does:
// at the turn's next tool boundary. The mod's tool.call hook asks for what is
// held (POST /mod/v1/take-held) and attaches each prompt to that tool's
// result as context, which the model reads before its next step
// (claude-mod/hooks/lib/steermain.ts). Viktor, 2026-10-10: "let's make it
// steer similarly to how Claude code works".
//
// Taken, a prompt is steering until Claude stores the row that carries it
// (sessionio.MainSteerTexts): then it has arrived, and its queued ghost goes.
// Nothing about the take itself says the context will land: the mod's request
// can time out, and the call can end in a way that carries none. So what no
// row confirms is held again in effect: the turn's end sends it as it would
// any held prompt (releaseHeld), a Stop hands it back (takeHeld), and the
// file keeps it across a restart (pendingLocked).
//
// The mod asks; nothing here pushes. A mod reload forgets everything in the
// module, and a prompt the mod held itself would be lost with it, and taking
// one back would need a round trip to the mod.

import (
	"encoding/json"
	"net/http"
	"slices"

	"terminal-lobby/sessionio"
	"terminal-lobby/telemetry"
)

// takeBodyLimit bounds POST /mod/v1/take-held's body, which is a token.
const takeBodyLimit = 4 << 10

// takeForSteer hands the mod every held prompt, oldest first, to deliver into
// the running turn, and keeps them as steering. Nothing while no main turn is
// known to run: what is held then is about to go out as the next turn, and a
// tool call seen then belongs to a turn this fold has not caught up with.
//
// The file is not written: it keeps steering and held prompts alike.
func (c *modConn) takeForSteer() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.held) == 0 || !c.knownLocked() || !c.st.turnOpen {
		return []string{}
	}
	out := c.held
	c.steering = append(c.steering, out...)
	c.held = nil
	return out
}

// confirmSteered marks the n oldest steering prompts as arrived, the count a
// stored row delivered, and takes their ghosts off the stream's queue. By
// count rather than by text: the row's copy of a long paste is capped, and
// the prompts are delivered in the order they were taken. Called from apply,
// under applyMu.
func (c *modConn) confirmSteered(n int, fs *sessionio.FileSource, at int64) {
	c.mu.Lock()
	k := min(n, len(c.steering))
	if k == 0 {
		c.mu.Unlock()
		return
	}
	gone := c.steering[:k]
	c.steering = c.steering[k:]
	pending, waiting, user, sid, session := c.pendingLocked(), slices.Clone(c.waiting), c.user, c.sid, c.session
	c.mu.Unlock()
	c.hub.files.keep(user, sid, pending, waiting)
	fs.Unqueue(gone, at)
	events.Emit("claude.prompt_steered", user, telemetry.Attrs{"tl.session": session, "tl.count": k})
}

// handleTakeHeld serves POST /mod/v1/take-held, {"token": ...}: the held
// prompts for the mod to deliver at the tool boundary it is at, as
// {"texts": [...]}, an empty list when there are none.
func (h *modHub) handleTakeHeld() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Token string `json:"token"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, takeBodyLimit)).Decode(&b) != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		c := h.byTokenOf(b.Token)
		if c == nil {
			http.Error(w, "unknown token", http.StatusConflict)
			return
		}
		writeJSON(w, struct {
			Texts []string `json:"texts"`
		}{c.takeForSteer()})
	}
}
