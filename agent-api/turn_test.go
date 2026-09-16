package main

import (
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

// sendMessage posts one message and returns its task id.
func (h *harness) sendMessage(conv, text string) string {
	h.t.Helper()
	var got struct {
		TaskID       string `json:"task_id"`
		Status       string `json:"status"`
		QueuedBehind int    `json:"queued_behind"`
	}
	h.decodeJSON(h.call("POST", "/v1/conversations/"+conv+"/messages", `{"text":`+jsonString(text)+`}`),
		http.StatusAccepted, &got)
	if got.Status != "accepted" || got.TaskID == "" {
		h.t.Fatalf("message not accepted: %+v", got)
	}
	return got.TaskID
}

// readyConversation is a conversation owned by the caller with one line of
// history, in the state a finished turn leaves it.
func (h *harness) readyConversation(name string) {
	h.t.Helper()
	h.sessions.start(testOSUser, LiveSession{Name: name, Owner: testActor, State: "done"})
	h.sessions.setTranscript(testOSUser, name, userLine("earlier", "2026-09-16T10:00:00Z"),
		assistantLine("the previous turn's answer", "2026-09-16T10:00:01Z"))
}

// A whole turn, through the API a caller sees.
func TestTurnRunsToDone(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	// The session starts working as soon as the prompt lands, and finishes on
	// the next beat, which is what a real turn looks like from outside.
	h.sessions.onPrompt = func(f *fakeSessions, k string) {
		f.setStateLocked(k, "running")
		go func() {
			time.Sleep(5 * time.Millisecond)
			f.appendTranscript(testOSUser, "c1",
				userLine("the new question", "2026-09-16T11:00:00Z"),
				assistantLine("the new answer", "2026-09-16T11:00:09Z"))
			f.setState(testOSUser, "c1", "done")
		}()
	}

	task := h.sendMessage("c1", "the new question")
	v := h.waitStatus(task, StatusDone, StatusFailed)
	if v.Status != StatusDone {
		t.Fatalf("status %q, error %q", v.Status, v.Error)
	}
	if v.Result != "the new answer" {
		t.Fatalf("result %q — the result must be THIS turn's final message", v.Result)
	}
	if v.DetailURL != "/v1/conversations/c1/transcript" {
		t.Fatalf("detail_url %q", v.DetailURL)
	}
	// What was injected is exactly what the caller sent.
	prompts := h.sessions.promptCalls()
	if len(prompts) != 1 || prompts[0].Text != "the new question" || prompts[0].OSUser != testOSUser {
		t.Fatalf("injected %+v", prompts)
	}
}

// The race the watcher exists for: @claude_state still reads "done" from the
// PREVIOUS turn for a moment after the prompt lands. A watcher that believed
// the first read would hand back the previous turn's answer.
func TestTurnIgnoresTheStaleDoneState(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	// The hook is slow: the state stays "done" for a while, and no transcript
	// is written in the meantime.
	h.sessions.onPrompt = func(f *fakeSessions, k string) {
		go func() {
			time.Sleep(25 * time.Millisecond)
			f.setState(testOSUser, "c1", "running")
			time.Sleep(10 * time.Millisecond)
			f.appendTranscript(testOSUser, "c1", assistantLine("the real answer", "2026-09-16T11:00:09Z"))
			f.setState(testOSUser, "c1", "done")
		}()
	}

	task := h.sendMessage("c1", "go")
	v := h.waitStatus(task, StatusDone, StatusFailed)
	if v.Status != StatusDone {
		t.Fatalf("status %q, error %q", v.Status, v.Error)
	}
	if v.Result != "the real answer" {
		t.Fatalf("result %q, want the new answer — the stale done state was believed", v.Result)
	}
}

// A turn that finishes between two polls is still finished. The transcript
// growing is the evidence, in place of a "running" the watcher never saw.
func TestTurnFinishesFasterThanOnePoll(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	h.sessions.onPrompt = func(f *fakeSessions, k string) {
		f.appendTranscriptLocked(k, assistantLine("instant", "2026-09-16T11:00:00Z"))
		f.setStateLocked(k, "done")
	}

	task := h.sendMessage("c1", "quick")
	v := h.waitStatus(task, StatusDone, StatusFailed)
	if v.Status != StatusDone || v.Result != "instant" {
		t.Fatalf("status %q result %q error %q", v.Status, v.Result, v.Error)
	}
}

// Blocked on a question for a person.
func TestTurnParksOnNeedsInput(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	h.sessions.setPane(testOSUser, "c1", strings.Join([]string{
		"  Some earlier output",
		"",
		"╭──────────────────────────────╮",
		"│ Land this on master?         │",
		"│                              │",
		"│ ❯ 1. Yes                     │",
		"│   2. Open a pull request     │",
		"╰──────────────────────────────╯",
	}, "\n"))
	h.sessions.onPrompt = func(f *fakeSessions, k string) {
		f.setStateLocked(k, "running")
		go func() {
			time.Sleep(5 * time.Millisecond)
			f.setState(testOSUser, "c1", "awaiting")
		}()
	}

	task := h.sendMessage("c1", "ship it")
	v := h.waitStatus(task, StatusNeedsInput, StatusFailed, StatusDone)
	if v.Status != StatusNeedsInput {
		t.Fatalf("status %q, error %q", v.Status, v.Error)
	}
	if v.Question == "" {
		t.Fatal("needs_input carried no question, which is the one field it exists for")
	}
	if !strings.Contains(v.Question, "Land this on master") {
		t.Fatalf("question %q does not name what is being asked", v.Question)
	}

	// Answered in the terminal, the same turn resumes and finishes.
	h.sessions.appendTranscript(testOSUser, "c1", assistantLine("landed", "2026-09-16T11:05:00Z"))
	h.sessions.setState(testOSUser, "c1", "running")
	v = h.waitStatus(task, StatusRunning, StatusDone, StatusFailed)
	if v.Status == StatusFailed {
		t.Fatalf("a resumed turn failed: %q", v.Error)
	}
	h.sessions.setState(testOSUser, "c1", "done")
	v = h.waitStatus(task, StatusDone, StatusFailed)
	if v.Status != StatusDone || v.Result != "landed" {
		t.Fatalf("status %q result %q error %q", v.Status, v.Result, v.Error)
	}
}

// Every way a turn can fail, each with an error a person can act on.
func TestTurnFailures(t *testing.T) {
	cases := []struct {
		name  string
		arm   func(*harness)
		match string
		// injected says whether the message should have reached tmux at all.
		injected bool
	}{
		{
			name: "the transcript cannot be read when the turn ends",
			arm: func(h *harness) {
				h.readyConversation("c1")
				h.sessions.onPrompt = func(f *fakeSessions, k string) {
					f.setStateLocked(k, "running")
					go func() {
						time.Sleep(5 * time.Millisecond)
						f.mu.Lock()
						f.transcriptErr = errors.New("input/output error")
						f.mu.Unlock()
						f.setState(testOSUser, "c1", "done")
					}()
				}
			},
			match:    "could not be read",
			injected: true,
		},
		{
			name: "the paste fails",
			arm: func(h *harness) {
				h.readyConversation("c1")
				h.sessions.promptErr = errors.New("tmux: no server")
			},
			match:    "failed",
			injected: true,
		},
		{
			name: "no turn ever starts",
			arm: func(h *harness) {
				h.readyConversation("c1") // stays "done", transcript never grows
			},
			match:    "no turn started",
			injected: true,
		},
		{
			name: "a conversation with no transcript and no Claude",
			arm: func(h *harness) {
				h.sessions.start(testOSUser, LiveSession{Name: "c1", Owner: testActor})
				h.sessions.noTranscript[key(testOSUser, "c1")] = true
			},
			match:    "no Claude in it",
			injected: true,
		},
		{
			name: "the session has no Claude in it",
			arm: func(h *harness) {
				h.sessions.start(testOSUser, LiveSession{Name: "c1", Owner: testActor})
				h.sessions.setTranscript(testOSUser, "c1", userLine("x", "2026-09-16T10:00:00Z"))
			},
			match:    "no Claude in it",
			injected: true,
		},
		{
			name: "the session is killed mid-turn",
			arm: func(h *harness) {
				h.readyConversation("c1")
				h.sessions.onPrompt = func(f *fakeSessions, k string) {
					f.setStateLocked(k, "running")
					go func() {
						time.Sleep(5 * time.Millisecond)
						f.mu.Lock()
						delete(f.live, key(testOSUser, "c1"))
						f.mu.Unlock()
					}()
				}
			},
			match:    "is gone",
			injected: true,
		},
		{
			name: "the turn produces no assistant message",
			arm: func(h *harness) {
				h.readyConversation("c1")
				h.sessions.onPrompt = func(f *fakeSessions, k string) {
					f.setStateLocked(k, "running")
					go func() {
						time.Sleep(5 * time.Millisecond)
						f.appendTranscript(testOSUser, "c1", userLine("only the echo", "2026-09-16T11:00:00Z"))
						f.setState(testOSUser, "c1", "done")
					}()
				}
			},
			match:    "without an assistant message",
			injected: true,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t)
			c.arm(h)
			task := h.sendMessage("c1", "go")
			v := h.waitStatus(task, StatusFailed, StatusDone)
			if v.Status != StatusFailed {
				t.Fatalf("status %q result %q, want failed", v.Status, v.Result)
			}
			if !strings.Contains(v.Error, c.match) {
				t.Fatalf("error %q does not mention %q", v.Error, c.match)
			}
			if got := len(h.sessions.promptCalls()) > 0; got != c.injected {
				t.Fatalf("injected=%v, want %v", got, c.injected)
			}
		})
	}
}

