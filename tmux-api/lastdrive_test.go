package main

import "testing"

// Last driven — the session-list timestamp that answers "when did a human last
// have hands on this session".
//
// WHY IT IS NOT tmux's session_activity: tmux bumps #{session_activity} on ANY
// attach, a read-only one included (measured 2026-08-18: a `tmux attach -r`
// moved it by 1s on an otherwise idle session). So opening a session to watch it
// reset the "5m ago" on the card, which is the opposite of what the number is
// for — the whole point of Watch mode is that a viewer leaves the session as it
// found it.
//
// The stamp is therefore derived from the client list, which already separates
// driving from merely attached (driven.go), and written to the session's
// @last_drive option so it lives with the session and every reader agrees.

const staleAfter = 30 // seconds; see drivesToStamp

func TestADrivenSessionThatHasNeverBeenStampedIsStampedNow(t *testing.T) {
	got := drivesToStamp([]Session{{Name: "work", Driven: true, Created: 900}}, 1000, staleAfter)
	want := []driveStamp{{Name: "work", At: 1000}}
	if len(got) != 1 || got[0] != want[0] {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestADrivenSessionIsRestampedOnceItsStampGoesStale(t *testing.T) {
	got := drivesToStamp([]Session{{Name: "work", Driven: true, LastDrive: 960, Created: 900}}, 1000, staleAfter)
	if len(got) != 1 || got[0].At != 1000 {
		t.Fatalf("a 40s-old stamp on a driven session should be refreshed; got %+v", got)
	}
}

// The fork budget: the list is rebuilt every 5s, and a `tmux set-option` per
// driven session per poll would be pure churn. Freshness within staleAfter is
// indistinguishable to a human reading "just now".
func TestAFreshStampIsLeftAlone(t *testing.T) {
	if got := drivesToStamp([]Session{{Name: "work", Driven: true, LastDrive: 995, Created: 900}}, 1000, staleAfter); len(got) != 0 {
		t.Fatalf("a 5s-old stamp needs no write; got %+v", got)
	}
}

// THE BUG THIS FIXES. Watchers must not move the number, however long they
// watch: no driver, no stamp.
func TestWatchersNeverMoveTheStamp(t *testing.T) {
	// attached twice over, driven by nobody, stamped an hour ago
	s := []Session{{Name: "work", Attached: 2, Driven: false, LastDrive: 1000, Created: 900}}
	if got := drivesToStamp(s, 4600, staleAfter); len(got) != 0 {
		t.Fatalf("a watched-but-undriven session must keep its stamp; got %+v", got)
	}
}

// Nothing should ever render an empty timer. A session exists because somebody
// created it, and creating one attaches read-write — so its creation time is a
// truthful lower bound until the first driver is seen. This is also the
// migration path for every session that predates the option.
func TestAnUnstampedUndrivenSessionIsSeededFromItsCreation(t *testing.T) {
	got := drivesToStamp([]Session{{Name: "old", Driven: false, Created: 900}}, 1000, staleAfter)
	want := []driveStamp{{Name: "old", At: 900}}
	if len(got) != 1 || got[0] != want[0] {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestSeedingHappensOnlyOnce(t *testing.T) {
	if got := drivesToStamp([]Session{{Name: "old", Driven: false, LastDrive: 900, Created: 900}}, 5000, staleAfter); len(got) != 0 {
		t.Fatalf("an already-seeded session needs no write; got %+v", got)
	}
}

func TestEverySessionIsConsideredIndependently(t *testing.T) {
	got := drivesToStamp([]Session{
		{Name: "driving", Driven: true, LastDrive: 900, Created: 800},
		{Name: "watched", Driven: false, LastDrive: 900, Created: 800},
		{Name: "fresh", Driven: true, LastDrive: 999, Created: 800},
		{Name: "new", Driven: false, Created: 950},
	}, 1000, staleAfter)
	want := []driveStamp{{Name: "driving", At: 1000}, {Name: "new", At: 950}}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}
