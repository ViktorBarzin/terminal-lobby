package sessionio

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// ms is a fixture timestamp in the contract's unit.
func ms(t *testing.T, ts string) int64 {
	t.Helper()
	at, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		t.Fatal(err)
	}
	return at.UnixMilli()
}

func readMeta(t *testing.T, jsonl string) AgentMeta {
	t.Helper()
	b, err := os.ReadFile(AgentMetaPath(jsonl))
	if err != nil {
		t.Fatal(err)
	}
	m, err := ParseAgentMeta(b)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// The fixtures are sanitized from real agent transcripts on this box, one per
// way an agent's life is measured to go: an ad-hoc agent that finished (a
// SubagentStop hook's record trailing its last answer), the nested agent it
// spawned (an API error it recovered from, then one that ended it), a workflow
// member mid-tool-call, and a workflow member that finished through
// StructuredOutput, which writes no end_turn at all.
func TestAgentTailFixtures(t *testing.T) {
	const dir = "testdata/agents/subagents/"
	for _, tc := range []struct {
		name    string
		path    string
		want    AgentInfo
		spawned []string
	}{
		{"ad-hoc agent that finished", dir + "agent-a4f1c2e9b7d3a0001.jsonl", AgentInfo{
			ID: "a4f1c2e9b7d3a0001", Description: "Summarise open issues", AgentType: "general-purpose",
			Model: "claude-opus-5-5", Depth: 1, ToolUseID: "toolu_01MAIN", State: AgentDone,
			StartedAt:      ms(t, "2026-09-24T04:01:19.971Z"),
			LastActivityAt: ms(t, "2026-09-24T04:02:49.180Z"),
			EndedAt:        ms(t, "2026-09-24T04:02:49.162Z"),
			Tool:           "Agent", ToolDetail: "Check stale issues", ToolCalls: 3,
			// msg_01A is written as 8, 8, then 805; only its last record counts.
			OutputTokens: 805 + 261 + 732,
			Result:       "There are 12 open issues. Three are stale: - #4 flaky test - #9 docs - #11 login",
		}, []string{"toolu_01A3"}},
		{"nested agent ended by an API error", dir + "agent-a9e3b5d7c1f2a0002.jsonl", AgentInfo{
			ID: "a9e3b5d7c1f2a0002", Description: "Check stale issues", AgentType: "Explore",
			// The error records say "<synthetic>", which is no model at all.
			Model: "claude-haiku-4-5", Depth: 2, ToolUseID: "toolu_01A3", State: AgentFailed,
			StartedAt:      ms(t, "2026-09-24T04:01:31.100Z"),
			LastActivityAt: ms(t, "2026-09-24T04:01:50.000Z"),
			EndedAt:        ms(t, "2026-09-24T04:01:50.000Z"),
			Tool:           "Glob", ToolDetail: "issues/**/*.md", ToolCalls: 2, OutputTokens: 120 + 90,
			Result: "API Error: 529 Overloaded. The API is temporarily overloaded; try again shortly.",
		}, nil},
		{"workflow member mid-tool-call", dir + "workflows/wf_5c2d9e1a-7b3/agent-a2c4e6f8a0b1c0003.jsonl", AgentInfo{
			ID: "a2c4e6f8a0b1c0003", Description: "review:bugs", AgentType: "workflow-subagent",
			Model: "claude-opus-5-5", Depth: 1, WorkflowID: "wf_5c2d9e1a-7b3", State: AgentRunning,
			StartedAt:      ms(t, "2026-09-24T05:00:00.000Z"),
			LastActivityAt: ms(t, "2026-09-24T05:00:03.000Z"),
			Tool:           "Bash", ToolDetail: "go test ./... …", ToolCalls: 1, OutputTokens: 150,
		}, nil},
		{"workflow member that returned structured output", dir + "workflows/wf_5c2d9e1a-7b3/agent-a6b8d0f2c4e6d0004.jsonl", AgentInfo{
			ID: "a6b8d0f2c4e6d0004", Description: "review:design", AgentType: "workflow-subagent",
			Model: "claude-opus-5-5", Depth: 1, WorkflowID: "wf_5c2d9e1a-7b3", State: AgentDone,
			StartedAt:      ms(t, "2026-09-24T05:00:00.500Z"),
			LastActivityAt: ms(t, "2026-09-24T05:00:12.060Z"),
			EndedAt:        ms(t, "2026-09-24T05:00:12.040Z"),
			Tool:           "StructuredOutput", ToolDetail: "The diff matches the design.", ToolCalls: 2, OutputTokens: 95 + 310,
			Result: `{"ok":true,"summary":"The diff matches the design.","findings":[]}`,
		}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tail := NewAgentTail(tc.path, LocalReader{})
			changed, err := tail.Poll()
			if err != nil || !changed {
				t.Fatalf("Poll = %v, %v; want true, nil", changed, err)
			}
			if got := tail.Info(readMeta(t, tc.path)); got != tc.want {
				t.Errorf("Info\n got %+v\nwant %+v", got, tc.want)
			}
			if got := tail.Spawned(); !reflect.DeepEqual(got, tc.spawned) {
				t.Errorf("Spawned = %v, want %v", got, tc.spawned)
			}
		})
	}
}

