package main

import (
	"strings"
	"sync"
	"testing"

	"terminal-lobby/telemetry"
)

// The telemetry drop rule: an event naming a system session is not written
// (docs/plans/2026-09-06-test-session-origin-design.md).
//
// The rule answers from the body the sessions cache already holds, so these
// tests prime that cache the way a poll would and then ask. Each one uses its
// own OS user name, because the memo is keyed by user and a shared one would
// carry a previous test's answer into the next.

// primeSessionList puts a served list into the sessions cache for one user, the
// way GET /sessions does, and clears both it and the memo afterwards.
func primeSessionList(t *testing.T, osUser, body string) {
	t.Helper()
	sessionsCacheInstance.put(osUser, []byte(body))
	t.Cleanup(func() {
		sessionsCacheInstance.invalidate(osUser)
		systemSessionRule.mu.Lock()
		delete(systemSessionRule.seen, osUser)
		systemSessionRule.mu.Unlock()
	})
}

func TestDropRuleReadsTheServedList(t *testing.T) {
	const u = "droprule-served"
	primeSessionList(t, u, `[
		{"name":"k7m2q9x4tp0v","origin":"user"},
		{"name":"b3n8h1x5r2wq","origin":"test"},
		{"name":"q4m8vwx2rt5n"},
		{"name":"qa-slug","origin":"user"}
	]`)

	for _, c := range []struct {
		session string
		want    bool
		why     string
	}{
		{"k7m2q9x4tp0v", false, "the lobby's own create path stamped it"},
		{"b3n8h1x5r2wq", true, "a harness stamped it"},
		{"q4m8vwx2rt5n", true, "nobody stamped it, and that is what makes a session system"},
		{"qa-slug", true, "a reserved name is system whatever the option says"},
	} {
		if got := systemSessionRule.isSystem(u, c.session); got != c.want {
			t.Errorf("isSystem(%q) = %v, want %v — %s", c.session, got, c.want, c.why)
		}
	}
}

// The mutating handlers invalidate the cache and THEN emit, so the events that
// matter most arrive while it is cold. A memo read seconds ago still describes
// the box correctly, and answering from it is the difference between the rule
// working for session.killed and not.
func TestDropRuleAnswersFromASecondsOldMemoWhenTheCacheIsCold(t *testing.T) {
	const u = "droprule-cold"
	primeSessionList(t, u, `[{"name":"k7m2q9x4tp0v","origin":"test"}]`)

	if !systemSessionRule.isSystem(u, "k7m2q9x4tp0v") {
		t.Fatal("the warm read was already wrong")
	}
	sessionsCacheInstance.invalidate(u) // what killSession does before it emits

	if !systemSessionRule.isSystem(u, "k7m2q9x4tp0v") {
		t.Error("a harness session's kill would be recorded, because the cache went cold first")
	}
}

// A memo old enough to be describing a different box is not trusted. Past that
// the rule falls back to the name, which fails towards recording.
func TestDropRuleStopsTrustingAStaleMemo(t *testing.T) {
	const u = "droprule-stale"
	primeSessionList(t, u, `[{"name":"k7m2q9x4tp0v","origin":"test"}]`)
	if !systemSessionRule.isSystem(u, "k7m2q9x4tp0v") {
		t.Fatal("the warm read was already wrong")
	}
	sessionsCacheInstance.invalidate(u)

	// Move the clock past the max age rather than sleeping through it.
	systemSessionRule.mu.Lock()
	snap := systemSessionRule.seen[u]
	snap.at = snap.at.Add(-2 * systemSessionMaxAge)
	systemSessionRule.seen[u] = snap
	systemSessionRule.mu.Unlock()

	if systemSessionRule.isSystem(u, "k7m2q9x4tp0v") {
		t.Error("an answer minutes old was still being trusted")
	}
}

// With no list to read at all — a user nobody has polled for, a service that
// has just started — the name is all there is. It answers the harness prefixes
// correctly and records everything else.
func TestDropRuleWithNoListFallsBackToTheName(t *testing.T) {
	const u = "droprule-nolist"
	for _, c := range []struct {
		session string
		want    bool
	}{
		{"qa-slug", true},
		{"t3e2e-42", true},
		{poolSlotPrefix + "home_wizard", true},
		{"k7m2q9x4tp0v", false},
	} {
		if got := systemSessionRule.isSystem(u, c.session); got != c.want {
			t.Errorf("isSystem(%q) with no list = %v, want %v", c.session, got, c.want)
		}
	}
}

