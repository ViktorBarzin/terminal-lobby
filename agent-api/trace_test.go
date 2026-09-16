package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// One line per request, with the caller's own words in it.
func TestTraceRecordsARequest(t *testing.T) {
	h := newHarness(t)
	h.sessions.start(testOSUser, LiveSession{Name: "c1", Owner: testActor, State: "done"})
	h.sessions.setTranscript(testOSUser, "c1", userLine("earlier", "2026-09-16T10:00:00Z"))

	const text = "Which stacks still read the retired forgejo registry?"
	task := h.sendMessage("c1", text)

	lines := h.traceLines()
	if len(lines) != 1 {
		t.Fatalf("%d trace lines, want 1", len(lines))
	}
	e := lines[0]

	if e.Verb != "POST /v1/conversations/{id}/messages" {
		t.Errorf("verb %q — the trace records the ROUTE, so lines group", e.Verb)
	}
	if e.Actor != testActor {
		t.Errorf("actor %q, want %q", e.Actor, testActor)
	}
	if e.ConversationID != "c1" || e.TaskID != task {
		t.Errorf("ids: conversation %q task %q", e.ConversationID, e.TaskID)
	}
	if e.Status != http.StatusAccepted {
		t.Errorf("status %d", e.Status)
	}
	if e.TraceID == "" || len(e.TraceID) != 26 {
		t.Errorf("trace_id %q", e.TraceID)
	}
	if e.Duration < 0 {
		t.Errorf("duration_ms %v", e.Duration)
	}
	if _, err := time.Parse("2006-01-02T15:04:05.000Z", e.TS); err != nil {
		t.Errorf("ts %q is not the documented format: %v", e.TS, err)
	}

	// The request is the caller's own bytes, not a re-encoding.
	var req map[string]string
	if err := json.Unmarshal(e.Request, &req); err != nil {
		t.Fatalf("request %s: %v", e.Request, err)
	}
	if req["text"] != text {
		t.Errorf("request text %q, want the caller's words verbatim", req["text"])
	}

	var res map[string]any
	if err := json.Unmarshal(e.Response, &res); err != nil {
		t.Fatalf("response %s: %v", e.Response, err)
	}
	if res["status"] != "accepted" || res["task_id"] != task {
		t.Errorf("response %s", e.Response)
	}
	h.waitIdle()
}

// The property the whole file is here for: a token never reaches the trace.
// Not a redaction check — a grep of the real bytes for the real token.
func TestTraceNeverCarriesTheToken(t *testing.T) {
	h := newHarness(t)
	h.sessions.start(testOSUser, LiveSession{Name: "c1", Owner: testActor, State: "done"})
	h.sessions.setTranscript(testOSUser, "c1", userLine("earlier", "2026-09-16T10:00:00Z"))
	code := filepath.Join(h.homeBase, testOSUser, "code")

	// Every route, authenticated, refused and served, including the ones
	// whose bodies echo back what the caller sent.
	h.call("GET", "/v1/conversations", "")
	h.call("POST", "/v1/conversations", `{"cwd":`+jsonString(code)+`}`)
	h.call("GET", "/v1/conversations/c1", "")
	h.call("GET", "/v1/conversations/c1/transcript", "")
	h.call("GET", "/v1/tasks/nope", "")
	h.call("POST", "/v1/tasks/nope/cancel", "")
	h.call("POST", "/v1/conversations/c1/messages", `{"text":"an ordinary question"}`)
	// An unknown token, which is refused before any handler runs.
	h.do(request{method: "GET", path: "/v1/conversations", token: strings.Repeat("z", 48)})
	h.waitIdle()

	raw := h.trace.String()
	if raw == "" {
		t.Fatal("nothing was traced, so the check proves nothing")
	}
	for _, secret := range []string{testToken, testOtherToken, strings.Repeat("z", 48)} {
		if strings.Contains(raw, secret) {
			t.Fatalf("a credential reached the trace:\n%s", raw)
		}
	}
	// And no Authorization header under any spelling.
	for _, s := range []string{"Authorization", "authorization", "Bearer "} {
		if strings.Contains(raw, s) {
			t.Fatalf("the trace mentions %q:\n%s", s, raw)
		}
	}
}

