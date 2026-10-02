package main

import (
	"errors"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"terminal-lobby/sessionio"
)

// The lifecycle of a Caller's conversation: the turn clock the suspend sweep
// reads, the resume a message triggers, and the delete a Caller may make.

// finishOnPrompt makes the fake behave like a Claude that takes the prompt,
// works, and answers.
func finishOnPrompt(h *harness, conv, answer string) {
	h.sessions.onPrompt = func(f *fakeSessions, k string) {
		f.setStateLocked(k, "running")
		go func() {
			time.Sleep(3 * time.Millisecond)
			f.appendTranscript(testOSUser, conv,
				userLine("q", "2026-09-16T11:00:00Z"), assistantLine(answer, "2026-09-16T11:00:05Z"))
			f.setState(testOSUser, conv, "done")
		}()
	}
}

// ---------------------------------------------------------------------------
// The turn clock.

// tmux-api times a Caller's conversation by @agent_last_turn, so every turn
// stamps it: once when the message is accepted, before anything reaches the
// pane, which is what keeps a sweep already walking its list from taking the
// conversation; and once when the turn ends, so the 24 hours run from the
// last thing that happened in it.
func TestATurnStampsTheLastTurnClock(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	finishOnPrompt(h, "c1", "done it")

	task := h.sendMessage("c1", "go")
	stamps := h.sessions.lastTurnStamps()
	if len(stamps) == 0 {
		t.Fatal("accepting the message did not stamp the turn clock")
	}
	if v := h.waitStatus(task, StatusDone, StatusFailed); v.Status != StatusDone {
		t.Fatalf("turn %s: %s", v.Status, v.Error)
	}
	h.waitIdle()
	stamps = h.sessions.lastTurnStamps()
	if len(stamps) < 2 {
		t.Fatalf("the turn ended without stamping the clock again: %v", stamps)
	}
	at, err := strconv.ParseInt(stamps[len(stamps)-1], 10, 64)
	want := time.Date(2026, 9, 16, 11, 0, 0, 0, time.UTC).Unix()
	if err != nil || at != want {
		t.Fatalf("stamp = %q, want the unix second of the service clock (%d)", stamps[len(stamps)-1], want)
	}
	// The accept stamp lands before the prompt.
	ev := h.sessions.eventLog()
	if len(ev) < 2 || ev[0] != "stamp c1" || ev[1] != "prompt c1" {
		t.Fatalf("events = %v, want the stamp before the prompt", ev)
	}
}

// A turn that fails still counts as a turn: the Caller was using the
// conversation, and the clock is about use.
func TestAFailedTurnStillStampsTheClock(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	h.sessions.promptErr = errors.New("paste refused")

	task := h.sendMessage("c1", "go")
	if v := h.waitStatus(task, StatusDone, StatusFailed); v.Status != StatusFailed {
		t.Fatalf("status %s", v.Status)
	}
	h.waitIdle()
	if n := len(h.sessions.lastTurnStamps()); n < 2 {
		t.Fatalf("%d stamps, want the accept and the end", n)
	}
}

// ---------------------------------------------------------------------------
// Transparent resume.