// A conversation runs one turn at a time. Driven through the HTTP surface
// rather than the Runner, so the property is proved end to end.
func TestSecondMessageQueues(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	h.sessions.onPrompt = func(f *fakeSessions, k string) { f.setStateLocked(k, "running") }

	first := h.sendMessage("c1", "first")
	h.waitStatus(first, StatusRunning)

	var second struct {
		TaskID       string `json:"task_id"`
		QueuedBehind int    `json:"queued_behind"`
	}
	h.decodeJSON(h.call("POST", "/v1/conversations/c1/messages", `{"text":"second"}`),
		http.StatusAccepted, &second)
	if second.QueuedBehind != 1 {
		t.Fatalf("queued_behind %d, want 1", second.QueuedBehind)
	}

	// The second message has NOT been injected while the first turn runs.
	// This is the property: a bracketed paste arriving mid-turn would land on
	// Claude's input line and be submitted into the middle of the answer.
	time.Sleep(20 * time.Millisecond)
	if prompts := h.sessions.promptCalls(); len(prompts) != 1 {
		t.Fatalf("%d prompts injected while one turn was running: %+v", len(prompts), prompts)
	}
	if v, _ := h.srv.Tasks.Get(second.TaskID); v.Status != StatusAccepted {
		t.Fatalf("the queued task is %q, want accepted", v.Status)
	}

	// Finish the first, and the second runs.
	h.sessions.appendTranscript(testOSUser, "c1", assistantLine("one done", "2026-09-16T11:00:00Z"))
	h.sessions.setState(testOSUser, "c1", "done")
	h.waitStatus(first, StatusDone, StatusFailed)
	h.waitStatus(second.TaskID, StatusRunning, StatusDone, StatusFailed)

	prompts := h.sessions.promptCalls()
	if len(prompts) != 2 || prompts[0].Text != "first" || prompts[1].Text != "second" {
		t.Fatalf("injected %+v, want first then second", prompts)
	}
}

