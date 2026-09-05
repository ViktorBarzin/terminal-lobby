package main

import (
	"errors"
	"testing"
)

// The sweep touches only the sessions that are both pinned and stale.
func TestRepairStaleGridPinsOnlyTouchesTheFrozenOnes(t *testing.T) {
	sessions := map[string][]Session{
		"wizard": {{Name: "healthy"}, {Name: "frozen"}},
		"emo":    {{Name: "also-frozen"}, {Name: "never-pinned"}},
	}
	stale := map[string]bool{"wizard/frozen": true, "emo/also-frozen": true}

	origStale, origRepin := gridPinStale, repinGrid
	t.Cleanup(func() { gridPinStale, repinGrid = origStale, origRepin })

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
