package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"terminal-lobby/sessionio"
)

// Panes as Claude Code draws them, trimmed from the captures under
// sessionio/testdata. The parsers anchor on the last line, so each one ends on
// its dialog's footer exactly as a real capture does.

// permissionPane is the tool permission prompt (permission-bash.txt).
var permissionPane = strings.Join([]string{
	"● Writing hi to a.txt",
	"",
	"────────────────────────────────────────────────────────────────────────",
	" Bash command",
	"",
	"   printf 'hi\\n' > a.txt",
	"   Write \"hi\" to a.txt",
	"",
	" Do you want to proceed?",
	" ❯ 1. Yes",
	"   2. Yes, and always allow access to /tmp/proj from this project",
	"   3. No",
	"",
	" Esc to cancel · Tab to amend",
}, "\n")

// permissionPaneOther is a second prompt with the same rows over a different
// command: what Claude draws for the next tool call of the same turn.
var permissionPaneOther = strings.Replace(permissionPane,
	"   printf 'hi\\n' > a.txt\n   Write \"hi\" to a.txt",
	"   rm -rf build\n   Remove the build directory", 1)

// permissionPaneNoNo is a prompt with no No row, which has nowhere to put
// words.
var permissionPaneNoNo = strings.Join([]string{
	"────────────────────────────────────────────────────────────────────────",
	" Bash command",
	"",
	"   date",
	"",
	" Do you want to proceed?",
	" ❯ 1. Yes",
	"   2. Yes, and always allow access to /tmp/proj from this project",
	"",
	" Esc to cancel",
}, "\n")

// planPane is the plan approval (plan-no-auto.txt).
var planPane = strings.Join([]string{
	"   Steps",
	"",
	"   1. Write hello.txt in that directory.",
	"  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌",
	"",
	"  ────────────────────────────────────────────────────────────────────────",
	"   Claude has written up a plan and is ready to execute. Would you like to proceed?",
	"",
	"   ❯ 1. Yes, auto-accept edits",
	"     2. Yes, manually approve edits",
	"     3. Tell Claude what to change",
	"        shift+tab to approve with this feedback",
	"",
	"   ctrl+g to edit in Vim · ~/.claude/plans/hello.md",
}, "\n")

// choicePane is an AskUserQuestion menu (dialog-single.txt).
var choicePane = strings.Join([]string{
	"❯ Call AskUserQuestion with ONE question.",
	"────────────────────────────────────────────────────────────────────────",
	" ☐ Font",
	"",
	"Which font should the badge use?",
	"",
	"❯ 1. Sans",
	"     A sans-serif typeface.",
	"  2. Serif",
	"     A serif typeface.",
	"  3. Type something.",
	"────────────────────────────────────────────────────────────────────────",
	"  4. Chat about this",
	"",
	"Enter to select · ↑/↓ to navigate · Esc to cancel",
}, "\n")