// The design's "done when": a transcript that grows while it is read. A line
// still being written is not consumed until its newline lands, and the state
// follows each line as it arrives, including an agent that ends and is then
// given more work.
func TestAgentTailGrowingFile(t *testing.T) {
	lines := strings.Split(strings.TrimSuffix(mustRead(t, "testdata/agents/subagents/agent-a4f1c2e9b7d3a0001.jsonl"), "\n"), "\n")
	path := filepath.Join(t.TempDir(), "agent-a4f1c2e9b7d3a0001.jsonl")
	tail := NewAgentTail(path, LocalReader{})
	meta := AgentMeta{Description: "Summarise open issues", WrittenAt: ms(t, "2026-09-24T04:01:17.900Z")}

	poll := func(wantChanged bool) AgentInfo {
		t.Helper()
		changed, err := tail.Poll()
		if err != nil {
			t.Fatalf("Poll: %v", err)
		}
		if changed != wantChanged {
			t.Fatalf("Poll changed = %v, want %v", changed, wantChanged)
		}
		return tail.Info(meta)
	}

	// The sidecar lands about two seconds before the first record. Until then
	// the agent is running, and its spawn time is the sidecar's.
	if _, err := tail.Poll(); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("Poll before the transcript exists = %v, want not-exist", err)
	}
	info := tail.Info(meta)
	if info.State != AgentRunning || info.StartedAt != meta.WrittenAt || info.LastActivityAt != meta.WrittenAt {
		t.Fatalf("before any record: %+v", info)
	}

	// Three records, and half of the fourth: the Bash call is still being written.
	head := strings.Join(lines[:3], "\n") + "\n"
	appendTo(t, path, head+lines[3][:len(lines[3])/2])
	info = poll(true)
	if tail.Offset() != int64(len(head)) {
		t.Errorf("Offset = %d, want %d: a partial line must stay unread", tail.Offset(), len(head))
	}
	if info.ToolCalls != 0 || info.Tool != "" || info.OutputTokens != 8 || info.State != AgentRunning {
		t.Errorf("after three records: %+v", info)
	}
	if info.StartedAt != ms(t, "2026-09-24T04:01:19.971Z") || info.LastActivityAt != ms(t, "2026-09-24T04:01:22.486Z") {
		t.Errorf("times after three records: started %d, last %d", info.StartedAt, info.LastActivityAt)
	}

	// Its newline lands.
	appendTo(t, path, lines[3][len(lines[3])/2:]+"\n")
	info = poll(true)
	if info.ToolCalls != 1 || info.Tool != "Bash" || info.ToolDetail != "gh issue list --state open" || info.OutputTokens != 8 {
		t.Errorf("after the Bash call: %+v", info)
	}

	// Nothing new: nothing changes, and the cursor stays put.
	at := tail.Offset()
	poll(false)
	if tail.Offset() != at {
		t.Errorf("Offset moved from %d to %d with nothing appended", at, tail.Offset())
	}

	// The rest lands and the agent ends.
	appendTo(t, path, strings.Join(lines[4:], "\n")+"\n")
	info = poll(true)
	if info.State != AgentDone || info.EndedAt != ms(t, "2026-09-24T04:02:49.162Z") || !strings.HasPrefix(info.Result, "There are 12 open issues.") {
		t.Errorf("after the last answer: %+v", info)
	}

	// A teammate is sent more work after it ended: running again.
	appendTo(t, path, userText("2026-09-24T04:05:00.000Z", "Also count the closed ones.")+"\n")
	info = poll(true)
	if info.State != AgentRunning || info.EndedAt != 0 || info.Result != "" || info.LastActivityAt != ms(t, "2026-09-24T04:05:00.000Z") {
		t.Errorf("after a new message: %+v", info)
	}
}

