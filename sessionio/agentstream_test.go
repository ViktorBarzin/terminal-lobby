package sessionio

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// One agent's own transcript, cut down from a real agent-<id>.jsonl: every
// record is a sidechain record naming the agent, the first one is the prompt
// the agent was given, and it ends on an end_turn answer.
var agentOwnLines = []string{
	`{"type":"user","isSidechain":true,"agentId":"a1b2","timestamp":"2026-09-24T06:00:00Z","message":{"role":"user","content":"Find where the strip is drawn"}}`,
	`{"type":"attachment","isSidechain":true,"agentId":"a1b2","timestamp":"2026-09-24T06:00:00Z","attachment":{"type":"skill_listing"}}`,
	`{"type":"assistant","isSidechain":true,"agentId":"a1b2","timestamp":"2026-09-24T06:00:02Z","effort":"high","message":{"id":"m1","role":"assistant","model":"claude-sonnet-5","content":[{"type":"thinking","thinking":"Start with the text view.","signature":"s"}],"stop_reason":null,"usage":{"output_tokens":8}}}`,
	`{"type":"assistant","isSidechain":true,"agentId":"a1b2","timestamp":"2026-09-24T06:00:03Z","effort":"high","message":{"id":"m1","role":"assistant","model":"claude-sonnet-5","content":[{"type":"tool_use","id":"tu_g","name":"Grep","input":{"pattern":"tl-bg-strip"}}],"stop_reason":"tool_use","usage":{"output_tokens":40}}}`,
	`{"type":"user","isSidechain":true,"agentId":"a1b2","timestamp":"2026-09-24T06:00:04Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_g","content":"TextView.tsx:863"}]},"toolUseResult":{"mode":"content","numFiles":1}}`,
	`{"type":"assistant","isSidechain":true,"agentId":"a1b2","timestamp":"2026-09-24T06:00:06Z","effort":"high","message":{"id":"m2","role":"assistant","model":"claude-sonnet-5","content":[{"type":"text","text":"It is drawn in TextView.tsx."}],"stop_reason":"end_turn","usage":{"output_tokens":12}}}`,
}

func agentOwn(t *testing.T) []Event {
	t.Helper()
	n := NewAgentNormalizer("demo")
	var out []Event
	for _, ln := range agentOwnLines {
		out = append(out, n.Line([]byte(ln))...)
	}
	return out
}

// In the agent's own file the sidechain flag says whose file it is, not that
// the work is nested under some call: read there, the agent's records are the
// conversation, with a prompt that opens the turn and an answer that ends it.
func TestAgentNormalizerReadsTheAgentsRecordsAsItsOwnConversation(t *testing.T) {
	out := agentOwn(t)
	var got []Kind
	for _, e := range out {
		if e.Kind == KindMeta {
			continue // the model marker, asserted below
		}
		got = append(got, e.Kind)
	}
	want := []Kind{KindUser, KindThinking, KindToolUse, KindToolResult, KindText, KindTurnEnd}
	if strings.Join(kindNames(got), ",") != strings.Join(kindNames(want), ",") {
		t.Fatalf("kinds = %v, want %v", got, want)
	}
	for _, e := range out {
		if e.Sidechain || e.AgentID != "" {
			t.Fatalf("%s event %d is marked as nested work: %+v", e.Kind, e.ID, e)
		}
		if e.TurnID != "t1" {
			t.Fatalf("%s event %d is outside the agent's one turn: %q", e.Kind, e.ID, e.TurnID)
		}
	}
	if out[0].Body != "Find where the strip is drawn" {
		t.Fatalf("the prompt the agent was given = %q", out[0].Body)
	}
}

// The model the agent answers on is this thread's own, so it is reported,
// where the session's normalizer leaves a subagent's model out.
func TestAgentNormalizerReportsTheAgentsModel(t *testing.T) {
	got := modelEvent(agentOwn(t))
	if got == nil || got.Model.Model != "claude-sonnet-5" || got.Model.Effort != "high" {
		t.Fatalf("model event = %+v", got)
	}
}

