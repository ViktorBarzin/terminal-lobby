package sessionio

import (
	"encoding/json"
	"strconv"
	"time"
)

// Normalizer turns Claude Code transcript records into normalized Events.
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
//     continuing (see EndsTurn), or when the operator interrupts it (see
//     InterruptNotice), which emits one KindTurnEnd.
//   - work that appears after a turn closed without a new prompt (a Stop hook
//     continuing the agent) opens a fresh turn, so it is never filed under a
//     turn the renderer has already settled.
type Normalizer struct {
	session     string
	seq         int64
	turnID      string
	turnN       int
	turnDone    bool   // the current turn has already emitted its turn_end
	doneMsg     string // message.id of the assistant response that closed it
	interruptAt int64  // epoch ms of an interrupt the transcript has not caught up with
}

func NewNormalizer(session string) *Normalizer { return &Normalizer{session: session} }

// MaxInlineResult caps what one tool result may put on the wire. Measured over
// the transcripts on this box, tool results run to 673 KB and one session holds
// 5.5 MB of them; replaying that to a phone on open is not worth doing for
// output that renders collapsed. Past the cap the flattened text is cut with a
// marker and the structured form is dropped whole — truncating JSON would only
// produce something no reader can parse — and the event is marked Truncated so
// the renderer can offer to fetch the rest (see FullResult).
const MaxInlineResult = 8 << 10

// cap returns s cut to MaxInlineResult with a marker, and whether it cut.
func capText(s string) (string, bool) { return capTextTo(s, MaxInlineResult) }

// capTextTo is capText against an explicit budget. A string nested INSIDE a
// result has to leave room for the rest of the object, so it gets a smaller
// one — cut to the full cap, the enclosing JSON came out over the limit again
// and the whole result was dropped, which is the failure this exists to avoid.
func capTextTo(s string, max int) (string, bool) {
	if len(s) <= max {
		return s, false
	}
	return s[:max] + "\n… truncated, " + strconv.Itoa(len(s)-max) + " bytes not shown", true
}

// bulkyResultFields are the keys a structured tool result carries for the
// harness's benefit rather than a reader's. An Edit records `originalFile` —
// the ENTIRE file as it was before the change — beside the structuredPatch that
// describes the change itself, and a Write records the whole new `content`.
// They are what pushes a result past the cap, and they are the parts nothing
// renders.
var bulkyResultFields = []string{"originalFile", "content", "oldString", "newString"}

// pruneResult trims an oversized structured result to the parts a reader needs,
// and reports whether it had to change anything.
//
// Dropping an oversized result whole cost the diff: measured across the six most
// recent transcripts on this box, 209 tool results carried a structuredPatch and
// 54 of them exceeded MaxInlineResult — every one of those would have rendered
// as a file change with no visible change. Removing the bulky fields brings 48
// of the 54 back under the cap; the remaining 6 are patches that are genuinely
// enormous, and those are dropped rather than shown in part.
//
// Pruning is deliberately shallow and key-based. A result is a different shape
// per tool family, and guessing at nested structure would be how a future tool's
// output gets mangled; anything this does not recognise is left alone and judged
// on size, the same as before.
func pruneResult(raw json.RawMessage) (json.RawMessage, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	if len(raw) <= MaxInlineResult {
		return raw, false
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return nil, true // not an object — nothing safe to prune
	}
	for _, k := range bulkyResultFields {
		delete(fields, k)
	}
	// Command output is trimmed rather than removed: its head is usually the
	// part that says what happened, and stderr is short and almost always worth
	// keeping whole.
	for _, k := range []string{"stdout", "stderr"} {
		var s string
		if raw, ok := fields[k]; ok && json.Unmarshal(raw, &s) == nil {
			if cut, did := capTextTo(s, MaxInlineResult/2); did {
				if b, err := json.Marshal(cut); err == nil {
					fields[k] = b
				}
			}
		}
	}
	out, err := json.Marshal(fields)
	if err != nil || len(out) > MaxInlineResult {
		return nil, true
	}
	return out, true
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

// Line normalizes one transcript JSONL line into zero or more Events.
// Unparseable input yields nil.
func (n *Normalizer) Line(b []byte) []Event {
	rec, ok := DecodeRecord(b)
	if !ok {
		return nil
	}
	return n.Record(rec)
}

// Record normalizes an already-decoded transcript record. Non-conversation
// records (meta lines: mode, permission-mode, last-prompt, attachment, …) yield
// nil.
func (n *Normalizer) Record(rec Record) []Event {
	if !rec.Conversational() {
		return n.meta(rec)
	}
	// A compaction boundary is written as a user-role record, so the "the human
	// spoke" test claims it and the summary renders as an enormous prompt
	// nobody typed — and opens a turn around it. It is session lifecycle, not
	// conversation.
	if rec.IsCompactSummary {
		e := n.emit(KindMeta, parseAt(rec.Timestamp))
		e.Meta = MetaCompact
		return []Event{e}
	}
	// The message role is authoritative; the line type is the fallback for the
	// older lines that omit it.
	role := rec.Role()
	blocks := rec.Blocks()
	at := parseAt(rec.Timestamp)

	// An interrupt is the transcript reporting a key press, not a prompt: it
	// settles the turn it landed in instead of opening one.
	if notice, ok := interruptNotice(role, rec.IsMeta, blocks); ok {
		e := n.emit(KindState, at)
		e.Body = notice
		out := []Event{e}
		if !n.turnDone {
			n.turnDone, n.doneMsg = true, ""
			out = append(out, n.emit(KindTurnEnd, at))
		}
		return out
	}

	// isPrompt: the human actually said something (see the turn model above).
	// isMeta lines are skill/system text injected as if the user typed it.
	isPrompt := role == "user" && !rec.IsMeta && hasBlock(blocks, "text")
	switch {
	case isPrompt:
		n.startTurn()
	case n.turnDone && !n.sameResponse(role, rec.Message.ID) &&
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
		case "thinking":
			e := n.emit(KindThinking, at)
			e.Body = bl.Thinking
			out = append(out, e)
		case "tool_use":
			e := n.emit(KindToolUse, at)
			e.Tool, e.ToolID = bl.Name, bl.ID
			e.Body = string(bl.Input)
			out = append(out, e)
		case "tool_result":
			e := n.emit(KindToolResult, at)
			e.ToolID, e.IsError = bl.ToolUseID, bl.IsError
			body, cut := capText(decodeToolResult(bl.Content))
			e.Body = body
			// The structured result is where the stdout/stderr split and the
			// diff live, so an oversized one is PRUNED down to those parts
			// rather than dropped whole (see pruneResult).
			res, pruned := pruneResult(rec.ToolUseResult)
			e.Result = res
			e.Truncated = cut || pruned
			out = append(out, e)
		}
	}

	// Subagent work shares the transcript with the main thread; the renderer
	// nests it rather than interleaving it.
	if rec.IsSidechain {
		for i := range out {
			out[i].Sidechain = true
		}
	}

	// One turn_end per turn: Claude splits a single reply across several lines
	// (thinking, then text) that all repeat the same terminal stop_reason.
	if role == "assistant" && !n.turnDone && EndsTurn(rec.Message.StopReason) {
		n.turnDone, n.doneMsg = true, rec.Message.ID
		end := n.emit(KindTurnEnd, at)
		end.Usage = rec.Message.Usage
		out = append(out, end)
	}
	// A prompt the operator has already interrupted arrives dead: it opens a
	// turn nobody is working on, and Claude will write nothing further about
	// it. Settle it as it opens (see Interrupt).
	if isPrompt && n.interruptAt > 0 && at > 0 && at <= n.interruptAt {
		n.interruptAt = 0
		out = append(out, n.emit(KindTurnEnd, at))
	}
	return out
}