// Different conversations do not wait for each other.
func TestConversationsRunConcurrently(t *testing.T) {
	h := newHarness(t)
	for _, name := range []string{"c1", "c2", "c3"} {
		h.readyConversation(name)
	}
	var mu sync.Mutex
	running := map[string]bool{}
	h.sessions.onPrompt = func(f *fakeSessions, k string) {
		f.setStateLocked(k, "running")
		mu.Lock()
		running[k] = true
		mu.Unlock()
	}

	var tasks []string
	for _, name := range []string{"c1", "c2", "c3"} {
		tasks = append(tasks, h.sendMessage(name, "go"))
	}
	for _, id := range tasks {
		h.waitStatus(id, StatusRunning)
	}

	mu.Lock()
	n := len(running)
	mu.Unlock()
	if n != 3 {
		t.Fatalf("%d of 3 conversations were running at once", n)
	}

	for _, name := range []string{"c1", "c2", "c3"} {
		h.sessions.appendTranscript(testOSUser, name, assistantLine("done "+name, "2026-09-16T11:00:00Z"))
		h.sessions.setState(testOSUser, name, "done")
	}
	for _, id := range tasks {
		h.waitStatus(id, StatusDone, StatusFailed)
	}
}

func TestCancelRunningTurn(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	h.sessions.onPrompt = func(f *fakeSessions, k string) { f.setStateLocked(k, "running") }

	task := h.sendMessage("c1", "a long job")
	h.waitStatus(task, StatusRunning)

	var got struct {
		TaskID      string `json:"task_id"`
		Status      string `json:"status"`
		Interrupted bool   `json:"interrupted"`
	}
	h.decodeJSON(h.call("POST", "/v1/tasks/"+task+"/cancel", ""), http.StatusOK, &got)
	if got.Status != "cancelled" || !got.Interrupted {
		t.Fatalf("got %+v", got)
	}
	if calls := h.sessions.cancelCalls(); len(calls) != 1 || calls[0] != key(testOSUser, "c1") {
		t.Fatalf("interrupt went to %v", calls)
	}

	// The watcher lets go, and a turn that finishes anyway does not undo the
	// cancel.
	h.waitIdle()
	h.sessions.appendTranscript(testOSUser, "c1", assistantLine("finished anyway", "2026-09-16T11:09:00Z"))
	h.sessions.setState(testOSUser, "c1", "done")
	time.Sleep(10 * time.Millisecond)
	v, _ := h.srv.Tasks.Get(task)
	if v.Status != StatusCancelled || v.Result != "" {
		t.Fatalf("a cancelled task became %+v", v)
	}
}