// A workflow member returns its answer through StructuredOutput, and that
// tool result is the end of its turn: it writes no end_turn record at all (37
// of the 38 members of one real run). Without this the member's transcript
// reads as working forever.
func TestNormalizeSettlesATurnOnAToolResultThatEndsIt(t *testing.T) {
	member := []string{
		`{"type":"user","isSidechain":true,"agentId":"m1","timestamp":"2026-09-24T06:00:00Z","message":{"role":"user","content":"Check the setup"}}`,
		`{"type":"assistant","isSidechain":true,"agentId":"m1","timestamp":"2026-09-24T06:00:05Z","message":{"id":"x1","role":"assistant","model":"claude-opus-5-5","content":[{"type":"tool_use","id":"tu_so","name":"StructuredOutput","input":{"ok":true}}],"stop_reason":"tool_use","usage":{"output_tokens":30}}}`,
		`{"type":"attachment","isSidechain":true,"agentId":"m1","timestamp":"2026-09-24T06:00:05Z","attachment":{"type":"structured_output","data":{"ok":true}}}`,
		`{"type":"user","isSidechain":true,"agentId":"m1","timestamp":"2026-09-24T06:00:05Z","toolEndsTurn":true,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_so","content":"Structured output provided successfully"}]}}`,
		`{"type":"attachment","isSidechain":true,"agentId":"m1","timestamp":"2026-09-24T06:00:06Z","attachment":{"type":"hook_success","hookName":"SubagentStop"}}`,
	}
	var out []Event
	n := NewAgentNormalizer("demo")
	for _, ln := range member {
		out = append(out, n.Line([]byte(ln))...)
	}
	ends := 0
	for i, e := range out {
		if e.Kind != KindTurnEnd {
			continue
		}
		ends++
		if i == 0 || out[i-1].Kind != KindToolResult {
			t.Fatalf("the turn ended somewhere other than on the result: %v", kinds(out))
		}
	}
	if ends != 1 {
		t.Fatalf("want exactly one turn_end, got %d: %v", ends, kinds(out))
	}

	// The same records in the session's own stream are a member finishing,
	// not the main thread: ending the main turn there took the working row
	// away while the main thread was still busy (2026-10-03).
	out = nil
	n = NewNormalizer("demo")
	for _, ln := range member {
		out = append(out, n.Line([]byte(ln))...)
	}
	for _, e := range out {
		if e.Kind == KindTurnEnd {
			t.Fatalf("a member's result ended the session's turn: %v", kinds(out))
		}
	}
}

// An ordinary tool result is the harness answering a call, and the turn goes on.
func TestNormalizeKeepsATurnOpenOverAnOrdinaryToolResult(t *testing.T) {
	n := NewAgentNormalizer("demo")
	var out []Event
	for _, ln := range agentOwnLines[:5] {
		out = append(out, n.Line([]byte(ln))...)
	}
	for _, e := range out {
		if e.Kind == KindTurnEnd {
			t.Fatalf("a tool result ended the turn: %v", kinds(out))
		}
	}
}

// The drill-in's source is the session's FileSource over the agent file, with
// the same log, cursor and backfill, and the agent normalizer behind it.
func TestAgentFileSourceTailsTheAgentsTranscript(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent-a1b2.jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(agentOwnLines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	f := NewAgentFileSource("demo", path, 0, nil)
	f.TailOnce()
	evs := f.Replay(0)
	if len(evs) == 0 || evs[0].Kind != KindUser || evs[0].Session != "demo" {
		t.Fatalf("replay = %+v", evs)
	}
	for _, e := range evs {
		if e.Sidechain {
			t.Fatalf("event %d is marked as nested work in the agent's own stream", e.ID)
		}
	}
	b := f.Backfill(0, 1<<20)
	if len(b.Events) != len(evs) || b.Cursor != 0 {
		t.Fatalf("backfill = %d events, cursor %d; want all %d and 0", len(b.Events), b.Cursor, len(evs))
	}
	if f.Path() != path {
		t.Fatalf("path = %q", f.Path())
	}
}

func kindNames(ks []Kind) []string {
	out := make([]string, len(ks))
	for i, k := range ks {
		out[i] = string(k)
	}
	return out
}
