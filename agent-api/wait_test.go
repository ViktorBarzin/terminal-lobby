package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"testing"
	"time"
)

// The wait parameter's whole vocabulary. Every route that takes it shares the
// parser, so the edges are pinned once here and the routes only prove they
// use it.
func TestWaitSeconds(t *testing.T) {
	for _, c := range []struct {
		raw     string
		present bool
		want    int
		ok      bool
	}{
		{present: false, want: 0, ok: true},
		{raw: "0", present: true, want: 0, ok: true},
		{raw: "1", present: true, want: 1, ok: true},
		{raw: "300", present: true, want: 300, ok: true},
		{raw: "301", present: true, ok: false},
		{raw: "-1", present: true, ok: false},
		{raw: "+5", present: true, ok: false},
		{raw: "1.5", present: true, ok: false},
		{raw: "abc", present: true, ok: false},
		{raw: "", present: true, ok: false},
		{raw: " 5", present: true, ok: false},
		{raw: "99999999999999999999", present: true, ok: false},
	} {
		q := url.Values{}
		if c.present {
			q.Set("wait", c.raw)
		}
		got, err := waitSeconds(q)
		if c.ok && (err != nil || got != c.want) {
			t.Errorf("wait=%q: got %d, %v; want %d", c.raw, got, err, c.want)
		}
		if !c.ok && err == nil {
			t.Errorf("wait=%q: accepted as %d, want a refusal", c.raw, got)
		}
	}
}

// A turn that ends inside the wait answers with the task itself, the same
// JSON GET /v1/tasks/{id} serves, so a caller needs no second request.
func TestSendAndWaitReturnsTheFinishedTask(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	h.sessions.onPrompt = func(f *fakeSessions, k string) {
		f.setStateLocked(k, "running")
		go func() {
			time.Sleep(5 * time.Millisecond)
			f.appendTranscript(testOSUser, "c1", assistantLine("the answer", "2026-09-16T11:00:09Z"))
			f.setState(testOSUser, "c1", "done")
		}()
	}

	w := h.call("POST", "/v1/conversations/c1/messages?wait=300", `{"text":"go"}`)
	var got TaskView
	h.decodeJSON(w, http.StatusOK, &got)
	if got.Status != StatusDone || got.Result != "the answer" || got.ID == "" {
		t.Fatalf("got %+v", got)
	}
	// Byte for byte what the poll route says about the same task.
	var polled TaskView
	h.decodeJSON(h.call("GET", "/v1/tasks/"+got.ID, ""), http.StatusOK, &polled)
	if !reflect.DeepEqual(polled, got) {
		t.Fatalf("send-and-wait answered %+v, the poll %+v", got, polled)
	}
	h.waitIdle()
}

// A question is as far as a turn can get without somebody, so it ends the
// wait as an end state does.
func TestSendAndWaitStopsAtAQuestion(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	h.sessions.setPane(testOSUser, "c1", "Approve the deploy?")
	h.sessions.onPrompt = func(f *fakeSessions, k string) {
		f.setStateLocked(k, "running")
		go func() {
			time.Sleep(5 * time.Millisecond)
			f.setState(testOSUser, "c1", "awaiting")
		}()
	}

	var got TaskView
	h.decodeJSON(h.call("POST", "/v1/conversations/c1/messages?wait=300", `{"text":"deploy"}`), http.StatusOK, &got)
	if got.Status != StatusNeedsInput || got.Question == "" {
		t.Fatalf("got %+v", got)
	}
	h.srv.Tasks.Cancel(got.ID)
	h.waitIdle()
}

// A turn still running when the wait runs out gets today's receipt, exactly,
// so a caller that handles the 202 already handles this.
func TestSendAndWaitTimesOutIntoTheReceipt(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	h.sessions.onPrompt = func(f *fakeSessions, k string) { f.setStateLocked(k, "running") }

	w := h.call("POST", "/v1/conversations/c1/messages?wait=2", `{"text":"a long job"}`)
	assertReceipt(t, h, w)
}

// wait=0 is the default spelled out: no waiting at all.
func TestSendWithWaitZeroIsTheOldBehaviour(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	// A turn that would finish at once: wait=0 must still not report it.
	h.sessions.onPrompt = func(f *fakeSessions, k string) {
		f.appendTranscriptLocked(k, assistantLine("instant", "2026-09-16T11:00:00Z"))
		f.setStateLocked(k, "done")
	}
	assertReceipt(t, h, h.call("POST", "/v1/conversations/c1/messages?wait=0", `{"text":"quick"}`))
	h.waitIdle()
}

