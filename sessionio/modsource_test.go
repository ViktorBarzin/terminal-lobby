package sessionio

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

var modRowN int

// modRow builds a session.append row the way the mod forwards it, each with a
// uuid of its own.
func modRow(t *testing.T, typ, role, door string, content any) ModEvent {
	t.Helper()
	b, err := json.Marshal(content)
	if err != nil {
		t.Fatal(err)
	}
	modRowN++
	return ModEvent{
		Type: ModRowEvent, T: 1790900000000, UUID: fmt.Sprintf("u-%s-%d", door, modRowN), Door: door,
		Message: &ModMessage{Type: typ, Role: role, Content: b},
	}
}

func modKinds(evs []Event) []string {
	out := make([]string, len(evs))
	for i, e := range evs {
		out[i] = string(e.Kind)
		if e.Kind == KindMeta {
			out[i] += ":" + string(e.Meta)
		}
	}
	return out
}

func TestModFeedTurnFromPromptToTurnEnd(t *testing.T) {
	fs := NewModSource("s", "", nil)
	fs.Feed(modRow(t, "user", "user", "prompt", []map[string]any{{"type": "text", "text": "hello"}}))
	fs.Feed(modRow(t, "assistant", "assistant", "response", []map[string]any{
		{"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": map[string]any{"command": "echo hi"}},
	}))
	fs.Feed(ModEvent{Type: ModResultEvent, ToolID: "toolu_1", Tool: "Bash",
		Result: json.RawMessage(`{"stdout":"hi","stderr":""}`), Text: "hi"})
	fs.Feed(modRow(t, "user", "user", "tool-result", []map[string]any{
		{"type": "tool_result", "tool_use_id": "toolu_1", "content": "hi"},
	}))
	fs.Feed(modRow(t, "assistant", "assistant", "response", []map[string]any{{"type": "text", "text": "done"}}))
	fs.Feed(ModEvent{Type: ModTurnEndEvent, TurnID: "c1", Usage: json.RawMessage(`{"output_tokens":3}`)})

	got := fs.Replay(0)
	want := []string{"user", "tool_use", "tool_result", "text", "turn_end"}
	if strings.Join(modKinds(got), ",") != strings.Join(want, ",") {
		t.Fatalf("kinds = %v, want %v", modKinds(got), want)
	}
	for _, e := range got {
		if e.TurnID != "t1" {
			t.Errorf("%s in turn %q, want t1", e.Kind, e.TurnID)
		}
	}
	if string(got[2].Result) != `{"stdout":"hi","stderr":""}` {
		t.Errorf("tool_result Result = %s, want the structured result the mod sent", got[2].Result)
	}
	if string(got[4].Usage) != `{"output_tokens":3}` {
		t.Errorf("turn_end Usage = %s", got[4].Usage)
	}
	if got[0].At != 1790900000000 {
		t.Errorf("At = %d, want the mod's timestamp", got[0].At)
	}
}

func TestModFeedDropsARowItAlreadyHas(t *testing.T) {
	fs := NewModSource("s", "", nil)
	row := modRow(t, "user", "user", "prompt", []map[string]any{{"type": "text", "text": "once"}})
	fs.Feed(row)
	fs.Feed(row)
	if got := modKinds(fs.Replay(0)); len(got) != 1 {
		t.Fatalf("a re-sent row was logged twice: %v", got)
	}
}

