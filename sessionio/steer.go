package sessionio

import (
	"bytes"
	"encoding/json"
	"strings"
)

// SteerPrefix opens every message the person sends a subagent from the Text
// view (the claude-mod's `steer` op). The engine delivers a plugin's message
// framed as the coordinator's, so the agent would otherwise take the person's
// words for the main thread's; the line says who is speaking. The view shows
// only what follows it. The mod spells it too, and a test holds the two
// together (claude-mod/hooks/register.ts).
const SteerPrefix = "The person watching this session in the lobby says:"

// steerText is what the person typed, when s is a message the lobby sent: the
// prefix at the start, bare or inside the `<teammate-message …>` envelope an
// idle teammate receives it in (both captured live on CLI 2.1.288, 2026-10-03).
func steerText(s string) (string, bool) {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "<teammate-message") {
		open := strings.Index(s, ">")
		end := strings.LastIndex(s, "</teammate-message>")
		if open < 0 || end < open {
			return "", false
		}
		s = strings.TrimSpace(s[open+1 : end])
	}
	rest, ok := strings.CutPrefix(s, SteerPrefix)
	if !ok {
		return "", false
	}
	rest = strings.TrimSpace(rest)
	return rest, rest != ""
}

// steered is an agent stream's account of a message the person sent it while
// it worked: the engine stores it as a queued_command attachment, taken at the
// agent's next tool boundary, which the agent reads as an instruction to
// address before it goes on. It opens a turn of its own, as an absorbed prompt
// does in the session's stream (see absorbed). Every other queued_command, a
// background task's notification or the main thread's own SendMessage, stays
// as it was.
func (n *Normalizer) steered(rec Record) []Event {
	if !bytes.Contains(rec.Line, []byte(`"queued_command"`)) {
		return nil
	}
	at, ok := queuedCommand(rec.Line)
	if !ok || at.Type != "queued_command" {
		return nil
	}
	var prompt string
	if json.Unmarshal(at.Prompt, &prompt) != nil {
		return nil
	}
	text, ok := steerText(prompt)
	if !ok {
		return nil
	}
	n.startTurn()
	e := n.emit(KindUser, parseAt(rec.Timestamp))
	e.Body, e.Steer = plainText(text), true
	return []Event{e}
}