// What each kind of pane reads as. The kind and the options are what a caller
// decides from, so they are pinned exactly.
func TestParseQuestion(t *testing.T) {
	for _, c := range []struct {
		name       string
		pane       string
		kind       string
		options    []TaskOption
		answerWith []string
		mentions   []string
	}{
		{
			name: "a tool permission prompt",
			pane: permissionPane,
			kind: KindPermission,
			options: []TaskOption{
				{1, "Yes"},
				{2, "Yes, and always allow access to /tmp/proj from this project"},
				{3, "No"},
			},
			answerWith: []string{"option", "text"},
			mentions:   []string{"Bash command", "printf", "Do you want to proceed?"},
		},
		{
			name:       "a permission prompt with no No row takes no words",
			pane:       permissionPaneNoNo,
			kind:       KindPermission,
			options:    []TaskOption{{1, "Yes"}, {2, "Yes, and always allow access to /tmp/proj from this project"}},
			answerWith: []string{"option"},
			mentions:   []string{"date"},
		},
		{
			name:       "the plan approval",
			pane:       planPane,
			kind:       KindPlan,
			options:    []TaskOption{{1, "Yes, auto-accept edits"}, {2, "Yes, manually approve edits"}},
			answerWith: []string{"option", "text"},
			mentions:   []string{"Would you like to proceed?"},
		},
		{
			name:       "an AskUserQuestion menu is shown but not answerable here",
			pane:       choicePane,
			kind:       KindChoice,
			options:    []TaskOption{{1, "Sans"}, {2, "Serif"}},
			answerWith: nil,
			mentions:   []string{"Which font should the badge use?"},
		},
		{
			name:       "a pane with no dialog the lobby can read",
			pane:       "  Some earlier output\n\n  Approve the deploy? [y/N]",
			kind:       KindUnknown,
			answerWith: nil,
			mentions:   []string{"Approve the deploy?"},
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			got := parseQuestion(c.pane)
			if got.Kind != c.kind {
				t.Fatalf("kind %q, want %q", got.Kind, c.kind)
			}
			if !reflect.DeepEqual(got.Options, c.options) {
				t.Fatalf("options %+v, want %+v", got.Options, c.options)
			}
			if !reflect.DeepEqual(got.AnswerWith, c.answerWith) {
				t.Fatalf("answer_with %v, want %v", got.AnswerWith, c.answerWith)
			}
			for _, m := range c.mentions {
				if !strings.Contains(got.Text, m) {
					t.Errorf("question %q does not mention %q", got.Text, m)
				}
			}
		})
	}
}

// needsInput runs one message into a question drawn on the pane, and returns
// the task id once the task reports it.
func (h *harness) needsInput(pane string) string {
	h.t.Helper()
	h.readyConversation("c1")
	h.sessions.setPane(testOSUser, "c1", pane)
	h.sessions.onPrompt = func(f *fakeSessions, k string) {
		f.setStateLocked(k, "running")
		go func() {
			time.Sleep(5 * time.Millisecond)
			f.setState(testOSUser, "c1", "awaiting")
		}()
	}
	task := h.sendMessage("c1", "do the thing")
	h.waitStatus(task, StatusNeedsInput)
	return task
}

// answer posts one answer.
func (h *harness) answer(task, body string) *httptest.ResponseRecorder {
	h.t.Helper()
	return h.call("POST", "/v1/tasks/"+task+"/answer", body)
}

// stop lets a test end without a watcher still polling the fake.
func (h *harness) stop(task string) {
	h.srv.Tasks.Cancel(task)
	h.waitIdle()
}

// A blocked task says what kind of question it is and what can be picked, so
// a caller can answer it without reading the pane itself.
func TestNeedsInputCarriesTheChoices(t *testing.T) {
	h := newHarness(t)
	task := h.needsInput(permissionPane)
	defer h.stop(task)

	var got TaskView
	h.decodeJSON(h.call("GET", "/v1/tasks/"+task, ""), http.StatusOK, &got)
	if got.Kind != KindPermission || len(got.Options) != 3 || got.Options[2] != (TaskOption{3, "No"}) {
		t.Fatalf("got %+v", got)
	}
	if !reflect.DeepEqual(got.AnswerWith, []string{"option", "text"}) {
		t.Fatalf("answer_with %v", got.AnswerWith)
	}
	// The wire names, which a generated client is built from.
	raw := h.call("GET", "/v1/tasks/"+task, "").Body.String()
	for _, f := range []string{`"kind":"permission"`, `"options":[{"index":1,"label":"Yes"}`, `"answer_with":["option","text"]`} {
		if !strings.Contains(raw, f) {
			t.Errorf("the task JSON lacks %s: %s", f, raw)
		}
	}
}

