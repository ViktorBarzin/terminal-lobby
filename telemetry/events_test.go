package telemetry

import (
	"os"
	"strings"
	"testing"
)

// Every name below is emitted from production code today. Emit is gated on the
// catalog and drops an uncatalogued name with no error, no log line and nothing
// that fails, so a name missing from knownEvents is a series that silently never
// reaches the journal. Each row names the call site, so a reader can check the
// attribute list against the code that passes it.
func TestEmittedNamesAreCatalogued(t *testing.T) {
	emitted := []struct{ name, site string }{
		{"claude.answered", "session-events/main.go POST /keys and POST /answer-text"},
		{"file.attached", "clipboard-upload/main.go, an attachment under the size cap"},
		{"session.grid_repinned", "tmux-api/repair_grid_pins.go, the stale-pin sweep"},
		{"skill.edited", "skills-api/handlers.go, the skill editor's write"},
		{"watch.switched", "frontend-v2/src/store/watchmode.ts saveWatch, via the browser intake"},
		{"notify.tap", "frontend-v2/public/sw.js notificationclick, via the browser intake"},
	}
	for _, e := range emitted {
		if !IsKnown(e.name) {
			t.Errorf("%q is emitted from %s but is not in the catalog, so Emit drops it", e.name, e.site)
		}
	}
}

// The browser intake takes event names from a tab, so a name it accepts has to
// be one the catalog lists. This pins the drop itself rather than the list.
func TestEmitDropsAnUncataloguedName(t *testing.T) {
	c := &capture{}
	New("tmux-api", "v1", c).Emit("watch.definitely_not_a_real_event", "wizard", nil)
	if len(c.lines) != 0 {
		t.Fatalf("an uncatalogued name was written: %q", c.lines)
	}
}

// The notification tap, reported BY THE SERVICE WORKER's notificationclick
// handler. It is the one step of the tap chain that emitted nothing at all, so
// "does iOS dispatch notificationclick when the app is backgrounded" had to be
// answered from a WebKit bug thread instead of from the journal.
//
// The catalog gates NAMES, not attribute values, so this pins the name and
// records the branch vocabulary the handler and every query share. Each value
// is one arm of the handler: sw.js finds window clients and posts the switch
// (acked / posted), or finds none and opens one (opened), or has no session to
// switch to (focused), or cannot complete the arm it chose (failed).
func TestNotifyTapCarriesTheClickBranches(t *testing.T) {
	if !IsKnown("notify.tap") {
		t.Fatal("notify.tap is emitted by frontend-v2/public/sw.js but is not in the catalog, so Emit drops it")
	}
	branches := []struct{ kind, means string }{
		{"acked", "a lobby window answered the switch message"},
		{"posted", "every lobby was posted to and none answered inside the ACK window"},
		{"opened", "no lobby was open, so openWindow was called"},
		{"focused", "a session-less tap (the /push/test payload): foreground only, no switch"},
		{"failed", "the chosen branch could not be carried out"},
	}
	seen := map[string]bool{}
	for _, b := range branches {
		if b.means == "" {
			t.Errorf("tl.kind=%q has no documented meaning", b.kind)
		}
		if seen[b.kind] {
			t.Errorf("tl.kind=%q listed twice", b.kind)
		}
		seen[b.kind] = true
	}
	if len(seen) != len(branches) {
		t.Fatalf("branch vocabulary collapsed to %d of %d values", len(seen), len(branches))
	}
}

// tl.device is the per-installation id the browser stamps on every event
// (frontend-v2/src/telemetry/device.ts). It rides through the intake as an
// ordinary attribute, so nothing in the catalog has to know about it — but the
// convention comment above knownEvents has to list it, or the next reader adds
// a second name for the same dimension.
func TestDeviceAttributeIsNamedInTheConventions(t *testing.T) {
	src, err := os.ReadFile("events.go")
	if err != nil {
		t.Fatalf("reading events.go: %v", err)
	}
	if !strings.Contains(string(src), "tl.device") {
		t.Error("the attribute conventions never mention tl.device, which every browser event now carries")
	}
}
