package telemetry

import (
	"encoding/json"
	"strings"
	"testing"
)

// capture collects emitted lines instead of writing them to a log.
type capture struct{ lines []string }

func (c *capture) Write(line string) { c.lines = append(c.lines, line) }

func decode(t *testing.T, line string) map[string]any {
	t.Helper()
	if !strings.HasPrefix(line, Marker+" ") {
		t.Fatalf("line missing %q marker: %q", Marker, line)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(strings.TrimPrefix(line, Marker+" ")), &got); err != nil {
		t.Fatalf("payload is not JSON (%v): %q", err, line)
	}
	return got
}

func TestEmitWritesOneMarkedJSONLine(t *testing.T) {
	c := &capture{}
	e := New("tmux-api", "v1", c)
	e.Emit("session.created", "wizard", Attrs{"tl.session": "worktree", "tl.count": 3})

	if len(c.lines) != 1 {
		t.Fatalf("want exactly 1 line, got %d: %q", len(c.lines), c.lines)
	}
	got := decode(t, c.lines[0])
	if got["event.name"] != "session.created" {
		t.Errorf("event.name = %v", got["event.name"])
	}
	if got["service.name"] != "tmux-api" || got["service.version"] != "v1" {
		t.Errorf("service resource wrong: %v / %v", got["service.name"], got["service.version"])
	}
	if got["user.id"] != "wizard" {
		t.Errorf("user.id = %v", got["user.id"])
	}
	if got["ts"] == nil || got["ts"] == "" {
		t.Error("ts missing")
	}
	attrs, _ := got["attrs"].(map[string]any)
	if attrs["tl.session"] != "worktree" || attrs["tl.count"] != float64(3) {
		t.Errorf("attrs round-tripped wrong: %v", attrs)
	}
}

// A session name is user-supplied and reaches the emitter verbatim. If a
// newline could survive into the output, anyone able to name a session could
// forge whole telemetry records in the journal. Everything must stay on ONE
// line, escaped.
func TestEmitCannotBeLineInjected(t *testing.T) {
	c := &capture{}
	e := New("tmux-api", "v1", c)
	hostile := "ok\n" + Marker + ` {"event.name":"forged","user.id":"root"}`
	e.Emit("session.renamed", "wizard\nroot", Attrs{"tl.session": hostile})

	if len(c.lines) != 1 {
		t.Fatalf("want 1 line, got %d", len(c.lines))
	}
	if strings.Contains(c.lines[0], "\n") {
		t.Fatalf("emitted line contains a raw newline: %q", c.lines[0])
	}
	got := decode(t, c.lines[0])
	if got["event.name"] != "session.renamed" {
		t.Fatalf("forged record won: %v", got["event.name"])
	}
	attrs, _ := got["attrs"].(map[string]any)
	if attrs["tl.session"] != hostile {
		t.Errorf("hostile value should survive escaped and intact, got %q", attrs["tl.session"])
	}
}

// Event names are a closed vocabulary (docs/adr/0005): a typo or a
// client-supplied name must not silently create a new series nobody queries.
func TestEmitRejectsUnknownEventNames(t *testing.T) {
	c := &capture{}
	e := New("tmux-api", "v1", c)
	e.Emit("totally.made.up", "wizard", nil)
	if len(c.lines) != 0 {
		t.Fatalf("unknown event was emitted: %q", c.lines)
	}
	if !IsKnown("session.created") {
		t.Error("session.created should be a known event")
	}
	if IsKnown("") || IsKnown("nope") {
		t.Error("empty/unknown names must not validate")
	}
}

// Telemetry is never worth breaking a request over: a nil emitter (feature
// off, or a service that never wired one) must be a silent no-op.
func TestNilEmitterIsSafe(t *testing.T) {
	var e *Emitter
	e.Emit("session.created", "wizard", Attrs{"tl.session": "x"}) // must not panic
}

// Attribute count and value length are bounded so one bad call site cannot
// flood Loki (30-day retention, shared tenant) with megabyte lines.
func TestEmitBoundsAttrs(t *testing.T) {
	c := &capture{}
	e := New("tmux-api", "v1", c)
	attrs := Attrs{"tl.session": strings.Repeat("x", MaxValueLen*2)}
	for i := 0; i < MaxAttrs*3; i++ {
		attrs["tl.filler"+string(rune('a'+i%26))+string(rune('a'+i/26))] = i
	}
	e.Emit("session.created", "wizard", attrs)

	got := decode(t, c.lines[0])
	out, _ := got["attrs"].(map[string]any)
	if len(out) > MaxAttrs {
		t.Errorf("attrs not capped: %d > %d", len(out), MaxAttrs)
	}
	if s, ok := out["tl.session"].(string); ok && len(s) > MaxValueLen {
		t.Errorf("value not truncated: %d > %d", len(s), MaxValueLen)
	}
}
