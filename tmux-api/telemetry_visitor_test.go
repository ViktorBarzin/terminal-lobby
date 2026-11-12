package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	standard "github.com/ViktorBarzin/telemetry/go"

	"terminal-lobby/telemetry"
)

// visitorSink records the browser each forwarded Product event was sent with.
type visitorSink struct {
	mu   sync.Mutex
	seen []standard.Request
}

func (s *visitorSink) Track(ctx context.Context, _ string, _ map[string]any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.seen = append(s.seen, standard.CurrentRequest(ctx))
	return nil
}

func (s *visitorSink) Identify(context.Context, string, map[string]any) error { return nil }
func (s *visitorSink) Close() error                                           { return nil }

// postBatch sends one usage batch through the intake the way the service
// serves it, behind RequestContext, and returns the browsers the forwarded
// events carried.
func postBatch(t *testing.T, body string, header map[string]string) []standard.Request {
	t.Helper()
	me, _ := twoLocalUsers(t)
	withUserMap(t, "wiz="+me)
	withTelemetry(t)
	at := time.Unix(1785700000, 0)
	withTelemetryClock(t, &at)
	sink := &visitorSink{}
	p := telemetry.NewProduct(sink)
	events.SetProduct(p)

	r := telemetryReq(t, body, "wiz")
	for k, v := range header {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	telemetry.RequestContext(http.HandlerFunc(handleTelemetry)).ServeHTTP(w, r)
	if w.Code != http.StatusNoContent {
		t.Fatalf("POST /telemetry: got %d (body %q)", w.Code, w.Body)
	}
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	return sink.seen
}

// The page's usage events become Product events with the browser that sent
// them: its Rybbit visitor id, IP and User-Agent.
func TestTheIntakeForwardsTheBrowserWithEachEvent(t *testing.T) {
	seen := postBatch(t, `{"client":"lobby-v2","events":[{"name":"palette.opened","attrs":{}}]}`, map[string]string{
		standard.VisitorHeader: "rv-header",
		"X-Real-Ip":            "203.0.113.7",
		"User-Agent":           "Mozilla/5.0 (X11; Linux x86_64)",
	})
	want := standard.Request{VisitorID: "rv-header", ClientIP: "203.0.113.7", UserAgent: "Mozilla/5.0 (X11; Linux x86_64)"}
	if len(seen) != 1 || seen[0] != want {
		t.Fatalf("forwarded with %+v, want %+v", seen, want)
	}
}

// The batch the page sends by sendBeacon as it hides cannot carry a header,
// so it names its visitor in the body.
func TestABeaconBatchNamesItsVisitorInTheBody(t *testing.T) {
	seen := postBatch(t, `{"client":"lobby-v2","visitor":"rv-beacon","events":[{"name":"palette.opened","attrs":{}}]}`, nil)
	if len(seen) != 1 || seen[0].VisitorID != "rv-beacon" {
		t.Fatalf("forwarded with %+v, want the body's visitor id", seen)
	}
}
