package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"terminal-lobby/telemetry"
)

// recorder captures emitted event lines for assertions.
type recorder struct{ lines []string }

func (r *recorder) Write(line string) { r.lines = append(r.lines, line) }

// withTelemetry swaps the package emitter for a capturing one.
func withTelemetry(t *testing.T) *recorder {
	t.Helper()
	rec := &recorder{}
	old := events
	events = telemetry.New("tmux-api", "test", rec)
	t.Cleanup(func() { events = old })
	return rec
}

// withTelemetryClock pins the rate limiter's clock so the bucket is testable.
func withTelemetryClock(t *testing.T, at *time.Time) {
	t.Helper()
	oldNow, oldBuckets := telemetryNow, intakeBuckets
	telemetryNow = func() time.Time { return *at }
	intakeBuckets = map[string]*intakeBucket{}
	t.Cleanup(func() { telemetryNow, intakeBuckets = oldNow, oldBuckets })
}

func telemetryReq(t *testing.T, body, authUser string) *http.Request {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/telemetry", strings.NewReader(body))
	if authUser != "" {
		r.Header.Set(authHeader, authUser)
	}
	return r
}

func decodeEvent(t *testing.T, line string) map[string]any {
	t.Helper()
	var got map[string]any
	payload := strings.TrimPrefix(line, telemetry.Marker+" ")
	if err := json.Unmarshal([]byte(payload), &got); err != nil {
		t.Fatalf("emitted line is not JSON (%v): %q", err, line)
	}
	return got
}

func TestHandleTelemetryAcceptsABatch(t *testing.T) {
	me, _ := twoLocalUsers(t)
	withUserMap(t, "wiz="+me)
	rec := withTelemetry(t)
	at := time.Unix(1785700000, 0)
	withTelemetryClock(t, &at)

	body := `{"client":"lobby-v2","build":"abc123","events":[
		{"name":"session.selected","attrs":{"tl.session":"worktree"}},
		{"name":"palette.action","attrs":{"tl.key":"session.kill"}}]}`
	w := httptest.NewRecorder()
	handleTelemetry(w, telemetryReq(t, body, "wiz"))

	if w.Code != http.StatusNoContent {
		t.Fatalf("POST /telemetry: got %d, want 204 (body %q)", w.Code, w.Body)
	}
	if len(rec.lines) != 2 {
		t.Fatalf("want 2 emitted events, got %d: %q", len(rec.lines), rec.lines)
	}
	first := decodeEvent(t, rec.lines[0])
	if first["event.name"] != "session.selected" {
		t.Errorf("event.name = %v", first["event.name"])
	}
	if first["user.id"] != me {
		t.Errorf("user.id = %v, want the auth-resolved %q", first["user.id"], me)
	}
	attrs, _ := first["attrs"].(map[string]any)
	if attrs["tl.session"] != "worktree" {
		t.Errorf("tl.session = %v", attrs["tl.session"])
	}
	if attrs["tl.client"] != "lobby-v2" || attrs["tl.build"] != "abc123" {
		t.Errorf("batch resource fields not stamped onto the event: %v", attrs)
	}
}

// The browser must not be able to attribute events to somebody else, nor to
// forge the service name: both come from the server side only.
func TestHandleTelemetryIgnoresClientSuppliedIdentity(t *testing.T) {
	me, other := twoLocalUsers(t)
	withUserMap(t, "wiz="+me)
	rec := withTelemetry(t)
	at := time.Unix(1785700000, 0)
	withTelemetryClock(t, &at)

	body := fmt.Sprintf(`{"client":"lobby-v2","events":[{"name":"session.killed",
		"user.id":%q,"service.name":"forged","attrs":{"user.id":%q}}]}`, other, other)
	w := httptest.NewRecorder()
	handleTelemetry(w, telemetryReq(t, body, "wiz"))

	if len(rec.lines) != 1 {
		t.Fatalf("want 1 event, got %d", len(rec.lines))
	}
	got := decodeEvent(t, rec.lines[0])
	if got["user.id"] != me {
		t.Fatalf("client spoofed user.id: %v", got["user.id"])
	}
	if got["service.name"] != "tmux-api" {
		t.Fatalf("client spoofed service.name: %v", got["service.name"])
	}
}

// An unknown name (client bug, or a tab probing the endpoint) is dropped
// without taking the rest of the batch down.
func TestHandleTelemetryDropsUnknownEventsButKeepsTheRest(t *testing.T) {
	me, _ := twoLocalUsers(t)
	withUserMap(t, "wiz="+me)
	rec := withTelemetry(t)
	at := time.Unix(1785700000, 0)
	withTelemetryClock(t, &at)

	body := `{"client":"lobby-v2","events":[
		{"name":"not.a.real.event"},
		{"name":"session.created","attrs":{"tl.session":"ok"}}]}`
	w := httptest.NewRecorder()
	handleTelemetry(w, telemetryReq(t, body, "wiz"))

	if w.Code != http.StatusNoContent {
		t.Fatalf("got %d, want 204", w.Code)
	}
	names := []string{}
	for _, l := range rec.lines {
		names = append(names, decodeEvent(t, l)["event.name"].(string))
	}
	// the good event, plus one api.rejected recording the drop
	if !contains(names, "session.created") {
		t.Fatalf("good event lost: %v", names)
	}
	if contains(names, "not.a.real.event") {
		t.Fatalf("unknown event was emitted: %v", names)
	}
	if !contains(names, "api.rejected") {
		t.Fatalf("drop not recorded: %v", names)
	}
}