// Every read goes through the Reader it was given, resuming from the offset the
// last read returned, so the cross-user reader serves agents unchanged.
func TestAgentTailReadsThroughItsReader(t *testing.T) {
	r := &scriptedReader{
		lines: [][]string{
			{userText("2026-09-24T05:00:00.000Z", "Go."), toolCall("2026-09-24T05:00:01.000Z", "m1", "t1", "Read", `{"file_path":"/a/b.go"}`)},
			{finalText("2026-09-24T05:00:02.000Z", "m2", "end_turn", "Read it.")},
		},
		next: []int64{400, 650},
	}
	tail := NewAgentTail("/home/other/.claude/projects/p/s/subagents/agent-a1.jsonl", r)
	for i := 0; i < 2; i++ {
		if _, err := tail.Poll(); err != nil {
			t.Fatal(err)
		}
	}
	if want := []int64{0, 400}; !reflect.DeepEqual(r.offsets, want) {
		t.Errorf("ReadFrom offsets = %v, want %v", r.offsets, want)
	}
	if tail.Offset() != 650 {
		t.Errorf("Offset = %d, want 650", tail.Offset())
	}
	if info := tail.Info(AgentMeta{}); info.ID != "a1" || info.State != AgentDone || info.Tool != "Read" || info.Result != "Read it." {
		t.Errorf("Info = %+v", info)
	}
}