// A refresh picks up a rescue: the session was system when it was last read and
// is a person's now, and the next window says so.
func TestDropRuleFollowsARescueOnTheNextRefresh(t *testing.T) {
	const u = "droprule-rescue"
	primeSessionList(t, u, `[{"name":"rescued"}]`)
	if !systemSessionRule.isSystem(u, "rescued") {
		t.Fatal("an unstamped session was not read as system")
	}

	sessionsCacheInstance.put(u, []byte(`[{"name":"rescued","origin":"user"}]`))
	// Age the memo past the refresh window, which is what the passage of one
	// poll interval does in production.
	systemSessionRule.mu.Lock()
	snap := systemSessionRule.seen[u]
	snap.at = snap.at.Add(-2 * systemSessionRefresh)
	systemSessionRule.seen[u] = snap
	systemSessionRule.mu.Unlock()

	if systemSessionRule.isSystem(u, "rescued") {
		t.Error("a rescued session is still being kept out of the record")
	}
}

// The rule is INSTALLED, not merely written: this goes through the service's
// own emitter, which is the thing every call site uses.
func TestSystemSessionEventsAreNotWritten(t *testing.T) {
	const u = "droprule-emitter"
	primeSessionList(t, u, `[
		{"name":"k7m2q9x4tp0v","origin":"user"},
		{"name":"b3n8h1x5r2wq","origin":"test"}
	]`)

	out := captureLog(t, func() {
		events.Emit("session.killed", u, telemetry.Attrs{"tl.session": "b3n8h1x5r2wq", "tl.client": "api"})
	})
	if strings.Contains(out, telemetry.Marker) {
		t.Errorf("a harness session's event was written:\n%s", out)
	}

	out = captureLog(t, func() {
		events.Emit("session.killed", u, telemetry.Attrs{"tl.session": "k7m2q9x4tp0v", "tl.client": "api"})
	})
	if !strings.Contains(out, telemetry.Marker) || !strings.Contains(out, "k7m2q9x4tp0v") {
		t.Errorf("a person's session stopped being recorded:\n%s", out)
	}

	// An event that names no session is not the rule's business — it cannot
	// judge one, and app.loaded arriving from the fleet is the browser leg's
	// problem (the qa-harness proxy refuses POST /telemetry).
	out = captureLog(t, func() {
		events.Emit("app.loaded", u, telemetry.Attrs{"tl.client": "lobby-v2"})
	})
	if !strings.Contains(out, telemetry.Marker) {
		t.Errorf("an event naming no session was dropped:\n%s", out)
	}
}

// Diagnostics keeps recording. A fleet session hitting a stall or an exception
// is exactly as interesting as a person hitting it; the decision was about the
// usage record (ADR-0008 is a separate channel with a separate budget).
func TestDiagnosticsStillRecordsSystemSessions(t *testing.T) {
	const u = "droprule-diag"
	primeSessionList(t, u, `[{"name":"b3n8h1x5r2wq","origin":"test"}]`)

	out := captureLog(t, func() {
		diagEvents.Emit("term.stall", u, telemetry.Attrs{"tl.session": "b3n8h1x5r2wq", "tl.ms": 900.0})
	})
	if !strings.Contains(out, telemetry.DiagMarker) {
		t.Errorf("a health record about a system session was dropped:\n%s", out)
	}
}

// The rule runs inside Emit, which every handler goroutine reaches at once, so
// the memo has to hold up under -race.
func TestDropRuleIsSafeUnderConcurrentEmitters(t *testing.T) {
	const u = "droprule-race"
	primeSessionList(t, u, `[{"name":"k7m2q9x4tp0v","origin":"user"},{"name":"qa-slug"}]`)

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for n := 0; n < 200; n++ {
				if systemSessionRule.isSystem(u, "k7m2q9x4tp0v") {
					t.Error("a person's session was judged system")
					return
				}
				if !systemSessionRule.isSystem(u, "qa-slug") {
					t.Error("a harness session was judged a person's")
					return
				}
			}
		}()
	}
	wg.Wait()
}
