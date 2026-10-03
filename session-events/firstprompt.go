package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"terminal-lobby/sessionio"
	"terminal-lobby/telemetry"
)

// A first prompt, timed (docs/plans/2026-10-03-first-prompt-latency-design.md).
//
// The New-session composer's first prompt is timed from the Send press to two
// moments: Accepted, when the session's mod acks it and the POST returns, and
// Shown, when Claude's own record of it arrives as a row. The browser sees the
// first and usually not the second, since after a create it rarely has a Text
// view open, so session-events records both. The browser says how long before
// its request Send was pressed; everything after the request arrived is
// measured here, on one clock.

// firstPromptMarkTTL is how long an accepted first prompt waits to be shown.
// A slash command may never be recorded at all, and its mark must not stand
// for good, nor take the next prompt's row.
const firstPromptMarkTTL = 2 * time.Minute

// firstPromptMark is a first prompt the mod has accepted and Claude has not
// yet recorded.
type firstPromptMark struct {
	session, user string
	text          string
	sent          time.Time // the Send press, on this clock
	accepted      time.Time
	hidden        bool
}

// markFirstPrompt holds m until its row arrives, dropping marks that have
// waited past firstPromptMarkTTL.
func (c *modConn) markFirstPrompt(m firstPromptMark) {
	c.mu.Lock()
	defer c.mu.Unlock()
	cut := time.Now().Add(-firstPromptMarkTTL)
	kept := c.firstPrompts[:0]
	for _, old := range c.firstPrompts {
		if old.sent.After(cut) {
			kept = append(kept, old)
		}
	}
	c.firstPrompts = append(kept, m)
}

// firstPromptShown records prompt.landed for the oldest marked first prompt a
// row is the record of. The CLI trims trailing whitespace from what it
// records (measured 2026-08-18), so both sides are trimmed before comparing.
// One row accounts for one prompt.
func (c *modConn) firstPromptShown(ev sessionio.ModEvent, now time.Time) {
	if ev.Type != sessionio.ModRowEvent || ev.AgentID != "" || ev.Message == nil || ev.Message.IsMeta {
		return
	}
	rec := sessionio.Record{Message: sessionio.Message{Role: ev.Message.Role, Content: ev.Message.Content}}
	if rec.Role() != "user" {
		return
	}
	text := strings.TrimSpace(rec.Text())
	if text == "" {
		return
	}
	c.mu.Lock()
	var m firstPromptMark
	found := false
	for i, p := range c.firstPrompts {
		if strings.TrimSpace(p.text) == text {
			m, found = p, true
			c.firstPrompts = append(c.firstPrompts[:i], c.firstPrompts[i+1:]...)
			break
		}
	}
	c.mu.Unlock()
	if !found {
		return
	}
	events.Emit("prompt.landed", m.user, telemetry.Attrs{
		"tl.session":   m.session,
		"tl.first":     true,
		"tl.post_ms":   m.accepted.Sub(m.sent).Milliseconds(),
		"tl.settle_ms": now.Sub(m.sent).Milliseconds(),
		"tl.n":         len(m.text),
		"tl.hidden":    m.hidden,
	})
}

// handleClaimed serves POST /hooks/claimed, which tmux-user-attach posts the
// moment it claims a pre-warm slot by renaming it.
//
// The slot's mod said hello under the slot's name and learns a new one only
// when asked. Asking here, rather than when the first prompt arrives, moves
// the mod under the session's name while the browser is still attaching, so
// the prompt finds it waiting. The prompt route asks too (servePromptViaMod),
// which covers a claim post that never arrived.
//
// Answered 202 before the ask: the claim script does not wait on it, and the
// hello it leads to is what anything waiting cares about.
func handleClaimed(rg *registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			User    string `json:"user"`
			Session string `json:"session"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, hookBodyLimit)).Decode(&body) != nil ||
			body.User == "" || !modSessionRe.MatchString(body.Session) {
			http.Error(w, "bad body (need user, session)", http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusAccepted)
		go rg.mods.follow(context.Background(), body.User, body.Session, modFollowWait)
	}
}
