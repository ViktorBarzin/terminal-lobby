package main

import (
	"testing"
	"time"
)

// kinds is a compact view of an event slice, for readable failure messages.
func kinds(evs []Event) []Kind {
	out := make([]Kind, 0, len(evs))
	for _, e := range evs {
		out = append(out, e.Kind)
	}
	return out
}

func TestNormalizeAssistantTextAndToolPairing(t *testing.T) {
	n := NewNormalizer("demo")
	var out []Event
	out = append(out, n.Line([]byte(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"},{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"ls"}}]},"uuid":"a1","timestamp":"2026-07-19T00:00:00Z"}`))...)
	out = append(out, n.Line([]byte(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","content":"file.txt","is_error":false}]},"uuid":"a2"}`))...)

	if len(out) != 3 {
		t.Fatalf("want 3 events (text, tool_use, tool_result), got %d: %+v", len(out), out)
	}
	if out[0].Kind != KindText || out[0].Body != "hi" {
		t.Fatalf("event0 = %+v", out[0])
	}
	if out[1].Kind != KindToolUse || out[1].Tool != "Bash" || out[1].ToolID != "tu_1" {
		t.Fatalf("event1 = %+v", out[1])
	}
	if out[2].Kind != KindToolResult || out[2].ToolID != "tu_1" || out[2].Body != "file.txt" || out[2].IsError {
		t.Fatalf("event2 = %+v", out[2])
	}
	// IDs are monotonic within a normalizer.
	if out[0].ID != 1 || out[1].ID != 2 || out[2].ID != 3 {
		t.Fatalf("ids not monotonic: %d %d %d", out[0].ID, out[1].ID, out[2].ID)
	}
}

func TestNormalizeToolResultAsBlockArray(t *testing.T) {
	n := NewNormalizer("demo")
	out := n.Line([]byte(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_9","content":[{"type":"text","text":"blockbody"}],"is_error":true}]}}`))
	if len(out) != 1 || out[0].Body != "blockbody" || !out[0].IsError {
		t.Fatalf("block-array tool_result = %+v", out)
	}
}

func TestNormalizeSkipsMetaLines(t *testing.T) {
	n := NewNormalizer("demo")
	for _, meta := range []string{
		`{"type":"mode","mode":"default","sessionId":"x"}`,
		`{"type":"permission-mode","permissionMode":"default","sessionId":"x"}`,
		`{"type":"last-prompt","leafUuid":"u","sessionId":"x"}`,
	} {
		if got := n.Line([]byte(meta)); len(got) != 0 {
			t.Fatalf("meta %q should yield no events, got %+v", meta, got)
		}
	}
}

func TestNormalizeIgnentsGarbage(t *testing.T) {
	n := NewNormalizer("demo")
	if got := n.Line([]byte(`not json`)); got != nil {
		t.Fatalf("garbage should yield nil, got %+v", got)
	}
}

// --- role, turn structure and timestamps -----------------------------------
//
// The renderer distinguishes the human's prompt from Claude's answer, folds
// finished turns, and stops showing "Working…" once a turn ends. All three read
// fields the normalizer must put on the wire: kind=user, turnId, turn_end, at.

// A typed prompt is the user's, not Claude's: it must arrive as kind "user" so
// the renderer draws a plain bubble instead of interpreting it as markdown.
func TestNormalizeUserPromptIsUserKind(t *testing.T) {
	n := NewNormalizer("demo")
	out := n.Line([]byte(`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"![logo](/icons/icon-192.png)"}]},"promptSource":"sdk","uuid":"u1","timestamp":"2026-08-06T10:00:00.000Z"}`))
	if len(out) != 1 {
		t.Fatalf("want 1 event, got %d: %+v", len(out), out)
	}
	if out[0].Kind != KindUser {
		t.Fatalf("user prompt kind = %q, want %q (event=%+v)", out[0].Kind, KindUser, out[0])
	}
	if out[0].Body != "![logo](/icons/icon-192.png)" {
		t.Fatalf("user prompt body = %q, want the raw typed text verbatim", out[0].Body)
	}
}

// A plain-string user message is the same thing in another encoding.
func TestNormalizeUserPromptAsPlainString(t *testing.T) {
	n := NewNormalizer("demo")
	out := n.Line([]byte(`{"type":"user","message":{"role":"user","content":"say ok"},"timestamp":"2026-08-06T10:00:00Z"}`))
	if len(out) != 1 || out[0].Kind != KindUser || out[0].Body != "say ok" {
		t.Fatalf("string-content user prompt = %+v", out)
	}
}

// Assistant prose stays kind "text" — the renderer markdown-renders it.
func TestNormalizeAssistantTextStaysTextKind(t *testing.T) {
	n := NewNormalizer("demo")
	out := n.Line([]byte(`{"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"text","text":"thinking out loud"}]},"timestamp":"2026-08-06T10:00:01Z"}`))
	if len(out) != 1 || out[0].Kind != KindText {
		t.Fatalf("assistant text = %+v, want kind %q", out, KindText)
	}
}

// tool_result rides in on a line typed "user" but is NOT the human speaking:
// it must stay a tool_result and must not open a new turn.
func TestNormalizeToolResultLineIsNotAUserPrompt(t *testing.T) {
	n := NewNormalizer("demo")
	var out []Event
	out = append(out, n.Line([]byte(`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"go"}]},"timestamp":"2026-08-06T10:00:00Z"}`))...)
	out = append(out, n.Line([]byte(`{"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"ls"}}]},"timestamp":"2026-08-06T10:00:01Z"}`))...)
	out = append(out, n.Line([]byte(`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_1","content":"file.txt"}]},"toolUseResult":{},"timestamp":"2026-08-06T10:00:02Z"}`))...)

	if got := kinds(out); len(got) != 3 || got[2] != KindToolResult {
		t.Fatalf("kinds = %v, want [user tool_use tool_result]", got)
	}
	if out[2].TurnID != out[0].TurnID {
		t.Fatalf("tool_result opened a new turn: %q vs prompt %q", out[2].TurnID, out[0].TurnID)
	}
}

// Skill/system text is injected as a user-typed line with isMeta — it is not a
// prompt and must not split the turn.
func TestNormalizeMetaUserLineIsNotAPrompt(t *testing.T) {
	n := NewNormalizer("demo")
	var out []Event
	out = append(out, n.Line([]byte(`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"real prompt"}]},"timestamp":"2026-08-06T10:00:00Z"}`))...)
	out = append(out, n.Line([]byte(`{"type":"user","isMeta":true,"message":{"role":"user","content":[{"type":"text","text":"Base directory for this skill: /x"}]},"timestamp":"2026-08-06T10:00:01Z"}`))...)

	if len(out) != 2 {
		t.Fatalf("want 2 events, got %d: %+v", len(out), out)
	}
	if out[1].Kind == KindUser {
		t.Fatalf("isMeta line was reported as a user prompt: %+v", out[1])
	}
	if out[1].TurnID != out[0].TurnID {
		t.Fatalf("isMeta line opened a new turn: %q vs %q", out[1].TurnID, out[0].TurnID)
	}
}

// Every event in a turn carries the same non-empty turnId; the next prompt
// starts a new one. Without this the renderer lumps a whole session into one
// synthetic turn that can never settle.
func TestNormalizeAssignsTurnIDAtUserBoundaries(t *testing.T) {
	n := NewNormalizer("demo")
	var out []Event
	for _, ln := range []string{
		`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"first"}]},"timestamp":"2026-08-06T10:00:00Z"}`,
		`{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"one"}]},"timestamp":"2026-08-06T10:00:01Z"}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"second"}]},"timestamp":"2026-08-06T10:00:02Z"}`,
		`{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"two"}]},"timestamp":"2026-08-06T10:00:03Z"}`,
	} {
		out = append(out, n.Line([]byte(ln))...)
	}
	for _, e := range out {
		if e.TurnID == "" {
			t.Fatalf("event has empty turnId: %+v (all=%+v)", e, out)
		}
	}
	if out[0].TurnID != out[1].TurnID {
		t.Fatalf("prompt and its answer are in different turns: %q vs %q", out[0].TurnID, out[1].TurnID)
	}
	second := out[len(out)-1].TurnID
	if second == out[0].TurnID {
		t.Fatalf("the second prompt reused turn %q; a prompt must start a new turn", second)
	}
}

// A finished turn must announce itself, or the renderer keeps the turn "running"
// forever: no fold row, a permanent "Working…" row, and a composer stuck on Stop.
func TestNormalizeEmitsTurnEndWhenTheTurnEnds(t *testing.T) {
	n := NewNormalizer("demo")
	var out []Event
	out = append(out, n.Line([]byte(`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"say ok"}]},"timestamp":"2026-08-06T10:00:00Z"}`))...)
	out = append(out, n.Line([]byte(`{"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use","id":"tu_1","name":"Bash","input":{}}]},"timestamp":"2026-08-06T10:00:01Z"}`))...)

	for _, e := range out {
		if e.Kind == KindTurnEnd {
			t.Fatalf("turn_end emitted mid-turn (stop_reason=tool_use): %+v", out)
		}
	}

	out = append(out, n.Line([]byte(`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_1","content":"ok"}]},"timestamp":"2026-08-06T10:00:02Z"}`))...)
	out = append(out, n.Line([]byte(`{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"OK."}]},"timestamp":"2026-08-06T10:00:03Z"}`))...)

	last := out[len(out)-1]
	if last.Kind != KindTurnEnd {
		t.Fatalf("last event = %v, want %q to close the turn (kinds=%v)", last.Kind, KindTurnEnd, kinds(out))
	}
	if last.TurnID != out[0].TurnID {
		t.Fatalf("turn_end carries turn %q, want the turn it closes (%q)", last.TurnID, out[0].TurnID)
	}
	if n := countKind(out, KindTurnEnd); n != 1 {
		t.Fatalf("got %d turn_end events for one turn, want exactly 1 (kinds=%v)", n, kinds(out))
	}
}

// Claude splits one reply across several transcript lines (thinking, then text)
// that all repeat stop_reason=end_turn. That is still one turn ending once.
func TestNormalizeEmitsTurnEndOncePerTurn(t *testing.T) {
	n := NewNormalizer("demo")
	var out []Event
	out = append(out, n.Line([]byte(`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]},"timestamp":"2026-08-06T10:00:00Z"}`))...)
	out = append(out, n.Line([]byte(`{"type":"assistant","message":{"id":"msg_1","role":"assistant","stop_reason":"end_turn","content":[{"type":"thinking","thinking":"…"}]},"timestamp":"2026-08-06T10:00:01Z"}`))...)
	out = append(out, n.Line([]byte(`{"type":"assistant","message":{"id":"msg_1","role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"hello"}]},"timestamp":"2026-08-06T10:00:02Z"}`))...)
	if got := countKind(out, KindTurnEnd); got != 1 {
		t.Fatalf("got %d turn_end events across one split reply, want 1 (kinds=%v)", got, kinds(out))
	}
	// …and the whole reply stays in the prompt's turn.
	for _, e := range out {
		if e.TurnID != out[0].TurnID {
			t.Fatalf("split reply spilled into turn %q, want %q (kinds=%v)", e.TurnID, out[0].TurnID, kinds(out))
		}
	}
}

// Work that resumes after a turn ended (a Stop hook continuing the agent) must
// open a fresh turn, otherwise it lands inside a turn already marked settled and
// the renderer shows no working row while Claude is in fact running.
func TestNormalizeContinuationAfterTurnEndOpensANewTurn(t *testing.T) {
	n := NewNormalizer("demo")
	var out []Event
	out = append(out, n.Line([]byte(`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]},"timestamp":"2026-08-06T10:00:00Z"}`))...)
	out = append(out, n.Line([]byte(`{"type":"assistant","message":{"id":"msg_1","role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"done"}]},"timestamp":"2026-08-06T10:00:01Z"}`))...)
	first := out[0].TurnID
	out = append(out, n.Line([]byte(`{"type":"assistant","message":{"id":"msg_2","role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use","id":"tu_2","name":"Bash","input":{}}]},"timestamp":"2026-08-06T10:00:02Z"}`))...)
	resumed := out[len(out)-1]
	if resumed.TurnID == first {
		t.Fatalf("post-turn_end work stayed in the settled turn %q", first)
	}
	if resumed.TurnID == "" {
		t.Fatalf("post-turn_end work has no turn id: %+v", resumed)
	}
}

// `at` is what turns "Worked · 3 steps" into "Worked for 4s"; without it the
// renderer cannot compute a turn duration at all.
func TestNormalizePopulatesAtFromTimestamp(t *testing.T) {
	n := NewNormalizer("demo")
	out := n.Line([]byte(`{"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"text","text":"hi"}]},"timestamp":"2026-08-06T10:00:03.500Z"}`))
	want := time.Date(2026, 8, 6, 10, 0, 3, 500_000_000, time.UTC).UnixMilli()
	if len(out) != 1 || out[0].At != want {
		t.Fatalf("at = %d, want %d (epoch ms of the line timestamp); event=%+v", out[0].At, want, out)
	}
}

// Every event of a real turn — synthesized turn_end included — carries `at`.
func TestNormalizeEveryEventOfATurnCarriesAt(t *testing.T) {
	n := NewNormalizer("demo")
	var out []Event
	for _, ln := range []string{
		`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"say ok"}]},"timestamp":"2026-08-06T10:00:00Z"}`,
		`{"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use","id":"tu_1","name":"Bash","input":{}}]},"timestamp":"2026-08-06T10:00:01Z"}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_1","content":"ok"}]},"timestamp":"2026-08-06T10:00:02Z"}`,
		`{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"OK."}]},"timestamp":"2026-08-06T10:00:04Z"}`,
	} {
		out = append(out, n.Line([]byte(ln))...)
	}
	for _, e := range out {
		if e.At == 0 {
			t.Fatalf("event without at: %+v (all kinds=%v)", e, kinds(out))
		}
	}
	// First-to-last spread is the turn duration the fold row shows.
	if d := out[len(out)-1].At - out[0].At; d != 4000 {
		t.Fatalf("turn spread = %dms, want 4000", d)
	}
}

// A line with no usable timestamp leaves `at` unset rather than inventing a
// wall-clock one — the normalizer must replay a transcript identically.
func TestNormalizeMissingTimestampLeavesAtUnset(t *testing.T) {
	n := NewNormalizer("demo")
	out := n.Line([]byte(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}`))
	if len(out) != 1 || out[0].At != 0 {
		t.Fatalf("timestamp-less line = %+v, want at unset", out)
	}
}

// End-to-end shape of the wire for two complete turns — the exact thing the
// renderer needs to draw a user bubble, fold turn 1, and show no working row.
func TestNormalizeTwoTurnsWireShape(t *testing.T) {
	n := NewNormalizer("demo")
	var out []Event
	for _, ln := range []string{
		`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"say ok"}]},"timestamp":"2026-08-06T10:00:00Z"}`,
		`{"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"echo ok"}}]},"timestamp":"2026-08-06T10:00:01Z"}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_1","content":"ok"}]},"timestamp":"2026-08-06T10:00:02Z"}`,
		`{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"OK."}]},"timestamp":"2026-08-06T10:00:03Z"}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"again"}]},"timestamp":"2026-08-06T10:00:10Z"}`,
		`{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"OK again."}]},"timestamp":"2026-08-06T10:00:12Z"}`,
	} {
		out = append(out, n.Line([]byte(ln))...)
	}
	want := []Kind{
		KindUser, KindToolUse, KindToolResult, KindText, KindTurnEnd,
		KindUser, KindText, KindTurnEnd,
	}
	got := kinds(out)
	if len(got) != len(want) {
		t.Fatalf("kinds = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("kinds = %v, want %v", got, want)
		}
	}
	t1, t2 := out[0].TurnID, out[5].TurnID
	if t1 == "" || t2 == "" || t1 == t2 {
		t.Fatalf("turn ids = %q / %q, want two distinct non-empty ids", t1, t2)
	}
	for i, e := range out[:5] {
		if e.TurnID != t1 {
			t.Fatalf("event %d (%v) has turn %q, want %q", i, e.Kind, e.TurnID, t1)
		}
	}
	for i, e := range out[5:] {
		if e.TurnID != t2 {
			t.Fatalf("event %d (%v) has turn %q, want %q", i+5, e.Kind, e.TurnID, t2)
		}
	}
}

// --- interrupts -------------------------------------------------------------
//
// Pressing ESC at a permission prompt, or the composer's Stop, makes Claude
// append the interrupt notice to the transcript as a user-ROLE text line:
//
//	{"type":"user","message":{"role":"user","content":[
//	  {"type":"text","text":"[Request interrupted by user for tool use]"}]}}
//
// It carries no isMeta key, so the plain "role==user && has a text block" test
// reads it as the human speaking. That is wrong twice over: it renders the
// notice as the operator's own words in a right-hand bubble, and it OPENS a turn
// that nothing ever closes — the interrupted response stopped at
// stop_reason "tool_use", which endsTurn deliberately treats as a continuation.
// The renderer then shows a permanent "Working…" row and a composer stuck on
// Stop, while tmux already reports the session as idle.

// The interrupt notice belongs to the turn it interrupted, and closes it.
func TestNormalizeInterruptClosesTheInterruptedTurn(t *testing.T) {
	for _, notice := range []string{
		"[Request interrupted by user for tool use]",
		"[Request interrupted by user]",
	} {
		t.Run(notice, func(t *testing.T) {
			n := NewNormalizer("demo")
			var out []Event
			out = append(out, n.Line([]byte(`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"count to 60"}]},"timestamp":"2026-08-06T10:00:00Z"}`))...)
			out = append(out, n.Line([]byte(`{"type":"assistant","message":{"id":"msg_1","role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use","id":"tu_1","name":"Bash","input":{}}]},"timestamp":"2026-08-06T10:00:01Z"}`))...)
			turn := out[0].TurnID
			at := len(out)
			out = append(out, n.Line([]byte(`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"`+notice+`"}]},"timestamp":"2026-08-06T10:00:02Z"}`))...)

			produced := out[at:]
			if len(produced) == 0 {
				t.Fatalf("the interrupt line produced no events; the renderer needs one to settle the turn")
			}
			for _, e := range produced {
				if e.Kind == KindUser {
					t.Fatalf("interrupt notice classified as a user prompt: %+v", e)
				}
				if e.TurnID != turn {
					t.Fatalf("interrupt notice landed in turn %q, want the interrupted turn %q (kinds=%v)", e.TurnID, turn, kinds(out))
				}
			}
			if got := countKind(out, KindTurnEnd); got != 1 {
				t.Fatalf("got %d turn_end for the interrupted turn, want exactly 1 (kinds=%v)", got, kinds(out))
			}
			if last := out[len(out)-1]; last.Kind != KindTurnEnd {
				t.Fatalf("last event = %v, want %v to settle the turn (kinds=%v)", last.Kind, KindTurnEnd, kinds(out))
			}
			// The notice itself still reaches the renderer, as a meta line.
			body := ""
			for _, e := range produced {
				if e.Kind == KindState {
					body = e.Body
				}
			}
			if body != notice {
				t.Fatalf("notice body = %q, want %q carried on a %v event (produced=%+v)", body, notice, KindState, produced)
			}
			if got := countKind(produced, KindText); got != 0 {
				t.Fatalf("interrupt notice emitted %d text events; it must not read as assistant prose", got)
			}
		})
	}
}

// The next real prompt after an interrupt still opens its own turn.
func TestNormalizePromptAfterInterruptOpensANewTurn(t *testing.T) {
	n := NewNormalizer("demo")
	var out []Event
	out = append(out, n.Line([]byte(`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"count to 60"}]},"timestamp":"2026-08-06T10:00:00Z"}`))...)
	out = append(out, n.Line([]byte(`{"type":"assistant","message":{"id":"msg_1","role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use","id":"tu_1","name":"Bash","input":{}}]},"timestamp":"2026-08-06T10:00:01Z"}`))...)
	first := out[0].TurnID
	out = append(out, n.Line([]byte(`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]},"timestamp":"2026-08-06T10:00:02Z"}`))...)
	out = append(out, n.Line([]byte(`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"never mind, say hi"}]},"timestamp":"2026-08-06T10:00:09Z"}`))...)

	next := out[len(out)-1]
	if next.Kind != KindUser {
		t.Fatalf("prompt after an interrupt = %v, want %v (kinds=%v)", next.Kind, KindUser, kinds(out))
	}
	if next.TurnID == first || next.TurnID == "" {
		t.Fatalf("prompt after an interrupt reused turn %q (interrupted turn %q)", next.TurnID, first)
	}
}

// An interrupt whose turn already closed normally must not emit a second
// turn_end — one turn, one settlement.
func TestNormalizeInterruptAfterTurnEndDoesNotDoubleClose(t *testing.T) {
	n := NewNormalizer("demo")
	var out []Event
	out = append(out, n.Line([]byte(`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]},"timestamp":"2026-08-06T10:00:00Z"}`))...)
	out = append(out, n.Line([]byte(`{"type":"assistant","message":{"id":"msg_1","role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"hello"}]},"timestamp":"2026-08-06T10:00:01Z"}`))...)
	out = append(out, n.Line([]byte(`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]},"timestamp":"2026-08-06T10:00:02Z"}`))...)

	if got := countKind(out, KindTurnEnd); got != 1 {
		t.Fatalf("got %d turn_end, want 1 (kinds=%v)", got, kinds(out))
	}
	if got := countKind(out, KindUser); got != 1 {
		t.Fatalf("got %d user events, want 1 — the interrupt notice is not a prompt (kinds=%v)", got, kinds(out))
	}
}

func countKind(evs []Event, k Kind) int {
	n := 0
	for _, e := range evs {
		if e.Kind == k {
			n++
		}
	}
	return n
}
