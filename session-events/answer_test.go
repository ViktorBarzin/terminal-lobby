package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"terminal-lobby/sessionio"
	"terminal-lobby/sessionio/siotest"
	"terminal-lobby/telemetry"
)

// POST /answer/{session}: a held AskUserQuestion answered as data (hold.go,
// hold_test.go), or Claude Code's plan approval answered by keys through the
// driver. WHAT IS UNDER TEST HERE is the route: bound the body, place the
// session, hand the driver the request, encode what comes back, and record the
// shape of it. The driver's own loop is tested against a real tmux in
// sessionio/plandrive_test.go.

// A transcript with a prompt and an AskUserQuestion still open, as a call
// Claude Code abandoned would leave it, which a plan answer must not count.
const (
	answerUserLine = `{"type":"user","message":{"role":"user","content":"ask me two things"},` +
		`"uuid":"u1","timestamp":"2026-09-10T18:35:00Z"}`
	answerAskLine = `{"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","content":[` +
		`{"type":"tool_use","id":"tu_1","name":"AskUserQuestion","input":{"questions":[` +
		`{"question":"Pick fruits","header":"Fruit","multiSelect":true,"options":[` +
		`{"label":"Apple","description":"Include apples."},{"label":"Pear"},{"label":"Plum"}]}]}}]},` +
		`"uuid":"a1","timestamp":"2026-09-10T18:35:01Z"}`
	answerResultLine = `{"type":"user","message":{"role":"user","content":[` +
		`{"type":"tool_result","tool_use_id":"tu_1","content":"Pear"}]},` +
		`"uuid":"a2","timestamp":"2026-09-10T18:35:09Z"}`
)

// fakeAnswerDriver stands in for sessionio.Injector.Answer: it records what the
// route handed it and returns a scripted reading.
type fakeAnswerDriver struct {
	resp  sessionio.AnswerResponse
	err   error
	calls int
	req   sessionio.AnswerRequest
}

func (f *fakeAnswerDriver) Answer(_ context.Context, _, _ string, req sessionio.AnswerRequest,
) (sessionio.AnswerResponse, error) {
	f.calls++
	f.req = req
	resp := f.resp
	if resp.Action == "" {
		resp.Action = sessionio.AnswerAction(req)
	}
	return resp, f.err
}

// answerEnv registers one session called "demo" for "wizard", lays down the
// transcript lines given, and returns a mux serving POST /answer over it.
func answerEnv(t *testing.T, drv answerDriver, lines ...string) http.Handler {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	home := t.TempDir()
	path := sessionio.TranscriptPath(sessionio.ProjectsRoot(home, "wizard"), "/home/wizard/x", "s1")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	rg := newRegistry(ctx, time.Millisecond, home, siotest.NewFakeOptions("wizard/demo"), "wizard")
	w := httptest.NewRecorder()
	rg.handleSessionStart()(w, httptest.NewRequest(http.MethodPost, "/hooks/session-start",
		strings.NewReader(`{"user":"wizard","session_id":"s1","cwd":"/home/wizard/x","tmux_session":"demo"}`)))
	if w.Code != http.StatusNoContent {
		t.Fatalf("session-start: %d (%s)", w.Code, w.Body.String())
	}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /answer/{session}", handleAnswer(rg, drv))
	return mux
}

// postAnswer sends one request as the authenticated wizard. The identity comes
// from the context because that is where authMiddleware leaves it.
func postAnswer(t *testing.T, h http.Handler, session, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/answer/"+session, strings.NewReader(body))
	req = req.WithContext(context.WithValue(req.Context(), osUserKey, "wizard"))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decodeAnswer(t *testing.T, rec *httptest.ResponseRecorder) sessionio.AnswerResponse {
	t.Helper()
	var got sessionio.AnswerResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("the reply is not an AnswerResponse (%v): %s", err, rec.Body.String())
	}
	return got
}

// planReading is a real capture of the plan approval, parsed.
func planReading(t *testing.T) *sessionio.Dialog {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "sessionio", "testdata", "plan-first.txt"))
	if err != nil {
		t.Fatal(err)
	}
	d := sessionio.ParsePlanDialog(string(raw))
	if d == nil {
		t.Fatal("plan-first.txt no longer parses")
	}
	return d
}

// eventSink keeps the lines the emitter would have written to the journal.
// Locked, because a held question emits from the hook's own request goroutine.
type eventSink struct {
	mu    sync.Mutex
	lines []string
}

func (s *eventSink) Write(line string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lines = append(s.lines, line)
}

// snapshot is the lines written so far.
func (s *eventSink) snapshot() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.lines...)
}

// captureEvents points this service's emitter at a sink for the test.
func captureEvents(t *testing.T) *eventSink {
	t.Helper()
	sink := &eventSink{}
	old := events
	events = telemetry.New("session-events", buildID, sink)
	t.Cleanup(func() { events = old })
	return sink
}

