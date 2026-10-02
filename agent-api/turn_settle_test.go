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
