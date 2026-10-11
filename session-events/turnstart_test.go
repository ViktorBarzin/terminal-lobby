package main

import (
	"net/http"
	"slices"
	"testing"
	"time"

	"terminal-lobby/sessionio"
)

// idle says hello and folds a snapshot with no turn running.
func idle(t *testing.T, rg *registry) *modConn {
	t.Helper()
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3", Instance: "i1"})
	c := rg.mods.conn("wizard", "demo")
	c.apply([]sessionio.ModEvent{idleHistory(), {Type: sessionio.ModLevelEvent}})
	return c
}

// A prompt sent while idle starts a turn, but Claude reports the turn only
// once its prompt hooks have run, seconds later. A second message sent in
// between is held, so it can steer that turn instead of waiting behind it in
// Claude (measured 2026-10-11: 5 seconds between the send and turn_start).
func TestAMessageSentAsATurnStartsIsHeldForIt(t *testing.T) {
	rg, mux := heldMux(t, t.TempDir())
	c := idle(t, rg)
	sent := fakeMod(t, c)
	postTurn(t, mux, "/prompt/demo", `{"text":"go"}`)
	if got := prompts(t, sent, 1); !slices.Equal(got, []string{"prompt go"}) {
		t.Fatalf("sent %q", got)
	}
	if rec := postTurn(t, mux, "/prompt/demo", `{"text":"and steer"}`); rec.Code != http.StatusNoContent {
		t.Fatalf("status %d (%s)", rec.Code, rec.Body.String())
	}
	time.Sleep(20 * time.Millisecond)
	if got := sent(); len(got) != 0 {
		t.Fatalf("the mod was sent %+v before the turn started", got)
	}
	if q := queueOf(c); !slices.Equal(q, []string{"and steer"}) {
		t.Fatalf("queue = %q", q)
	}
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModTurnStartEvent}})
	if got := c.takeForSteer(); !slices.Equal(got, []string{"and steer"}) {
		t.Fatalf("take at the first tool boundary = %q", got)
	}
}

// A prompt that starts no turn (the mod accepted it, Claude dropped it) must
// not keep what follows held for good.
func TestAHoldForATurnThatNeverStartsLetsGo(t *testing.T) {
	defer func(w time.Duration) { turnStartWait = w }(turnStartWait)
	turnStartWait = 30 * time.Millisecond
	rg, mux := heldMux(t, t.TempDir())
	c := idle(t, rg)
	sent := fakeMod(t, c)
	postTurn(t, mux, "/prompt/demo", `{"text":"go"}`)
	postTurn(t, mux, "/prompt/demo", `{"text":"next"}`)
	if got := prompts(t, sent, 2); !slices.Equal(got, []string{"prompt go", "prompt next"}) {
		t.Fatalf("sent %q", got)
	}
}

// Held prompts going out at a turn's end start the next turn the same way.
func TestReleasedPromptsHoldWhatFollowsUntilTheirTurnStarts(t *testing.T) {
	rg, mux := heldMux(t, t.TempDir())
	c := running(t, rg, "sid1")
	sent := fakeMod(t, c)
	postTurn(t, mux, "/prompt/demo", `{"text":"one"}`)
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModTurnEndEvent}})
	if got := prompts(t, sent, 1); !slices.Equal(got, []string{"prompt one"}) {
		t.Fatalf("sent %q", got)
	}
	postTurn(t, mux, "/prompt/demo", `{"text":"two"}`)
	time.Sleep(20 * time.Millisecond)
	if got := sent(); len(got) != 0 {
		t.Fatalf("the mod was sent %+v before the turn started", got)
	}
	if q := queueOf(c); !slices.Contains(q, "two") {
		t.Fatalf("queue = %q", q)
	}
}

// A slash command may run without a model turn (/clear, /model), so it does
// not hold what follows.
func TestASlashCommandWhileIdleHoldsNothing(t *testing.T) {
	rg, mux := heldMux(t, t.TempDir())
	c := idle(t, rg)
	sent := fakeMod(t, c)
	postTurn(t, mux, "/prompt/demo", `{"text":"/model"}`)
	postTurn(t, mux, "/prompt/demo", `{"text":"next"}`)
	if got := prompts(t, sent, 2); !slices.Equal(got, []string{"prompt /model", "prompt next"}) {
		t.Fatalf("sent %q", got)
	}
}

// A short turn can start and end inside one batch of the mod's events. What
// was held for it goes out with that turn's end, not after turnStartWait.
func TestATurnStartingAndEndingInOneBatchLetsGoAtOnce(t *testing.T) {
	rg, mux := heldMux(t, t.TempDir())
	c := idle(t, rg)
	sent := fakeMod(t, c)
	postTurn(t, mux, "/prompt/demo", `{"text":"go"}`)
	postTurn(t, mux, "/prompt/demo", `{"text":"next"}`)
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModTurnStartEvent}, {Type: sessionio.ModTurnEndEvent}})
	if got := prompts(t, sent, 2); !slices.Equal(got, []string{"prompt go", "prompt next"}) {
		t.Fatalf("sent %q", got)
	}
}