// How each measured record changes an agent's state. The rows past the fixtures'
// coverage: an API error the harness retries past, the interrupt notice, a turn
// ended by a tool with no structured-output record, and the two sidecar facts.
func TestAgentTailStates(t *testing.T) {
	prompt := userText("2026-09-24T05:00:00.000Z", "Go.")
	call := toolCall("2026-09-24T05:00:01.000Z", "m1", "t1", "Bash", `{"command":"sleep 20"}`)
	stoppedAt := ms(t, "2026-09-24T05:09:00.000Z")
	for _, tc := range []struct {
		name       string
		meta       AgentMeta
		lines      []string
		wantState  AgentState
		wantResult string
		wantEnded  string // RFC3339, "" = 0
		wantModel  string
	}{
		{"an API error it recovers from", AgentMeta{},
			[]string{prompt, apiError("2026-09-24T05:00:02.000Z", "API Error: 500"), call},
			AgentRunning, "", "", "claude-opus-5-5"},
		{"interrupted by the operator", AgentMeta{},
			[]string{prompt, call, userText("2026-09-24T05:00:03.000Z", "[Request interrupted by user for tool use]")},
			AgentFailed, "[Request interrupted by user for tool use]", "2026-09-24T05:00:03.000Z", "claude-opus-5-5"},
		{"a turn a tool ended", AgentMeta{},
			[]string{prompt, call, toolResult("2026-09-24T05:00:04.000Z", "t1", "Structured output provided successfully", true)},
			AgentDone, "Structured output provided successfully", "2026-09-24T05:00:04.000Z", "claude-opus-5-5"},
		{"a tool result does not reopen a finished agent", AgentMeta{},
			[]string{prompt, finalText("2026-09-24T05:00:02.000Z", "m2", "end_turn", "Done."), toolResult("2026-09-24T05:00:03.000Z", "t1", "late", false)},
			AgentDone, "Done.", "2026-09-24T05:00:02.000Z", "claude-opus-5-5"},
		{"any stop that ends a turn ends the agent", AgentMeta{},
			[]string{prompt, finalText("2026-09-24T05:00:02.000Z", "m2", "max_tokens", "Partial answer")},
			AgentDone, "Partial answer", "2026-09-24T05:00:02.000Z", "claude-opus-5-5"},
		{"the sidecar's model wins", AgentMeta{Model: "opus"},
			[]string{prompt, call},
			AgentRunning, "", "", "opus"},
		{"stopped by the operator while running", AgentMeta{StoppedByUser: true, WrittenAt: stoppedAt},
			[]string{prompt, call},
			AgentFailed, "Stopped by user", "2026-09-24T05:09:00.000Z", "claude-opus-5-5"},
		{"a stop after it finished changes nothing", AgentMeta{StoppedByUser: true, WrittenAt: stoppedAt},
			[]string{prompt, finalText("2026-09-24T05:00:02.000Z", "m2", "end_turn", "Done.")},
			AgentDone, "Done.", "2026-09-24T05:00:02.000Z", "claude-opus-5-5"},
		{"a long answer is cut to one line of 200", AgentMeta{},
			[]string{prompt, finalText("2026-09-24T05:00:02.000Z", "m2", "end_turn", "Line one.\n\n"+strings.Repeat("word ", 60))},
			AgentDone, "Line one. " + strings.Repeat("word ", 37) + "word…", "2026-09-24T05:00:02.000Z", "claude-opus-5-5"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tail := NewAgentTail("agent-a1.jsonl", &scriptedReader{lines: [][]string{tc.lines}, next: []int64{1}})
			if _, err := tail.Poll(); err != nil {
				t.Fatal(err)
			}
			info := tail.Info(tc.meta)
			var wantEnded int64
			if tc.wantEnded != "" {
				wantEnded = ms(t, tc.wantEnded)
			}
			if info.State != tc.wantState || info.Result != tc.wantResult || info.EndedAt != wantEnded || info.Model != tc.wantModel {
				t.Errorf("got state %q result %q ended %d model %q\nwant state %q result %q ended %d model %q",
					info.State, info.Result, info.EndedAt, info.Model, tc.wantState, tc.wantResult, wantEnded, tc.wantModel)
			}
		})
	}
}

