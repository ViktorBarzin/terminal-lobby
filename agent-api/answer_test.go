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

// Dialogs as the lobby's mod reports them through session-events.

func permissionDialog(toolID, command string) *modDialog {
	return &modDialog{Kind: "permission", ToolID: toolID, Tool: "Bash", Title: "Bash command",
		Detail: []string{command, "Print the date"}}
}

var planDialog = &modDialog{Kind: "plan", ToolID: "toolu_plan", Plan: "1. Build the thing\n2. Ship it",
	PlanFilePath: "/home/wizard/.claude/plans/p.md"}

func choiceDialog(questions ...string) *modDialog {
	d := &modDialog{Kind: "ask", ToolID: "toolu_ask"}
	for _, q := range questions {
		d.Questions = append(d.Questions, modQuestion{Question: q,
			Options: []modOption{{Label: "Postgres"}, {Label: "SQLite", Description: "one file"}}})
	}
	return d
}

func TestReadingFromDialog(t *testing.T) {
	for _, c := range []struct {
		name       string
		d          modDialog
		kind       string
		options    []TaskOption
		answerWith []string
		mentions   []string
	}{
		{"a permission prompt", *permissionDialog("toolu_1", "date"), KindPermission,
			[]TaskOption{{1, "Allow"}, {2, "Deny"}}, []string{"option", "text"}, []string{"Bash command", "date"}},
		{"a plan approval", *planDialog, KindPlan,
			[]TaskOption{{1, "Approve plan"}, {2, "Keep planning"}}, []string{"option", "text"}, []string{"Ship it"}},
		{"one question", *choiceDialog("Which database?"), KindChoice,
			[]TaskOption{{1, "Postgres"}, {2, "SQLite"}}, []string{"option", "text"}, []string{"Which database?"}},
		{"several questions", *choiceDialog("Which database?", "Which cache?"), KindChoice,
			[]TaskOption{{1, "Postgres"}, {2, "SQLite"}}, nil, []string{"Which database?", "2 questions"}},
		{"a kind the lobby does not know", modDialog{Kind: "survey", ToolID: "toolu_x"}, KindUnknown, nil, nil, nil},
	} {
		t.Run(c.name, func(t *testing.T) {
			got := readingFromDialog(c.d)
			if got.Kind != c.kind || !reflect.DeepEqual(got.Options, c.options) || !reflect.DeepEqual(got.AnswerWith, c.answerWith) {
				t.Fatalf("got %+v", got)
			}
			if c.kind != KindUnknown && got.ToolID != c.d.ToolID {
				t.Fatalf("tool id %q, want %q", got.ToolID, c.d.ToolID)
			}
			for _, m := range c.mentions {
				if !strings.Contains(got.Text, m) {
					t.Errorf("question %q does not mention %q", got.Text, m)
				}
			}
		})
	}
}

