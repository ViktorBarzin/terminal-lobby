package main

import (
	"encoding/json"
	"strconv"
	"time"
)

// Normalizer turns Claude Code transcript JSONL lines into normalized Events.
// It is stateful only for the monotonic sequence and the current turn, so a
// fresh Normalizer replays a transcript identically from the start.
//
// Turn model — the renderer folds finished turns and shows "Working…" only while
// one is running, so the wire has to carry the structure the transcript implies:
//
//   - a turn OPENS at the human's prompt: a non-meta line whose role is "user"
//     and which carries a text block. Lines typed "user" that carry only a
//     tool_result are the harness feeding Claude back its own tool output, not
//     the human speaking, and stay inside the running turn.
//   - a turn CLOSES when Claude's message stops for a reason other than
//     continuing (see endsTurn), which emits one KindTurnEnd.
//   - work that appears after a turn closed without a new prompt (a Stop hook
//     continuing the agent) opens a fresh turn, so it is never filed under a
//     turn the renderer has already settled.
type Normalizer struct {
	session  string
	seq      int64
	turnID   string
	turnN    int
	turnDone bool   // the current turn has already emitted its turn_end
	doneMsg  string // message.id of the assistant response that closed it
}

func NewNormalizer(session string) *Normalizer { return &Normalizer{session: session} }

type rawLine struct {
	Type      string `json:"type"`
	IsMeta    bool   `json:"isMeta"`
	Timestamp string `json:"timestamp"`
	Message   struct {
		ID         string          `json:"id"`
		Role       string          `json:"role"`
		StopReason string          `json:"stop_reason"`
		Content    json.RawMessage `json:"content"`
	} `json:"message"`
}

type rawBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	IsError   bool            `json:"is_error"`
}

func (n *Normalizer) next() int64 { n.seq++; return n.seq }

func (n *Normalizer) emit(k Kind, at int64) Event {
	return Event{ID: n.next(), Kind: k, Session: n.session, TurnID: n.turnID, At: at}
}

// startTurn opens a new turn; every event emitted from here on carries its id
// until the next boundary.
func (n *Normalizer) startTurn() {
	n.turnN++
	n.turnID = "t" + strconv.Itoa(n.turnN)
	n.turnDone, n.doneMsg = false, ""
}

// sameResponse reports whether this line is a further block of the assistant
// response that already closed the current turn. Claude writes one transcript
// line per content block (thinking, then text) and repeats the response's
// stop_reason on each, so the trailing lines of a finished reply must not be
// mistaken for work that resumed after the turn.
func (n *Normalizer) sameResponse(role, msgID string) bool {
	return role == "assistant" && msgID != "" && msgID == n.doneMsg
}

// Line normalizes one transcript JSONL line into zero or more Events. Non-message
// (meta) lines and unparseable input yield nil.
func (n *Normalizer) Line(b []byte) []Event {
	var rl rawLine
	if json.Unmarshal(b, &rl) != nil {
		return nil
	}
	switch rl.Type {
	case "assistant", "user":
	default:
		return nil // meta lines: mode, permission-mode, last-prompt, ...
	}
	// The message role is authoritative; the line type is the fallback for the
	// older lines that omit it.
	role := rl.Message.Role
	if role == "" {
		role = rl.Type
	}
	blocks := decodeContent(rl.Message.Content)
	at := parseAt(rl.Timestamp)

	// isPrompt: the human actually said something (see the turn model above).
	// isMeta lines are skill/system text injected as if the user typed it.
	isPrompt := role == "user" && !rl.IsMeta && hasBlock(blocks, "text")
	switch {
	case isPrompt:
		n.startTurn()
	case n.turnDone && !n.sameResponse(role, rl.Message.ID) &&
		hasBlock(blocks, "text", "tool_use", "tool_result"):
		n.startTurn() // work resumed after the turn closed
	}

	var out []Event
	for _, bl := range blocks {
		switch bl.Type {
		case "text":
			k := KindText
			if isPrompt {
				k = KindUser // rendered as a plain bubble, never as markdown
			}
			e := n.emit(k, at)
			e.Body = bl.Text
			out = append(out, e)
		case "tool_use":
			e := n.emit(KindToolUse, at)
			e.Tool, e.ToolID = bl.Name, bl.ID
			e.Body = string(bl.Input)
			out = append(out, e)
		case "tool_result":
			e := n.emit(KindToolResult, at)
			e.ToolID, e.IsError = bl.ToolUseID, bl.IsError
			e.Body = decodeToolResult(bl.Content)
			out = append(out, e)
		}
	}

	// One turn_end per turn: Claude splits a single reply across several lines
	// (thinking, then text) that all repeat the same terminal stop_reason.
	if role == "assistant" && !n.turnDone && endsTurn(rl.Message.StopReason) {
		n.turnDone, n.doneMsg = true, rl.Message.ID
		out = append(out, n.emit(KindTurnEnd, at))
	}
	return out
}

// endsTurn reports whether a message stop_reason means Claude is finished.
// A turn continues only while it is calling a tool or has paused mid-turn;
// anything else (end_turn, stop_sequence, max_tokens, refusal, …) ends it.
// Whitelisting the continuations rather than the terminals keeps an
// unrecognized future stop_reason from wedging the timeline on "Working…".
func endsTurn(stopReason string) bool {
	switch stopReason {
	case "", "tool_use", "pause_turn":
		return false
	}
	return true
}

// hasBlock reports whether the content carries a block of any of these types.
func hasBlock(blocks []rawBlock, types ...string) bool {
	for _, b := range blocks {
		for _, t := range types {
			if b.Type == t {
				return true
			}
		}
	}
	return false
}

// parseAt converts a transcript RFC3339 timestamp to epoch milliseconds — the
// unit the renderer's turn duration is computed in. An absent or unparseable
// timestamp yields 0 (omitted on the wire) rather than a wall-clock guess, so a
// replay of the same transcript always produces the same events.
func parseAt(ts string) int64 {
	if ts == "" {
		return 0
	}
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return 0
	}
	return t.UnixMilli()
}

// decodeContent accepts message.content as either a plain string (wrapped into a
// single text block) or an array of blocks.
func decodeContent(raw json.RawMessage) []rawBlock {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return []rawBlock{{Type: "text", Text: s}}
	}
	var blocks []rawBlock
	if json.Unmarshal(raw, &blocks) == nil {
		return blocks
	}
	return nil
}

// decodeToolResult accepts a tool_result content as a JSON string or an array of
// {type:text,text} blocks.
func decodeToolResult(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var blocks []rawBlock
	if json.Unmarshal(raw, &blocks) == nil {
		for _, b := range blocks {
			if b.Type == "text" {
				return b.Text
			}
		}
	}
	return string(raw)
}