// meta turns a non-conversation record into the session-lifecycle events the
// renderer shows as inline markers: the mode in force, a prompt sitting in the
// queue, a hook that failed. Records that say nothing a reader would act on —
// a system summary with no errors, a dequeue (the queue being drained is just
// the prompt arriving, which the transcript reports anyway) — yield nothing.
//
// This is the one place that reads past Conversational(). That whitelist stays
// exactly as it is: the T3 bridge mirrors conversation only, and a `mode` record
// is not something to put in a thread.
func (n *Normalizer) meta(rec Record) []Event {
	at := parseAt(rec.Timestamp)
	emit := func(m Meta, body string) []Event {
		e := n.emit(KindMeta, at)
		e.Meta, e.Body = m, body
		return []Event{e}
	}
	switch rec.Type {
	case RecordMode:
		if rec.Mode != "" {
			return emit(MetaMode, rec.Mode)
		}
	case RecordPermissionMode:
		if rec.PermissionMode != "" {
			return emit(MetaPermissionMode, rec.PermissionMode)
		}
	case RecordQueueOperation:
		if rec.Operation == "enqueue" && rec.Content != "" {
			return emit(MetaQueued, rec.Content)
		}
	case RecordSystem:
		if s := string(rec.HookErrors); s != "" && s != "[]" && s != "null" {
			return emit(MetaHookError, s)
		}
	}
	return nil
}

// Interrupt reports that the operator interrupted this session at `at` (epoch
// ms) and returns the event that settles the turn it landed in, if one is open.
//
// It exists because the transcript cannot always tell. Interrupting after
// Claude has started streaming leaves "[Request interrupted by user]" behind
// and InterruptNotice settles the turn from the file. Interrupting BEFORE the
// first token leaves nothing at all — no notice, sometimes not even the prompt
// line — so a turn the renderer has already opened would never close and the
// composer would sit on "Working…" + Stop for the life of the session. Whoever
// injects the interrupt owns the transition, the same way Injector.Cancel owns
// @claude_state (see tmux.go).
//
// The transcript stays the authority for what a turn CONTAINS: this marks no
// normalizer state as done, so lines still in flight keep landing in the turn
// they belong to instead of opening a spurious new one. A transcript notice
// arriving later settles the same turn a second time, which the renderer folds
// into the same "this turn is over".
//
// The timestamp is also kept as a watermark for the tail: see Record.
func (n *Normalizer) Interrupt(at int64) (Event, bool) {
	n.interruptAt = at
	if n.turnID == "" || n.turnDone {
		return Event{}, false
	}
	return n.emit(KindTurnEnd, at), true
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

// decodeToolResult accepts a tool_result content as a JSON string or an array of
// {type:text,text} blocks.
func decodeToolResult(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var blocks []Block
	if json.Unmarshal(raw, &blocks) == nil {
		for _, b := range blocks {
			if b.Type == "text" {
				return b.Text
			}
		}
	}
	return string(raw)
}