// recorded is one decoded journal line.
type recorded struct {
	Name  string         `json:"event.name"`
	Attrs map[string]any `json:"attrs"`
}

// all decodes what the sink holds, in order.
func (s *eventSink) all(t *testing.T) []recorded {
	t.Helper()
	lines := s.snapshot()
	out := make([]recorded, 0, len(lines))
	for _, line := range lines {
		var rec recorded
		raw := strings.TrimPrefix(line, telemetry.Marker+" ")
		if err := json.Unmarshal([]byte(raw), &rec); err != nil {
			t.Fatalf("the event is not JSON (%v): %s", err, line)
		}
		out = append(out, rec)
	}
	return out
}

// names is what the request recorded, in order, for a test that cares about
// which records it produced rather than what any one of them says.
func (s *eventSink) names(t *testing.T) []string {
	t.Helper()
	var out []string
	for _, rec := range s.all(t) {
		out = append(out, rec.Name)
	}
	return out
}

// only returns the attrs of the one event with this name, failing if there is
// not exactly one of it: a route that emits the same name twice doubles every
// count drawn from it.
//
// BY NAME, rather than "the only event there is", because one applied answer
// records two different things. text.answer_sent counts what the text view
// attempted and carries the shape of the call; claude.answered is ADR-0006's
// record of a blocking prompt being answered, whichever surface answered it,
// and the /keys and /answer-text routes this one replaces both emit it.
func (s *eventSink) only(t *testing.T, name string) map[string]any {
	t.Helper()
	var found []recorded
	for _, rec := range s.all(t) {
		if rec.Name == name {
			found = append(found, rec)
		}
	}
	if len(found) != 1 {
		t.Fatalf("want exactly one %s, got %d: %v", name, len(found), s.names(t))
	}
	return found[0].Attrs
}

// A session nobody registered gets nothing typed into it, and the refusal is
// recorded: a silent 404 would read as a failure class that stopped happening.
func TestAnswerRefusesAnUnregisteredSession(t *testing.T) {
	sink := captureEvents(t)
	drv := &fakeAnswerDriver{}
	h := answerEnv(t, drv, answerUserLine)

	rec := postAnswer(t, h, "ghost", `{"plan":{"option":1,"label":"Yes"}}`)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status %d, want 404 (%s)", rec.Code, rec.Body.String())
	}
	if drv.calls != 0 {
		t.Fatalf("the driver ran %d times for a session that was never registered", drv.calls)
	}
	attrs := sink.only(t, "text.answer_failed")
	if attrs["tl.reason"] != answerNoSession || attrs["tl.session"] != "ghost" {
		t.Errorf("attrs = %v", attrs)
	}
}

// An AskUserQuestion is never typed: with no hook holding it the answer is
// refused as not-held and the driver is not asked.
func TestAQuestionAnswerWithNoHoldNeverReachesThePane(t *testing.T) {
	drv := &fakeAnswerDriver{}
	h := answerEnv(t, drv, answerUserLine, answerAskLine)

	got := decodeAnswer(t, postAnswer(t, h, "demo", `{"answers":{"Pick fruits":["Pear"]}}`))

	if got.Applied || got.Reason != sessionio.AnswerNotHeld {
		t.Fatalf("reply = %+v, want not-held", got)
	}
	if drv.calls != 0 {
		t.Fatalf("the driver ran %d times for a question", drv.calls)
	}
}

func TestAnswerBoundsTheBody(t *testing.T) {
	t.Run("feedback at the injector's own limit is accepted", func(t *testing.T) {
		drv := &fakeAnswerDriver{resp: sessionio.AnswerResponse{Applied: true}}
		h := answerEnv(t, drv, answerUserLine)
		body, err := json.Marshal(sessionio.AnswerRequest{
			Plan: &sessionio.PlanAnswer{Feedback: strings.Repeat("m", sessionio.MaxAnswerText)},
		})
		if err != nil {
			t.Fatal(err)
		}
		if rec := postAnswer(t, h, "demo", string(body)); rec.Code != http.StatusOK {
			t.Fatalf("status %d for a %d-byte body, want 200 (%s)", rec.Code, len(body), rec.Body.String())
		}
	})
	t.Run("a body over the cap is refused before anything is typed", func(t *testing.T) {
		drv := &fakeAnswerDriver{}
		h := answerEnv(t, drv, answerUserLine)
		body := `{"plan":{"feedback":"` + strings.Repeat("x", answerBodyLimit) + `"}}`
		if rec := postAnswer(t, h, "demo", body); rec.Code != http.StatusBadRequest {
			t.Fatalf("status %d for a %d-byte body, want 400", rec.Code, len(body))
		}
		if drv.calls != 0 {
			t.Fatalf("the driver ran %d times on an oversized body", drv.calls)
		}
	})
}

