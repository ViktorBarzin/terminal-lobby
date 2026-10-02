package main

import (
	"testing"
	"time"
)

// Transcript lines for background work, in the shapes Claude Code writes
// (measured from a live transcript on 2026-10-02).
func bgLaunchLines(taskID, at string) []string {
	return []string{
		`{"type":"assistant","timestamp":"` + at + `","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_bg1","name":"Bash","input":{"command":"sleep 45; echo FOXTROT-45","run_in_background":true}}]}}`,
		`{"type":"user","timestamp":"` + at + `","message":{"role":"user","content":[{"tool_use_id":"toolu_bg1","type":"tool_result","content":"Command running in background with ID: ` + taskID + `."}]},"toolUseResult":{"stdout":"","stderr":"","backgroundTaskId":"` + taskID + `"}}`,
	}
}

func bgNoticeLine(taskID, status, at string) string {
	text := "<task-notification>\n<task-id>" + taskID + "</task-id>\n<tool-use-id>toolu_bg1</tool-use-id>\n<status>" + status + "</status>\n<summary>Background command completed</summary>\n</task-notification>"
	return `{"type":"user","timestamp":"` + at + `","origin":{"kind":"task-notification"},"message":{"role":"user","content":` + jsonString(text) + `}}`
}

// Measured live on 2026-10-02: the first turn of a new conversation ran with
// @claude_transcript unset, so the second turn's line count before sending
// read as 0. The previous turn's "done" plus a transcript longer than 0 was
// taken as this turn finishing, and the task came back done with the FIRST
// turn's answer ("ALPHA" for a prompt whose real answer was "BRAVO").
func TestTurnNeverReturnsAnAnswerFromBeforeItsPrompt(t *testing.T) {
	h := newHarness(t)
	h.sessions.start(testOSUser, LiveSession{Name: "c1", Owner: testActor, State: "done"})
	// The earlier turn happened, but nothing stamped where its transcript is.
	h.sessions.noTranscript[key(testOSUser, "c1")] = true
	h.sessions.onPrompt = func(f *fakeSessions, k string) {
		// The stamp lands as the new turn starts; the state still says done.
		delete(f.noTranscript, k)
		f.setTranscriptLocked(k,
			userLine("Reply with ALPHA", "2026-09-16T10:59:50Z"),
			assistantLine("ALPHA", "2026-09-16T10:59:51Z"))
		go func() {
			time.Sleep(30 * time.Millisecond)
			f.setState(testOSUser, "c1", "running")
			time.Sleep(10 * time.Millisecond)
			f.appendTranscript(testOSUser, "c1",
				userLine("Reply with BRAVO", "2026-09-16T11:00:05Z"),
				assistantLine("BRAVO", "2026-09-16T11:00:06Z"))
			f.setState(testOSUser, "c1", "done")
		}()
	}

	task := h.sendMessage("c1", "Reply with BRAVO")
	v := h.waitStatus(task, StatusDone, StatusFailed)
	if v.Status != StatusDone || v.Result != "BRAVO" {
		t.Fatalf("status %q result %q error %q, want done BRAVO", v.Status, v.Result, v.Error)
	}
}

// The prompt reaching the transcript proves the turn STARTED, not that it
// ended. A watcher that took the stale "done" plus the prompt's own line as
// the end would read the answer before it is written.
func TestTurnWaitsForTheAnswerAfterItsPrompt(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	h.sessions.onPrompt = func(f *fakeSessions, k string) {
		f.appendTranscriptLocked(k, userLine("go", "2026-09-16T11:00:01Z"))
		go func() {
			time.Sleep(30 * time.Millisecond)
			f.appendTranscript(testOSUser, "c1", assistantLine("the answer", "2026-09-16T11:00:09Z"))
			f.setState(testOSUser, "c1", "running")
			f.setState(testOSUser, "c1", "done")
		}()
	}

	task := h.sendMessage("c1", "go")
	v := h.waitStatus(task, StatusDone, StatusFailed)
	if v.Status != StatusDone || v.Result != "the answer" {
		t.Fatalf("status %q result %q error %q, want done with the answer", v.Status, v.Result, v.Error)
	}
}

