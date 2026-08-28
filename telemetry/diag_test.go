package telemetry

import (
	"encoding/json"
	"strings"
	"testing"
)

func decodeDiag(t *testing.T, line string) map[string]any {
	t.Helper()
	if !strings.HasPrefix(line, DiagMarker+" ") {
		t.Fatalf("line missing %q marker: %q", DiagMarker, line)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(strings.TrimPrefix(line, DiagMarker+" ")), &got); err != nil {
		t.Fatalf("payload is not JSON (%v): %q", err, line)
	}
	return got
}

// Diagnostics ride the same pipeline as usage events but carry their own
// marker, so a LogQL line filter can select one without parsing the other
// (docs/adr/0008-client-diagnostics.md).
func TestDiagEmitUsesItsOwnMarker(t *testing.T) {
	c := &capture{}
	e := NewDiag("tmux-api", "v1", c)
	e.Emit("perf.rollup", "wizard", Attrs{"tl.input.p95": 41})

	if len(c.lines) != 1 {
		t.Fatalf("want exactly 1 line, got %d: %q", len(c.lines), c.lines)
	}
	if strings.HasPrefix(c.lines[0], Marker+" ") {
		t.Fatalf("diag record used the usage marker: %q", c.lines[0])
	}
	got := decodeDiag(t, c.lines[0])
	if got["event.name"] != "perf.rollup" {
		t.Errorf("event.name = %v", got["event.name"])
	}
	if got["service.name"] != "tmux-api" || got["user.id"] != "wizard" {
		t.Errorf("resource fields wrong: %v / %v", got["service.name"], got["user.id"])
	}
}

// The two vocabularies stay separate in both directions: a usage name must not
// arrive on the diagnostics channel, and a diagnostics name must not arrive on
// the usage one. Otherwise the marker stops being a reliable selector.
func TestDiagAndUsageCatalogsDoNotBleed(t *testing.T) {
	diagOut, usageOut := &capture{}, &capture{}
	diag := NewDiag("tmux-api", "v1", diagOut)
	usage := New("tmux-api", "v1", usageOut)

	diag.Emit("session.created", "wizard", nil) // usage name on the diag channel
	usage.Emit("perf.rollup", "wizard", nil)    // diag name on the usage channel

	if len(diagOut.lines) != 0 {
		t.Errorf("usage name accepted by diag emitter: %q", diagOut.lines)
	}
	if len(usageOut.lines) != 0 {
		t.Errorf("diag name accepted by usage emitter: %q", usageOut.lines)
	}
	if !IsKnownDiag("app.exception") || IsKnownDiag("session.created") {
		t.Error("IsKnownDiag should cover diag names only")
	}
	if !IsKnown("session.created") || IsKnown("app.exception") {
		t.Error("IsKnown should cover usage names only")
	}
}

// A stack truncated to the 512-byte value cap routinely loses the frames that
// identify the call path, so tl.stack alone is allowed 1024. Every other key
// keeps the usage bound.
func TestDiagAllowsALongerStackOnly(t *testing.T) {
	c := &capture{}
	e := NewDiag("tmux-api", "v1", c)
	e.Emit("app.exception", "wizard", Attrs{
		"tl.stack": strings.Repeat("f", MaxStackLen*2),
		"tl.msg":   strings.Repeat("m", MaxValueLen*2),
	})

	attrs, _ := decodeDiag(t, c.lines[0])["attrs"].(map[string]any)
	stack, _ := attrs["tl.stack"].(string)
	if len(stack) != MaxStackLen {
		t.Errorf("tl.stack should truncate to %d, got %d", MaxStackLen, len(stack))
	}
	msg, _ := attrs["tl.msg"].(string)
	if len(msg) != MaxValueLen {
		t.Errorf("tl.msg should keep the %d cap, got %d", MaxValueLen, len(msg))
	}
	if MaxStackLen <= MaxValueLen {
		t.Fatal("the stack allowance must actually be larger than the default")
	}
}

// tl.trace is the flight recorder: the raw events preceding an incident. It is
// the one array the attribute contract permits, and only bounded.
func TestBoundTraceCapsEntries(t *testing.T) {
	in := make([]any, 0, MaxTraceEntries*2)
	for i := 0; i < MaxTraceEntries*2; i++ {
		in = append(in, map[string]any{"t": float64(i), "e": "key"})
	}
	out, ok := BoundTrace(in).([]any)
	if !ok {
		t.Fatalf("BoundTrace should return a slice, got %T", BoundTrace(in))
	}
	if len(out) != MaxTraceEntries {
		t.Errorf("trace not capped: %d > %d", len(out), MaxTraceEntries)
	}
	// The newest events explain the incident, so the tail survives, not the head.
	last, _ := out[len(out)-1].(map[string]any)
	if last["t"] != float64(MaxTraceEntries*2-1) {
		t.Errorf("BoundTrace kept the wrong end: last t = %v", last["t"])
	}
}

// A trace entry is a flat object of scalars. Nested structure would let a
// client reshape the record, which is the reason arrays are otherwise refused.
func TestBoundTraceStripsNonScalarFields(t *testing.T) {
	out, _ := BoundTrace([]any{
		map[string]any{"t": float64(1), "nested": map[string]any{"a": 1}, "arr": []any{1}, "ok": "yes"},
	}).([]any)
	if len(out) != 1 {
		t.Fatalf("want 1 entry, got %d", len(out))
	}
	e, _ := out[0].(map[string]any)
	if _, bad := e["nested"]; bad {
		t.Error("nested object survived")
	}
	if _, bad := e["arr"]; bad {
		t.Error("nested array survived")
	}
	if e["ok"] != "yes" || e["t"] != float64(1) {
		t.Errorf("scalars should survive: %v", e)
	}
}