// Attributes are a flat tl.* namespace: foreign keys and nested structures are
// dropped so a client cannot reshape the record.
func TestHandleTelemetrySanitizesAttrs(t *testing.T) {
	me, _ := twoLocalUsers(t)
	withUserMap(t, "wiz="+me)
	rec := withTelemetry(t)
	at := time.Unix(1785700000, 0)
	withTelemetryClock(t, &at)

	body := `{"client":"lobby-v2","events":[{"name":"file.previewed","attrs":{
		"tl.kind":"md","evil":"drop me","tl.nested":{"a":1},"tl.list":[1,2],"tl.count":7}}]}`
	w := httptest.NewRecorder()
	handleTelemetry(w, telemetryReq(t, body, "wiz"))

	attrs, _ := decodeEvent(t, rec.lines[0])["attrs"].(map[string]any)
	if attrs["tl.kind"] != "md" || attrs["tl.count"] != float64(7) {
		t.Errorf("scalar tl.* attrs should survive: %v", attrs)
	}
	for _, gone := range []string{"evil", "tl.nested", "tl.list"} {
		if _, present := attrs[gone]; present {
			t.Errorf("%s should have been dropped: %v", gone, attrs)
		}
	}
}

func TestHandleTelemetryCapsBatchSize(t *testing.T) {
	me, _ := twoLocalUsers(t)
	withUserMap(t, "wiz="+me)
	rec := withTelemetry(t)
	at := time.Unix(1785700000, 0)
	withTelemetryClock(t, &at)

	var sb strings.Builder
	sb.WriteString(`{"client":"lobby-v2","events":[`)
	for i := 0; i < maxBatchEvents+10; i++ {
		if i > 0 {
			sb.WriteString(",")
		}
		sb.WriteString(`{"name":"shortcut.used","attrs":{"tl.key":"g"}}`)
	}
	sb.WriteString(`]}`)

	w := httptest.NewRecorder()
	handleTelemetry(w, telemetryReq(t, sb.String(), "wiz"))

	kept := 0
	for _, l := range rec.lines {
		if decodeEvent(t, l)["event.name"] == "shortcut.used" {
			kept++
		}
	}
	if kept != maxBatchEvents {
		t.Fatalf("kept %d events, want the cap %d", kept, maxBatchEvents)
	}
}

// Volume protection: Loki is a shared 30-day store, so a runaway tab gets
// throttled — and recovers once its bucket refills.
func TestHandleTelemetryRateLimitsPerUserAndRecovers(t *testing.T) {
	me, _ := twoLocalUsers(t)
	withUserMap(t, "wiz="+me)
	withTelemetry(t)
	at := time.Unix(1785700000, 0)
	withTelemetryClock(t, &at)

	body := `{"client":"lobby-v2","events":[{"name":"shortcut.used","attrs":{"tl.key":"j"}}]}`
	sent := 0
	for {
		w := httptest.NewRecorder()
		handleTelemetry(w, telemetryReq(t, body, "wiz"))
		if w.Code == http.StatusTooManyRequests {
			break
		}
		sent++
		if sent > intakeRatePerMinute*3 {
			t.Fatalf("never rate limited after %d requests", sent)
		}
	}
	if sent < 1 {
		t.Fatal("rate limited before accepting anything")
	}

	at = at.Add(2 * time.Minute) // bucket refills
	w := httptest.NewRecorder()
	handleTelemetry(w, telemetryReq(t, body, "wiz"))
	if w.Code != http.StatusNoContent {
		t.Fatalf("after the window: got %d, want 204", w.Code)
	}
}

func TestHandleTelemetryRejectsOversizedBody(t *testing.T) {
	me, _ := twoLocalUsers(t)
	withUserMap(t, "wiz="+me)
	withTelemetry(t)
	at := time.Unix(1785700000, 0)
	withTelemetryClock(t, &at)

	huge := `{"client":"lobby-v2","events":[{"name":"app.error","attrs":{"tl.kind":"` +
		strings.Repeat("x", maxTelemetryBody+1024) + `"}}]}`
	w := httptest.NewRecorder()
	handleTelemetry(w, telemetryReq(t, huge, "wiz"))
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("got %d, want 413", w.Code)
	}
}

func TestHandleTelemetryRejectsOtherMethodsAndAnonymous(t *testing.T) {
	me, _ := twoLocalUsers(t)
	withUserMap(t, "wiz="+me)
	withTelemetry(t)
	at := time.Unix(1785700000, 0)
	withTelemetryClock(t, &at)

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/telemetry", nil)
	r.Header.Set(authHeader, "wiz")
	handleTelemetry(w, r)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET: got %d, want 405", w.Code)
	}

	w = httptest.NewRecorder()
	handleTelemetry(w, telemetryReq(t, `{"client":"lobby-v2","events":[]}`, ""))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous: got %d, want 401", w.Code)
	}
}

func contains(hay []string, needle string) bool {
	for _, s := range hay {
		if s == needle {
			return true
		}
	}
	return false
}