// assertReceipt checks a response is MessageAccepted and nothing else.
func assertReceipt(t *testing.T, h *harness, w *httptest.ResponseRecorder) {
	t.Helper()
	res := w.Result()
	if res.StatusCode != http.StatusAccepted {
		t.Fatalf("status %d, want 202", res.StatusCode)
	}
	var got map[string]any
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatalf("decoding the receipt: %v", err)
	}
	if len(got) != 3 || got["status"] != "accepted" || got["task_id"] == "" {
		t.Fatalf("the receipt changed shape: %v", got)
	}
	if _, ok := got["queued_behind"].(float64); !ok {
		t.Fatalf("queued_behind missing: %v", got)
	}
	if id, _ := got["task_id"].(string); id != "" {
		h.srv.Tasks.Cancel(id)
	}
	h.waitIdle()
}

// A caller that hangs up stops the wait. Nothing would read the answer, and a
// handler parked for five minutes on behalf of nobody is a leak.
func TestSendAndWaitEndsWhenTheCallerHangsUp(t *testing.T) {
	h := newHarness(t)
	h.srv.WaitUnit = time.Second
	h.readyConversation("c1")
	h.sessions.onPrompt = func(f *fakeSessions, k string) { f.setStateLocked(k, "running") }

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(30 * time.Millisecond)
		cancel()
	}()
	start := time.Now()
	w := h.do(request{method: "POST", path: "/v1/conversations/c1/messages?wait=300",
		body: `{"text":"go"}`, token: testToken, ctx: ctx})
	if time.Since(start) > 5*time.Second {
		t.Fatal("the wait outlived the request")
	}
	if w.Code != http.StatusAccepted {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	var got struct {
		TaskID string `json:"task_id"`
	}
	json.Unmarshal(w.Body.Bytes(), &got)
	h.srv.Tasks.Cancel(got.TaskID)
	h.waitIdle()
}

// A bad wait is refused BEFORE anything is sent, so a typo never costs the
// caller a turn it did not mean to start.
func TestSendRefusesABadWait(t *testing.T) {
	for _, raw := range []string{"301", "-1", "x", "2.5", ""} {
		t.Run("wait="+raw, func(t *testing.T) {
			h := newHarness(t)
			h.readyConversation("c1")
			w := h.call("POST", "/v1/conversations/c1/messages?wait="+url.QueryEscape(raw), `{"text":"go"}`)
			var e struct {
				Error string `json:"error"`
			}
			h.decodeJSON(w, http.StatusBadRequest, &e)
			if e.Error == "" {
				t.Fatalf("no error message: %s", w.Body.String())
			}
			h.waitIdle()
			if p := h.sessions.promptCalls(); len(p) != 0 {
				t.Fatalf("a refused request still sent %v", p)
			}
			if n := h.srv.Runner.Ahead("c1"); n != 0 {
				t.Fatalf("a refused request queued %d turns", n)
			}
		})
	}
}

// The long-poll returns at once for a task that cannot change any more, or
// that is waiting on somebody and so will not change by itself.
func TestTaskWaitReturnsAtOnceWhenNothingWillChange(t *testing.T) {
	for _, c := range []struct {
		name  string
		state string
		pane  string
		want  TaskStatus
	}{
		{"done", "done", "", StatusDone},
		{"needs_input", "awaiting", "Approve?", StatusNeedsInput},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t)
			h.readyConversation("c1")
			h.sessions.setPane(testOSUser, "c1", c.pane)
			h.sessions.onPrompt = func(f *fakeSessions, k string) {
				f.setStateLocked(k, "running")
				go func() {
					time.Sleep(5 * time.Millisecond)
					if c.state == "done" {
						f.appendTranscript(testOSUser, "c1", assistantLine("fin", "2026-09-16T11:00:09Z"))
					}
					f.setState(testOSUser, "c1", c.state)
				}()
			}
			task := h.sendMessage("c1", "go")
			h.waitStatus(task, c.want)

			h.srv.WaitUnit = time.Second
			start := time.Now()
			var got TaskView
			h.decodeJSON(h.call("GET", "/v1/tasks/"+task+"?wait=300", ""), http.StatusOK, &got)
			if got.Status != c.want {
				t.Fatalf("status %q, want %q", got.Status, c.want)
			}
			if time.Since(start) > time.Second {
				t.Fatalf("a %s task was waited on", c.want)
			}
			h.srv.Tasks.Cancel(task)
			h.waitIdle()
		})
	}
}