// An agent that hands work to the background and then ends its turn has paused
// to wait for it, not finished: Claude Code wakes it with the task's
// notification, and Claude Code's own bar calls it finished at each pause. So
// an end of turn ends the agent only when nothing it started in the background
// is still outstanding. The wordings are Claude Code's own (2.1.283), each seen
// in transcripts on this box.
func TestAgentTailWaitsOnItsOwnBackgroundWork(t *testing.T) {
	prompt := userText("2026-09-24T05:00:00.000Z", "Go.")
	bash := toolCall("2026-09-24T05:00:01.000Z", "m1", "t1", "Bash", `{"command":"sleep 240","run_in_background":true}`)
	started := toolResult("2026-09-24T05:00:02.000Z", "t1", "Command running in background with ID: bk1. Output is being written to: /tmp/x/tasks/bk1.output", false)
	pause := finalText("2026-09-24T05:00:03.000Z", "m2", "end_turn", "Waiting for it.")
	finish := finalText("2026-09-24T05:04:05.000Z", "m3", "end_turn", "waiter done")
	for _, tc := range []struct {
		name       string
		lines      []string
		wantState  AgentState
		wantResult string
		wantEnded  string // RFC3339, "" = 0
		wantTool   string
	}{
		{"a TaskStop on the task ends the wait, since no notice follows one",
			[]string{prompt, bash, started, toolCall("2026-09-24T05:01:00.000Z", "m3", "t2", "TaskStop", `{"task_id":"bk1"}`),
				toolResult("2026-09-24T05:01:01.000Z", "t2", `{"message":"Successfully stopped task: bk1 (sleep 240)","task_id":"bk1","task_type":"local_bash"}`, false), finish},
			AgentDone, "waiter done", "2026-09-24T05:04:05.000Z", "TaskStop bk1"},
		{"so does a KillShell",
			[]string{prompt, bash, started, toolCall("2026-09-24T05:01:00.000Z", "m3", "t2", "KillShell", `{"shell_id":"bk1"}`),
				toolResult("2026-09-24T05:01:01.000Z", "t2", "Shell bk1 killed", false), finish},
			AgentDone, "waiter done", "2026-09-24T05:04:05.000Z", "KillShell bk1"},
		{"a monitor that expired ends the wait, though its notice has no status",
			[]string{prompt, toolCall("2026-09-24T05:00:01.000Z", "m1", "t1", "Monitor", `{"description":"watch the build"}`),
				toolResult("2026-09-24T05:00:02.000Z", "t1", "Monitor started (task mn1, timeout 600000ms). You will be notified on each event.", false), pause,
				monitorEvent("2026-09-24T05:10:02.000Z", "mn1", "[Monitor expired after 10m with no events delivered. Re-arm it if you still need the watch.]"), finish},
			AgentDone, "waiter done", "2026-09-24T05:04:05.000Z", "Monitor watch the build"},
		{"so does a monitor that timed out",
			[]string{prompt, toolCall("2026-09-24T05:00:01.000Z", "m1", "t1", "Monitor", `{"description":"watch the build"}`),
				toolResult("2026-09-24T05:00:02.000Z", "t1", "Monitor started (task mn1, timeout 600000ms). You will be notified on each event.", false), pause,
				monitorEvent("2026-09-24T05:10:02.000Z", "mn1", "[Monitor timed out — re-arm if needed.]"), finish},
			AgentDone, "waiter done", "2026-09-24T05:04:05.000Z", "Monitor watch the build"},
		{"a monitor's ordinary event is not its end",
			[]string{prompt, toolCall("2026-09-24T05:00:01.000Z", "m1", "t1", "Monitor", `{"description":"watch the build"}`),
				toolResult("2026-09-24T05:00:02.000Z", "t1", "Monitor started (task mn1, timeout 600000ms). You will be notified on each event.", false), pause,
				monitorEvent("2026-09-24T05:02:00.000Z", "mn1", "build 3 of 5 passed"), finalText("2026-09-24T05:02:02.000Z", "m3", "end_turn", "Noted.")},
			AgentRunning, "", "", "Monitor watch the build"},
		{"a turn ended with a background command outstanding is a pause",
			[]string{prompt, bash, started, pause},
			AgentRunning, "", "", "Bash sleep 240"},
		{"the command's notice wakes it, and its next end is the end",
			[]string{prompt, bash, started, pause, notice("2026-09-24T05:04:01.000Z", "bk1", "completed", ""), finish},
			AgentDone, "waiter done", "2026-09-24T05:04:05.000Z", "Bash sleep 240"},
		{"a notice that arrives while it is busy retires the task too",
			[]string{prompt, bash, started, queuedNotice("2026-09-24T05:00:02.500Z", "bk1", "completed"), pause},
			AgentDone, "Waiting for it.", "2026-09-24T05:00:03.000Z", "Bash sleep 240"},
		{"a notice that is not an end leaves it waiting",
			[]string{prompt, bash, started, pause, notice("2026-09-24T05:01:00.000Z", "bk1", "running", ""), finalText("2026-09-24T05:01:02.000Z", "m3", "end_turn", "Still waiting.")},
			AgentRunning, "", "", "Bash sleep 240"},
		{"a command the harness moved to the background holds it too",
			[]string{prompt, bash, toolResult("2026-09-24T05:02:00.000Z", "t1", `Command "sleep 900" was moved to the background (ID: bk2). It keeps running.`, false), pause},
			AgentRunning, "", "", "Bash sleep 240"},
		{"a killed command ends the wait",
			[]string{prompt, bash, started, pause, notice("2026-09-24T05:01:00.000Z", "bk1", "killed", ""), finish},
			AgentDone, "waiter done", "2026-09-24T05:04:05.000Z", "Bash sleep 240"},
		{"a monitor holds it until the monitor expires",
			[]string{prompt, toolCall("2026-09-24T05:00:01.000Z", "m1", "t1", "Monitor", `{"description":"watch the build"}`),
				toolResult("2026-09-24T05:00:02.000Z", "t1", "Monitor started (task mn1, timeout 600000ms). You will be notified on each event.", false), pause},
			AgentRunning, "", "", "Monitor watch the build"},
		{"a background agent it launched holds it through that agent's own pause",
			[]string{prompt, toolCall("2026-09-24T05:00:01.000Z", "m1", "t1", "Agent", `{"description":"Child","prompt":"x","run_in_background":true}`),
				toolResult("2026-09-24T05:00:02.000Z", "t1", "Async agent launched successfully. (internal)\nagentId: ach1 (internal ID)", false), pause,
				notice("2026-09-24T05:02:00.000Z", "ach1", "completed", "This agent stopped with background work of its own still running; the same task-id notifies again."),
				finalText("2026-09-24T05:02:02.000Z", "m3", "end_turn", "Child paused.")},
			AgentRunning, "", "", "Agent Child"},
		{"and that agent's last notice lets it finish",
			[]string{prompt, toolCall("2026-09-24T05:00:01.000Z", "m1", "t1", "Agent", `{"description":"Child","prompt":"x","run_in_background":true}`),
				toolResult("2026-09-24T05:00:02.000Z", "t1", "Async agent launched successfully. (internal)\nagentId: ach1 (internal ID)", false), pause,
				notice("2026-09-24T05:03:00.000Z", "ach1", "completed", "It stops with no live background children of its own."), finish},
			AgentDone, "waiter done", "2026-09-24T05:04:05.000Z", "Agent Child"},
		{"an agent that ran in the foreground names an agentId but is no task",
			[]string{prompt, toolCall("2026-09-24T05:00:01.000Z", "m1", "t1", "Agent", `{"description":"Child","prompt":"x"}`),
				toolResult("2026-09-24T05:00:40.000Z", "t1", "The child's report.\nagentId: ach2", false), pause},
			AgentDone, "Waiting for it.", "2026-09-24T05:00:03.000Z", "Agent Child"},
		{"a failure while it waits is still a failure",
			[]string{prompt, bash, started, pause, userText("2026-09-24T05:01:00.000Z", "[Request interrupted by user]")},
			AgentFailed, "[Request interrupted by user]", "2026-09-24T05:01:00.000Z", "Bash sleep 240"},
		{"a workflow member's structured output ends it whatever it left running",
			[]string{prompt, bash, started, structuredOutput("2026-09-24T05:00:04.000Z", `{"ok":true}`)},
			AgentDone, `{"ok":true}`, "2026-09-24T05:00:04.000Z", "Bash sleep 240"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tail := NewAgentTail("agent-a1.jsonl", &scriptedReader{lines: [][]string{tc.lines}, next: []int64{1}})
			if _, err := tail.Poll(); err != nil {
				t.Fatal(err)
			}
			info := tail.Info(AgentMeta{})
			var wantEnded int64
			if tc.wantEnded != "" {
				wantEnded = ms(t, tc.wantEnded)
			}
			if tool := strings.TrimSpace(info.Tool + " " + info.ToolDetail); info.State != tc.wantState || info.Result != tc.wantResult || info.EndedAt != wantEnded || tool != tc.wantTool {
				t.Errorf("got state %q result %q ended %d tool %q\nwant state %q result %q ended %d tool %q",
					info.State, info.Result, info.EndedAt, tool, tc.wantState, tc.wantResult, wantEnded, tc.wantTool)
			}
			// Waiting is running with the turn over: the last line is the
			// pause itself or a notice that did not end it.
			last := tc.lines[len(tc.lines)-1]
			wantWaiting := tc.wantState == AgentRunning && strings.Contains(last, `"end_turn"`)
			if info.Waiting != wantWaiting {
				t.Errorf("Waiting = %v, want %v", info.Waiting, wantWaiting)
			}
		})
	}
}