// needsInput runs one message into a dialog the mod reports, and returns the
// task id once the task reports it.
func (h *harness) needsInput(d *modDialog) string {
	h.t.Helper()
	h.readyConversation("c1")
	h.sessions.setDialog(testOSUser, "c1", d)
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
// a caller can answer it without reading the pane.
func TestNeedsInputCarriesTheChoices(t *testing.T) {
	h := newHarness(t)
	task := h.needsInput(permissionDialog("toolu_1", "date"))
	defer h.stop(task)

	raw := h.call("GET", "/v1/tasks/"+task, "").Body.String()
	for _, f := range []string{`"kind":"permission"`, `"options":[{"index":1,"label":"Allow"},{"index":2,"label":"Deny"}]`,
		`"answer_with":["option","text"]`} {
		if !strings.Contains(raw, f) {
			t.Errorf("the task JSON lacks %s: %s", f, raw)
		}
	}
	if strings.Contains(raw, "toolu_1") {
		t.Errorf("the dialog's tool id is internal, but the task JSON carries it: %s", raw)
	}
}

// Each answer, through the route, reaching session-events as the request the
// Text view's card would send, naming the dialog.
func TestAnswerReachesTheMod(t *testing.T) {
	for _, c := range []struct {
		name string
		d    *modDialog
		body string
		want sessionio.AnswerRequest
	}{
		{"a permission allowed", permissionDialog("toolu_1", "date"), `{"option":1}`,
			sessionio.AnswerRequest{ToolID: "toolu_1", Permission: &sessionio.PermissionAnswer{Option: 1, Label: "Allow"}}},
		{"a permission denied", permissionDialog("toolu_1", "date"), `{"option":2}`,
			sessionio.AnswerRequest{ToolID: "toolu_1", Permission: &sessionio.PermissionAnswer{Option: 2, Label: "Deny"}}},
		{"a permission declined with words", permissionDialog("toolu_1", "date"), `{"text":"print the time instead"}`,
			sessionio.AnswerRequest{ToolID: "toolu_1", Permission: &sessionio.PermissionAnswer{Decline: "print the time instead"}}},
		{"a plan approved", planDialog, `{"option":1}`,
			sessionio.AnswerRequest{ToolID: "toolu_plan", Plan: &sessionio.PlanAnswer{Option: 1, Label: "Approve plan"}}},
		{"a plan kept in planning", planDialog, `{"option":2}`,
			sessionio.AnswerRequest{ToolID: "toolu_plan", Plan: &sessionio.PlanAnswer{Option: 2, Label: "Keep planning"}}},
		{"a plan sent back with feedback", planDialog, `{"text":"keep the old file too"}`,
			sessionio.AnswerRequest{ToolID: "toolu_plan", Plan: &sessionio.PlanAnswer{Feedback: "keep the old file too"}}},
		{"a question answered by a row", choiceDialog("Which database?"), `{"option":2}`,
			sessionio.AnswerRequest{ToolID: "toolu_ask", Answers: map[string][]string{"Which database?": {"SQLite"}}}},
		{"a question answered in words", choiceDialog("Which database?"), `{"text":"DuckDB"}`,
			sessionio.AnswerRequest{ToolID: "toolu_ask", Answers: map[string][]string{"Which database?": {"DuckDB"}}}},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t)
			task := h.needsInput(c.d)
			defer h.stop(task)

			var got answerResult
			h.decodeJSON(h.answer(task, c.body), http.StatusOK, &got)
			if got.Status != StatusRunning || got.Warning != "" || got.Question != "" {
				t.Fatalf("got %+v, want the task back at running", got)
			}
			calls := h.sessions.answerCalls()
			if len(calls) != 1 || calls[0].OSUser != testOSUser || calls[0].Session != "c1" {
				t.Fatalf("answer calls %+v", calls)
			}
			if !reflect.DeepEqual(calls[0].Req, c.want) {
				t.Fatalf("session-events was asked %+v, want %+v", calls[0].Req, c.want)
			}

			// Traced like every other route, with the caller's own body and
			// what was sent for it.
			var line *TraceEntry
			for _, e := range h.traceLines() {
				if e.Verb == "POST /v1/tasks/{id}/answer" {
					e := e
					line = &e
				}
			}
			if line == nil || line.TaskID != task || line.Status != http.StatusOK || string(line.Request) != c.body ||
				!strings.Contains(line.Event, c.want.ToolID) {
				t.Fatalf("trace line %+v", line)
			}
		})
	}
}

// What cannot be answered through this API is refused with nothing sent.
func TestAnswerRefusesWhatItCannotAnswer(t *testing.T) {
	for _, c := range []struct {
		name     string
		d        *modDialog
		pane     string
		body     string
		mentions string
	}{
		{"several questions at once", choiceDialog("Which database?", "Which cache?"), "", `{"option":1}`, "several questions"},
		{"a session with no mod", nil, "Approve the deploy? [y/N]", `{"text":"y"}`, "terminal"},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t)
			var task string
			if c.d != nil {
				task = h.needsInput(c.d)
			} else {
				h.readyConversation("c1")
				h.sessions.setPane(testOSUser, "c1", c.pane)
				h.sessions.onPrompt = func(f *fakeSessions, k string) {
					f.setStateLocked(k, "running")
					go func() {
						time.Sleep(5 * time.Millisecond)
						f.setState(testOSUser, "c1", "awaiting")
					}()
				}
				task = h.sendMessage("c1", "go")
				h.waitStatus(task, StatusNeedsInput)
			}
			defer h.stop(task)

			var e struct {
				Error string `json:"error"`
			}
			h.decodeJSON(h.answer(task, c.body), http.StatusUnprocessableEntity, &e)
			if !strings.Contains(e.Error, c.mentions) {
				t.Fatalf("error %q does not mention %q", e.Error, c.mentions)
			}
			if n := len(h.sessions.answerCalls()); n != 0 {
				t.Fatalf("a refused answer still reached session-events %d times", n)
			}
			if v, _ := h.srv.Tasks.Get(task); v.Status != StatusNeedsInput {
				t.Fatalf("a refused answer moved the task to %q", v.Status)
			}
		})
	}
}