// Each answer the lobby can give, through the route, reaching sessionio as
// the request its own card would send: a row by number with the label the
// caller was shown, or words.
func TestAnswerReachesSessionio(t *testing.T) {
	for _, c := range []struct {
		name string
		pane string
		body string
		want sessionio.AnswerRequest
	}{
		{"a permission row", permissionPane, `{"option":1}`,
			sessionio.AnswerRequest{Permission: &sessionio.PermissionAnswer{Option: 1, Label: "Yes"}}},
		{"a permission prompt declined with words", permissionPane, `{"text":"print the date instead"}`,
			sessionio.AnswerRequest{Permission: &sessionio.PermissionAnswer{Decline: "print the date instead"}}},
		{"a plan approved", planPane, `{"option":2}`,
			sessionio.AnswerRequest{Plan: &sessionio.PlanAnswer{Option: 2, Label: "Yes, manually approve edits"}}},
		{"a plan sent back with feedback", planPane, `{"text":"keep the old file too"}`,
			sessionio.AnswerRequest{Plan: &sessionio.PlanAnswer{Feedback: "keep the old file too"}}},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t)
			task := h.needsInput(c.pane)
			defer h.stop(task)
			h.sessions.onAnswer = func(f *fakeSessions, k string) { f.panes[k] = "● Working…" }

			w := h.answer(task, c.body)
			var got struct {
				TaskView
				Warning string `json:"warning"`
			}
			h.decodeJSON(w, http.StatusOK, &got)
			if got.Status != StatusRunning || got.ID != task {
				t.Fatalf("got %+v, want the task back at running", got)
			}
			if got.Warning != "" || got.Question != "" || got.Options != nil {
				t.Fatalf("a clean answer carried %+v", got)
			}
			calls := h.sessions.answerCalls()
			if len(calls) != 1 {
				t.Fatalf("%d answer calls, want 1", len(calls))
			}
			if calls[0].OSUser != testOSUser || calls[0].Session != "c1" {
				t.Fatalf("answered %s/%s", calls[0].OSUser, calls[0].Session)
			}
			if !reflect.DeepEqual(calls[0].Req, c.want) {
				t.Fatalf("sessionio was asked %+v, want %+v", calls[0].Req, c.want)
			}

			// Traced like every other route, with the caller's own body.
			var line *TraceEntry
			for _, e := range h.traceLines() {
				if e.Verb == "POST /v1/tasks/{id}/answer" {
					e := e
					line = &e
				}
			}
			if line == nil {
				t.Fatal("the answer was not traced")
			}
			if line.TaskID != task || line.ConversationID != "c1" || line.Status != http.StatusOK ||
				line.Actor != testActor || string(line.Request) != c.body {
				t.Fatalf("trace line %+v", line)
			}
		})
	}
}

// The lobby answers an AskUserQuestion as DATA, through the hook
// session-events holds (ADR-0034), and this service calls no other service's
// port. Nothing in sessionio types an answer into that menu any more, so the
// route refuses rather than guessing at keys.
func TestAnswerRefusesWhatItCannotAnswerSafely(t *testing.T) {
	for _, c := range []struct {
		name, pane, body, mentions string
	}{
		{"an AskUserQuestion menu", choicePane, `{"option":1}`, "AskUserQuestion"},
		{"a pane with no dialog the lobby can read", "Approve the deploy? [y/N]", `{"text":"y"}`, "terminal"},
		{"words for a prompt with nowhere to put them", permissionPaneNoNo, `{"text":"no thanks"}`, "option"},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t)
			task := h.needsInput(c.pane)
			defer h.stop(task)

			w := h.answer(task, c.body)
			var e struct {
				Error string `json:"error"`
			}
			h.decodeJSON(w, http.StatusUnprocessableEntity, &e)
			if !strings.Contains(e.Error, c.mentions) {
				t.Fatalf("error %q does not mention %q", e.Error, c.mentions)
			}
			if n := len(h.sessions.answerCalls()); n != 0 {
				t.Fatalf("a refused answer still reached sessionio %d times", n)
			}
			if v, _ := h.srv.Tasks.Get(task); v.Status != StatusNeedsInput {
				t.Fatalf("a refused answer moved the task to %q", v.Status)
			}
		})
	}
}