// A done agent given more work starts a new piece of it, so its clock starts
// again rather than counting the hour it sat finished. Its tool calls and
// tokens keep adding up.
func TestAgentTailRestartsTheClockWhenWokenAfterItEnded(t *testing.T) {
	lines := []string{
		userText("2026-09-24T05:00:00.000Z", "Go."),
		toolCall("2026-09-24T05:00:01.000Z", "m1", "t1", "Bash", `{"command":"ls"}`),
		finalText("2026-09-24T05:00:05.000Z", "m2", "end_turn", "Done."),
		userText("2026-09-24T06:00:00.000Z", "Also count the closed ones."),
		toolCall("2026-09-24T06:00:02.000Z", "m3", "t2", "Bash", `{"command":"wc -l"}`),
	}
	tail := NewAgentTail("agent-a1.jsonl", &scriptedReader{lines: [][]string{lines}, next: []int64{1}})
	if _, err := tail.Poll(); err != nil {
		t.Fatal(err)
	}
	info := tail.Info(AgentMeta{})
	if info.State != AgentRunning || info.StartedAt != ms(t, "2026-09-24T06:00:00.000Z") || info.ToolCalls != 2 || info.OutputTokens != 30 {
		t.Errorf("woken for more work: %+v", info)
	}
}

// The same pause, read from a recorded agent (2.1.283, 2026-09-26) as its
// transcript grew: a background `sleep 240`, a turn that ends to wait for it,
// the notice four minutes later, and the answer that really ends it.
func TestAgentTailRecordedWaiter(t *testing.T) {
	const src = "testdata/agents/subagents/agent-aee635c515c9699b7.jsonl"
	lines := strings.Split(strings.TrimSuffix(mustRead(t, src), "\n"), "\n")
	path := filepath.Join(t.TempDir(), "agent-aee635c515c9699b7.jsonl")
	tail := NewAgentTail(path, LocalReader{})
	meta := readMeta(t, src)

	appendTo(t, path, strings.Join(lines[:4], "\n")+"\n")
	if _, err := tail.Poll(); err != nil {
		t.Fatal(err)
	}
	info := tail.Info(meta)
	if info.State != AgentRunning || !info.Waiting || info.EndedAt != 0 || info.Result != "" || info.Tool != "Bash" || info.ToolDetail != "sleep 240" {
		t.Errorf("paused on its background command: %+v", info)
	}

	appendTo(t, path, strings.Join(lines[4:], "\n")+"\n")
	if _, err := tail.Poll(); err != nil {
		t.Fatal(err)
	}
	info = tail.Info(meta)
	if info.State != AgentDone || info.Waiting || info.Result != "waiter done" || info.EndedAt != ms(t, "2026-09-26T18:31:27.661Z") || info.OutputTokens != 125+19+6 {
		t.Errorf("after the notice and its answer: %+v", info)
	}
}