// A message to a suspended conversation of this Caller's brings it back and
// then runs the turn, so a Caller never has to know the sweep was there.
func TestAMessageResumesASuspendedConversationFirst(t *testing.T) {
	h := newHarness(t)
	suspendedConversation(h, "napping")
	h.sessions.setTranscript(testOSUser, "napping", userLine("earlier", "2026-09-15T10:00:00Z"),
		assistantLine("before the nap", "2026-09-15T10:00:01Z"))
	finishOnPrompt(h, "napping", "back again")

	w := h.call("POST", "/v1/conversations/napping/messages", `{"text":"are you there"}`)
	var receipt struct {
		TaskID string `json:"task_id"`
	}
	h.decodeJSON(w, http.StatusAccepted, &receipt)

	v := h.waitStatus(receipt.TaskID, StatusDone, StatusFailed)
	if v.Status != StatusDone || v.Result != "back again" {
		t.Fatalf("status %s result %q error %q", v.Status, v.Result, v.Error)
	}
	if r := h.sessions.resumeCalls(); !reflect.DeepEqual(r, []string{testOSUser + "/napping"}) {
		t.Fatalf("resumes = %v, want exactly one, of napping", r)
	}
	var order []string
	for _, e := range h.sessions.eventLog() {
		if strings.HasPrefix(e, "resume") || strings.HasPrefix(e, "prompt") {
			order = append(order, e)
		}
	}
	if !reflect.DeepEqual(order, []string{"resume napping", "prompt napping"}) {
		t.Fatalf("order = %v, want the resume before the prompt", order)
	}
	// Waiting for the resumed harness to draw its prompt is the same wait any
	// turn makes, so a cold start is not pasted into.
	if h.sessions.readyCallCount() == 0 {
		t.Fatal("the turn did not wait for the resumed pane to be ready")
	}
}

// Two messages to one suspended conversation resume it once: the turns queue
// per conversation, and the second finds it awake.
func TestQueuedMessagesResumeOnce(t *testing.T) {
	h := newHarness(t)
	suspendedConversation(h, "napping")
	finishOnPrompt(h, "napping", "ok")

	a := h.sendMessage("napping", "one")
	b := h.sendMessage("napping", "two")
	h.waitStatus(a, StatusDone, StatusFailed)
	h.waitStatus(b, StatusDone, StatusFailed)
	h.waitIdle()
	if r := h.sessions.resumeCalls(); len(r) != 1 {
		t.Fatalf("resumes = %v, want one", r)
	}
}

// A resume that cannot happen fails the task with the reason, and nothing is
// pasted into a pane with no Claude in it.
func TestAFailedResumeFailsTheTurn(t *testing.T) {
	h := newHarness(t)
	suspendedConversation(h, "napping")
	h.sessions.resumeErr = sessionio.ErrNothingToResume

	task := h.sendMessage("napping", "hello")
	v := h.waitStatus(task, StatusDone, StatusFailed)
	if v.Status != StatusFailed {
		t.Fatalf("status %s, want failed", v.Status)
	}
	if !strings.Contains(v.Error, "resume") || !strings.Contains(v.Error, sessionio.ErrNothingToResume.Error()) {
		t.Fatalf("the error does not say the resume failed or why: %q", v.Error)
	}
	if p := h.sessions.promptCalls(); len(p) != 0 {
		t.Fatalf("the message was pasted anyway: %+v", p)
	}
}

// Somebody resumed it from the lobby between the list and the turn: the
// conversation is awake, which is all the turn needed.
func TestAConversationThatWokeUpMeanwhileStillTakesTheTurn(t *testing.T) {
	h := newHarness(t)
	suspendedConversation(h, "napping")
	h.sessions.resumeErr = sessionio.ErrNotSuspended
	finishOnPrompt(h, "napping", "fine")

	task := h.sendMessage("napping", "hello")
	if v := h.waitStatus(task, StatusDone, StatusFailed); v.Status != StatusDone {
		t.Fatalf("status %s: %s", v.Status, v.Error)
	}
}

// A live conversation is never resumed: the respawn would replace a running
// Claude.
func TestALiveConversationIsNotResumed(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	finishOnPrompt(h, "c1", "ok")
	task := h.sendMessage("c1", "go")
	h.waitStatus(task, StatusDone, StatusFailed)
	if r := h.sessions.resumeCalls(); len(r) != 0 {
		t.Fatalf("a live conversation was resumed: %v", r)
	}
}

