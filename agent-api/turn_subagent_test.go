package main

import (
	"strings"
	"testing"
	"time"
)

// Measured live on 2026-10-02 (conversation rv3-flow, Claude Code 2.1.287): a
// turn launched a background subagent, the subagent backgrounded its sleep
// and armed a Monitor on it, and both of the subagent's notices carried the
// "result below may be interim" note: the first because the sleep was still
// running, the second because the Monitor was. The answer, SUBAGENT-DONE-42,
// was written at 18:55:41; the task stayed running for the whole 30-minute
// hold and then settled with background_running set. The Monitor expired at
// 18:56:12 without waking the subagent; its expiry notice was only ever
// enqueued in the main session, never delivered.
//
// The fixtures below keep the ids, times and wording of that transcript and
// drop everything the turn reader does not look at.

const rv3Agent = "a7181c2c2fcd90994"

func rv3InterimNotice(result, at string) string {
	return agentNoticeLine(rv3Agent, result, true, at)
}

// rv3Main is the main session's side of the turn, up to the second notice
// and the reply to it.
func rv3Main() []string {
	return append(agentLaunchLines(rv3Agent, "2026-10-02T18:54:34.543Z"),
		assistantLine("LAUNCHED", "2026-10-02T18:54:36.086Z"),
		rv3InterimNotice("Waiting for the background sleep to finish before replying.", "2026-10-02T18:54:44.131Z"),
		assistantLine("The subagent is still waiting on its own background sleep to finish.", "2026-10-02T18:54:46.647Z"),
		rv3InterimNotice("SUBAGENT-DONE-42", "2026-10-02T18:55:39.897Z"),
		assistantLine("SUBAGENT-DONE-42", "2026-10-02T18:55:41.498Z"),
	)
}

// The subagent's own transcript, subagents/agent-a7181c2c2fcd90994.jsonl.
// Every record is a sidechain one, and the notice for its own sleep reached
// it as a meta user record.
var (
	rv3SubPrompt  = `{"type":"user","isSidechain":true,"timestamp":"2026-10-02T18:54:34.524Z","message":{"role":"user","content":"Run the shell command: sleep 60. After it completes, respond with exactly this string and nothing else: SUBAGENT-DONE-42"}}`
	rv3SubBash    = `{"type":"user","isSidechain":true,"timestamp":"2026-10-02T18:54:38.554Z","message":{"role":"user","content":[{"tool_use_id":"toolu_01GeVdKjajLXYuVmGpbyAZLy","type":"tool_result","content":"Command running in background with ID: b5qkrv9vh."}]},"toolUseResult":{"stdout":"","stderr":"","interrupted":false,"backgroundTaskId":"b5qkrv9vh"}}`
	rv3SubMonitor = `{"type":"user","isSidechain":true,"timestamp":"2026-10-02T18:54:42.752Z","message":{"role":"user","content":[{"tool_use_id":"toolu_01Lb4UBcfpXawpnHLcaP2LUc","type":"tool_result","content":"Monitor started (task bvmj0mdxk, expires in 1m 30s unless the source ends first)"}]},"toolUseResult":{"taskId":"bvmj0mdxk","timeoutMs":90000,"persistent":false}}`
	rv3SubWaiting = `{"type":"assistant","isSidechain":true,"timestamp":"2026-10-02T18:54:44.013Z","message":{"role":"assistant","content":[{"type":"text","text":"Waiting for the background sleep to finish before replying."}]}}`
	rv3SubNotice  = `{"type":"user","isSidechain":true,"isMeta":true,"timestamp":"2026-10-02T18:55:38.588Z","origin":{"kind":"task-notification"},"message":{"role":"user","content":` + jsonString("[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\n\n<task-notification>\n<task-id>b5qkrv9vh</task-id>\n<tool-use-id>toolu_01GeVdKjajLXYuVmGpbyAZLy</tool-use-id>\n<status>completed</status>\n<summary>Background command \"sleep 60\" completed (exit code 0)</summary>\n</task-notification>") + `}}`
	rv3SubAnswer  = `{"type":"assistant","isSidechain":true,"timestamp":"2026-10-02T18:55:39.828Z","message":{"role":"assistant","content":[{"type":"text","text":"SUBAGENT-DONE-42"}]}}`
)

func rv3Sub() []string {
	return []string{rv3SubPrompt, rv3SubBash, rv3SubMonitor, rv3SubWaiting, rv3SubNotice, rv3SubAnswer}
}

func toLines(ss []string) [][]byte {
	var out [][]byte
	for _, s := range ss {
		out = append(out, []byte(s))
	}
	return out
}

func at(s string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		panic(err)
	}
	return t
}

// subagentsOf is an agentView over a fixed set of subagent transcripts.
func subagentsOf(now time.Time, files map[string][]string) agentView {
	return agentView{now: now, read: func(id string) ([][]byte, bool) {
		f, ok := files[id]
		return toLines(f), ok
	}}
}