// A plan answer is handed to the driver as posted, its reading comes back, and
// the record carries the action and the reason but no question shape and none
// of the words: the plan answered no question, and a dialog quotes whatever the
// session was working on (ADR-0006).
func TestAPlanAnswerIsRecordedWithoutTheQuestionShape(t *testing.T) {
	sink := captureEvents(t)
	drv := &fakeAnswerDriver{resp: sessionio.AnswerResponse{Reason: sessionio.AnswerUnverified, Dialog: planReading(t)}}
	h := answerEnv(t, drv, answerUserLine, answerAskLine)

	rec := postAnswer(t, h, "demo", `{"plan":{"feedback":"a secret of mine"}}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d (%s)", rec.Code, rec.Body.String())
	}
	if drv.req.Plan == nil || drv.req.Plan.Feedback != "a secret of mine" {
		t.Fatalf("the driver got %+v, want the plan answer that was posted", drv.req)
	}
	got := decodeAnswer(t, rec)
	if got.Dialog == nil || got.Dialog.Kind != sessionio.DialogKindPlan {
		t.Fatalf("the reply must carry the plan reading: %s", rec.Body.String())
	}
	attrs := sink.only(t, "text.answer_failed")
	if attrs["tl.action"] != sessionio.ActionPlanFeedback || attrs["tl.reason"] != sessionio.AnswerUnverified ||
		attrs["tl.session"] != "demo" || attrs["tl.client"] != "api-answer" {
		t.Errorf("attrs = %v", attrs)
	}
	for _, k := range []string{"tl.questions", "tl.multi"} {
		if _, ok := attrs[k]; ok {
			t.Errorf("%s = %v on a plan answer, which answered no question", k, attrs[k])
		}
	}
	for k, v := range attrs {
		if s, ok := v.(string); ok && strings.Contains(s, "secret") {
			t.Errorf("%s = %q carries what was typed", k, s)
		}
	}
}

// ADR-0006's record of a blocking prompt answered: one digit for an approval,
// the characters for words, and nothing for a refusal.
func TestAnswerRecordsTheBlockingPromptAsAnswered(t *testing.T) {
	for _, tc := range []struct {
		name, body, client string
		count              float64
	}{
		{"a plan approval", `{"plan":{"option":2,"label":"Yes, and use auto mode"}}`, "api", 1},
		{"plan feedback", `{"plan":{"feedback":"kiwi"}}`, "api-text", 4},
		{"an approval with feedback", `{"plan":{"feedback":"kiwi","approve":true}}`, "api-text", 4},
		{"a permission declined with words", `{"permission":{"decline":"use ls"}}`, "api-text", 6},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sink := captureEvents(t)
			drv := &fakeAnswerDriver{resp: sessionio.AnswerResponse{Applied: true}}
			h := answerEnv(t, drv, answerUserLine)
			postAnswer(t, h, "demo", tc.body)
			attrs := sink.only(t, "claude.answered")
			if attrs["tl.client"] != tc.client || attrs["tl.count"] != tc.count || attrs["tl.session"] != "demo" {
				t.Errorf("attrs = %v", attrs)
			}
		})
	}
	t.Run("a refusal records no answer", func(t *testing.T) {
		sink := captureEvents(t)
		drv := &fakeAnswerDriver{resp: sessionio.AnswerResponse{Reason: sessionio.AnswerNotDrawn}}
		h := answerEnv(t, drv, answerUserLine)
		postAnswer(t, h, "demo", `{"plan":{"option":1,"label":"Yes"}}`)
		if got := sink.names(t); len(got) != 1 || got[0] != "text.answer_failed" {
			t.Fatalf("a refusal recorded %v, want text.answer_failed alone", got)
		}
	})
}

// A pane that cannot be read at all is the one driver failure that is an HTTP
// error.
func TestAnswerReportsAPaneItCannotReadAs502(t *testing.T) {
	sink := captureEvents(t)
	drv := &fakeAnswerDriver{err: errors.New("no server running on /tmp/tmux-1000/default")}
	h := answerEnv(t, drv, answerUserLine)

	rec := postAnswer(t, h, "demo", `{"plan":{"option":1,"label":"Yes"}}`)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status %d, want 502 (%s)", rec.Code, rec.Body.String())
	}
	if attrs := sink.only(t, "text.answer_failed"); attrs["tl.reason"] != "unreadable" {
		t.Errorf("tl.reason = %v, want unreadable", attrs["tl.reason"])
	}
}

// A reader who navigated away mid-request is not a failure of this route.
func TestAnswerRecordsNothingWhenTheReaderHangsUp(t *testing.T) {
	sink := captureEvents(t)
	drv := &fakeAnswerDriver{err: context.Canceled}
	h := answerEnv(t, drv, answerUserLine)

	postAnswer(t, h, "demo", `{"plan":{"option":1,"label":"Yes"}}`)

	if lines := sink.snapshot(); len(lines) != 0 {
		t.Fatalf("an abandoned request was recorded as an answer: %v", lines)
	}
}