// A queued message is dropped before anything reaches the conversation, and
// no interrupt is sent — that would stop a turn nobody asked to stop.
func TestCancelQueuedMessage(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	h.sessions.onPrompt = func(f *fakeSessions, k string) { f.setStateLocked(k, "running") }

	first := h.sendMessage("c1", "first")
	h.waitStatus(first, StatusRunning)
	second := h.sendMessage("c1", "second")

	var got struct {
		Status      string `json:"status"`
		Interrupted bool   `json:"interrupted"`
	}
	h.decodeJSON(h.call("POST", "/v1/tasks/"+second+"/cancel", ""), http.StatusOK, &got)
	if got.Status != "cancelled" || got.Interrupted {
		t.Fatalf("got %+v, want cancelled without an interrupt", got)
	}
	if calls := h.sessions.cancelCalls(); len(calls) != 0 {
		t.Fatalf("a queued cancel interrupted a running turn: %v", calls)
	}

	h.sessions.appendTranscript(testOSUser, "c1", assistantLine("one done", "2026-09-16T11:00:00Z"))
	h.sessions.setState(testOSUser, "c1", "done")
	h.waitStatus(first, StatusDone, StatusFailed)
	h.waitIdle()

	// The cancelled message never reached tmux.
	for _, p := range h.sessions.promptCalls() {
		if p.Text == "second" {
			t.Fatal("a cancelled queued message was injected")
		}
	}
}

func TestCancelRefusals(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	h.sessions.onPrompt = func(f *fakeSessions, k string) {
		f.appendTranscriptLocked(k, assistantLine("done", "2026-09-16T11:00:00Z"))
		f.setStateLocked(k, "done")
	}

	t.Run("an unknown task", func(t *testing.T) {
		h.decodeJSON(h.call("POST", "/v1/tasks/nope/cancel", ""), http.StatusNotFound, nil)
	})

	t.Run("another caller's task", func(t *testing.T) {
		task := h.sendMessage("c1", "mine")
		h.waitStatus(task, StatusDone, StatusFailed)
		w := h.do(request{method: "POST", path: "/v1/tasks/" + task + "/cancel", token: testOtherToken})
		h.decodeJSON(w, http.StatusForbidden, nil)
	})

	t.Run("a finished task", func(t *testing.T) {
		task := h.sendMessage("c1", "mine")
		h.waitStatus(task, StatusDone, StatusFailed)
		h.decodeJSON(h.call("POST", "/v1/tasks/"+task+"/cancel", ""), http.StatusConflict, nil)
	})
	h.waitIdle()
}

