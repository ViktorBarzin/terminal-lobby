package telemetry

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestMetricsCountsRequestsByEndpointAndOutcome(t *testing.T) {
	m := NewMetrics()
	m.Record("/sessions", 200, 12)
	m.Record("/sessions", 200, 30)
	m.Record("/sessions", 500, 5)
	m.Record("/whoami", 404, 2)

	got := render(t, m)
	want := []string{
		`tl_http_requests_total{endpoint="/sessions",outcome="ok"} 2`,
		`tl_http_requests_total{endpoint="/sessions",outcome="server_error"} 1`,
		`tl_http_requests_total{endpoint="/whoami",outcome="client_error"} 1`,
	}
	for _, w := range want {
		if !strings.Contains(got, w) {
			t.Errorf("missing %q in:\n%s", w, got)
		}
	}
}

func TestMetricsRendersACumulativeLatencyHistogram(t *testing.T) {
	m := NewMetrics()
	// 5ms lands in every bucket from 10 up; 900ms only in +Inf and 1000.
	m.Record("/sessions", 200, 5)
	m.Record("/sessions", 200, 900)

	got := render(t, m)
	for _, w := range []string{
		`tl_http_request_duration_ms_bucket{endpoint="/sessions",le="10"} 1`,
		`tl_http_request_duration_ms_bucket{endpoint="/sessions",le="1000"} 2`,
		`tl_http_request_duration_ms_bucket{endpoint="/sessions",le="+Inf"} 2`,
		`tl_http_request_duration_ms_count{endpoint="/sessions"} 2`,
		`tl_http_request_duration_ms_sum{endpoint="/sessions"} 905`,
	} {
		if !strings.Contains(got, w) {
			t.Errorf("missing %q in:\n%s", w, got)
		}
	}
}

// The reason this exists at all: the Loki side keeps everything out of labels
// because of a global stream cap, and a metric labelled by a user-supplied
// session name is the same mistake in Prometheus. Record must never widen
// cardinality beyond what EndpointGroup already collapsed.
func TestMetricsUsesTheGroupedEndpointNotTheRawPath(t *testing.T) {
	m := NewMetrics()
	for _, p := range []string{"/sessions/alpha", "/sessions/beta", "/sessions/gamma"} {
		m.Record(EndpointGroup(p), 200, 1)
	}
	got := render(t, m)
	if strings.Contains(got, "alpha") || strings.Contains(got, "beta") {
		t.Fatalf("raw session names leaked into metrics:\n%s", got)
	}
	if n := strings.Count(got, "tl_http_requests_total{"); n != 1 {
		t.Fatalf("want 1 request series, got %d:\n%s", n, got)
	}
}

func TestMetricsEscapesLabelValues(t *testing.T) {
	m := NewMetrics()
	m.Record(`/we"ird`+"\n", 200, 1)
	got := render(t, m)
	if strings.Contains(got, "\"weird\"\n\"") {
		t.Fatalf("unescaped label value:\n%s", got)
	}
	if !strings.Contains(got, `\"`) && !strings.Contains(got, `\n`) {
		t.Fatalf("expected escaping in:\n%s", got)
	}
}

func TestMetricsGaugesAreSettable(t *testing.T) {
	m := NewMetrics()
	m.SetGauge("tl_sessions", map[string]string{"user": "emo"}, 16)
	m.SetGauge("tl_sessions", map[string]string{"user": "wizard"}, 33)
	m.SetGauge("tl_sessions", map[string]string{"user": "emo"}, 17) // replaces
	got := render(t, m)
	if !strings.Contains(got, `tl_sessions{user="emo"} 17`) {
		t.Errorf("gauge not replaced:\n%s", got)
	}
	if !strings.Contains(got, `tl_sessions{user="wizard"} 33`) {
		t.Errorf("second gauge missing:\n%s", got)
	}
	if strings.Contains(got, `tl_sessions{user="emo"} 16`) {
		t.Errorf("stale gauge value still present:\n%s", got)
	}
}

func TestMetricsIsConcurrencySafe(t *testing.T) {
	m := NewMetrics()
	var wg sync.WaitGroup
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); m.Record("/sessions", 200, 3); m.SetGauge("g", nil, 1) }()
	}
	wg.Wait()
	if !strings.Contains(render(t, m), `tl_http_requests_total{endpoint="/sessions",outcome="ok"} 40`) {
		t.Fatal("lost updates under concurrency")
	}
}

// A nil Metrics must be inert. This sits on the request path of the whole
// service and must never be the reason a request fails.
func TestNilMetricsIsSafe(t *testing.T) {
	var m *Metrics
	m.Record("/x", 200, 1)
	m.SetGauge("g", nil, 1)
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("nil Metrics handler returned %d", rec.Code)
	}
}

func render(t *testing.T, m *Metrics) string {
	t.Helper()
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Fatalf("content-type %q is not the Prometheus text format", ct)
	}
	return rec.Body.String()
}

// The middleware already sits in front of every request and already groups
// endpoints. Feeding Metrics from the same place is what keeps the two views
// consistent, and keeps the cardinality guarantee in one function.
func TestTimingFeedsMetrics(t *testing.T) {
	m := NewMetrics()
	tm := NewTiming(nil, TimingOpts{})
	tm.Metrics = m

	h := tm.Wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/sessions/some-user-named-thing", nil))

	got := render(t, m)
	if !strings.Contains(got, `outcome="server_error"`) {
		t.Errorf("request not counted:\n%s", got)
	}
	if strings.Contains(got, "some-user-named-thing") {
		t.Errorf("raw path leaked past EndpointGroup:\n%s", got)
	}
}

// NewTiming(nil, ...) makes the event side a no-op. Metrics must still work,
// because the two sinks are independent and a service may want only one.
func TestMetricsWorkWithoutAnEventEmitter(t *testing.T) {
	m := NewMetrics()
	tm := NewTiming(nil, TimingOpts{})
	tm.Metrics = m
	tm.Wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})).
		ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/whoami", nil))
	if !strings.Contains(render(t, m), `tl_http_requests_total{endpoint="/whoami",outcome="ok"} 1`) {
		t.Fatal("metrics did not record while the emitter was nil")
	}
}
