package main

import (
	"encoding/json"
	"os"
	"testing"
)

// The SERVER half of the badge parity fixture. frontend-v2/test/badge.parity.test.ts
// runs the same cases through the page's arithmetic, and both must reach `want`.
//
// Why this test exists: the app icon has two writers, and they disagreed in
// production for a whole release. The page counted awaiting plus finished-and-
// unread; the server counted awaiting plus EVERY finished session, so any push
// reset the icon upward. Each side had tests, and each side passed, because
// neither ran the other's numbers. This fixture is the only place they meet.
//
// The server no longer sends a total for a modern client — it sends the named
// set (waitingList) and the device subtracts what it has shown. So the parity
// this test asserts is: waitingList, minus the seen set derived the same way the
// browser derives it, equals what the page would draw.

type parityFixture struct {
	Cases []struct {
		Case     string `json:"case"`
		Sessions []struct {
			Name  string `json:"name"`
			State string `json:"state"`
		} `json:"sessions"`
		Visits map[string]int64 `json:"visits"`
		States map[string]struct {
			State string `json:"state"`
			At    int64  `json:"at"`
		} `json:"states"`
		Want int `json:"want"`
	} `json:"cases"`
}

func TestBadgeParityWithTheBrowser(t *testing.T) {
	raw, err := os.ReadFile("../testdata/badge-parity.json")
	if err != nil {
		t.Fatalf("reading the shared fixture: %v", err)
	}
	var fx parityFixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("fixture is not JSON: %v", err)
	}
	if len(fx.Cases) == 0 {
		t.Fatal("fixture has no cases")
	}

	for _, c := range fx.Cases {
		t.Run(c.Case, func(t *testing.T) {
			// What the poll would hand the sender.
			states := map[string]string{}
			for _, s := range c.Sessions {
				states[s.Name] = s.State
			}

			// The device's seen set, derived the way store/visits.ts derives it:
			// a finished session is SEEN when it was looked at after it reached
			// that state (a strict >, matching isUnseen).
			seen := map[string]bool{}
			for name, v := range c.Visits {
				if st, ok := c.States[name]; ok && v > st.At {
					seen[name] = true
				}
			}

			w := waitingList(states)
			if w == nil {
				t.Fatalf("fixture case is over the name cap (%d)", waitingListCap)
			}
			got := len(w.Awaiting)
			for _, name := range w.Done {
				if !seen[name] {
					got++
				}
			}
			if got != c.Want {
				t.Fatalf("server side counted %d, the browser counts %d\n  awaiting=%v done=%v seen=%v",
					got, c.Want, w.Awaiting, w.Done, seen)
			}
		})
	}
}

// The fallback total is what a device with no stored seen set draws, and what an
// old worker draws. It must never be SMALLER than the parity answer, or the icon
// would under-report real work.
func TestFallbackTotalIsNeverLowerThanTheParityAnswer(t *testing.T) {
	raw, err := os.ReadFile("../testdata/badge-parity.json")
	if err != nil {
		t.Fatalf("reading the shared fixture: %v", err)
	}
	var fx parityFixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("fixture is not JSON: %v", err)
	}
	for _, c := range fx.Cases {
		states := map[string]string{}
		for _, s := range c.Sessions {
			states[s.Name] = s.State
		}
		if total := waitingCount(states); total < c.Want {
			t.Fatalf("%s: fallback total %d < parity answer %d", c.Case, total, c.Want)
		}
	}
}