func TestAnswerRefusals(t *testing.T) {
	h := newHarness(t)
	task := h.needsInput(permissionPane)
	defer h.stop(task)

	t.Run("an unknown task", func(t *testing.T) {
		h.decodeJSON(h.answer("nope", `{"option":1}`), http.StatusNotFound, nil)
	})
	t.Run("another account's task", func(t *testing.T) {
		h.srv.Tasks.Add(&Task{ID: "theirs", ConversationID: "c9", Actor: testActor, OSUser: "emo"})
		h.decodeJSON(h.answer("theirs", `{"option":1}`), http.StatusNotFound, nil)
	})
	t.Run("another caller's task", func(t *testing.T) {
		w := h.do(request{method: "POST", path: "/v1/tasks/" + task + "/answer", body: `{"option":1}`, token: testOtherToken})
		h.decodeJSON(w, http.StatusForbidden, nil)
	})
	for _, body := range []string{
		``,
		`{}`,
		`{"option":1,"text":"both"}`,
		`{"option":0}`,
		`{"option":-1}`,
		`{"option":"1"}`,
		`{"option":9}`,
		`{"text":"   "}`,
		`{"text":"two\nlines"}`,
		`{"text":"` + strings.Repeat("x", sessionio.MaxAnswerText+1) + `"}`,
		`{"choice":1}`,
		`[1]`,
		`{"option":1}{"option":2}`,
	} {
		name := body
		if len(name) > 40 {
			name = name[:40]
		}
		t.Run("body "+name, func(t *testing.T) {
			h.decodeJSON(h.answer(task, body), http.StatusBadRequest, nil)
		})
	}
	if n := len(h.sessions.answerCalls()); n != 0 {
		t.Fatalf("refused answers reached sessionio %d times", n)
	}

	t.Run("a task that is not waiting on anything", func(t *testing.T) {
		h2 := newHarness(t)
		h2.readyConversation("c1")
		h2.sessions.onPrompt = func(f *fakeSessions, k string) { f.setStateLocked(k, "running") }
		running := h2.sendMessage("c1", "go")
		h2.waitStatus(running, StatusRunning)
		h2.decodeJSON(h2.answer(running, `{"option":1}`), http.StatusConflict, nil)
		h2.stop(running)
		h2.decodeJSON(h2.answer(running, `{"option":1}`), http.StatusConflict, nil)
	})
}

// The question on screen is read again before anything is typed. If it is
// not the one the task reported — the next tool call's prompt, say, with the
// same rows over a different command — the caller is answering something it
// has not seen, so nothing is typed and the task is updated to what is there.
func TestAnswerRefusesWhenTheQuestionChanged(t *testing.T) {
	h := newHarness(t)
	task := h.needsInput(permissionPane)
	defer h.stop(task)
	h.sessions.setPane(testOSUser, "c1", permissionPaneOther)

	h.decodeJSON(h.answer(task, `{"option":1}`), http.StatusConflict, nil)
	if n := len(h.sessions.answerCalls()); n != 0 {
		t.Fatalf("an answer to a question the caller never saw reached sessionio %d times", n)
	}
	var got TaskView
	h.decodeJSON(h.call("GET", "/v1/tasks/"+task, ""), http.StatusOK, &got)
	if got.Status != StatusNeedsInput || !strings.Contains(got.Question, "rm -rf build") {
		t.Fatalf("the task still reports the old question: %+v", got)
	}
	// Answering again, now that the caller has seen it, goes through.
	h.decodeJSON(h.answer(task, `{"option":3}`), http.StatusOK, nil)
}

