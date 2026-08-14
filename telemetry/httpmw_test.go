package telemetry

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func timingHarness(t *testing.T, at *time.Time, opts TimingOpts) (*Timing, *capture) {
	t.Helper()
	rec := &capture{}
	opts.Now = func() time.Time { return *at }
	tm := NewTiming(NewDiag("tmux-api", "test", rec), opts)
	return tm, rec
}

func diagAttrs(t *testing.T, line string) map[string]any {
	t.Helper()
	var got map[string]any
	if err := json.Unmarshal([]byte(strings.TrimPrefix(line, DiagMarker+" ")), &got); err != nil {
		t.Fatalf("not JSON: %q", line)
	}
	attrs, _ := got["attrs"].(map[string]any)
	if attrs == nil {
		attrs = map[string]any{}
	}
	attrs["__name"] = got["event.name"]
	return attrs
}

func serve(tm *Timing, h http.Handler, method, path, reqID string) {
	r := httptest.NewRequest(method, path, nil)
	if reqID != "" {
		r.Header.Set(RequestIDHeader, reqID)
	}
	tm.Wrap(h).ServeHTTP(httptest.NewRecorder(), r)
}

var okHandler = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) })

// The point of the server half: a client that saw 812 ms can be told how much
// of it was the devvm. The request id is what joins the two records.
func TestTimingRecordsASlowRequestWithItsRequestID(t *testing.T) {
	now := time.Now()
	tm, rec := timingHarness(t, &now, TimingOpts{SlowMs: 100})

	slow := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		now = now.Add(200 * time.Millisecond)
		w.WriteHeader(200)
	})
	serve(tm, slow, "GET", "/layout", "f3a91c02-17")

	if len(rec.lines) != 1 {
		t.Fatalf("want 1 record, got %d: %q", len(rec.lines), rec.lines)
	}
	a := diagAttrs(t, rec.lines[0])
	if a["__name"] != "api.served" {
		t.Errorf("event.name = %v", a["__name"])
	}
	if a["tl.ep"] != "/layout" {
		t.Errorf("tl.ep = %v", a["tl.ep"])
	}
	if a["tl.ms"] != float64(200) {
		t.Errorf("tl.ms = %v", a["tl.ms"])
	}
	if a["tl.req"] != "f3a91c02-17" {
		t.Errorf("tl.req = %v", a["tl.req"])
	}
	if a["tl.status"] != float64(200) {
		t.Errorf("tl.status = %v", a["tl.status"])
	}
}

// A fast request contributes to the distribution and nothing else. Emitting
// one record per request would be the volume this design exists to avoid.
func TestTimingDoesNotRecordFastRequestsIndividually(t *testing.T) {
	now := time.Now()
	tm, rec := timingHarness(t, &now, TimingOpts{SlowMs: 100})

	serve(tm, okHandler, "GET", "/layout", "")
	if len(rec.lines) != 0 {
		t.Fatalf("a fast request emitted a record: %q", rec.lines)
	}
}

func TestTimingRollsUpPerEndpointAtWindowClose(t *testing.T) {
	now := time.Now()
	tm, rec := timingHarness(t, &now, TimingOpts{SlowMs: 10_000, WindowMs: 60_000})

	for _, ms := range []int{10, 20, 30} {
		d := time.Duration(ms) * time.Millisecond
		serve(tm, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			now = now.Add(d)
			w.WriteHeader(200)
		}), "GET", "/layout", "")
	}
	serve(tm, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(500)
	}), "GET", "/layout", "")

	now = now.Add(61 * time.Second)
	tm.Tick()

	if len(rec.lines) != 1 {
		t.Fatalf("want 1 rollup, got %d: %q", len(rec.lines), rec.lines)
	}
	a := diagAttrs(t, rec.lines[0])
	if a["__name"] != "api.rollup" {
		t.Fatalf("event.name = %v", a["__name"])
	}
	if a["tl.ep"] != "/layout" {
		t.Errorf("tl.ep = %v", a["tl.ep"])
	}
	if a["tl.n"] != float64(4) {
		t.Errorf("tl.n = %v, want 4", a["tl.n"])
	}
	if a["tl.err"] != float64(1) {
		t.Errorf("tl.err = %v, want 1", a["tl.err"])
	}
	if a["tl.max"] != float64(30) {
		t.Errorf("tl.max = %v, want 30", a["tl.max"])
	}
}

// Endpoint groups keep the vocabulary small: a session name in the path would
// otherwise mint a distinct series per session.
func TestTimingGroupsDynamicPathSegments(t *testing.T) {
	cases := map[string]string{
		"/layout":                 "/layout",
		"/sessions":               "/sessions",
		"/sessions/worktree":      "/sessions/*",
		"/projects/abc123/member": "/projects/*",
		"/":                       "/",
	}
	for in, want := range cases {
		if got := EndpointGroup(in); got != want {
			t.Errorf("EndpointGroup(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestTimingEmitsNothingForAQuietWindow(t *testing.T) {
	now := time.Now()
	tm, rec := timingHarness(t, &now, TimingOpts{WindowMs: 60_000})
	now = now.Add(61 * time.Second)
	tm.Tick()

	if len(rec.lines) != 0 {
		t.Errorf("a window with no requests emitted: %q", rec.lines)
	}
}

// The middleware sits in front of every request in the service. It must not be
// the reason one fails.
func TestTimingIsSafeWithoutAnEmitter(t *testing.T) {
	tm := NewTiming(nil, TimingOpts{})
	w := httptest.NewRecorder()
	tm.Wrap(okHandler).ServeHTTP(w, httptest.NewRequest("GET", "/layout", nil))
	if w.Code != 200 {
		t.Errorf("request did not survive a nil emitter: %d", w.Code)
	}
	tm.Tick() // must not panic
}

func TestTimingPassesResponsesThroughUntouched(t *testing.T) {
	now := time.Now()
	tm, _ := timingHarness(t, &now, TimingOpts{})
	body := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Thing", "kept")
		w.WriteHeader(201)
		w.Write([]byte("hello"))
	})
	w := httptest.NewRecorder()
	tm.Wrap(body).ServeHTTP(w, httptest.NewRequest("GET", "/layout", nil))

	if w.Code != 201 || w.Body.String() != "hello" || w.Header().Get("X-Thing") != "kept" {
		t.Errorf("response was altered: %d %q %q", w.Code, w.Body.String(), w.Header().Get("X-Thing"))
	}
}

// Handlers run concurrently. Run with -race.
func TestTimingIsConcurrencySafe(t *testing.T) {
	now := time.Now()
	tm, _ := timingHarness(t, &now, TimingOpts{WindowMs: 1})

	var wg sync.WaitGroup
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			serve(tm, okHandler, "GET", "/layout", "")
			tm.Tick()
		}()
	}
	wg.Wait()
}