// Measured live on 2026-10-02: a turn that ran `sleep 45` in the background
// ended with "I'm waiting for the background command", and the task came
// back done with that as its result. The real answer, FOXTROT-45, came in a
// second turn started by the command's <task-notification>. The task stays
// running while background work it started is outstanding.
func TestTurnWaitsOutBackgroundWork(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	h.sessions.onPrompt = func(f *fakeSessions, k string) {
		f.setStateLocked(k, "running")
		go func() {
			time.Sleep(5 * time.Millisecond)
			f.appendTranscript(testOSUser, "c1", userLine("run it in the background", "2026-09-16T11:00:01Z"))
			f.appendTranscript(testOSUser, "c1", bgLaunchLines("bx1", "2026-09-16T11:00:02Z")...)
			f.appendTranscript(testOSUser, "c1", assistantLine("Waiting for the background command.", "2026-09-16T11:00:03Z"))
			f.setState(testOSUser, "c1", "done")
			time.Sleep(60 * time.Millisecond)
			f.appendTranscript(testOSUser, "c1", bgNoticeLine("bx1", "completed", "2026-09-16T11:00:48Z"))
			f.setState(testOSUser, "c1", "running")
			time.Sleep(5 * time.Millisecond)
			f.appendTranscript(testOSUser, "c1", assistantLine("FOXTROT-45", "2026-09-16T11:00:50Z"))
			f.setState(testOSUser, "c1", "done")
		}()
	}

	task := h.sendMessage("c1", "run it in the background")
	time.Sleep(40 * time.Millisecond)
	if v, _ := h.srv.Tasks.Get(task); v.Status != StatusRunning {
		t.Fatalf("status %q result %q while the background command runs, want running", v.Status, v.Result)
	}
	v := h.waitStatus(task, StatusDone, StatusFailed)
	if v.Status != StatusDone || v.Result != "FOXTROT-45" {
		t.Fatalf("status %q result %q error %q, want done FOXTROT-45", v.Status, v.Result, v.Error)
	}
	if v.BackgroundRunning {
		t.Fatal("background_running set on a turn whose background work finished")
	}
}

// The notification arriving does not settle the task on its own: the
// answer it prompts has to be written first.
func TestTurnDoesNotSettleOnTheNotificationAlone(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	h.sessions.onPrompt = func(f *fakeSessions, k string) {
		f.setStateLocked(k, "running")
		go func() {
			time.Sleep(5 * time.Millisecond)
			f.appendTranscript(testOSUser, "c1", userLine("go", "2026-09-16T11:00:01Z"))
			f.appendTranscript(testOSUser, "c1", bgLaunchLines("bx1", "2026-09-16T11:00:02Z")...)
			f.appendTranscript(testOSUser, "c1", assistantLine("Waiting.", "2026-09-16T11:00:03Z"))
			f.setState(testOSUser, "c1", "done")
			time.Sleep(20 * time.Millisecond)
			// The notification is written while the state still says done.
			f.appendTranscript(testOSUser, "c1", bgNoticeLine("bx1", "completed", "2026-09-16T11:00:48Z"))
			time.Sleep(40 * time.Millisecond)
			f.setState(testOSUser, "c1", "running")
			f.appendTranscript(testOSUser, "c1", assistantLine("the real answer", "2026-09-16T11:00:50Z"))
			f.setState(testOSUser, "c1", "done")
		}()
	}

	task := h.sendMessage("c1", "go")
	v := h.waitStatus(task, StatusDone, StatusFailed)
	if v.Status != StatusDone || v.Result != "the real answer" {
		t.Fatalf("status %q result %q error %q", v.Status, v.Result, v.Error)
	}
}

// Background work that never ends (a dev server, a tail) does not hold the
// task forever: past the hold it settles with what the turn said, and says
// that work is still running.
func TestTurnSettlesWhenBackgroundWorkOutlivesTheHold(t *testing.T) {
	h := newHarness(t)
	h.srv.BackgroundHold = 50 * time.Millisecond
	h.readyConversation("c1")
	h.sessions.onPrompt = func(f *fakeSessions, k string) {
		f.setStateLocked(k, "running")
		go func() {
			time.Sleep(5 * time.Millisecond)
			f.appendTranscript(testOSUser, "c1", userLine("start the server", "2026-09-16T11:00:01Z"))
			f.appendTranscript(testOSUser, "c1", bgLaunchLines("bsrv", "2026-09-16T11:00:02Z")...)
			f.appendTranscript(testOSUser, "c1", assistantLine("The server is up on port 8080.", "2026-09-16T11:00:03Z"))
			f.setState(testOSUser, "c1", "done")
		}()
	}

	task := h.sendMessage("c1", "start the server")
	v := h.waitStatus(task, StatusDone, StatusFailed)
	if v.Status != StatusDone || v.Result != "The server is up on port 8080." {
		t.Fatalf("status %q result %q error %q", v.Status, v.Result, v.Error)
	}
	if !v.BackgroundRunning {
		t.Fatal("background_running not set on a turn that left work running")
	}
}