func TestGetTaskUnknown(t *testing.T) {
	h := newHarness(t)
	w := h.call("GET", "/v1/tasks/01NOPE", "")
	h.decodeJSON(w, http.StatusNotFound, nil)
	// The message says WHY an id can vanish, so a caller does not read a
	// restart as lost work.
	if !strings.Contains(w.Body.String(), "restart") {
		t.Fatalf("unhelpful body: %s", w.Body.String())
	}
}

func TestPaneTail(t *testing.T) {
	for _, c := range []struct {
		name  string
		pane  string
		limit int
		want  string
	}{
		{"short", "Continue?\n\n\n", 100, "Continue?"},
		{"empty", "\n\n  \n", 100, ""},
		{"trimmed to a line boundary", "aaaa\nbbbb\ncccc", 9, "cccc"},
		{"exactly the limit", "abcd", 4, "abcd"},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := paneTail(c.pane, c.limit); got != c.want {
				t.Fatalf("paneTail = %q, want %q", got, c.want)
			}
		})
	}
}

// A message sent straight after creating a conversation is SENT, not held.
//
// This is the measured flow, and the reason the readiness gate watches the
// pane rather than the transcript. Against a real Claude on 2026-09-16 the
// SessionStart hook stamped @claude_transcript within a second and the file
// itself did not exist until the first message arrived — so a gate that
// waited for the file waited for something only sending could produce.
func TestTurnSendsToAConversationWithNoTranscriptYet(t *testing.T) {
	h := newHarness(t)
	// Live, owned, and with nothing written: exactly what a session looks
	// like in the second after `claude` starts.
	h.sessions.start(testOSUser, LiveSession{Name: "fresh", Owner: testActor})
	h.sessions.noTranscript[key(testOSUser, "fresh")] = true
	h.sessions.onPrompt = func(f *fakeSessions, k string) {
		f.setStateLocked(k, "running")
		go func() {
			time.Sleep(5 * time.Millisecond)
			// The message is what makes Claude write the file.
			f.mu.Lock()
			delete(f.noTranscript, key(testOSUser, "fresh"))
			f.mu.Unlock()
			f.appendTranscript(testOSUser, "fresh",
				userLine("hello", "2026-09-16T11:00:00Z"),
				assistantLine("up and answering", "2026-09-16T11:00:09Z"))
			f.setState(testOSUser, "fresh", "done")
		}()
	}

	task := h.sendMessage("fresh", "hello")
	v := h.waitStatus(task, StatusDone, StatusFailed)
	if v.Status != StatusDone {
		t.Fatalf("status %q error %q — a message to a fresh conversation must be sent", v.Status, v.Error)
	}
	if v.Result != "up and answering" {
		t.Fatalf("result %q", v.Result)
	}
	if got := h.sessions.promptCalls(); len(got) != 1 {
		t.Fatalf("%d prompts, want 1", len(got))
	}
}

// A transcript that cannot be READ is not a reason to refuse to send, but it
// does mean a line count is no longer evidence: the stale "done" from the
// previous turn must not be believed on the strength of a file whose length
// before the turn is unknown.
func TestTurnWithAnUnreadableTranscriptStillWaitsForTheTurnToStart(t *testing.T) {
	h := newHarness(t)
	h.sessions.start(testOSUser, LiveSession{Name: "c1", Owner: testActor, State: "done"})
	h.sessions.transcriptErr = errors.New("input/output error")
	h.sessions.onPrompt = func(f *fakeSessions, k string) {
		go func() {
			time.Sleep(20 * time.Millisecond)
			// The read recovers, and the session really does start working.
			f.mu.Lock()
			f.transcriptErr = nil
			f.mu.Unlock()
			f.setTranscript(testOSUser, "c1", assistantLine("the real answer", "2026-09-16T11:00:09Z"))
			f.setState(testOSUser, "c1", "running")
			time.Sleep(10 * time.Millisecond)
			f.setState(testOSUser, "c1", "done")
		}()
	}

	task := h.sendMessage("c1", "go")
	v := h.waitStatus(task, StatusDone, StatusFailed)
	if v.Status != StatusDone {
		t.Fatalf("status %q error %q", v.Status, v.Error)
	}
	if v.Result != "the real answer" {
		t.Fatalf("result %q — an unknown mark must not make a stale done believable", v.Result)
	}
}