// The limit of that promise, written down rather than left to be discovered:
// a caller that puts a secret in its own MESSAGE has put it in the trace,
// because the message is recorded verbatim. The same text is already in the
// conversation's transcript on disk, so redacting here would cost the verbatim
// guarantee and buy nothing.
func TestTraceKeepsAMessageVerbatimEvenWhenItCarriesASecret(t *testing.T) {
	h := newHarness(t)
	h.sessions.start(testOSUser, LiveSession{Name: "c1", Owner: testActor, State: "done"})
	h.sessions.setTranscript(testOSUser, "c1", userLine("earlier", "2026-09-16T10:00:00Z"))

	h.call("POST", "/v1/conversations/c1/messages", `{"text":"deploy with `+testToken+`"}`)
	h.waitIdle()

	var req map[string]string
	json.Unmarshal(h.traceLines()[0].Request, &req)
	if req["text"] != "deploy with "+testToken {
		t.Fatalf("the message was not recorded verbatim: %q", req["text"])
	}
}

// Nothing above proves the grep would have caught a leak, so this proves the
// proof: the same search over a trace that DOES carry the token must fail.
func TestTraceTokenCheckWouldCatchALeak(t *testing.T) {
	var buf bytes.Buffer
	tr := NewTraceTo(&buf)
	tr.Write(TraceEntry{Actor: "muse", Request: json.RawMessage(`{"token":"` + testToken + `"}`)})
	if !strings.Contains(buf.String(), testToken) {
		t.Fatal("the leak check cannot see a token that IS in the trace")
	}
}

// A refusal is recorded too, with the reason. The trace is the record of what
// was asked for, not of what succeeded.
func TestTraceRecordsRefusals(t *testing.T) {
	h := newHarness(t)
	h.sessions.start(testOSUser, LiveSession{Name: "theirs", State: "done"})
	h.sessions.setTranscript(testOSUser, "theirs", userLine("x", "2026-09-16T10:00:00Z"))

	h.call("POST", "/v1/conversations/theirs/messages", `{"text":"let me in"}`)

	lines := h.traceLines()
	if len(lines) != 1 {
		t.Fatalf("%d trace lines, want 1", len(lines))
	}
	if lines[0].Status != http.StatusForbidden {
		t.Errorf("status %d, want 403", lines[0].Status)
	}
	var res map[string]string
	json.Unmarshal(lines[0].Response, &res)
	if !strings.Contains(res["error"], "not writable") {
		t.Errorf("response %s does not say why", lines[0].Response)
	}
	// The refused request is still recorded verbatim, which is the point: a
	// caller asking for something it may not have is exactly what a replay
	// needs to show.
	var req map[string]string
	json.Unmarshal(lines[0].Request, &req)
	if req["text"] != "let me in" {
		t.Errorf("a refused request was not recorded: %s", lines[0].Request)
	}
}

// A request with no auth at all is refused by the gate, before any handler,
// so it is not traced. Worth stating: a reader must not conclude from an
// empty trace that nothing was attempted.
func TestUnauthenticatedRequestsAreNotTraced(t *testing.T) {
	h := newHarness(t)
	h.do(request{method: "GET", path: "/v1/conversations"})
	if lines := h.traceLines(); len(lines) != 0 {
		t.Fatalf("an unauthenticated request was traced: %+v", lines)
	}
}

// Unbounded bodies are summarised rather than copied, so one request cannot
// write a megabyte of transcript into the file.
func TestTraceSummarisesLargeResponses(t *testing.T) {
	h := newHarness(t)
	h.sessions.start(testOSUser, LiveSession{Name: "c1", Owner: testActor})
	long := strings.Repeat("a very long answer. ", 500)
	h.sessions.setTranscript(testOSUser, "c1", assistantLine(long, "2026-09-16T11:00:00Z"))

	h.call("GET", "/v1/conversations/c1/transcript", "")
	lines := h.traceLines()
	if len(lines) != 1 {
		t.Fatalf("%d trace lines", len(lines))
	}
	if strings.Contains(string(lines[0].Response), "a very long answer") {
		t.Fatalf("the whole transcript went into the trace: %d bytes", len(lines[0].Response))
	}
	var res map[string]int
	if err := json.Unmarshal(lines[0].Response, &res); err != nil || res["messages"] != 1 {
		t.Fatalf("response %s, want a count", lines[0].Response)
	}
}

// A body that is not JSON is still recorded, because what was SENT is the
// thing the trace exists to keep.
func TestTraceKeepsANonJSONBody(t *testing.T) {
	h := newHarness(t)
	h.sessions.start(testOSUser, LiveSession{Name: "c1", Owner: testActor, State: "done"})
	h.call("POST", "/v1/conversations/c1/messages", "this is not json")

	lines := h.traceLines()
	if len(lines) != 1 {
		t.Fatalf("%d trace lines", len(lines))
	}
	var req map[string]string
	if err := json.Unmarshal(lines[0].Request, &req); err != nil {
		t.Fatalf("request %s: %v", lines[0].Request, err)
	}
	if req["raw"] != "this is not json" {
		t.Fatalf("request %s", lines[0].Request)
	}
}

