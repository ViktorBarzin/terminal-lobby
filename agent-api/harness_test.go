package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"terminal-lobby/authuser"
)

// The test harness: a real Server with a real authuser.Gate, a real credentials
// file and a fake tmux behind it.
//
// The gate is real on purpose. Auth is the one thing here that must not be
// stubbed — a test that injects an Identity would prove the handlers work and
// prove nothing at all about whether the door is locked, which is the property
// this service most needs held.

const (
	testToken      = "Y5Rvv6kMrQ0sN3tP8xWzL2dJ7hB4gFqA"
	testOtherToken = "Z9CkTmE1bXyU4wV6nR0pS5jH8aL2dG7f"
	testActor      = "muse"
	testOSUser     = "wizard"
)

type harness struct {
	t        *testing.T
	srv      *Server
	handler  http.Handler
	sessions *fakeSessions
	trace    *bytes.Buffer
	homeBase string

	// clockMu guards clock. The runner reads the clock from its own
	// goroutines while a request writes it, which the race detector is right
	// to object to.
	clockMu sync.Mutex
	clock   time.Time
}

// newHarness builds the whole service against a temp home and a temp
// credentials file.
func newHarness(t *testing.T) *harness {
	t.Helper()
	base := t.TempDir()
	for _, u := range []string{testOSUser, "emo"} {
		if err := os.MkdirAll(filepath.Join(base, u, "code", "infra"), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
	}

	// The credentials file, in the format authuser documents: three
	// whitespace-separated fields, mode 0640 so the gate does not refuse it.
	tokens := filepath.Join(t.TempDir(), "tokens")
	body := "# the caller that is under test\n" +
		testActor + "  " + testToken + "  " + testOSUser + "\n" +
		"scratch  " + testOtherToken + "  " + testOSUser + "\n"
	if err := os.WriteFile(tokens, []byte(body), 0o640); err != nil {
		t.Fatalf("write tokens: %v", err)
	}
	// The user map is what makes the credential's OS user a real terminal
	// account; without it the gate answers 403 for every bearer.
	userMap := filepath.Join(t.TempDir(), "user-map")
	if err := os.WriteFile(userMap, []byte("vbarzin="+testOSUser+"\nemil.barzin=emo\n"), 0o644); err != nil {
		t.Fatalf("write user map: %v", err)
	}

	gate := &authuser.Gate{
		MapPath: userMap,
		Config:  authuser.Config{BearerTokensPath: tokens, MultiUser: "on"},
		// The credential names an OS user that exists in the fixture, not on
		// this host, so the account lookup is the thing to skip — not the
		// terminal-account check above it, which is the rule under test.
		SkipAccountCheck: true,
	}

	h := &harness{
		t:        t,
		sessions: newFakeSessions(),
		trace:    &bytes.Buffer{},
		homeBase: base,
		clock:    time.Date(2026, 9, 16, 11, 0, 0, 0, time.UTC),
	}
	h.srv = &Server{
		Gate:      gate,
		Sessions:  h.sessions,
		Tasks:     NewTaskStore(h.now),
		Trace:     NewTraceTo(h.trace),
		IDs:       newIDGen(nil),
		HomeBase:  base,
		ClaudeBin: "/usr/local/bin/claude",
		Now:       h.now,
		// Fast enough that a turn test finishes in milliseconds, slow enough
		// that a poll loop does not spin.
		PollInterval: time.Millisecond,
		StartGrace:   150 * time.Millisecond,
		ReadyTimeout: 100 * time.Millisecond,
		TurnTimeout:  5 * time.Second,
	}
	h.srv.Runner = NewRunner(h.srv.runTurn)
	h.handler = h.srv.Routes()
	return h
}

// now advances a millisecond per call, so updated_at moves without any sleep.
func (h *harness) now() time.Time {
	h.clockMu.Lock()
	defer h.clockMu.Unlock()
	h.clock = h.clock.Add(time.Millisecond)
	return h.clock
}

// request is one call through the real mux, with whatever auth the caller
// specifies.
type request struct {
	method string
	path   string
	body   string
	// token, when set, is sent as a bearer. Empty sends no Authorization
	// header at all, which is the unauthenticated case.
	token string
	// header and secret exercise the OTHER credential path, to prove a bearer
	// route cannot be reached with a browser's credentials.
	header string
	secret string
}

func (h *harness) do(req request) *httptest.ResponseRecorder {
	h.t.Helper()
	var body io.Reader
	if req.body != "" {
		body = strings.NewReader(req.body)
	}
	r := httptest.NewRequest(req.method, req.path, body)
	if req.token != "" {
		r.Header.Set("Authorization", "Bearer "+req.token)
	}
	if req.header != "" {
		r.Header.Set(authuser.DefaultAuthHeader, req.header)
	}
	if req.secret != "" {
		r.Header.Set(authuser.SecretHeader, req.secret)
	}
	w := httptest.NewRecorder()
	h.handler.ServeHTTP(w, r)
	return w
}

// call is the common case: authenticated as the caller under test.
func (h *harness) call(method, path, body string) *httptest.ResponseRecorder {
	h.t.Helper()
	return h.do(request{method: method, path: path, body: body, token: testToken})
}

// decodeJSON reads a response body into v, failing the test on a status
// mismatch or a body that will not parse.
func (h *harness) decodeJSON(w *httptest.ResponseRecorder, wantStatus int, v any) {
	h.t.Helper()
	if w.Code != wantStatus {
		h.t.Fatalf("status %d, want %d: %s", w.Code, wantStatus, w.Body.String())
	}
	if v == nil {
		return
	}
	if err := json.Unmarshal(w.Body.Bytes(), v); err != nil {
		h.t.Fatalf("decoding %q: %v", w.Body.String(), err)
	}
}

// traceLines parses everything written to the trace so far.
func (h *harness) traceLines() []TraceEntry {
	h.t.Helper()
	var out []TraceEntry
	for _, line := range strings.Split(strings.TrimSpace(h.trace.String()), "\n") {
		if line == "" {
			continue
		}
		var e TraceEntry
		if err := json.Unmarshal([]byte(line), &e); err != nil {
			h.t.Fatalf("trace line %q is not JSON: %v", line, err)
		}
		out = append(out, e)
	}
	return out
}

// waitIdleHarness waits for every queued turn to finish.
func (h *harness) waitIdle() {
	h.t.Helper()
	select {
	case <-h.srv.Runner.Idle():
	case <-time.After(10 * time.Second):
		h.t.Fatal("the runner did not go idle")
	}
}

// waitStatus polls a task until it reaches one of the wanted statuses.
func (h *harness) waitStatus(taskID string, want ...TaskStatus) TaskView {
	h.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		v, ok := h.srv.Tasks.Get(taskID)
		if ok {
			for _, s := range want {
				if v.Status == s {
					return v
				}
			}
		}
		time.Sleep(time.Millisecond)
	}
	v, _ := h.srv.Tasks.Get(taskID)
	h.t.Fatalf("task %s stuck at %q, want one of %v (error=%q)", taskID, v.Status, want, v.Error)
	return TaskView{}
}

// transcript lines the tests reuse. Real Claude Code shapes, trimmed to the
// fields sessionio.Record reads.
func userLine(text, at string) string {
	return `{"type":"user","timestamp":"` + at + `","message":{"role":"user","content":` + jsonString(text) + `}}`
}

func assistantLine(text, at string) string {
	return `{"type":"assistant","timestamp":"` + at + `","message":{"role":"assistant","content":[{"type":"text","text":` + jsonString(text) + `}]}}`
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