// scriptedReader answers each ReadFrom with the next scripted batch, recording
// the offset it was asked for.
type scriptedReader struct {
	lines   [][]string
	next    []int64
	offsets []int64
}

func (r *scriptedReader) ReadFrom(_ string, off int64) ([]string, int64, error) {
	i := len(r.offsets)
	r.offsets = append(r.offsets, off)
	if i >= len(r.lines) {
		return nil, off, nil
	}
	return r.lines[i], r.next[i], nil
}

func (r *scriptedReader) FullResult(string, string) (string, json.RawMessage, error) {
	return "", nil, errors.New("not scripted")
}

func (r *scriptedReader) SearchResults(string, string, int) ([]ResultMatch, error) {
	return nil, errors.New("not scripted")
}

func mustRead(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func appendTo(t *testing.T, path, s string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(s); err != nil {
		t.Fatal(err)
	}
}

// The builders below write the smallest records that carry what the tail reads,
// in the shape the fixtures show in full.

func userText(ts, text string) string {
	return fmt.Sprintf(`{"type":"user","isSidechain":true,"timestamp":%q,"message":{"role":"user","content":%s}}`, ts, jsonString(text))
}

func toolCall(ts, msgID, toolID, name, input string) string {
	return fmt.Sprintf(`{"type":"assistant","isSidechain":true,"timestamp":%q,"message":{"id":%q,"role":"assistant","model":"claude-opus-5-5","stop_reason":"tool_use","content":[{"type":"tool_use","id":%q,"name":%q,"input":%s}],"usage":{"output_tokens":10}}}`, ts, msgID, toolID, name, input)
}

func finalText(ts, msgID, stop, text string) string {
	return fmt.Sprintf(`{"type":"assistant","isSidechain":true,"timestamp":%q,"message":{"id":%q,"role":"assistant","model":"claude-opus-5-5","stop_reason":%q,"content":[{"type":"text","text":%s}],"usage":{"output_tokens":10}}}`, ts, msgID, stop, jsonString(text))
}

func apiError(ts, text string) string {
	return fmt.Sprintf(`{"type":"assistant","isSidechain":true,"timestamp":%q,"message":{"id":"e-%s","role":"assistant","model":"<synthetic>","stop_reason":"stop_sequence","content":[{"type":"text","text":%s}],"usage":{"output_tokens":0}},"error":"unknown","isApiErrorMessage":true}`, ts, ts, jsonString(text))
}

func toolResult(ts, toolID, text string, endsTurn bool) string {
	return fmt.Sprintf(`{"type":"user","isSidechain":true,"timestamp":%q,"toolEndsTurn":%t,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":%q,"content":%s}]}}`, ts, endsTurn, toolID, jsonString(text))
}

// notice is a background task's notification as it reaches an agent that is
// waiting: a user record whose text carries the notification.
func notice(ts, id, status, extra string) string {
	return userText(ts, "[SYSTEM NOTIFICATION - NOT USER INPUT]\n\n<task-notification>\n<task-id>"+id+"</task-id>\n<status>"+status+"</status>\n<summary>"+extra+"</summary>\n</task-notification>")
}

// queuedNotice is the same notification reaching an agent that is busy: a
// queued_command attachment.
func queuedNotice(ts, id, status string) string {
	prompt := "<task-notification>\n<task-id>" + id + "</task-id>\n<status>" + status + "</status>\n</task-notification>"
	return fmt.Sprintf(`{"type":"attachment","isSidechain":true,"timestamp":%q,"attachment":{"type":"queued_command","prompt":%s,"commandMode":"task-notification"}}`, ts, jsonString(prompt))
}

// structuredOutput is how a workflow member hands back its result.
func structuredOutput(ts, data string) string {
	return fmt.Sprintf(`{"type":"attachment","isSidechain":true,"timestamp":%q,"attachment":{"type":"structured_output","data":%s}}`, ts, data)
}

// monitorEvent is a Monitor's notification: an event, and no status.
func monitorEvent(ts, id, event string) string {
	return userText(ts, "<task-notification>\n<task-id>"+id+"</task-id>\n<summary>Monitor event: \"watch the build\"</summary>\n<event>"+event+"</event>\n</task-notification>")
}
