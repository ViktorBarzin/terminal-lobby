package main

import (
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"terminal-lobby/sessionio"
)

// A dialog's highlighted row, as Claude Code and the lobby's mod draw it. An
// Enter typed over it picks the row.
const menuPane = "\n☐ Permission\n\nAllow Bash: touch /tmp/probe?\n\n❯ 1. Allow\n  2. Deny\n\nEnter to select · Esc to cancel\n"

// cancelReply is the cancel route's body.
type cancelReply struct {
	TaskID      string `json:"task_id"`
	Status      string `json:"status"`
	Interrupted bool   `json:"interrupted"`
	Warning     string `json:"warning"`
}

// Measured live on 2026-10-02 (rv-mf2-perm, rv-mf4-perm): cancelling a task
// blocked at a permission prompt sent Ctrl-C, which does not take the mod's
// dialog down, and stamped the session done. The next message was typed into
// the dialog and its Enter picked "1. Allow". A cancel at a dialog declines
// it through the mod first, then interrupts.
func TestCancelAtADialogDeclinesItThroughTheMod(t *testing.T) {
	h := newHarness(t)
	task := h.needsInput(permissionDialog("toolu_1", "touch /tmp/probe"))

	var got cancelReply
	h.decodeJSON(h.call("POST", "/v1/tasks/"+task+"/cancel", ""), http.StatusOK, &got)
	if got.Status != "cancelled" || !got.Interrupted || got.Warning != "" {
		t.Fatalf("got %+v, want cancelled and interrupted", got)
	}
	answers := h.sessions.answerCalls()
	if len(answers) != 1 || answers[0].Req.ToolID != "toolu_1" || answers[0].Req.Permission == nil ||
		strings.TrimSpace(answers[0].Req.Permission.Decline) == "" {
		t.Fatalf("answers sent %+v, want one decline naming toolu_1", answers)
	}
	if calls := h.sessions.cancelCalls(); len(calls) != 1 {
		t.Fatalf("interrupts %v, want one after the decline", calls)
	}
}

// Each kind of dialog is declined in its own words: a plan is sent back with
// feedback, a question is declined to chat, never approved or answered.
func TestCancelDeclinesEachKindOfDialog(t *testing.T) {
	plan := &modDialog{Kind: "plan", ToolID: "toolu_p", Plan: "1. build"}
	for _, c := range []struct {
		name  string
		d     *modDialog
		check func(sessionio.AnswerRequest) bool
	}{
		{"a plan", plan, func(r sessionio.AnswerRequest) bool {
			return r.Plan != nil && r.Plan.Option == 0 && !r.Plan.Approve && strings.TrimSpace(r.Plan.Feedback) != ""
		}},
		{"a question", choiceDialog("Which?"), func(r sessionio.AnswerRequest) bool {
			return r.Chat != nil && r.Answers == nil
		}},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t)
			task := h.needsInput(c.d)
			var got cancelReply
			h.decodeJSON(h.call("POST", "/v1/tasks/"+task+"/cancel", ""), http.StatusOK, &got)
			answers := h.sessions.answerCalls()
			if len(answers) != 1 || answers[0].Req.ToolID != c.d.ToolID || !c.check(answers[0].Req) {
				t.Fatalf("answers sent %+v", answers)
			}
			if !got.Interrupted {
				t.Fatalf("got %+v", got)
			}
		})
	}
}

// A decline that does not take the dialog down is reported, and the session
// is left at its real state: no Ctrl-C, which would stamp it done over a
// dialog that is still waiting.
func TestCancelAtADialogThatStaysOpenSaysSo(t *testing.T) {
	h := newHarness(t)
	task := h.needsInput(permissionDialog("toolu_1", "touch /tmp/probe"))
	h.sessions.answerResp = &sessionio.AnswerResponse{Reason: sessionio.AnswerUnverified}

	var got cancelReply
	h.decodeJSON(h.call("POST", "/v1/tasks/"+task+"/cancel", ""), http.StatusOK, &got)
	if got.Status != "cancelled" || got.Interrupted || !strings.Contains(got.Warning, "dialog") {
		t.Fatalf("got %+v, want cancelled, not interrupted, and a warning naming the dialog", got)
	}
	if calls := h.sessions.cancelCalls(); len(calls) != 0 {
		t.Fatalf("Ctrl-C sent %v over a dialog still open", calls)
	}
}

// A session with no mod draws Claude Code's own menu. A cancel that leaves it
// on the pane says so rather than claiming the turn was interrupted.
func TestCancelThatLeavesAMenuOnThePaneSaysSo(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	h.sessions.onPrompt = func(f *fakeSessions, k string) {
		f.setStateLocked(k, "running")
		f.panes[k] = menuPane
	}
	task := h.sendMessage("c1", "touch it")
	h.waitStatus(task, StatusRunning)

	var got cancelReply
	h.decodeJSON(h.call("POST", "/v1/tasks/"+task+"/cancel", ""), http.StatusOK, &got)
	if got.Interrupted || !strings.Contains(got.Warning, "dialog") {
		t.Fatalf("got %+v, want not interrupted and a warning naming the dialog", got)
	}
}