// An interim notice no longer holds a subagent open once the subagent's own
// transcript shows it has nothing left that could wake it, and it has said
// nothing since the notice.
func TestInterimNoticeClosesOnceTheSubagentIsIdle(t *testing.T) {
	main := rv3Main()
	firstOnly := main[:5] // launch, LAUNCHED, the first interim notice, the reply
	for _, c := range []struct {
		name  string
		main  []string
		files map[string][]string
		now   string
		want  int
	}{
		// The rv3-flow repro at the moment of the answer: the subagent's
		// Monitor still had 31 s to run, and an event from it could have
		// woken the subagent again.
		{"its monitor is still armed", main, map[string][]string{rv3Agent: rv3Sub()}, "2026-10-02T18:55:41.6Z", 1},
		{"its monitor has expired", main, map[string][]string{rv3Agent: rv3Sub()}, "2026-10-02T18:56:13Z", 0},
		// Nothing to read is what every turn had before: keep holding.
		{"its transcript cannot be read", main, nil, "2026-10-02T18:56:13Z", 1},
		// After the first notice the sleep was still running.
		{"its own background command is running", firstOnly,
			map[string][]string{rv3Agent: rv3Sub()[:4]}, "2026-10-02T18:57:00Z", 1},
		// The sleep's notice woke the subagent: its next notice is still to
		// come, and the interim one is not the answer.
		{"it was woken after its last notice", firstOnly,
			map[string][]string{rv3Agent: rv3Sub()[:5]}, "2026-10-02T18:57:00Z", 1},
		{"it answered after its last notice", firstOnly,
			map[string][]string{rv3Agent: rv3Sub()}, "2026-10-02T18:57:00Z", 1},
	} {
		t.Run(c.name, func(t *testing.T) {
			got := backgroundOutstanding(toLines(c.main), subagentsOf(at(c.now), c.files))
			if len(got) != c.want {
				t.Fatalf("outstanding %v, want %d", got, c.want)
			}
		})
	}
}

// A Monitor that times out says so in a notice with no <status>; measured on
// transcripts from 2026-10-02 ("[Monitor expired after 10m with no events
// delivered..."). It is over, and holding the turn for it is the 30-minute
// wait all over again.
func TestExpiredMonitorIsNotOutstanding(t *testing.T) {
	monitor := `{"type":"user","timestamp":"2026-10-02T11:00:03Z","message":{"role":"user","content":[{"tool_use_id":"toolu_m","type":"tool_result","content":"Monitor started (task bbvque85c)"}]},"toolUseResult":{"taskId":"bbvque85c","timeoutMs":600000,"persistent":false}}`
	expired := `{"type":"user","timestamp":"2026-10-02T11:10:03Z","origin":{"kind":"task-notification"},"message":{"role":"user","content":` +
		jsonString("<task-notification>\n<task-id>bbvque85c</task-id>\n<summary>Monitor event: \"goodreads poller DB reconnect and cycle outcome\"</summary>\n<event>[Monitor expired after 10m with no events delivered. Re-arm it if you still need the watch — and widen the filter if silence was unexpected.]</event>\n</task-notification>") + `}}`
	event := strings.Replace(expired, "[Monitor expired after 10m with no events delivered. Re-arm it if you still need the watch — and widen the filter if silence was unexpected.]", "cycle ok", 1)
	for _, c := range []struct {
		name  string
		lines []string
		want  int
	}{
		{"armed", []string{monitor}, 1},
		{"an event is not the end", []string{monitor, event}, 1},
		{"expired", []string{monitor, expired}, 0},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := backgroundOutstanding(toLines(c.lines), agentView{}); len(got) != c.want {
				t.Fatalf("outstanding %v, want %d", got, c.want)
			}
		})
	}
}

// End to end through the turn runner: the subagent's last notice carries the
// interim note, but the subagent's transcript shows its own work ended before
// it answered. The task settles on the answer at once, without the hold and
// without background_running.
func TestTurnSettlesWhenTheSubagentsLastNoticeOnlyLooksInterim(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	sub := []string{rv3SubPrompt, rv3SubBash, rv3SubWaiting, rv3SubNotice, rv3SubAnswer} // no Monitor
	h.sessions.onPrompt = func(f *fakeSessions, k string) {
		f.setStateLocked(k, "running")
		go func() {
			time.Sleep(5 * time.Millisecond)
			f.appendTranscript(testOSUser, "c1", userLine("launch one background subagent", "2026-10-02T18:54:31.5Z"))
			f.appendTranscript(testOSUser, "c1", rv3Main()...)
			f.setAgentTranscript(testOSUser, "c1", rv3Agent, sub...)
			f.setState(testOSUser, "c1", "done")
		}()
	}

	task := h.sendMessage("c1", "launch one background subagent")
	v := h.waitStatus(task, StatusDone, StatusFailed)
	if v.Status != StatusDone || v.Result != "SUBAGENT-DONE-42" || v.BackgroundRunning {
		t.Fatalf("status %q result %q background %v error %q, want done SUBAGENT-DONE-42 with nothing running",
			v.Status, v.Result, v.BackgroundRunning, v.Error)
	}
}
