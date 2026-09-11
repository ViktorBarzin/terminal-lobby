package telemetry

import (
	"encoding/json"
	"strings"
	"sync"
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

// --- the drop rule (docs/plans/2026-09-06-test-session-origin-design.md) ----

// syncCapture is capture with a lock, for the concurrency case. The plain one
// stays lock-free because every other test emits from one goroutine and a
// mutex there would say nothing about the code under test.
type syncCapture struct {
	mu    sync.Mutex
	lines []string
}

func (c *syncCapture) Write(line string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lines = append(c.lines, line)
}

func (c *syncCapture) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.lines)
}

// A system session is not recorded: it is the QA fleet or a harness driving the
// real lobby, and counting its turns as usage is what makes the usage numbers
// wrong.
func TestEmitDropsEventsNamingADroppedSession(t *testing.T) {
	c := &capture{}
	e := New("tmux-api", "v1", c)
	e.SetDropRule(func(osUser, session string) bool {
		return osUser == "wizard" && session == "qa-slug"
	})

	e.Emit("session.created", "wizard", Attrs{"tl.session": "qa-slug"})
	if len(c.lines) != 0 {
		t.Fatalf("a dropped session still wrote: %q", c.lines)
	}

	// Same session name, a different OS user: the rule gets both, because a
	// session name is only unique inside one user's tmux server.
	e.Emit("session.created", "emo", Attrs{"tl.session": "qa-slug"})
	if len(c.lines) != 1 {
		t.Fatalf("want the other user's event kept, got %d lines: %q", len(c.lines), c.lines)
	}

	e.Emit("session.created", "wizard", Attrs{"tl.session": "worktree"})
	if len(c.lines) != 2 {
		t.Fatalf("want an allowed session emitted, got %d lines: %q", len(c.lines), c.lines)
	}
	got := decode(t, c.lines[1])
	attrs, _ := got["attrs"].(map[string]any)
	if attrs["tl.session"] != "worktree" {
		t.Errorf("an allowed event must be untouched, got %v", attrs)
	}
}

// An event with no tl.session names no session, so the rule cannot judge it and
// must not be asked to. app.loaded and theme.changed are page-level and arrive
// this way; the browser leg is refused at the qa-harness proxy instead.
func TestEmitKeepsEventsWithNoSessionAttr(t *testing.T) {
	c := &capture{}
	e := New("tmux-api", "v1", c)
	asked := false
	e.SetDropRule(func(string, string) bool {
		asked = true
		return true // drop everything it is allowed to judge
	})

	e.Emit("app.loaded", "wizard", Attrs{"tl.client": "web"})
	e.Emit("app.loaded", "wizard", nil)
	// A non-string tl.session is not a session name either.
	e.Emit("app.loaded", "wizard", Attrs{"tl.session": 7})

	if len(c.lines) != 3 {
		t.Fatalf("want all 3 session-less events written, got %d: %q", len(c.lines), c.lines)
	}
	if asked {
		t.Error("the rule was consulted for an event carrying no tl.session string")
	}
}

// The rule is optional. An emitter that was never given one, and one handed a
// nil rule, both behave exactly as they did before this existed.
func TestNilDropRuleDropsNothing(t *testing.T) {
	c := &capture{}
	e := New("tmux-api", "v1", c)
	e.Emit("session.created", "wizard", Attrs{"tl.session": "qa-slug"})

	e.SetDropRule(func(string, string) bool { return true })
	e.Emit("session.created", "wizard", Attrs{"tl.session": "qa-slug"})

	e.SetDropRule(nil)
	e.Emit("session.created", "wizard", Attrs{"tl.session": "qa-slug"})

	if len(c.lines) != 2 {
		t.Fatalf("want the two unruled emits and nothing from the ruled one, got %d: %q",
			len(c.lines), c.lines)
	}
}

// The rule is installed once at startup and then read from every request
// goroutine in the service, so the field it lives in is shared state. Run with
// -race.
func TestDropRuleIsConcurrencySafe(t *testing.T) {
	c := &syncCapture{}
	e := New("tmux-api", "v1", c)
	e.SetDropRule(func(_, session string) bool { return session == "qa-slug" })

	var wg sync.WaitGroup
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if i%8 == 0 {
				e.SetDropRule(func(_, session string) bool { return session == "qa-slug" })
			}
			e.Emit("session.created", "wizard", Attrs{"tl.session": "qa-slug"})
			e.Emit("session.created", "wizard", Attrs{"tl.session": "worktree"})
		}(i)
	}
	wg.Wait()

	if got := c.count(); got != 64 {
		t.Fatalf("want the 64 allowed emits and none of the dropped ones, got %d", got)
	}
}