// A GET's query string is the request.
func TestTraceRecordsQueryParameters(t *testing.T) {
	h := newHarness(t)
	h.call("GET", "/v1/conversations?since=yesterday", "")
	lines := h.traceLines()
	if len(lines) != 1 {
		t.Fatalf("%d trace lines", len(lines))
	}
	var req map[string]string
	json.Unmarshal(lines[0].Request, &req)
	if req["since"] != "yesterday" {
		t.Fatalf("request %s", lines[0].Request)
	}
}

// An unwritable trace path is a warning and a service that keeps serving. The
// design doc is explicit that the trace must not take the service down.
func TestTraceOnAnUnwritablePath(t *testing.T) {
	dir := t.TempDir()
	// A file where a directory has to be, so both MkdirAll and OpenFile fail.
	blocker := filepath.Join(dir, "blocked")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	tr := OpenTrace(filepath.Join(blocker, "trace.jsonl"))
	if tr.Enabled() {
		t.Fatal("a trace on an unwritable path reported itself enabled")
	}
	// Writing to it is a no-op rather than a panic or an error to handle.
	tr.Write(TraceEntry{Actor: "muse", Verb: "GET /v1/conversations"})
	if err := tr.Close(); err != nil {
		t.Fatalf("closing a disabled trace: %v", err)
	}
}

// And the service still answers with the trace off.
func TestServiceServesWithTheTraceOff(t *testing.T) {
	h := newHarness(t)
	h.srv.Trace = OpenTrace("") // a trace that writes nowhere
	h.sessions.start(testOSUser, LiveSession{Name: "c1", Owner: testActor, State: "done"})

	h.decodeJSON(h.call("GET", "/v1/conversations/c1", ""), http.StatusOK, nil)
}

// A sink that errors is warned about once and then ignored. A broken disk
// must not turn one outage into a second one in the log.
func TestTraceWarnsOnceOnABrokenSink(t *testing.T) {
	var warnings int
	old := logf
	logf = func(string, ...any) { warnings++ }
	t.Cleanup(func() { logf = old })

	tr := NewTraceTo(brokenWriter{})
	for i := 0; i < 20; i++ {
		tr.Write(TraceEntry{Actor: "muse"})
	}
	if warnings != 1 {
		t.Fatalf("%d warnings for 20 failed writes, want 1", warnings)
	}
}

type brokenWriter struct{}

func (brokenWriter) Write([]byte) (int, error) { return 0, errors.New("disk is full") }

// One line per entry, whole and parseable, under concurrent writers — which
// is the normal case, since every request writes one from its own goroutine.
func TestTraceIsLineAtomicUnderConcurrency(t *testing.T) {
	var buf bytes.Buffer
	tr := NewTraceTo(&buf)

	var wg sync.WaitGroup
	const n = 200
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			tr.Write(TraceEntry{
				Actor:   "muse",
				Verb:    "POST /v1/conversations/{id}/messages",
				Request: json.RawMessage(`{"text":"` + strings.Repeat("x", 200) + `"}`),
			})
		}()
	}
	wg.Wait()

	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != n {
		t.Fatalf("%d lines, want %d", len(lines), n)
	}
	for i, l := range lines {
		var e TraceEntry
		if err := json.Unmarshal([]byte(l), &e); err != nil {
			t.Fatalf("line %d is not whole JSON: %v", i, err)
		}
	}
}

// A real file on disk, which is what production writes to.
func TestTraceWritesToAFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "trace.jsonl")
	tr := OpenTrace(path)
	if !tr.Enabled() {
		t.Fatal("a trace on a writable path is not enabled")
	}
	tr.Write(TraceEntry{Actor: "muse", Verb: "GET /v1/conversations"})
	if err := tr.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !strings.HasSuffix(string(body), "\n") {
		t.Fatal("the file does not end in a newline, so an appended line would join the last one")
	}
	var e TraceEntry
	if err := json.Unmarshal(bytes.TrimSpace(body), &e); err != nil {
		t.Fatalf("the file is not JSONL: %v", err)
	}
	// 0640: a trace carries every prompt a caller sent, so it is not
	// world-readable on a shared box.
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm&0o007 != 0 {
		t.Fatalf("mode %04o is world-readable", perm)
	}
}
