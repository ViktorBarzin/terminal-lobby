package main

import (
	"errors"
	"testing"
)

// noClientList makes the unpin half of the sweep stand down, which is what an
// unreadable tmux does in production. Without it these two would fork
// list-clients for every named user and reach the real injector.
func noClientList(t *testing.T) {
	t.Helper()
	old := watchedSessions
	t.Cleanup(func() { watchedSessions = old })
	watchedSessions = func(string) (map[string]bool, bool) { return nil, false }
}

// The sweep touches only the sessions that are both pinned and stale.
func TestRepairStaleGridPinsOnlyTouchesTheFrozenOnes(t *testing.T) {
	sessions := map[string][]Session{
		"wizard": {{Name: "healthy"}, {Name: "frozen"}},
		"emo":    {{Name: "also-frozen"}, {Name: "never-pinned"}},
	}
	stale := map[string]bool{"wizard/frozen": true, "emo/also-frozen": true}

	origStale, origRepin := gridPinStale, repinGrid
	t.Cleanup(func() { gridPinStale, repinGrid = origStale, origRepin })
	noClientList(t)

	var repinned []string
	gridPinStale = func(u, n string) (bool, error) { return stale[u+"/"+n], nil }
	repinGrid = func(u, n string) error {
		repinned = append(repinned, u+"/"+n)
		return nil
	}

	got := repairStaleGridPins([]string{"wizard", "emo"}, func(u string) []Session { return sessions[u] })

	if got != 2 {
		t.Errorf("repaired = %d, want 2", got)
	}
	want := []string{"wizard/frozen", "emo/also-frozen"}
	if len(repinned) != len(want) {
		t.Fatalf("repinned = %v, want %v", repinned, want)
	}
	for i := range want {
		if repinned[i] != want[i] {
			t.Errorf("repinned[%d] = %s, want %s", i, repinned[i], want[i])
		}
	}
}

// One session it cannot read, or cannot repair, must not stop the rest: the
// whole point is that a box full of frozen sessions comes back on one start.
func TestRepairStaleGridPinsCarriesOnPastAFailure(t *testing.T) {
	origStale, origRepin := gridPinStale, repinGrid
	t.Cleanup(func() { gridPinStale, repinGrid = origStale, origRepin })
	noClientList(t)

	gridPinStale = func(_, n string) (bool, error) {
		if n == "unreadable" {
			return false, errors.New("no server")
		}
		return true, nil
	}
	repinGrid = func(_, n string) error {
		if n == "refuses" {
			return errors.New("gone")
		}
		return nil
	}

	got := repairStaleGridPins([]string{"wizard"}, func(string) []Session {
		return []Session{{Name: "unreadable"}, {Name: "refuses"}, {Name: "fine"}}
	})
	if got != 1 {
		t.Errorf("repaired = %d, want 1 (only `fine` succeeded)", got)
	}
}

// --- the pins that were laid down before the revert existed ----------------

// stubSweep swaps the sweep's three tmux seams and records what they were
// asked to do.
type sweepCalls struct {
	unpinned []string
	repinned []string
}

func stubSweep(t *testing.T, watched map[string][]string, readable func(string) bool) *sweepCalls {
	t.Helper()
	got := &sweepCalls{}
	oldStale, oldRepin, oldWatched := gridPinStale, repinGrid, watchedSessions
	t.Cleanup(func() { gridPinStale, repinGrid, watchedSessions = oldStale, oldRepin, oldWatched })

	watchedSessions = func(u string) (map[string]bool, bool) {
		if readable != nil && !readable(u) {
			return nil, false
		}
		set := map[string]bool{}
		for _, n := range watched[u] {
			set[n] = true
		}
		return set, true
	}
	gridPinStale = func(string, string) (bool, error) { return true, nil }
	repinGrid = func(u, n string) error {
		got.repinned = append(got.repinned, u+"/"+n)
		return nil
	}
	oldUnpin := unpinGrid
	t.Cleanup(func() { unpinGrid = oldUnpin })
	unpinGrid = func(u, n string) (bool, error) {
		got.unpinned = append(got.unpinned, u+"/"+n)
		return true, nil
	}
	return got
}

// Decision 10. The pin used to be permanent, so every session that has ever
// been watched on this box is carrying one. The sweep takes them off the ones
// nobody is watching now, which is the state the revert would have left them
// in had it existed at the time.
func TestTheSweepUnpinsASessionNobodyIsWatching(t *testing.T) {
	rec := withTelemetry(t)
	got := stubSweep(t, map[string][]string{"wizard": {"watched"}}, nil)

	repaired := repairStaleGridPins([]string{"wizard"}, func(string) []Session {
		return []Session{{Name: "watched"}, {Name: "lonely"}}
	})

	if len(got.unpinned) != 1 || got.unpinned[0] != "wizard/lonely" {
		t.Errorf("unpinned = %v, want just wizard/lonely", got.unpinned)
	}
	// The watched one still goes through the stale path, so a v3 hook on a
	// session somebody IS watching is re-laid rather than left.
	if len(got.repinned) != 1 || got.repinned[0] != "wizard/watched" {
		t.Errorf("repinned = %v, want just wizard/watched", got.repinned)
	}
	if repaired != 1 {
		t.Errorf("repaired = %d, want 1", repaired)
	}
	var unpins int
	for _, line := range rec.lines {
		if decodeEvent(t, line)["event.name"] == "session.grid_unpinned" {
			unpins++
		}
	}
	if unpins != 1 {
		t.Errorf("emitted %d session.grid_unpinned events, want 1: %v", unpins, rec.lines)
	}
}

// An unreadable client list is not evidence that nobody is watching. Unpinning
// every pinned session because one tmux fork failed is the one outcome worth
// engineering against, so that user is skipped entirely.
func TestTheSweepUnpinsNothingWhenTheClientListCannotBeRead(t *testing.T) {
	got := stubSweep(t, nil, func(string) bool { return false })

	repairStaleGridPins([]string{"wizard"}, func(string) []Session {
		return []Session{{Name: "pinned"}}
	})

	if len(got.unpinned) != 0 {
		t.Errorf("unpinned %v on an unreadable client list", got.unpinned)
	}
	// The stale path still runs: it reads its own option per session and does
	// not depend on the client list at all.
	if len(got.repinned) != 1 {
		t.Errorf("repinned = %v, want the stale path to carry on", got.repinned)
	}
}

// A session that was never pinned answers false from UnpinGrid, and must then
// fall through to the stale check rather than being counted as swept.
func TestTheSweepDoesNotCountASessionThatWasNeverPinned(t *testing.T) {
	stubSweep(t, nil, nil)
	oldUnpin, oldStale := unpinGrid, gridPinStale
	t.Cleanup(func() { unpinGrid, gridPinStale = oldUnpin, oldStale })
	unpinGrid = func(string, string) (bool, error) { return false, nil }
	gridPinStale = func(string, string) (bool, error) { return false, nil }

	rec := withTelemetry(t)
	if got := repairStaleGridPins([]string{"wizard"}, func(string) []Session {
		return []Session{{Name: "ordinary"}}
	}); got != 0 {
		t.Errorf("repaired = %d, want 0", got)
	}
	for _, line := range rec.lines {
		if decodeEvent(t, line)["event.name"] == "session.grid_unpinned" {
			t.Errorf("an unpinned session was reported as swept: %s", line)
		}
	}
}