// An answer to a task whose conversation was suspended resumes it first, as a
// message does, and then says what the screen says.
func TestAnAnswerToASuspendedConversationResumesItFirst(t *testing.T) {
	h := newHarness(t)
	suspendedConversation(h, "napping")
	task := &Task{ID: "t-answer", ConversationID: "napping", Actor: testActor, OSUser: testOSUser, Text: "x"}
	h.srv.Tasks.Add(task)
	h.srv.Tasks.Update(task.ID, StatusRunning, nil)
	h.srv.Tasks.Update(task.ID, StatusNeedsInput, func(tk *Task) {
		tk.setQuestion(questionReading{Kind: KindPermission, Text: "Run ls?",
			Options: []TaskOption{{Index: 1, Label: "Yes"}}, AnswerWith: []string{answerOption}})
	})

	w := h.call("POST", "/v1/tasks/t-answer/answer", `{"option":1}`)
	if r := h.sessions.resumeCalls(); !reflect.DeepEqual(r, []string{testOSUser + "/napping"}) {
		t.Fatalf("resumes = %v, want napping resumed before the answer was read", r)
	}
	// A freshly resumed Claude draws no dialog, so the question the task
	// reported is not on screen and nothing is typed.
	if w.Code != http.StatusConflict {
		t.Fatalf("status %d, want 409 (the question is gone after a resume): %s", w.Code, w.Body)
	}
	if a := h.sessions.answerCalls(); len(a) != 0 {
		t.Fatalf("keys were typed into a resumed pane: %+v", a)
	}
}

// ---------------------------------------------------------------------------
// DELETE /v1/conversations/{id}.

func TestDeleteKillsTheSessionAndKeepsTheTranscript(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")

	var got struct {
		ID             string   `json:"conversation_id"`
		Deleted        bool     `json:"deleted"`
		CancelledTasks []string `json:"cancelled_tasks"`
	}
	h.decodeJSON(h.call("DELETE", "/v1/conversations/c1", ""), http.StatusOK, &got)
	if got.ID != "c1" || !got.Deleted || got.CancelledTasks == nil || len(got.CancelledTasks) != 0 {
		t.Fatalf("response %+v", got)
	}
	if k := h.sessions.killCalls(); !reflect.DeepEqual(k, []string{testOSUser + "/c1"}) {
		t.Fatalf("kills = %v", k)
	}
	if h.sessions.isLive(testOSUser, "c1") {
		t.Fatal("the session is still live")
	}
	if !h.sessions.hasTranscript(testOSUser, "c1") {
		t.Fatal("the transcript went with the session")
	}
	h.decodeJSON(h.call("GET", "/v1/conversations/c1", ""), http.StatusNotFound, nil)
}

// The id is the name the conversation was born with, and the kill goes to the
// name tmux knows it by now.
func TestDeleteKillsTheLiveName(t *testing.T) {
	h := newHarness(t)
	h.sessions.start(testOSUser, LiveSession{Name: "c1", Owner: testActor, State: "done", BornAs: "c1"})
	h.sessions.rename(testOSUser, "c1", "pong-response")
	h.decodeJSON(h.call("DELETE", "/v1/conversations/c1", ""), http.StatusOK, nil)
	if k := h.sessions.killCalls(); !reflect.DeepEqual(k, []string{testOSUser + "/pong-response"}) {
		t.Fatalf("kills = %v, want the live name", k)
	}
}

// Only the owning Caller may delete, by the same rule that governs writing.
func TestDeleteRefusals(t *testing.T) {
	h := newHarness(t)
	h.sessions.start(testOSUser, LiveSession{Name: "mine-by-hand", State: "done"})
	h.sessions.start(testOSUser, LiveSession{Name: "theirs", State: "done", Owner: "scratch"})

	h.decodeJSON(h.call("DELETE", "/v1/conversations/nope", ""), http.StatusNotFound, nil)
	h.decodeJSON(h.call("DELETE", "/v1/conversations/mine-by-hand", ""), http.StatusForbidden, nil)
	h.decodeJSON(h.call("DELETE", "/v1/conversations/theirs", ""), http.StatusForbidden, nil)
	if k := h.sessions.killCalls(); len(k) != 0 {
		t.Fatalf("a refused delete killed something: %v", k)
	}
	if !h.sessions.isLive(testOSUser, "mine-by-hand") || !h.sessions.isLive(testOSUser, "theirs") {
		t.Fatal("a refused delete took a session away")
	}
}