// The pane settle is waited for before every paste. sessionio measured that
// skipping it half-lands the message: the text arrives and the Enter does not.
func TestTurnWaitsForThePaneBeforePasting(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	h.sessions.onPrompt = func(f *fakeSessions, k string) {
		if f.readyCalls == 0 {
			t.Error("a prompt was pasted without waiting for the pane to settle")
		}
		f.appendTranscriptLocked(k, assistantLine("ok", "2026-09-16T11:00:00Z"))
		f.setStateLocked(k, "done")
	}

	task := h.sendMessage("c1", "go")
	h.waitStatus(task, StatusDone, StatusFailed)
	if h.sessions.readyCallCount() != 1 {
		t.Fatalf("WaitReady called %d times, want 1", h.sessions.readyCallCount())
	}
}

// A pane that never settles is logged and the message is sent anyway.
// sessionio's own reasoning: typing into a pane that never drew a prompt is a
// gamble, dropping the caller's message is a certainty, and the gamble is the
// better of the two.
func TestTurnSendsAnywayWhenThePaneNeverSettles(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	h.sessions.readyErr = errors.New("pane never drew a prompt")
	h.sessions.onPrompt = func(f *fakeSessions, k string) {
		f.appendTranscriptLocked(k, assistantLine("landed anyway", "2026-09-16T11:00:00Z"))
		f.setStateLocked(k, "done")
	}

	task := h.sendMessage("c1", "go")
	v := h.waitStatus(task, StatusDone, StatusFailed)
	if v.Status != StatusDone {
		t.Fatalf("status %q error %q — an unsettled pane must not drop the message", v.Status, v.Error)
	}
}

// Cancelling while the conversation is still starting stops before anything
// is injected.
func TestCancelWhileWaitingForTheHarness(t *testing.T) {
	h := newHarness(t)
	h.sessions.start(testOSUser, LiveSession{Name: "fresh", Owner: testActor})
	// Hold the pane wait open, which is where a starting conversation spends
	// its first seconds.
	release := make(chan struct{})
	h.sessions.readyBlock = release

	task := h.sendMessage("fresh", "never mind")
	// Wait until the turn is actually inside WaitReady, so the cancel lands
	// during the wait rather than before it.
	for h.sessions.readyCallCount() == 0 {
		time.Sleep(time.Millisecond)
	}
	h.decodeJSON(h.call("POST", "/v1/tasks/"+task+"/cancel", ""), http.StatusOK, nil)
	close(release)
	h.waitIdle()

	if got := h.sessions.promptCalls(); len(got) != 0 {
		t.Fatalf("a cancelled message was injected while the harness was starting: %+v", got)
	}
	v, _ := h.srv.Tasks.Get(task)
	if v.Status != StatusCancelled {
		t.Fatalf("status %q, want cancelled", v.Status)
	}
}

