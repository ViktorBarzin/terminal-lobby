package telemetry

import (
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// Server-side request timing (docs/adr/0008-client-diagnostics.md).
//
// The client can say a call took 812 ms. On its own that is unattributable —
// it could be the link, the device, or the devvm. This records how long the
// handler actually took, and echoes the client's request id so the two records
// join exactly:
//
//	client  api.slow   {tl.ep:"/layout", tl.ms:812, tl.req:"f3a91c02-17"}
//	server  api.served {tl.ep:"/layout", tl.ms:6,   tl.req:"f3a91c02-17"}
//
// Volume is shaped the same way as the browser's: a distribution per endpoint
// group per window, plus an individual record only when a request was slow.
// One record per request would be the volume the whole design avoids.

// RequestIDHeader carries the client's per-call id. The client mints it as
// <tab>-<n>, so a slow call is traceable to the tab that made it.
const RequestIDHeader = "X-TL-Req"

const (
	defaultTimingWindowMs = 60_000
	defaultTimingSlowMs   = 500
	// maxRequestIDLen bounds a client-supplied value before it reaches a log
	// line, like every other attribute here.
	maxRequestIDLen = 64
)

// TimingOpts configures a Timing. The zero value is usable.
type TimingOpts struct {
	// WindowMs is the rollup cadence. Default 60s.
	WindowMs int
	// SlowMs is the threshold above which a request is recorded on its own.
	// Default 500ms.
	SlowMs int
	// Now is a clock seam for tests.
	Now func() time.Time
	// User resolves the OS user for a request. Optional: a service that
	// cannot cheaply resolve one records requests without attribution rather
	// than paying for a second lookup on every call.
	User func(*http.Request) string
}

type epStats struct {
	vals []float64
	n    int
	errs int
	max  float64
}

// Timing is one service's request-timing middleware. Safe for concurrent use.
type Timing struct {
	events *Emitter
	opts   TimingOpts

	mu    sync.Mutex
	stats map[string]*epStats
	since time.Time
}

// NewTiming builds a Timing over a diagnostics emitter. A nil emitter is
// valid and makes every path a no-op — the middleware sits in front of every
// request in the service and must never be the reason one fails.
func NewTiming(events *Emitter, opts TimingOpts) *Timing {
	if opts.WindowMs <= 0 {
		opts.WindowMs = defaultTimingWindowMs
	}
	if opts.SlowMs <= 0 {
		opts.SlowMs = defaultTimingSlowMs
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Timing{
		events: events,
		opts:   opts,
		stats:  map[string]*epStats{},
		since:  opts.Now(),
	}
}

// statusWriter records the status code while leaving the response untouched.
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(b)
}

// Flush forwards to the wrapped writer so a streaming handler keeps working
// through the middleware.
//
// Embedding http.ResponseWriter promotes only the three methods of that
// interface; Flush is not one of them, so wrapping a flushable writer produced
// one that is not. session-events' SSE endpoint asserts w.(http.Flusher) and
// refuses the stream when the assertion fails, so from d7b509e (which put every
// service behind Wrap) until this passthrough, GET /events/{session} answered
// 500 "streaming unsupported" for every session and every user — the text view
// showed nothing at all. Nothing else in the codebase streams, which is why the
// blast radius stopped there.
func (w *statusWriter) Flush() {
	if fl, ok := w.ResponseWriter.(http.Flusher); ok {
		if w.status == 0 {
			w.status = http.StatusOK
		}
		fl.Flush()
	}
}

// Wrap returns next instrumented with request timing.
func (t *Timing) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := t.opts.Now()
		sw := &statusWriter{ResponseWriter: w}
		next.ServeHTTP(sw, r)
		t.record(r, sw.status, float64(t.opts.Now().Sub(start).Milliseconds()))
	})
}

func (t *Timing) record(r *http.Request, status int, ms float64) {
	if t == nil || t.events == nil {
		return
	}
	if status == 0 {
		status = http.StatusOK
	}
	ep := EndpointGroup(r.URL.Path)

	t.mu.Lock()
	s := t.stats[ep]
	if s == nil {
		s = &epStats{}
		t.stats[ep] = s
	}
	s.n++
	if status >= 400 {
		s.errs++
	}
	if ms > s.max {
		s.max = ms
	}
	// Bounded like the browser's sample sets: the count and max are exact
	// whatever happens, the retained values only feed percentiles.
	if len(s.vals) < 512 {
		s.vals = append(s.vals, ms)
	}
	t.mu.Unlock()

	if int(ms) < t.opts.SlowMs {
		return
	}
	attrs := Attrs{"tl.ep": ep, "tl.ms": ms, "tl.status": status}
	if id := r.Header.Get(RequestIDHeader); id != "" {
		if len(id) > maxRequestIDLen {
			id = id[:maxRequestIDLen]
		}
		attrs["tl.req"] = id
	}
	user := ""
	if t.opts.User != nil {
		user = t.opts.User(r)
	}
	t.events.Emit("api.served", user, attrs)
}

// Tick closes the window if it is due and emits one rollup per endpoint group
// that saw traffic. A quiet window emits nothing.
func (t *Timing) Tick() {
	if t == nil || t.events == nil {
		return
	}
	now := t.opts.Now()

	t.mu.Lock()
	if now.Sub(t.since) < time.Duration(t.opts.WindowMs)*time.Millisecond {
		t.mu.Unlock()
		return
	}
	stats := t.stats
	elapsed := now.Sub(t.since)
	t.stats = map[string]*epStats{}
	t.since = now
	t.mu.Unlock()

	for ep, s := range stats {
		if s.n == 0 {
			continue
		}
		sort.Float64s(s.vals)
		attrs := Attrs{
			"tl.ep":    ep,
			"tl.n":     s.n,
			"tl.max":   s.max,
			"tl.win_s": int(elapsed.Seconds()),
		}
		if len(s.vals) > 0 {
			attrs["tl.p50"] = nearestRank(s.vals, 0.5)
			attrs["tl.p95"] = nearestRank(s.vals, 0.95)
		}
		if s.errs > 0 {
			attrs["tl.err"] = s.errs
		}
		t.events.Emit("api.rollup", "", attrs)
	}
}

// Run drives Tick on an interval until stop is closed. Services call this in a
// goroutine at startup.
func (t *Timing) Run(stop <-chan struct{}) {
	if t == nil || t.events == nil {
		return
	}
	tick := time.NewTicker(time.Duration(t.opts.WindowMs) * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-tick.C:
			t.Tick()
		case <-stop:
			return
		}
	}
}

func nearestRank(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	i := int(float64(len(sorted))*p+0.999999) - 1
	if i < 0 {
		i = 0
	}
	if i > len(sorted)-1 {
		i = len(sorted) - 1
	}
	return sorted[i]
}

// EndpointGroup reduces a request path to a bounded label. Paths carry
// user-supplied names — session names, project ids — and keeping them whole
// would mint a distinct series per session. The first segment identifies the
// route; anything below it becomes "*".
func EndpointGroup(path string) string {
	if path == "" {
		return "/"
	}
	trimmed := strings.TrimPrefix(path, "/")
	if trimmed == "" {
		return "/"
	}
	first := trimmed
	rest := ""
	if i := strings.IndexByte(trimmed, '/'); i >= 0 {
		first, rest = trimmed[:i], trimmed[i+1:]
	}
	if len(first) > 40 {
		first = first[:40]
	}
	if rest == "" {
		return "/" + first
	}
	return "/" + first + "/*"
}