// What sessionio reports back, mapped onto what the caller is told.
func TestAnswerOutcomes(t *testing.T) {
	for _, c := range []struct {
		name       string
		resp       *sessionio.AnswerResponse
		err        error
		wantCode   int
		wantStatus TaskStatus
		warns      bool
	}{
		{"landed", &sessionio.AnswerResponse{Applied: true, Done: true}, nil, http.StatusOK, StatusRunning, false},
		{"typed but the dialog did not clear", &sessionio.AnswerResponse{Reason: sessionio.AnswerUnverified}, nil,
			http.StatusOK, StatusRunning, true},
		{"the dialog was gone already", &sessionio.AnswerResponse{Reason: sessionio.AnswerNoDialog}, nil,
			http.StatusConflict, StatusNeedsInput, false},
		{"a different dialog by the time the keys went", &sessionio.AnswerResponse{Reason: sessionio.AnswerNotDrawn}, nil,
			http.StatusConflict, StatusNeedsInput, false},
		{"the row changed under the answer", &sessionio.AnswerResponse{Reason: sessionio.AnswerUnknownOption}, nil,
			http.StatusConflict, StatusNeedsInput, false},
		{"tmux would not take the keys", &sessionio.AnswerResponse{Reason: sessionio.AnswerRefused}, nil,
			http.StatusInternalServerError, StatusNeedsInput, false},
		{"the pane could not be read", nil, errors.New("capture-pane: exit status 1"), http.StatusInternalServerError, StatusNeedsInput, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t)
			task := h.needsInput(permissionPane)
			defer h.stop(task)
			h.sessions.answerResp, h.sessions.answerErr = c.resp, c.err

			w := h.answer(task, `{"option":1}`)
			if w.Code != c.wantCode {
				t.Fatalf("status %d, want %d: %s", w.Code, c.wantCode, w.Body.String())
			}
			var body map[string]any
			json.Unmarshal(w.Body.Bytes(), &body)
			if _, has := body["warning"]; has != c.warns {
				t.Fatalf("warning present=%v, want %v: %v", has, c.warns, body)
			}
			// What the caller was told. Read from the response rather than the
			// store for the answers that went in: with the dialog left on this
			// fake pane, the watcher puts the task back to needs_input on its
			// next poll, which is the recovery the warning promises.
			got := TaskStatus(fmt.Sprint(body["status"]))
			if w.Code != http.StatusOK {
				v, _ := h.srv.Tasks.Get(task)
				got = v.Status
			}
			if got != c.wantStatus {
				t.Fatalf("task %q, want %q", got, c.wantStatus)
			}
		})
	}
}

// After an answer @claude_state can go on reading "awaiting" for as long as
// the approved tool runs: nothing stamps "running" until the next tool call or
// prompt. The task must not bounce back to needs_input over a pane with no
// question on it, and must go back the moment a new question is drawn.
func TestAfterAnAnswerTheNextQuestionIsFound(t *testing.T) {
	h := newHarness(t)
	task := h.needsInput(permissionPane)
	defer h.stop(task)
	h.sessions.onAnswer = func(f *fakeSessions, k string) { f.panes[k] = "● Running printf…" }

	h.decodeJSON(h.answer(task, `{"option":1}`), http.StatusOK, nil)
	// Thirty polls with the state still awaiting and no dialog drawn.
	time.Sleep(30 * time.Millisecond)
	if v, _ := h.srv.Tasks.Get(task); v.Status != StatusRunning {
		t.Fatalf("the task went back to %q over a pane with no question", v.Status)
	}

	h.sessions.setPane(testOSUser, "c1", permissionPaneOther)
	v := h.waitStatus(task, StatusNeedsInput)
	if !strings.Contains(v.Question, "rm -rf build") || v.Kind != KindPermission {
		t.Fatalf("the next question was not read: %+v", v)
	}
}

// An answer typed into a dialog that stays up is reported as running with a
// warning, and the watcher puts the task back to needs_input on its next
// poll, which is what the warning tells the caller to expect.
func TestAnUnclearedDialogComesBack(t *testing.T) {
	h := newHarness(t)
	task := h.needsInput(permissionPane)
	defer h.stop(task)
	h.sessions.answerResp = &sessionio.AnswerResponse{Reason: sessionio.AnswerUnverified}

	var got answerResult
	h.decodeJSON(h.answer(task, `{"option":1}`), http.StatusOK, &got)
	if got.Status != StatusRunning || got.Warning == "" {
		t.Fatalf("got %+v", got)
	}
	v := h.waitStatus(task, StatusNeedsInput)
	if v.Kind != KindPermission || len(v.Options) != 3 {
		t.Fatalf("the dialog still up was not read back: %+v", v)
	}
}