// A rename landing MID-TURN must not read as the session disappearing.
//
// tmux-api's autotitle fires from the first turn's content, measured at 20
// seconds after the prompt on this box, so any turn longer than that is
// renamed while it runs. A watcher holding the name it started with would
// report "the tmux session is gone" at the moment the conversation became
// useful.
func TestTurnSurvivesARenameMidFlight(t *testing.T) {
	h := newHarness(t)
	h.sessions.start(testOSUser, LiveSession{
		Name: "agent-work", BornAs: "agent-work", Owner: testActor, State: "done",
	})
	h.sessions.setTranscript(testOSUser, "agent-work", userLine("earlier", "2026-09-16T10:00:00Z"))

	h.sessions.onPrompt = func(f *fakeSessions, k string) {
		f.setStateLocked(k, "running")
		go func() {
			time.Sleep(5 * time.Millisecond)
			// Exactly what tmux-api does, while the turn is still running.
			f.rename(testOSUser, "agent-work", "a-title-from-the-first-turn")
			time.Sleep(5 * time.Millisecond)
			f.appendTranscript(testOSUser, "a-title-from-the-first-turn",
				assistantLine("finished despite the rename", "2026-09-16T11:00:09Z"))
			f.setState(testOSUser, "a-title-from-the-first-turn", "done")
		}()
	}

	task := h.sendMessage("agent-work", "a long job")
	v := h.waitStatus(task, StatusDone, StatusFailed)
	if v.Status != StatusDone {
		t.Fatalf("status %q error %q — the rename was read as the session vanishing", v.Status, v.Error)
	}
	if v.Result != "finished despite the rename" {
		t.Fatalf("result %q", v.Result)
	}
	// The task still reports the id the caller holds.
	if v.ConversationID != "agent-work" {
		t.Fatalf("conversation_id %q", v.ConversationID)
	}
}

// The message is sent to the name tmux answers to NOW, not the id.
func TestTurnPromptsTheLiveName(t *testing.T) {
	h := newHarness(t)
	h.sessions.start(testOSUser, LiveSession{
		Name: "renamed-already", BornAs: "agent-work", Owner: testActor, State: "done",
	})
	h.sessions.setTranscript(testOSUser, "renamed-already", userLine("earlier", "2026-09-16T10:00:00Z"))
	h.sessions.onPrompt = func(f *fakeSessions, k string) {
		f.appendTranscriptLocked(k, assistantLine("ok", "2026-09-16T11:00:00Z"))
		f.setStateLocked(k, "done")
	}

	task := h.sendMessage("agent-work", "go")
	h.waitStatus(task, StatusDone, StatusFailed)

	prompts := h.sessions.promptCalls()
	if len(prompts) != 1 || prompts[0].Session != "renamed-already" {
		t.Fatalf("injected %+v, want the live tmux name", prompts)
	}
}

// Cancelling interrupts the live name too.
func TestCancelInterruptsTheLiveName(t *testing.T) {
	h := newHarness(t)
	h.sessions.start(testOSUser, LiveSession{
		Name: "renamed-already", BornAs: "agent-work", Owner: testActor, State: "done",
	})
	h.sessions.setTranscript(testOSUser, "renamed-already", userLine("earlier", "2026-09-16T10:00:00Z"))
	h.sessions.onPrompt = func(f *fakeSessions, k string) { f.setStateLocked(k, "running") }

	task := h.sendMessage("agent-work", "a long job")
	h.waitStatus(task, StatusRunning)
	h.decodeJSON(h.call("POST", "/v1/tasks/"+task+"/cancel", ""), http.StatusOK, nil)
	h.waitIdle()

	if calls := h.sessions.cancelCalls(); len(calls) != 1 || calls[0] != key(testOSUser, "renamed-already") {
		t.Fatalf("interrupt went to %v, want the live tmux name", calls)
	}
}

