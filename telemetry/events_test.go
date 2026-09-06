package telemetry

import "testing"

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