func TestModFeedTurnEndClosesOnce(t *testing.T) {
	fs := NewModSource("s", "", nil)
	fs.Feed(modRow(t, "user", "user", "prompt", []map[string]any{{"type": "text", "text": "hi"}}))
	fs.Feed(ModEvent{Type: ModTurnEndEvent, TurnID: "c1"})
	fs.Feed(ModEvent{Type: ModTurnEndEvent, TurnID: "c1"})
	n := 0
	for _, e := range fs.Replay(0) {
		if e.Kind == KindTurnEnd {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("turn_end count = %d, want 1", n)
	}
	if fs.TurnOpen() {
		t.Error("TurnOpen after turn_end")
	}
}

func TestModFeedSubagentTurnEndDoesNotCloseTheMainTurn(t *testing.T) {
	fs := NewModSource("s", "", nil)
	fs.Feed(modRow(t, "user", "user", "prompt", []map[string]any{{"type": "text", "text": "hi"}}))
	fs.Feed(ModEvent{Type: ModTurnEndEvent, TurnID: "c2", AgentID: "a1"})
	if !fs.TurnOpen() {
		t.Fatal("a subagent's turn_end closed the main turn")
	}
}

func TestModFeedSubagentRowsNestUnderTheirAgent(t *testing.T) {
	fs := NewModSource("s", "", nil)
	fs.Feed(modRow(t, "user", "user", "prompt", []map[string]any{{"type": "text", "text": "hi"}}))
	r := modRow(t, "assistant", "assistant", "response", []map[string]any{{"type": "text", "text": "agent says"}})
	r.AgentID = "a1"
	fs.Feed(r)
	got := fs.Replay(0)
	last := got[len(got)-1]
	if !last.Sidechain || last.AgentID != "a1" {
		t.Fatalf("subagent row = %+v, want Sidechain with AgentID a1", last)
	}
}

func TestModFeedDeltasAreLiveOnly(t *testing.T) {
	fs := NewModSource("s", "", nil)
	fs.Feed(modRow(t, "user", "user", "prompt", []map[string]any{{"type": "text", "text": "hi"}}))
	ch, cancel := fs.Subscribe()
	defer cancel()
	fs.Feed(ModEvent{Type: ModDeltaEvent, TurnID: "c1", Index: 1, Kind: "text", Text: "Tea is"})
	select {
	case e := <-ch:
		if e.Kind != KindDelta || e.Body != "Tea is" || e.Stream != "text" || e.Block != 1 || e.TurnID != "t1" || e.ID != 0 {
			t.Fatalf("delta = %+v", e)
		}
	case <-time.After(time.Second):
		t.Fatal("no delta delivered to the subscriber")
	}
	for _, e := range fs.Replay(0) {
		if e.Kind == KindDelta {
			t.Fatal("a delta was stored in the log; it must be live only")
		}
	}
}

// Claude stores nothing for a block a Stop cut short, while the pane keeps the
// words, so the log keeps them too.
func TestModFeedAStoppedReplyKeepsWhatStreamed(t *testing.T) {
	fs := NewModSource("s", "", nil)
	fs.Feed(modRow(t, "user", "user", "prompt", []map[string]any{{"type": "text", "text": "count"}}))
	fs.Feed(ModEvent{Type: ModDeltaEvent, Kind: "text", Text: "1 one\n2 tw"})
	fs.Feed(ModEvent{Type: ModTurnEndEvent, Aborted: true})
	got := fs.Replay(0)
	if k := strings.Join(modKinds(got), ","); k != "user,text,turn_end" || got[1].Body != "1 one\n2 tw" {
		t.Fatalf("kinds = %s, text = %q", k, got[1].Body)
	}
}

func TestModFeedAFinishedReplyIsNotDoubled(t *testing.T) {
	fs := NewModSource("s", "", nil)
	fs.Feed(modRow(t, "user", "user", "prompt", []map[string]any{{"type": "text", "text": "hi"}}))
	fs.Feed(ModEvent{Type: ModDeltaEvent, Kind: "text", Text: "hello"})
	fs.Feed(modRow(t, "assistant", "assistant", "response", []map[string]any{{"type": "text", "text": "hello"}}))
	fs.Feed(ModEvent{Type: ModTurnEndEvent, Aborted: true})
	if k := strings.Join(modKinds(fs.Replay(0)), ","); k != "user,text,turn_end" {
		t.Fatalf("kinds = %s", k)
	}
}

func TestModFeedDeltaWithNoTextIsDropped(t *testing.T) {
	fs := NewModSource("s", "", nil)
	ch, cancel := fs.Subscribe()
	defer cancel()
	fs.Feed(ModEvent{Type: ModDeltaEvent, Index: 0, Kind: "thinking", Text: ""})
	select {
	case e := <-ch:
		t.Fatalf("delivered %+v for an empty delta", e)
	default:
	}
}

func TestModFeedQueuedPromptWhileTurnRuns(t *testing.T) {
	fs := NewModSource("s", "", nil)
	fs.Feed(modRow(t, "user", "user", "prompt", []map[string]any{{"type": "text", "text": "first"}}))
	fs.Feed(ModEvent{Type: ModPromptEvent, Text: "second", Origin: json.RawMessage(`{"kind":"composer"}`)})
	fs.Feed(ModEvent{Type: ModTurnEndEvent})
	fs.Feed(modRow(t, "user", "user", "prompt", []map[string]any{{"type": "text", "text": "second"}}))
	got := modKinds(fs.Replay(0))
	want := "user,meta:queued,turn_end,meta:unqueued,user"
	if strings.Join(got, ",") != want {
		t.Fatalf("kinds = %v, want %s", got, want)
	}
}

// A prompt session-events holds behind the turn shows as queued, and leaves
// the queue when its row arrives, as one the mod reported would.
func TestModQueueShowsAHeldPromptUntilItsRow(t *testing.T) {
	fs := NewModSource("s", "", nil)
	fs.Feed(modRow(t, "user", "user", "prompt", []map[string]any{{"type": "text", "text": "first"}}))
	fs.Queue(" later\n", 1790900000400)
	fs.Feed(ModEvent{Type: ModTurnEndEvent})
	fs.Feed(modRow(t, "user", "user", "prompt", []map[string]any{{"type": "text", "text": "later"}}))
	evs := fs.Replay(0)
	if got := strings.Join(modKinds(evs), ","); got != "user,meta:queued,turn_end,meta:unqueued,user" {
		t.Fatalf("kinds = %s", got)
	}
	if evs[1].Body != "later" || evs[1].At != 1790900000400 || evs[1].TurnID == "" {
		t.Fatalf("queued = %+v", evs[1])
	}
	if st := fs.State(0); len(st.Queue) != 0 {
		t.Fatalf("queue after its row = %q", st.Queue)
	}
}

// Prompts handed back to the web leave the queue on every device, and
// only those that were queued: a text the queue does not hold adds nothing.
func TestModUnqueueTakesTheNamedPromptsOffTheQueue(t *testing.T) {
	fs := NewModSource("s", "", nil)
	fs.Feed(modRow(t, "user", "user", "prompt", []map[string]any{{"type": "text", "text": "first"}}))
	fs.Feed(ModEvent{Type: ModPromptEvent, Text: "second", Origin: json.RawMessage(`{"kind":"plugin"}`)})
	fs.Feed(ModEvent{Type: ModPromptEvent, Text: "third\n", Origin: json.RawMessage(`{"kind":"plugin"}`)})
	fs.Unqueue([]string{"second", " third", "never queued"}, 1790900000500)
	evs := fs.Replay(0)
	if got := strings.Join(modKinds(evs), ","); got != "user,meta:queued,meta:queued,meta:unqueued,meta:unqueued" {
		t.Fatalf("kinds = %s", got)
	}
	if evs[3].Body != "second" || evs[4].Body != "third" || evs[4].At != 1790900000500 {
		t.Fatalf("unqueued = %+v %+v", evs[3], evs[4])
	}
	// Taken back, a later row with the same words is a new prompt, not one
	// leaving the queue.
	fs.Feed(ModEvent{Type: ModTurnEndEvent})
	fs.Feed(modRow(t, "user", "user", "prompt", []map[string]any{{"type": "text", "text": "second"}}))
	if got := strings.Join(modKinds(fs.Replay(0))[5:], ","); got != "turn_end,user" {
		t.Fatalf("after the hand-back: %s", got)
	}
}

// A prompt the mod submitted is reported when its turn starts, after the row
// that opened the turn: it is that turn's prompt, not one waiting behind it.
func TestModFeedTheTurnsOwnPromptIsNotQueued(t *testing.T) {
	fs := NewModSource("s", "", nil)
	fs.Feed(modRow(t, "user", "user", "prompt", []map[string]any{{"type": "text", "text": "from the lobby"}}))
	fs.Feed(ModEvent{Type: ModPromptEvent, Text: "from the lobby", Origin: json.RawMessage(`{"kind":"plugin"}`)})
	if got := modKinds(fs.Replay(0)); strings.Join(got, ",") != "user" {
		t.Fatalf("kinds = %v, want the prompt alone", got)
	}
}

// A prompt the lobby hands the mod mid-turn waits for the session to go idle
// before Claude reports it, so the server records it as queued itself, the
// moment the mod takes it: every device watching sees it, not only the one
// that sent it (measured live on Claude Code 2.1.289, 2026-10-05).
func TestModSentPromptWhileTurnRunsIsQueuedAtOnce(t *testing.T) {
	fs := NewModSource("s", "", nil)
	fs.Feed(modRow(t, "user", "user", "prompt", []map[string]any{{"type": "text", "text": "first"}}))
	if !fs.QueueSent("c1", "second ") {
		t.Fatal("QueueSent = false while the turn runs")
	}
	fs.Feed(ModEvent{Type: ModTurnEndEvent})
	fs.Feed(modRow(t, "user", "user", "prompt", []map[string]any{{"type": "text", "text": "second"}}))
	fs.Feed(ModEvent{Type: ModPromptEvent, Text: "second", Origin: json.RawMessage(`{"kind":"plugin"}`)})
	got := fs.Replay(0)
	if k := strings.Join(modKinds(got), ","); k != "user,meta:queued,turn_end,meta:unqueued,user" {
		t.Fatalf("kinds = %s", k)
	}
	if got[1].Body != "second" {
		t.Fatalf("queued body = %q", got[1].Body)
	}
}

// Two sent behind one turn, each with its own row when the turn ends.
func TestModSentPromptsLeaveTheQueueOneByOne(t *testing.T) {
	fs := NewModSource("s", "", nil)
	fs.Feed(modRow(t, "user", "user", "prompt", []map[string]any{{"type": "text", "text": "first"}}))
	fs.QueueSent("c1", "beta")
	fs.QueueSent("c2", "gamma")
	fs.Feed(ModEvent{Type: ModTurnEndEvent})
	fs.Feed(modRow(t, "user", "user", "prompt", []map[string]any{{"type": "text", "text": "beta"}}))
	fs.Feed(ModEvent{Type: ModPromptEvent, Text: "beta", Origin: json.RawMessage(`{"kind":"plugin"}`)})
	fs.Feed(modRow(t, "user", "user", "prompt", []map[string]any{{"type": "text", "text": "gamma"}}))
	fs.Feed(ModEvent{Type: ModPromptEvent, Text: "gamma", Origin: json.RawMessage(`{"kind":"plugin"}`)})
	want := "user,meta:queued,meta:queued,turn_end,meta:unqueued,user,meta:unqueued,user"
	if k := strings.Join(modKinds(fs.Replay(0)), ","); k != want {
		t.Fatalf("kinds = %s, want %s", k, want)
	}
}

// Two queued prompts run back to back, and the mod reports the first only
// after the second's row has opened a turn (measured live 2026-10-05: rows
// 25 ms apart, the first's prompt event 27 ms after the second row). The
// report is late, not a third prompt waiting; read as one it stayed on the
// queue for good.
func TestModLobbyPromptReportedLateIsNotQueuedAgain(t *testing.T) {
	fs := NewModSource("s", "", nil)
	lobby := json.RawMessage(`{"kind":"plugin","name":"terminal-lobby","asUser":true}`)
	fs.Feed(modRow(t, "user", "user", "prompt", []map[string]any{{"type": "text", "text": "beta"}}))
	fs.Feed(modRow(t, "user", "user", "prompt", []map[string]any{{"type": "text", "text": "gamma"}}))
	fs.Feed(ModEvent{Type: ModPromptEvent, Text: "beta", Origin: lobby})
	fs.Feed(ModEvent{Type: ModPromptEvent, Text: "gamma", Origin: lobby})
	for _, e := range fs.Replay(0) {
		if e.Kind == KindMeta && e.Meta == MetaQueued {
			t.Fatalf("queued %q after it ran", e.Body)
		}
	}
}

// Sent while idle, the prompt opens its own turn through its row.
func TestModSentPromptWhileIdleIsNotQueued(t *testing.T) {
	fs := NewModSource("s", "", nil)
	if fs.QueueSent("c1", "hi") {
		t.Fatal("QueueSent = true with no turn running")
	}
	if got := fs.Replay(0); len(got) != 0 {
		t.Fatalf("idle send produced %v", modKinds(got))
	}
}

// A slash command runs as one and leaves no prompt row to take it off the
// queue, so it is never put on it.
func TestModSentSlashCommandIsNotQueued(t *testing.T) {
	fs := NewModSource("s", "", nil)
	fs.Feed(modRow(t, "user", "user", "prompt", []map[string]any{{"type": "text", "text": "first"}}))
	if fs.QueueSent("c1", "/compact") {
		t.Fatal("a slash command was queued")
	}
}

// A prompt a hook dropped after the ack never runs: it leaves the queue with
// the error that says so.
func TestModSentPromptThatFailedLeavesTheQueue(t *testing.T) {
	fs := NewModSource("s", "", nil)
	fs.Feed(modRow(t, "user", "user", "prompt", []map[string]any{{"type": "text", "text": "first"}}))
	fs.QueueSent("c1", "second")
	fs.QueueSent("c2", "third")
	fs.Feed(ModEvent{Type: ModCommandFailedEvent, ID: "c1", Op: "prompt", Error: "dropped: hook"})
	got := fs.Replay(0)
	if k := strings.Join(modKinds(got), ","); k != "user,meta:queued,meta:queued,meta:unqueued,error" {
		t.Fatalf("kinds = %s", k)
	}
	if got[3].Body != "second" {
		t.Fatalf("unqueued %q, want second", got[3].Body)
	}
}

func TestModFeedPromptWhileIdleIsNotQueued(t *testing.T) {
	fs := NewModSource("s", "", nil)
	fs.Feed(ModEvent{Type: ModPromptEvent, Text: "hi", Origin: json.RawMessage(`{"kind":"composer"}`)})
	if got := fs.Replay(0); len(got) != 0 {
		t.Fatalf("idle prompt event produced %v", modKinds(got))
	}
}

func TestModFeedModelOnlyWhenItChanges(t *testing.T) {
	fs := NewModSource("s", "", nil)
	fs.Feed(ModEvent{Type: ModModelEvent, Model: "claude-opus-5-5", Effort: "high"})
	fs.Feed(ModEvent{Type: ModModelEvent, Model: "claude-opus-5-5", Effort: "high"})
	fs.Feed(ModEvent{Type: ModModelEvent, Model: "claude-sonnet-5-5", Effort: "high"})
	got := fs.Replay(0)
	if len(got) != 2 || got[1].Model.Model != "claude-sonnet-5-5" {
		t.Fatalf("model events = %+v", got)
	}
}

func TestModFeedHistoryRebuildsTheConversation(t *testing.T) {
	fs := NewModSource("s", "", nil)
	fs.FeedHistory([]ModHistoryMessage{
		{Role: "user", Text: "run it"},
		{Role: "assistant", ToolUses: []ModToolUse{{
			ToolUseID: "toolu_9", Tool: "Bash", Input: json.RawMessage(`{"command":"ls"}`),
			Result: json.RawMessage(`{"stdout":"a b","stderr":""}`), Text: "a b",
		}}},
		{Role: "user", ToolResults: json.RawMessage(`[{"tool_use_id":"toolu_9"}]`)},
		{Role: "assistant", Text: "two files"},
	}, false)
	got := fs.Replay(0)
	want := "user,tool_use,tool_result,text,turn_end"
	if strings.Join(modKinds(got), ",") != want {
		t.Fatalf("kinds = %v, want %s", modKinds(got), want)
	}
	if string(got[2].Result) != `{"stdout":"a b","stderr":""}` || got[2].Body != "a b" {
		t.Errorf("tool_result = %+v", got[2])
	}
}

func TestModFeedHistoryLeavesARunningTurnOpen(t *testing.T) {
	fs := NewModSource("s", "", nil)
	fs.FeedHistory([]ModHistoryMessage{{Role: "user", Text: "go"}}, true)
	if !fs.TurnOpen() {
		t.Fatal("history of a running turn closed it")
	}
}

func TestModFeedResultIsKeptInFull(t *testing.T) {
	fs := NewModSource("s", "", nil)
	big := strings.Repeat("x", MaxInlineResult*2)
	fs.Feed(ModEvent{Type: ModResultEvent, ToolID: "toolu_big", Tool: "Bash", Text: big})
	body, _, err := fs.FullResult("toolu_big")
	if err != nil || body != big {
		t.Fatalf("FullResult = %d bytes, %v; want the whole %d", len(body), err, len(big))
	}
}

func TestModFeedEpochIsTheSourcesOwn(t *testing.T) {
	a, b := NewModSource("s", "/p.jsonl", nil), NewModSource("s", "/p.jsonl", nil)
	_, ea := a.Head()
	_, eb := b.Head()
	if ea == eb {
		t.Fatal("two mod sources for one transcript share an epoch; a client would resume across them")
	}
}

// A background subagent's records arrive in the main thread's stream: its
// prompt while the main turn is still open, and its tool calls after the main
// reply has ended the turn. Measured on a live session, 2026-10-03: the prompt
// opened t2 and the first tool call after the reply opened t3, so the Text view
// drew a live "Working…" turn holding the subagent's commands and the picture it
// read, none of it under the Agent call that spawned it. A subagent's work never
// opens or closes a turn of the main thread.
func TestModFeedSubagentNeverMovesTheMainTurn(t *testing.T) {
	sub := func(ev ModEvent) ModEvent { ev.AgentID = "a596"; return ev }
	fs := NewModSource("s", "", nil)
	fs.Feed(modRow(t, "user", "user", "prompt", []map[string]any{{"type": "text", "text": "launch it"}}))
	fs.Feed(modRow(t, "assistant", "assistant", "response", []map[string]any{
		{"type": "tool_use", "id": "toolu_agent", "name": "Agent", "input": map[string]any{"prompt": "run ls", "run_in_background": true}},
	}))
	fs.Feed(sub(modRow(t, "user", "user", "prompt", []map[string]any{{"type": "text", "text": "run ls"}})))
	fs.Feed(modRow(t, "user", "user", "tool-result", []map[string]any{
		{"type": "tool_result", "tool_use_id": "toolu_agent", "content": "Async agent launched successfully."},
	}))
	fs.Feed(sub(modRow(t, "assistant", "assistant", "response", []map[string]any{
		{"type": "tool_use", "id": "toolu_ls", "name": "Bash", "input": map[string]any{"command": "ls"}},
	})))
	fs.Feed(modRow(t, "assistant", "assistant", "response", []map[string]any{{"type": "text", "text": "LAUNCHED"}}))
	fs.Feed(ModEvent{Type: ModTurnEndEvent, TurnID: "c1"})
	// Everything below is the subagent working after the main turn ended.
	fs.Feed(sub(modRow(t, "user", "user", "tool-result", []map[string]any{
		{"type": "tool_result", "tool_use_id": "toolu_ls", "content": "red.png"},
	})))
	fs.Feed(sub(modRow(t, "assistant", "assistant", "response", []map[string]any{
		{"type": "tool_use", "id": "toolu_read", "name": "Read", "input": map[string]any{"file_path": "red.png"}},
	})))
	fs.Feed(sub(modRow(t, "user", "user", "tool-result", []map[string]any{
		{"type": "tool_result", "tool_use_id": "toolu_read", "content": []map[string]any{{"type": "text", "text": "image"}}},
	})))
	fs.Feed(sub(modRow(t, "assistant", "assistant", "response", []map[string]any{{"type": "text", "text": "DONE"}})))
	fs.Feed(sub(ModEvent{Type: ModTurnEndEvent, TurnID: "c2"}))

	if fs.TurnOpen() {
		t.Error("the subagent's work reopened the main turn")
	}
	ends := 0
	for _, e := range fs.Replay(0) {
		if e.TurnID != "t1" {
			t.Errorf("%s (sidechain=%v %q) in turn %q, want t1", e.Kind, e.Sidechain, e.Body, e.TurnID)
		}
		if e.Kind == KindTurnEnd {
			ends++
		}
		if e.Sidechain && e.Kind == KindTurnEnd {
			t.Errorf("a subagent's record ended the main turn")
		}
	}
	if ends != 1 {
		t.Errorf("turn_end count = %d, want 1", ends)
	}
	// The subagent's prompt still travels, marked as its own: the renderer
	// pairs it with the call that spawned the agent.
	var prompt *Event
	for _, e := range fs.Replay(0) {
		if e.Kind == KindUser && e.Sidechain {
			e := e
			prompt = &e
		}
	}
	if prompt == nil || prompt.Body != "run ls" || prompt.AgentID != "a596" {
		t.Errorf("subagent prompt = %+v, want a sidechain user event naming a596", prompt)
	}
}
