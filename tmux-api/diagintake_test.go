package main

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"terminal-lobby/telemetry"
)

// withDiag swaps the package diagnostics emitter for a capturing one.
func withDiag(t *testing.T) *recorder {
	t.Helper()
	rec := &recorder{}
	old := diagEvents
	diagEvents = telemetry.NewDiag("tmux-api", "test", rec)
	t.Cleanup(func() { diagEvents = old })
	return rec
}

func withDiagClock(t *testing.T, at *time.Time) {
	t.Helper()
	oldNow, oldBuckets := telemetryNow, diagBuckets
	telemetryNow = func() time.Time { return *at }
	diagBuckets = map[string]*intakeBucket{}
	t.Cleanup(func() { telemetryNow, diagBuckets = oldNow, oldBuckets })
}

func decodeDiagLine(t *testing.T, line string) map[string]any {
	t.Helper()
	if !strings.HasPrefix(line, telemetry.DiagMarker+" ") {
		t.Fatalf("line missing %q marker: %q", telemetry.DiagMarker, line)
	}
	var got map[string]any
	payload := strings.TrimPrefix(line, telemetry.DiagMarker+" ")
	if err := json.Unmarshal([]byte(payload), &got); err != nil {
		t.Fatalf("emitted line is not JSON (%v): %q", err, line)
	}
	return got
}

// One intake, two channels. The batch says which it is; everything else —
// auth, identity, bounding — is the path that was already there.
func TestDiagBatchGoesToTheDiagChannel(t *testing.T) {
	me, _ := twoLocalUsers(t)
	withUserMap(t, "wiz="+me)
	usage, diag := withTelemetry(t), withDiag(t)
	now := time.Now()
	withTelemetryClock(t, &now)
	withDiagClock(t, &now)

	body := `{"kind":"diag","client":"lobby-v2","build":"abc1234","events":[
		{"name":"perf.rollup","attrs":{"tl.win_s":60,"tl.echo.p95":61,"tl.tab":"f3a91c02"}}]}`
	w := httptest.NewRecorder()
	handleTelemetry(w, telemetryReq(t, body, "wiz"))

	if w.Code != 204 {
		t.Fatalf("want 204, got %d: %s", w.Code, w.Body.String())
	}
	if len(usage.lines) != 0 {
		t.Errorf("diag batch leaked onto the usage channel: %q", usage.lines)
	}
	if len(diag.lines) != 1 {
		t.Fatalf("want 1 diag line, got %d: %q", len(diag.lines), diag.lines)
	}
	got := decodeDiagLine(t, diag.lines[0])
	if got["event.name"] != "perf.rollup" {
		t.Errorf("event.name = %v", got["event.name"])
	}
	// Identity is the server's, never the client's.
	if got["user.id"] != me {
		t.Errorf("user.id = %v, want %v", got["user.id"], me)
	}
	attrs, _ := got["attrs"].(map[string]any)
	if attrs["tl.client"] != "lobby-v2" || attrs["tl.build"] != "abc1234" {
		t.Errorf("surface attribution missing: %v", attrs)
	}
	if attrs["tl.tab"] != "f3a91c02" {
		t.Errorf("correlation id dropped: %v", attrs)
	}
}

// A batch with no kind is a usage batch. Existing clients keep working
// unchanged, which is what lets this ship without a lockstep frontend deploy.
func TestBatchWithoutKindStaysUsage(t *testing.T) {
	me, _ := twoLocalUsers(t)
	withUserMap(t, "wiz="+me)
	usage, diag := withTelemetry(t), withDiag(t)
	now := time.Now()
	withTelemetryClock(t, &now)
	withDiagClock(t, &now)

	body := `{"client":"lobby-vanilla","events":[{"name":"session.selected","attrs":{}}]}`
	w := httptest.NewRecorder()
	handleTelemetry(w, telemetryReq(t, body, "wiz"))

	if w.Code != 204 {
		t.Fatalf("want 204, got %d", w.Code)
	}
	if len(usage.lines) != 1 {
		t.Errorf("want 1 usage line, got %d", len(usage.lines))
	}
	if len(diag.lines) != 0 {
		t.Errorf("usage batch leaked onto the diag channel: %q", diag.lines)
	}
}

// The catalogs are closed on both channels, and a client cannot cross them.
func TestDiagIntakeRejectsUsageNames(t *testing.T) {
	me, _ := twoLocalUsers(t)
	withUserMap(t, "wiz="+me)
	withTelemetry(t)
	diag := withDiag(t)
	now := time.Now()
	withTelemetryClock(t, &now)
	withDiagClock(t, &now)

	body := `{"kind":"diag","client":"term","events":[
		{"name":"session.created","attrs":{}},
		{"name":"totally.made.up","attrs":{}},
		{"name":"conn.dropped","attrs":{"tl.code":1006}}]}`
	w := httptest.NewRecorder()
	handleTelemetry(w, telemetryReq(t, body, "wiz"))

	if w.Code != 204 {
		t.Fatalf("want 204, got %d", w.Code)
	}
	var kept []string
	for _, l := range diag.lines {
		kept = append(kept, decodeDiagLine(t, l)["event.name"].(string))
	}
	// conn.dropped survives; the rejection notice rides the diag channel too.
	if len(kept) != 2 || kept[0] != "conn.dropped" || kept[1] != "api.rejected" {
		t.Fatalf("want [conn.dropped api.rejected], got %v", kept)
	}
}

