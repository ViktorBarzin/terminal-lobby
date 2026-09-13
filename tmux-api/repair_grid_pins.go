package main

// Repairing grid pins whose hooks name a session that has been renamed away.
//
// PinGrid (sessionio/grid.go) takes a watched session's size out of tmux's hands
// — `window-size manual` — and gives it back through three hooks that resize the
// window to the last read-write client. The session name is baked into each
// hook's text, so a rename leaves them naming a session that no longer resolves:
// every hook fails into its own `|| true`, nothing resizes the window, and the
// grid is frozen for as long as the session lives.
//
// carryRenameAcrossStores repins from now on. This exists for the sessions that
// were already renamed, which on this box was most of them: the ADR-0019 id
// migration renamed every label-named session at once, and measured on
// 2026-09-05 that had frozen 1 of wizard's sessions and 8 of emo's 16, none of
// which anybody had reported. A frozen session looks fine until the window it is
// read in changes shape.
//
// IT ALSO TAKES PINS OFF. A pin used to be permanent, so every session that has
// ever been watched on this box is carrying one, and from tl-grid-v4 the
// client-detached hook reverts a pin when the last read-only client leaves.
// This is how the sessions pinned before that shipped reach the same state:
// pinned, and nobody watching, means unpin. It runs ahead of the stale check
// because a pin that is about to come off is not worth re-laying.
//
// Runs on EVERY start, unlike the id migration's one-shot marker. It is cheap —
// one option read per session, and it touches only the sessions that are both
// pinned and stale — and a sweep that keeps running is what makes a pin that
// slips through some future path self-healing rather than permanent.

import (
	"log"

	"terminal-lobby/telemetry"
)

// The tmux seams, as vars so the sweep's tests stay pure units.
var (
	gridPinStale = func(osUser, name string) (bool, error) {
		return gridInjector.GridPinStale(osUser, name)
	}
	unpinGrid = func(osUser, name string) (bool, error) {
		return gridInjector.UnpinGrid(osUser, name)
	}
	// watchedSessions names the sessions this user has a READ-ONLY client on,
	// and says whether the answer is trustworthy. One list-clients fork per
	// user, in the format the session list already parses.
	//
	// The second return is the whole reason this is not a plain map. An
	// unreadable client list is not evidence that nobody is watching, and
	// unpinning every pinned session because one fork failed is the one
	// outcome worth engineering against, so the caller skips that user.
	watchedSessions = func(osUser string) (map[string]bool, bool) {
		cs, ok := allClients(osUser)
		if !ok {
			return nil, false
		}
		watched := map[string]bool{}
		for _, c := range cs {
			if isReadOnly(c.Flags) {
				watched[c.Session] = true
			}
		}
		return watched, true
	}
)

// repairStaleGridPins repins every session whose pin names a session it is not.
// Returns how many it repaired. Never fails the caller: the service has to come
// up regardless, and a session it cannot repair is retried on the next start.
func repairStaleGridPins(users []string, list func(osUser string) []Session) int {
	repaired, unpinned := 0, 0
	for _, u := range users {
		watched, known := watchedSessions(u)
		for _, s := range list(u) {
			// Pinned with nobody watching: the revert would have taken this
			// off when the last watcher left, had it existed then.
			if known && !watched[s.Name] {
				took, err := unpinGrid(u, s.Name)
				if err != nil {
					log.Printf("grid pin sweep: unpinning %s/%s failed: %v", u, s.Name, err)
					continue
				}
				if took {
					unpinned++
					events.Emit("session.grid_unpinned", u, telemetry.Attrs{
						"tl.session": s.Name, "tl.client": "sweep",
					})
					continue
				}
			}
			stale, err := gridPinStale(u, s.Name)
			if err != nil {
				log.Printf("grid pin sweep: reading %s/%s failed: %v", u, s.Name, err)
				continue
			}
			if !stale {
				continue
			}
			if err := repinGrid(u, s.Name); err != nil {
				log.Printf("grid pin sweep: repinning %s/%s failed: %v", u, s.Name, err)
				continue
			}
			repaired++
			events.Emit("session.grid_repinned", u, telemetry.Attrs{
				"tl.session": s.Name, "tl.client": "sweep",
			})
		}
	}
	if repaired > 0 {
		log.Printf("grid pin sweep: repinned %d frozen session(s)", repaired)
	}
	if unpinned > 0 {
		log.Printf("grid pin sweep: unpinned %d session(s) nobody is watching", unpinned)
	}
	return repaired
}