// A rename during the READINESS wait must not lose the history mark.
//
// The wait runs up to a minute in production and tmux-api renames a session
// from the content of its first turn, so the name resolved before the wait
// can be gone by the time it ends. Reading the transcript under that name
// does not fail loudly: the option read misses, and the answer is "no
// transcript", which is the same answer an empty history gives. A mark of 0
// then makes the PREVIOUS turn's own output look like proof that this turn
// started, so the watcher believes the leftover "done" and reports the
// previous answer as this one's, inside a second, while the real turn runs on.
//
// The sequence is the ordinary one: a second message queued behind the first,
// drained the moment turn one ends, which is when the autotitle rename lands.
func TestTurnMarksHistoryUnderTheNameTheSessionHasNow(t *testing.T) {
	h := newHarness(t)
	h.sessions.start(testOSUser, LiveSession{
		Name: "agent-work", BornAs: "agent-work", Owner: testActor, State: "done",
	})
	h.sessions.setTranscript(testOSUser, "agent-work",
		userLine("the turn before", "2026-09-16T10:00:00Z"),
		assistantLine("THE PREVIOUS ANSWER", "2026-09-16T10:00:01Z"))
	// Room for the watcher to poll while the test holds the turn open, rather
	// than failing the task for a turn that never visibly started.
	h.srv.StartGrace = 5 * time.Second

	release := make(chan struct{})
	h.sessions.readyBlock = release

	task := h.sendMessage("agent-work", "the next question")
	for h.sessions.readyCallCount() == 0 {
		time.Sleep(time.Millisecond)
	}
	// tmux-api's autotitle, landing while the readiness wait is still open.
	h.sessions.rename(testOSUser, "agent-work", "a-title-from-the-first-turn")
	close(release)

	// The prompt is in and the session has produced nothing since, so there is
	// nothing to report. @claude_state is still the previous turn's "done",
	// which is exactly the state the stale-done guard exists for.
	if v := h.waitStatus(task, StatusRunning, StatusDone, StatusFailed); v.Status != StatusRunning {
		t.Fatalf("the turn was reported %q with result %q before it had produced anything",
			v.Status, v.Result)
	}
	for i := 0; i < 50; i++ {
		if v, _ := h.srv.Tasks.Get(task); v.Status.terminal() {
			t.Fatalf("the turn was reported %q with result %q before it had produced anything",
				v.Status, v.Result)
		}
		time.Sleep(2 * time.Millisecond)
	}

	h.sessions.appendTranscript(testOSUser, "a-title-from-the-first-turn",
		assistantLine("THE NEW ANSWER", "2026-09-16T11:00:00Z"))
	v := h.waitStatus(task, StatusDone, StatusFailed)
	if v.Status != StatusDone {
		t.Fatalf("status %q error %q", v.Status, v.Error)
	}
	if v.Result != "THE NEW ANSWER" {
		t.Fatalf("result %q, want this turn's answer rather than the one before it", v.Result)
	}
}

// A task belongs to the OS user it ran as, and a credential for another
// account cannot read it.
//
// A credentials line names an OS user per caller and this box has more than
// one terminal account, so "everything here is readable anyway" holds only
// within one account. A task's result is the agent's final message. Ids are
// not guessable, but every request writes one to trace.jsonl, which promtail
// ships to Loki, so they are not secret either.
func TestTaskOfAnotherOSUserIsNotReadable(t *testing.T) {
	h := newHarness(t)

	// A task that ran as emo. Built in the store rather than over the wire,
	// because the store is the only difference under test: everything about
	// the request below is the caller under test, credential included.
	other := &Task{
		ID: h.srv.IDs.New(), ConversationID: "emo-work",
		Actor: "emos-credential", OSUser: "emo", Text: "what did you find",
	}
	h.srv.Tasks.Add(other)
	h.srv.Tasks.Update(other.ID, StatusRunning, nil)
	h.srv.Tasks.Update(other.ID, StatusDone, func(tk *Task) { tk.Result = "emo's private answer" })

	w := h.call("GET", "/v1/tasks/"+other.ID, "")
	if w.Code != http.StatusNotFound {
		t.Fatalf("status %d, want 404: %s", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "private answer") {
		t.Fatalf("another account's result was served: %s", w.Body.String())
	}

	// Cancelling it is refused the same way and never reaches the session.
	// The same 404 rather than a 403, so the answer says nothing about which
	// ids exist on another account.
	if w := h.call("POST", "/v1/tasks/"+other.ID+"/cancel", ""); w.Code != http.StatusNotFound {
		t.Fatalf("cancel answered %d, want 404: %s", w.Code, w.Body.String())
	}
	if v, _ := h.srv.Tasks.Get(other.ID); v.Status != StatusDone {
		t.Fatalf("another account's task was moved to %q", v.Status)
	}

	// The control: the caller's own task, in the same store, still reads.
	mine := &Task{
		ID: h.srv.IDs.New(), ConversationID: "c1",
		Actor: testActor, OSUser: testOSUser, Text: "mine",
	}
	h.srv.Tasks.Add(mine)
	var got TaskView
	h.decodeJSON(h.call("GET", "/v1/tasks/"+mine.ID, ""), http.StatusOK, &got)
	if got.ID != mine.ID {
		t.Fatalf("the caller's own task did not read back: %+v", got)
	}
}