// A suspended conversation is deleted the same way: there is nothing to
// resume first, because nothing is going to run in it.
func TestDeleteOfASuspendedConversation(t *testing.T) {
	h := newHarness(t)
	suspendedConversation(h, "napping")
	h.decodeJSON(h.call("DELETE", "/v1/conversations/napping", ""), http.StatusOK, nil)
	if r := h.sessions.resumeCalls(); len(r) != 0 {
		t.Fatalf("a delete resumed the conversation: %v", r)
	}
	if h.sessions.isLive(testOSUser, "napping") {
		t.Fatal("the session is still live")
	}
}

// Every open task on the conversation is cancelled, whether it was running or
// queued, and none of them reaches the pane afterwards. No interrupt is sent:
// the kill ends whatever was running, and Ctrl-C into a session about to go
// is a keystroke with nothing to stop.
func TestDeleteCancelsOpenTasks(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	h.readyConversation("other")
	// The first turn takes the prompt and never finishes.
	h.sessions.onPrompt = func(f *fakeSessions, k string) {
		f.setStateLocked(k, "running")
	}

	running := h.sendMessage("c1", "long job")
	h.waitStatus(running, StatusRunning)
	queued := h.sendMessage("c1", "after that")
	elsewhere := h.sendMessage("other", "unrelated")
	h.waitStatus(elsewhere, StatusRunning)

	var got struct {
		CancelledTasks []string `json:"cancelled_tasks"`
	}
	h.decodeJSON(h.call("DELETE", "/v1/conversations/c1", ""), http.StatusOK, &got)
	if !reflect.DeepEqual(got.CancelledTasks, []string{running, queued}) {
		t.Fatalf("cancelled_tasks = %v, want [%s %s]", got.CancelledTasks, running, queued)
	}
	for _, id := range []string{running, queued} {
		if v, _ := h.srv.Tasks.Get(id); v.Status != StatusCancelled {
			t.Fatalf("task %s is %s, want cancelled", id, v.Status)
		}
	}
	if v, _ := h.srv.Tasks.Get(elsewhere); v.Status != StatusRunning {
		t.Fatalf("a task on another conversation was touched: %s", v.Status)
	}
	if c := h.sessions.cancelCalls(); len(c) != 0 {
		t.Fatalf("an interrupt was sent: %v", c)
	}
	// The queued message never reaches a pane.
	for _, p := range h.sessions.promptCalls() {
		if p.Text == "after that" {
			t.Fatal("the queued message was pasted after the delete")
		}
	}
}

// A kill tmux refuses is a 500 with the reason. The open tasks were cancelled
// before the kill was tried: the Caller asked for the conversation to end, and
// its turns are no longer followed either way.
func TestDeleteReportsAKillThatFailed(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	h.sessions.killErr = errors.New("tmux said no")
	w := h.call("DELETE", "/v1/conversations/c1", "")
	if w.Code != http.StatusInternalServerError || !strings.Contains(w.Body.String(), "tmux said no") {
		t.Fatalf("status %d body %s", w.Code, w.Body)
	}
}

// A conversation that went between the lookup and the kill is gone either
// way, which is what the Caller asked for.
func TestDeleteOfAConversationThatVanishedIsNotFound(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	h.sessions.killErr = sessionio.ErrSessionGone
	h.decodeJSON(h.call("DELETE", "/v1/conversations/c1", ""), http.StatusNotFound, nil)
}

// The delete is traced like every other write, under the conversation's id.
func TestDeleteIsTraced(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	h.call("DELETE", "/v1/conversations/c1", "")
	lines := h.traceLines()
	last := lines[len(lines)-1]
	if last.Verb != "DELETE /v1/conversations/{id}" || last.ConversationID != "c1" || last.Status != http.StatusOK {
		t.Fatalf("trace %+v", last)
	}
}