// The flight recorder is the one array the contract allows, and only on a
// per-incident record. On a rollup it is dropped, so a client cannot attach a
// 4 KiB payload to a once-a-minute record.
func TestDiagIntakeAllowsTraceOnIncidentsOnly(t *testing.T) {
	me, _ := twoLocalUsers(t)
	withUserMap(t, "wiz="+me)
	withTelemetry(t)
	diag := withDiag(t)
	now := time.Now()
	withTelemetryClock(t, &now)
	withDiagClock(t, &now)

	trace := `[{"t":0,"e":"key","k":"Enter"},{"t":12,"e":"ws.send","n":1}]`
	body := fmt.Sprintf(`{"kind":"diag","client":"term","events":[
		{"name":"diag.incident","attrs":{"tl.kind":"stall","tl.trace":%s}},
		{"name":"perf.rollup","attrs":{"tl.win_s":60,"tl.trace":%s}}]}`, trace, trace)
	w := httptest.NewRecorder()
	handleTelemetry(w, telemetryReq(t, body, "wiz"))

	if len(diag.lines) < 2 {
		t.Fatalf("want both records, got %d: %q", len(diag.lines), diag.lines)
	}
	incident, _ := decodeDiagLine(t, diag.lines[0])["attrs"].(map[string]any)
	if incident["tl.trace"] == nil {
		t.Error("trace dropped from an incident record")
	}
	if entries, ok := incident["tl.trace"].([]any); !ok || len(entries) != 2 {
		t.Errorf("trace should survive intact on an incident: %v", incident["tl.trace"])
	}
	rollup, _ := decodeDiagLine(t, diag.lines[1])["attrs"].(map[string]any)
	if rollup["tl.trace"] != nil {
		t.Errorf("trace should be dropped from a rollup: %v", rollup["tl.trace"])
	}
}

// A stack needs more room than any usage attribute gets, but not unbounded.
func TestDiagIntakeKeepsStacksWithinTheirOwnBound(t *testing.T) {
	me, _ := twoLocalUsers(t)
	withUserMap(t, "wiz="+me)
	withTelemetry(t)
	diag := withDiag(t)
	now := time.Now()
	withTelemetryClock(t, &now)
	withDiagClock(t, &now)

	long := strings.Repeat("f", telemetry.MaxStackLen*2)
	body := fmt.Sprintf(`{"kind":"diag","client":"term","events":[
		{"name":"app.exception","attrs":{"tl.stack":%q,"tl.msg":%q}}]}`, long, long)
	w := httptest.NewRecorder()
	handleTelemetry(w, telemetryReq(t, body, "wiz"))

	attrs, _ := decodeDiagLine(t, diag.lines[0])["attrs"].(map[string]any)
	if s, _ := attrs["tl.stack"].(string); len(s) != telemetry.MaxStackLen {
		t.Errorf("tl.stack = %d bytes, want %d", len(s), telemetry.MaxStackLen)
	}
	if m, _ := attrs["tl.msg"].(string); len(m) != telemetry.MaxValueLen {
		t.Errorf("tl.msg = %d bytes, want %d", len(m), telemetry.MaxValueLen)
	}
}

// Diagnostics have their own budget so a burst of health records cannot starve
// usage events, or the reverse.
func TestDiagRateCapIsSeparateFromUsage(t *testing.T) {
	me, _ := twoLocalUsers(t)
	withUserMap(t, "wiz="+me)
	usage, diag := withTelemetry(t), withDiag(t)
	now := time.Now()
	withTelemetryClock(t, &now)
	withDiagClock(t, &now)

	// Spend the entire diagnostics budget.
	one := `{"name":"perf.rollup","attrs":{}}`
	full := fmt.Sprintf(`{"kind":"diag","events":[%s]}`, strings.TrimSuffix(strings.Repeat(one+",", diagRatePerMinute), ","))
	w := httptest.NewRecorder()
	handleTelemetry(w, telemetryReq(t, full, "wiz"))
	if w.Code != 204 {
		t.Fatalf("filling the budget should succeed, got %d", w.Code)
	}

	// The next diagnostics event is refused...
	w = httptest.NewRecorder()
	handleTelemetry(w, telemetryReq(t, `{"kind":"diag","events":[`+one+`]}`, "wiz"))
	if w.Code != 429 {
		t.Errorf("want 429 once the diag budget is spent, got %d", w.Code)
	}

	// ...while usage events are unaffected.
	before := len(usage.lines)
	w = httptest.NewRecorder()
	handleTelemetry(w, telemetryReq(t, `{"events":[{"name":"session.selected","attrs":{}}]}`, "wiz"))
	if w.Code != 204 {
		t.Errorf("usage should be unaffected by the diag budget, got %d", w.Code)
	}
	if len(usage.lines) != before+1 {
		t.Errorf("usage event was not recorded: %d -> %d", before, len(usage.lines))
	}
	_ = diag
}

// Telemetry never decides who someone is. An unauthenticated diag batch is
// refused like any other request.
func TestDiagIntakeRequiresAuth(t *testing.T) {
	twoLocalUsers(t)
	diag := withDiag(t)
	now := time.Now()
	withDiagClock(t, &now)

	w := httptest.NewRecorder()
	handleTelemetry(w, telemetryReq(t, `{"kind":"diag","events":[{"name":"perf.rollup"}]}`, ""))
	if w.Code == 204 {
		t.Error("unauthenticated diag batch was accepted")
	}
	if len(diag.lines) != 0 {
		t.Errorf("unauthenticated batch emitted records: %q", diag.lines)
	}
}