func TestAnswerRefusals(t *testing.T) {
	h := newHarness(t)
	task := h.needsInput(permissionDialog("toolu_1", "date"))
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
	t.Run("a row that is not on offer", func(t *testing.T) {
		h.decodeJSON(h.answer(task, `{"option":9}`), http.StatusUnprocessableEntity, nil)
	})
	if n := len(h.sessions.answerCalls()); n != 0 {
		t.Fatalf("refused answers reached session-events %d times", n)
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

// The dialog is read again before anything is sent. If it is not the one the
// task reported (the next tool call's prompt, with the same rows over a
// different command), the caller is answering something it has not seen, so
// nothing is sent and the task is updated to what is there.
func TestAnswerRefusesWhenTheQuestionChanged(t *testing.T) {
	h := newHarness(t)
	task := h.needsInput(permissionDialog("toolu_1", "date"))
	defer h.stop(task)
	h.sessions.setDialog(testOSUser, "c1", permissionDialog("toolu_2", "rm -rf build"))

	h.decodeJSON(h.answer(task, `{"option":1}`), http.StatusConflict, nil)
	if n := len(h.sessions.answerCalls()); n != 0 {
		t.Fatalf("an answer to a question the caller never saw reached session-events %d times", n)
	}
	var got TaskView
	h.decodeJSON(h.call("GET", "/v1/tasks/"+task, ""), http.StatusOK, &got)
	if got.Status != StatusNeedsInput || !strings.Contains(got.Question, "rm -rf build") {
		t.Fatalf("the task still reports the old question: %+v", got)
	}
	// Answering again, now that the caller has seen it, goes through.
	h.decodeJSON(h.answer(task, `{"option":2}`), http.StatusOK, nil)
	if calls := h.sessions.answerCalls(); len(calls) != 1 || calls[0].Req.ToolID != "toolu_2" {
		t.Fatalf("answer calls %+v, want one for the dialog now open", calls)
	}
}

// What session-events reports back, mapped onto what the caller is told.
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
		{"sent but not confirmed", &sessionio.AnswerResponse{Reason: sessionio.AnswerUnverified}, nil,
			http.StatusOK, StatusRunning, true},
		{"answered in the terminal a moment ago", &sessionio.AnswerResponse{Reason: sessionio.AnswerNotHeld}, nil,
			http.StatusConflict, StatusNeedsInput, false},
		{"a different dialog by then", &sessionio.AnswerResponse{Reason: sessionio.AnswerNotDrawn}, nil,
			http.StatusConflict, StatusNeedsInput, false},
		{"a question left unanswered", &sessionio.AnswerResponse{Reason: sessionio.AnswerIncomplete}, nil,
			http.StatusUnprocessableEntity, StatusNeedsInput, false},
		{"the dialog went before session-events got it", nil, errDialogGone, http.StatusConflict, StatusNeedsInput, false},
		{"the mod disconnected", nil, errNoMod, http.StatusConflict, StatusNeedsInput, false},
		{"session-events could not be reached", nil, errors.New("connect: connection refused"),
			http.StatusInternalServerError, StatusNeedsInput, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t)
			task := h.needsInput(permissionDialog("toolu_1", "date"))
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
			// Read from the response for the answers that went in: with the
			// dialog still open in the fake, the watcher puts the task back
			// to needs_input on its next poll, the recovery the warning
			// promises.
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

// After an answer, @claude_state can read "awaiting" for a moment longer.
// The task must not bounce back to needs_input for the dialog it just
// answered, and must go back as soon as a new one opens.
func TestAfterAnAnswerTheNextQuestionIsFound(t *testing.T) {
	h := newHarness(t)
	task := h.needsInput(permissionDialog("toolu_1", "date"))
	defer h.stop(task)
	h.sessions.answerResp = &sessionio.AnswerResponse{Applied: true, Done: true}
	h.sessions.onAnswer = func(f *fakeSessions, k string) { f.dialogs[k] = permissionDialog("toolu_1", "date") }

	h.decodeJSON(h.answer(task, `{"option":1}`), http.StatusOK, nil)
	time.Sleep(30 * time.Millisecond)
	if v, _ := h.srv.Tasks.Get(task); v.Status != StatusRunning {
		t.Fatalf("the task went back to %q for the dialog it just answered", v.Status)
	}

	h.sessions.setDialog(testOSUser, "c1", permissionDialog("toolu_2", "rm -rf build"))
	v := h.waitStatus(task, StatusNeedsInput)
	if !strings.Contains(v.Question, "rm -rf build") || v.Kind != KindPermission {
		t.Fatalf("the next question was not read: %+v", v)
	}
}

// The state can be stamped a moment before the dialog event lands. The task
// stays running through the start grace, and the dialog read after it is the
// question, not the spinner on the pane.
func TestAnAwaitingSessionWithNoDialogYetIsReadAgain(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	h.sessions.setPane(testOSUser, "c1", "✢ Calculating… (12s · ↓ 300 tokens)\n\n❯ \n")
	h.sessions.setDialog(testOSUser, "c1", nil)
	h.sessions.onPrompt = func(f *fakeSessions, k string) {
		f.setStateLocked(k, "running")
		go func() {
			time.Sleep(5 * time.Millisecond)
			f.setState(testOSUser, "c1", "awaiting")
		}()
	}
	h.srv.StartGrace = 100 * time.Millisecond
	task := h.sendMessage("c1", "start a background agent")
	defer h.stop(task)
	time.Sleep(40 * time.Millisecond)
	if v, _ := h.srv.Tasks.Get(task); v.Status != StatusRunning {
		t.Fatalf("status %q kind %q question %q with no dialog yet", v.Status, v.Kind, v.Question)
	}
	h.sessions.setDialog(testOSUser, "c1", permissionDialog("toolu_1", "date"))
	v := h.waitStatus(task, StatusNeedsInput)
	if v.Kind != KindPermission || len(v.Options) == 0 {
		t.Fatalf("the dialog that landed after the state was not read: %+v", v)
	}
}

// With no dialog to read (no mod), the task is reported as unknown once the
// grace has run, with the pane's tail as the question, so a caller is not
// left holding a running task over a session that waits. A dialog that comes
// back afterwards (the mod reconnected after a session-events restart)
// replaces the unknown question.
func TestAnUnknownQuestionIsReportedAndThenReplaced(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	h.sessions.setPane(testOSUser, "c1", "Some dialog the lobby cannot read\n")
	h.sessions.onPrompt = func(f *fakeSessions, k string) {
		f.setStateLocked(k, "running")
		go func() {
			time.Sleep(5 * time.Millisecond)
			f.setState(testOSUser, "c1", "awaiting")
		}()
	}
	task := h.sendMessage("c1", "go")
	defer h.stop(task)
	v := h.waitStatus(task, StatusNeedsInput)
	if v.Kind != KindUnknown || !strings.Contains(v.Question, "cannot read") {
		t.Fatalf("got %+v", v)
	}
	h.sessions.setDialog(testOSUser, "c1", planDialog)
	deadline := time.Now().Add(2 * time.Second)
	for {
		v, _ = h.srv.Tasks.Get(task)
		if v.Kind == KindPlan {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the dialog that came back did not replace the unknown question: %+v", v)
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !strings.Contains(v.Question, "Ship it") {
		t.Fatalf("plan question %q", v.Question)
	}
}