// The second half of the same live failure: a message whose pane never drew
// a settled prompt was typed anyway, over an open dialog. With a dialog in
// the way the message is not typed at all, whatever says so: the mod, the
// state, or the pane.
func TestAMessageIsNeverTypedIntoAnOpenDialog(t *testing.T) {
	for _, c := range []struct {
		name  string
		setup func(f *fakeSessions)
	}{
		{"the mod holds a dialog", func(f *fakeSessions) {
			f.dialogs[key(testOSUser, "c1")] = permissionDialog("toolu_1", "touch /tmp/probe")
		}},
		{"the state says awaiting", func(f *fakeSessions) { f.live[key(testOSUser, "c1")].State = "awaiting" }},
		{"the pane shows a menu", func(f *fakeSessions) { f.panes[key(testOSUser, "c1")] = menuPane }},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t)
			h.readyConversation("c1")
			h.sessions.readyErr = errors.New("session c1 drew no settled prompt within 1m0s")
			h.sessions.mu.Lock()
			c.setup(h.sessions)
			h.sessions.mu.Unlock()

			task := h.sendMessage("c1", "Reply with only the word BANANA.")
			v := h.waitStatus(task, StatusDone, StatusFailed, StatusNeedsInput)
			if v.Status != StatusFailed || !strings.Contains(v.Error, "dialog") {
				t.Fatalf("status %q error %q, want failed naming the dialog", v.Status, v.Error)
			}
			if p := h.sessions.promptCalls(); len(p) != 0 {
				t.Fatalf("typed %+v into a session showing a dialog", p)
			}
		})
	}
}

// Measured live on 2026-10-02 (rv-mf7-nomod): with no mod, @claude_state is
// never stamped and the transcript stands in for it, and a permission prompt
// writes no turn-end record. The task read running on every poll and would
// have done so for the six-hour turn ceiling. A menu on the pane is the
// dialog, reported as an unknown question with the pane's text.
func TestAModlessTurnAtADialogReportsNeedsInput(t *testing.T) {
	h := newHarness(t)
	h.srv.TurnTimeout = time.Minute
	h.sessions.start(testOSUser, LiveSession{Name: "nomod", Owner: testActor})
	h.sessions.setTranscript(testOSUser, "nomod", userLine("earlier", "2026-09-16T10:00:00Z"),
		assistantLine("READY", "2026-09-16T10:00:01Z"), turnEndLine("2026-09-16T10:00:01Z"))
	toolUse := `{"type":"assistant","timestamp":"2026-09-16T11:00:02Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_9","name":"Bash","input":{"command":"touch /tmp/probe"}}]}}`
	h.sessions.onPrompt = func(f *fakeSessions, k string) {
		f.appendTranscriptLocked(k, userLine("touch it", "2026-09-16T11:00:00Z"), toolUse)
		f.panes[k] = menuPane
	}

	task := h.sendMessage("nomod", "touch it")
	v := h.waitStatus(task, StatusNeedsInput, StatusDone, StatusFailed)
	defer h.stop(task)
	if v.Status != StatusNeedsInput || v.Kind != KindUnknown || !strings.Contains(v.Question, "1. Allow") {
		t.Fatalf("status %q kind %q question %q error %q, want needs_input with the pane's menu",
			v.Status, v.Kind, v.Question, v.Error)
	}
}

// Measured live on 2026-10-02 (rv-fx4-nomod): with the mod disconnected,
// Ctrl-C left its dialog drawn. Escape took it down, Claude Code's own
// permission prompt came up beneath it, and a second Escape interrupted the
// turn. A cancel presses Escape while a menu stays, a few times at most.
func TestCancelEscapesAMenuThatCtrlCLeaves(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	h.sessions.onPrompt = func(f *fakeSessions, k string) {
		f.setStateLocked(k, "running")
		f.panes[k] = menuPane
	}
	escapes := 0
	h.sessions.onEscape = func(f *fakeSessions, k string) {
		escapes++
		if escapes == 2 {
			f.panes[k] = "\n────────\n❯ \n────────\n"
		}
	}
	task := h.sendMessage("c1", "touch it")
	h.waitStatus(task, StatusRunning)

	var got cancelReply
	h.decodeJSON(h.call("POST", "/v1/tasks/"+task+"/cancel", ""), http.StatusOK, &got)
	if !got.Interrupted || got.Warning != "" || escapes != 2 {
		t.Fatalf("got %+v after %d escapes, want interrupted after two", got, escapes)
	}
}