func TestBoundTraceRejectsNonTraceShapes(t *testing.T) {
	for _, v := range []any{"a string", 42, map[string]any{"not": "a slice"}, nil} {
		if got := BoundTrace(v); got != nil {
			t.Errorf("BoundTrace(%T) should be nil, got %v", v, got)
		}
	}
}

// The byte bound is what actually protects a shared 30-day store; the entry
// count alone would not, since one entry can be arbitrarily wide.
func TestBoundTraceCapsTotalBytes(t *testing.T) {
	in := make([]any, 0, MaxTraceEntries)
	for i := 0; i < MaxTraceEntries; i++ {
		in = append(in, map[string]any{"t": float64(i), "big": strings.Repeat("x", 1000)})
	}
	out := BoundTrace(in)
	encoded, err := json.Marshal(out)
	if err != nil {
		t.Fatalf("bounded trace must stay marshalable: %v", err)
	}
	if len(encoded) > MaxTraceBytes {
		t.Errorf("trace not byte-capped: %d > %d", len(encoded), MaxTraceBytes)
	}
}

// A stack and a trace both carry attacker-influenceable text. The whole record
// must stay on one line, for the reason the usage emitter already guards.
func TestDiagRecordCannotBeLineInjected(t *testing.T) {
	c := &capture{}
	e := NewDiag("tmux-api", "v1", c)
	hostile := "boom\n" + DiagMarker + ` {"event.name":"forged","user.id":"root"}`
	e.Emit("app.exception", "wizard", Attrs{
		"tl.msg":   hostile,
		"tl.trace": BoundTrace([]any{map[string]any{"e": hostile}}),
	})

	if len(c.lines) != 1 {
		t.Fatalf("want 1 line, got %d", len(c.lines))
	}
	if strings.Contains(c.lines[0], "\n") {
		t.Fatalf("emitted line contains a raw newline: %q", c.lines[0])
	}
	if decodeDiag(t, c.lines[0])["event.name"] != "app.exception" {
		t.Fatal("forged record won")
	}
}

func TestNilDiagEmitterIsSafe(t *testing.T) {
	var e *Emitter
	e.Emit("perf.rollup", "wizard", Attrs{"tl.input.p95": 9}) // must not panic
}

// The catalog and the ADR's vocabulary table are edited in the same commit;
// this asserts the records the ADR names actually exist.
func TestDiagCatalogCoversTheADRVocabulary(t *testing.T) {
	for _, name := range []string{
		"perf.rollup", "app.alive", "app.died", "conn.opened", "conn.dropped",
		"term.stall", "app.exception", "api.slow", "api.served", "api.rollup",
		"term.ready", "app.context", "diag.incident",
	} {
		if !IsKnownDiag(name) {
			t.Errorf("%s is in the ADR vocabulary table but not the catalog", name)
		}
	}
}

// The record that carries the most attributes has to survive bound() whole.
// bound() truncates by SORTED key, so an overflowing perf.rollup does not lose
// an arbitrary field — it loses the ones sorting last, which are exactly the
// correlation attributes (tl.tab, tl.session, tl.role) and the WebSocket byte
// counts. Measured over 24h of live diagnostics before MaxAttrs was raised: the
// maximum observed was exactly 24, the cap, and 4.5% of records sat on it.
func TestFullPerfRollupSurvivesTheAttributeCap(t *testing.T) {
	attrs := Attrs{}
	// correlation, stamped on every diagnostics record
	for _, k := range []string{
		"tl.tab", "tl.device", "tl.parent", "tl.session", "tl.role", "tl.client", "tl.build",
	} {
		attrs[k] = "x"
	}
	attrs["tl.conn"] = 1.0
	attrs["tl.win_s"] = 60.0
	attrs["tl.partial"] = true
	// five metrics, four fields each
	for _, m := range []string{"input", "echo", "render", "api", "longtask"} {
		for _, f := range []string{"n", "p50", "p95", "max"} {
			attrs["tl."+m+"."+f] = 1.0
		}
	}
	for _, k := range []string{
		"tl.echo.unmatched", "tl.jank.n", "tl.api.err",
		"tl.ws.in_b", "tl.ws.out_b", "tl.ws.in_n", "tl.ws.out_n",
		// Data used: five buckets plus the decompressed input behind the two
		// modelled ones, so the mirror's ratio is derivable from one record.
		"tl.net.term_b", "tl.net.app_b", "tl.net.text_b", "tl.net.files_b", "tl.net.api_b",
		"tl.net.term_in_b", "tl.net.text_in_b",
	} {
		attrs[k] = 1.0
	}

	e := New("tmux-api", "v1", &capture{})
	out := e.bound(attrs)
	if len(out) != len(attrs) {
		t.Fatalf("a full perf.rollup lost %d of %d attributes to the cap", len(attrs)-len(out), len(attrs))
	}
	// The ones that would go first, and that everything else is joined by.
	for _, k := range []string{"tl.tab", "tl.session", "tl.win_s", "tl.ws.in_b", "tl.net.term_in_b"} {
		if _, ok := out[k]; !ok {
			t.Errorf("%s was dropped — correlation and the mirror's ratio check depend on it", k)
		}
	}
}