// A running task is held until its status moves, and the answer is the moved
// task — not a fixed sleep, which is what the hour-scale wait proves.
func TestTaskWaitReturnsWhenTheStatusMoves(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	h.sessions.onPrompt = func(f *fakeSessions, k string) { f.setStateLocked(k, "running") }
	task := h.sendMessage("c1", "go")
	h.waitStatus(task, StatusRunning)

	h.srv.WaitUnit = time.Second
	go func() {
		time.Sleep(30 * time.Millisecond)
		h.sessions.appendTranscript(testOSUser, "c1", assistantLine("moved", "2026-09-16T11:00:09Z"))
		h.sessions.setState(testOSUser, "c1", "done")
	}()
	start := time.Now()
	var got TaskView
	h.decodeJSON(h.call("GET", "/v1/tasks/"+task+"?wait=300", ""), http.StatusOK, &got)
	if got.Status != StatusDone || got.Result != "moved" {
		t.Fatalf("got %+v", got)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("the long-poll did not return on the change")
	}
	h.waitIdle()
}

// accepted to running is a change too: the poll is "tell me when it moves",
// not "tell me when it ends".
func TestTaskWaitCountsStartingAsAChange(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	block := make(chan struct{})
	h.sessions.readyBlock = block
	h.sessions.onPrompt = func(f *fakeSessions, k string) { f.setStateLocked(k, "running") }
	task := h.sendMessage("c1", "go")
	if v, _ := h.srv.Tasks.Get(task); v.Status != StatusAccepted {
		t.Fatalf("status %q, want accepted while the harness comes up", v.Status)
	}

	h.srv.WaitUnit = time.Second
	go func() {
		time.Sleep(30 * time.Millisecond)
		close(block)
	}()
	var got TaskView
	h.decodeJSON(h.call("GET", "/v1/tasks/"+task+"?wait=300", ""), http.StatusOK, &got)
	if got.Status != StatusRunning {
		t.Fatalf("status %q, want running", got.Status)
	}
	h.srv.Tasks.Cancel(task)
	h.waitIdle()
}

// Out of time, the task comes back as it is, with a 200: an unchanged status
// is an answer, not a failure.
func TestTaskWaitTimesOutWithTheCurrentTask(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	h.sessions.onPrompt = func(f *fakeSessions, k string) { f.setStateLocked(k, "running") }
	task := h.sendMessage("c1", "go")
	h.waitStatus(task, StatusRunning)

	var got TaskView
	h.decodeJSON(h.call("GET", "/v1/tasks/"+task+"?wait=2", ""), http.StatusOK, &got)
	if got.Status != StatusRunning {
		t.Fatalf("status %q", got.Status)
	}
	h.srv.Tasks.Cancel(task)
	h.waitIdle()
}

func TestTaskWaitEndsWhenTheCallerHangsUp(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	h.sessions.onPrompt = func(f *fakeSessions, k string) { f.setStateLocked(k, "running") }
	task := h.sendMessage("c1", "go")
	h.waitStatus(task, StatusRunning)

	h.srv.WaitUnit = time.Second
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(30 * time.Millisecond)
		cancel()
	}()
	start := time.Now()
	w := h.do(request{method: "GET", path: "/v1/tasks/" + task + "?wait=300", token: testToken, ctx: ctx})
	if time.Since(start) > 5*time.Second {
		t.Fatal("the long-poll outlived the request")
	}
	if w.Code != http.StatusOK {
		t.Fatalf("status %d", w.Code)
	}
	h.srv.Tasks.Cancel(task)
	h.waitIdle()
}

func TestTaskWaitRefusesABadWait(t *testing.T) {
	h := newHarness(t)
	h.readyConversation("c1")
	h.sessions.onPrompt = func(f *fakeSessions, k string) { f.setStateLocked(k, "running") }
	task := h.sendMessage("c1", "go")
	for _, raw := range []string{"301", "-5", "soon"} {
		h.decodeJSON(h.call("GET", "/v1/tasks/"+task+"?wait="+raw, ""), http.StatusBadRequest, nil)
	}
	h.srv.Tasks.Cancel(task)
	h.waitIdle()
}

// The account boundary holds under a wait too: another account's task is a
// 404 straight away, never a wait on something the caller cannot see.
func TestTaskWaitDoesNotRevealAnotherAccountsTask(t *testing.T) {
	h := newHarness(t)
	h.srv.Tasks.Add(&Task{ID: "theirs", ConversationID: "c9", Actor: "other", OSUser: "emo"})
	h.srv.WaitUnit = time.Second
	start := time.Now()
	h.decodeJSON(h.call("GET", "/v1/tasks/theirs?wait=300", ""), http.StatusNotFound, nil)
	if time.Since(start) > time.Second {
		t.Fatal("waited on another account's task")
	}
}

// The server's write deadline covers the whole handler, so it has to outlast
// the longest wait a caller may ask for, with room for the work around it.
func TestTheWriteTimeoutOutlastsTheLongestWait(t *testing.T) {
	if longest := maxWaitSeconds * time.Second; serverWriteTimeout < longest+30*time.Second {
		t.Fatalf("WriteTimeout %s would cut off a %s wait", serverWriteTimeout, longest)
	}
}