// A background command that was stopped, or failed, is not outstanding.
func TestBackgroundTasksOutstanding(t *testing.T) {
	launch := bgLaunchLines("b1", "2026-09-16T11:00:02Z")
	stopped := `{"type":"user","timestamp":"2026-09-16T11:00:04Z","message":{"role":"user","content":[{"tool_use_id":"toolu_x","type":"tool_result","content":"Successfully stopped task: b1 (sleep 240)"}]},"toolUseResult":{"message":"Successfully stopped task: b1 (sleep 240)","task_id":"b1","task_type":"local_bash"}}`
	monitor := `{"type":"user","timestamp":"2026-09-16T11:00:03Z","message":{"role":"user","content":[{"tool_use_id":"toolu_m","type":"tool_result","content":"Monitor started (task m1)"}]},"toolUseResult":{"taskId":"m1","timeoutMs":120000,"persistent":false}}`
	absorbedText := "<task-notification>\\n<task-id>m1</task-id>\\n<tool-use-id>toolu_m</tool-use-id>\\n<status>completed</status>\\n<summary>Monitor stream ended</summary>\\n<event>Task completed</event>\\n</task-notification>"
	absorbed := `{"isSidechain":false,"attachment":{"type":"queued_command","prompt":"` + absorbedText + `","commandMode":"task-notification","origin":{"kind":"task-notification"}},"type":"attachment","timestamp":"2026-10-02T06:56:26.177Z"}`
	enqueued := `{"type":"queue-operation","operation":"enqueue","timestamp":"2026-10-02T06:56:26.177Z","content":"` + absorbedText + `"}`
	persistent := `{"type":"user","timestamp":"2026-09-16T11:00:03Z","message":{"role":"user","content":[{"tool_use_id":"toolu_p","type":"tool_result","content":"Monitor started (task p1)"}]},"toolUseResult":{"taskId":"p1","persistent":true}}`
	for _, c := range []struct {
		name  string
		lines []string
		want  int
	}{
		{"launched", launch, 1},
		{"completed", append(append([]string{}, launch...), bgNoticeLine("b1", "completed", "2026-09-16T11:00:05Z")), 0},
		{"failed", append(append([]string{}, launch...), bgNoticeLine("b1", "failed", "2026-09-16T11:00:05Z")), 0},
		{"stopped with TaskStop", append(append([]string{}, launch...), stopped), 0},
		{"a monitor", []string{monitor}, 1},
		// Measured live on 2026-10-02: a notice that arrives while a turn is
		// running is absorbed into it as a queued_command attachment, and
		// is never written as a user record of its own.
		{"a monitor whose notice was absorbed mid-turn", []string{monitor, absorbed}, 0},
		// Queued is not yet delivered: the turn it starts writes the
		// notice as a user record, and settling before that would hand
		// back the interim answer.
		{"a notice queued but not yet delivered", []string{monitor, enqueued}, 1},
		{"a persistent monitor never ends on its own", []string{persistent}, 0},
	} {
		t.Run(c.name, func(t *testing.T) {
			var lines [][]byte
			for _, l := range c.lines {
				lines = append(lines, []byte(l))
			}
			if got := backgroundOutstanding(lines); len(got) != c.want {
				t.Fatalf("outstanding %v, want %d", got, c.want)
			}
		})
	}
}

// A background subagent's launch and notices, in the shapes Claude Code
// wrote them live on 2026-10-02 (conversation rv-r4-flow). The launch answers
// status async_launched with the agentId its notices will name.
func agentLaunchLines(agentID, at string) []string {
	return []string{
		`{"type":"assistant","timestamp":"` + at + `","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_ag1","name":"Agent","input":{"description":"Run sleep and echo command","prompt":"sleep 40; echo MANGO-58","subagent_type":"general-purpose","run_in_background":true}}]}}`,
		`{"type":"user","timestamp":"` + at + `","message":{"role":"user","content":[{"tool_use_id":"toolu_ag1","type":"tool_result","content":[{"type":"text","text":"Async agent launched successfully.\nagentId: ` + agentID + ` (internal ID - do not mention to user."}]}]},"toolUseResult":{"isAsync":true,"status":"async_launched","agentId":"` + agentID + `","description":"Run sleep and echo command","resolvedModel":"claude-sonnet-5","outputFile":"/var/tmp/x/tasks/` + agentID + `.output","canReadOutputFile":true}}`,
	}
}

// agentNoticeLine is a subagent's <task-notification>. interim is the notice
// an agent sends when it stops with background work of its own still
// running: its status is still "completed", and the note says the result
// may be interim and the same task-id notifies again.
func agentNoticeLine(agentID, result string, interim bool, at string) string {
	note := "A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once."
	if interim {
		note = "This agent stopped with background work of its own still running. It may resume on its own when that work completes or reports, and the same task-id notifies again if it does; the result below may be interim."
	}
	text := "<task-notification>\n<task-id>" + agentID + "</task-id>\n<status>completed</status>\n<summary>Agent \"Run sleep and echo command\" finished</summary>\n<note>" + note + "</note>\n<result>" + result + "</result>\n</task-notification>"
	return `{"type":"user","timestamp":"` + at + `","origin":{"kind":"task-notification"},"message":{"role":"user","content":` + jsonString(text) + `}}`
}

// Measured live on 2026-10-02: a turn that launched a background subagent
// settled done on "Waiting for it to finish." 6 s in. The agent itself
// backgrounded its sleep, so its first notice was interim; the real answer,
// MANGO-58, came two notices and two turns later.
func TestTurnWaitsOutABackgroundSubagent(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	h.sessions.onPrompt = func(f *fakeSessions, k string) {
		f.setStateLocked(k, "running")
		go func() {
			time.Sleep(5 * time.Millisecond)
			f.appendTranscript(testOSUser, "c1", userLine("launch a background subagent", "2026-10-02T09:16:24Z"))
			f.appendTranscript(testOSUser, "c1", agentLaunchLines("a50611dc2ef8e57df", "2026-10-02T09:16:26Z")...)
			f.appendTranscript(testOSUser, "c1", assistantLine("Waiting for it to finish.", "2026-10-02T09:16:28Z"))
			f.setState(testOSUser, "c1", "done")
			time.Sleep(40 * time.Millisecond)
			f.setState(testOSUser, "c1", "running")
			f.appendTranscript(testOSUser, "c1", agentNoticeLine("a50611dc2ef8e57df", "I kicked off the sleep in the background.", true, "2026-10-02T09:16:32Z"))
			f.appendTranscript(testOSUser, "c1", assistantLine("Interim, still waiting.", "2026-10-02T09:16:34Z"))
			f.setState(testOSUser, "c1", "done")
			time.Sleep(40 * time.Millisecond)
			f.setState(testOSUser, "c1", "running")
			f.appendTranscript(testOSUser, "c1", agentNoticeLine("a50611dc2ef8e57df", "MANGO-58", false, "2026-10-02T09:17:14Z"))
			f.appendTranscript(testOSUser, "c1", assistantLine("MANGO-58", "2026-10-02T09:17:15Z"))
			f.setState(testOSUser, "c1", "done")
		}()
	}

	task := h.sendMessage("c1", "launch a background subagent")
	time.Sleep(30 * time.Millisecond)
	if v, _ := h.srv.Tasks.Get(task); v.Status != StatusRunning {
		t.Fatalf("status %q result %q while the subagent works, want running", v.Status, v.Result)
	}
	time.Sleep(40 * time.Millisecond)
	if v, _ := h.srv.Tasks.Get(task); v.Status != StatusRunning {
		t.Fatalf("status %q result %q after the interim notice, want running", v.Status, v.Result)
	}
	v := h.waitStatus(task, StatusDone, StatusFailed)
	if v.Status != StatusDone || v.Result != "MANGO-58" {
		t.Fatalf("status %q result %q error %q, want done MANGO-58", v.Status, v.Result, v.Error)
	}
	if v.BackgroundRunning {
		t.Fatal("background_running set on a turn whose subagent finished")
	}
}

func TestBackgroundSubagentsOutstanding(t *testing.T) {
	launch := agentLaunchLines("a1", "2026-10-02T09:16:26Z")
	interim := agentNoticeLine("a1", "still going", true, "2026-10-02T09:16:32Z")
	final := agentNoticeLine("a1", "MANGO-58", false, "2026-10-02T09:17:14Z")
	// A foreground Agent call also answers with an agentId, but it has
	// finished by the time its result is written.
	foreground := `{"type":"user","timestamp":"2026-10-02T09:16:26Z","message":{"role":"user","content":[{"tool_use_id":"toolu_f","type":"tool_result","content":[{"type":"text","text":"done"}]}]},"toolUseResult":{"status":"completed","agentId":"af1","content":[{"type":"text","text":"done"}]}}`
	with := func(extra ...string) []string { return append(append([]string{}, launch...), extra...) }
	for _, c := range []struct {
		name  string
		lines []string
		want  int
	}{
		{"launched", launch, 1},
		{"its final notice", with(final), 0},
		{"only an interim notice", with(interim), 1},
		{"interim then final", with(interim, final), 0},
		{"a foreground agent", []string{foreground}, 0},
	} {
		t.Run(c.name, func(t *testing.T) {
			var lines [][]byte
			for _, l := range c.lines {
				lines = append(lines, []byte(l))
			}
			if got := backgroundOutstanding(lines); len(got) != c.want {
				t.Fatalf("outstanding %v, want %d", got, c.want)
			}
		})
	}
}
