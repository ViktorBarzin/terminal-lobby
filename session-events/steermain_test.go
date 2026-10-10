package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"terminal-lobby/sessionio"
)

// steerRow is the row the mod forwards once the context it attached at a
// tool boundary is stored (shape captured on CLI 2.1.296, 2026-10-10).
func steerRow(texts ...string) sessionio.ModEvent {
	entries := make([]string, len(texts))
	for i, t := range texts {
		entries[i] = sessionio.FrameMainSteer(t)
	}
	content, _ := json.Marshal([]map[string]string{{
		"type": "text",
		"text": "<system-reminder>\ntool.call hook additional context: " + strings.Join(entries, "\n") + "\n</system-reminder>",
	}})
	return sessionio.ModEvent{
		Type: sessionio.ModRowEvent, UUID: "steer-" + strings.Join(texts, "-"), Door: "hook-context",
		Origin:  json.RawMessage(`{"kind":"plugin","event":"tool.call"}`),
		Message: &sessionio.ModMessage{Type: "attachment", Name: "hook_additional_context", Role: "user", Content: content},
	}
}

func TestTakeForSteerHandsOverWhatIsHeldOnce(t *testing.T) {
	rg, mux := heldMux(t, t.TempDir())
	c := running(t, rg, "sid1")
	fakeMod(t, c)
	postTurn(t, mux, "/prompt/demo", `{"text":"one"}`)
	postTurn(t, mux, "/prompt/demo", `{"text":"two"}`)
	if got := c.takeForSteer(); !slices.Equal(got, []string{"one", "two"}) {
		t.Fatalf("first take = %q", got)
	}
	if got := c.takeForSteer(); len(got) != 0 {
		t.Fatalf("second take = %q, want nothing", got)
	}
	// Until Claude has stored them they still show as waiting.
	if q := queueOf(c); !slices.Equal(q, []string{"one", "two"}) {
		t.Fatalf("queue = %q", q)
	}
}

// Nothing is handed over while no main turn is known to run: what is held
// then is about to go out as the next turn.
func TestTakeForSteerTakesNothingWithoutARunningTurn(t *testing.T) {
	rg, _ := heldMux(t, t.TempDir())
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3", Instance: "i1"})
	c := rg.mods.conn("wizard", "demo")
	c.mu.Lock()
	c.held = []string{"before the snapshot"}
	c.mu.Unlock()
	if got := c.takeForSteer(); len(got) != 0 {
		t.Fatalf("take before the snapshot = %q", got)
	}
}

// The stored row is what says Claude has them: their ghosts go, they show as
// prompts, and the turn's end sends nothing.
func TestADeliveredMessageLeavesTheQueueAndIsNotSentAgain(t *testing.T) {
	rg, mux := heldMux(t, t.TempDir())
	c := running(t, rg, "sid1")
	sent := fakeMod(t, c)
	postTurn(t, mux, "/prompt/demo", `{"text":"one"}`)
	postTurn(t, mux, "/prompt/demo", `{"text":"two"}`)
	c.takeForSteer()
	c.apply([]sessionio.ModEvent{steerRow("one", "two")})
	if q := queueOf(c); len(q) != 0 {
		t.Fatalf("queue after the row = %q", q)
	}
	c.mu.Lock()
	fs := c.ls.fs
	c.mu.Unlock()
	if got := userBodies(fs); !strings.HasSuffix(got, "|one|two") {
		t.Fatalf("prompts = %q", got)
	}
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModTurnEndEvent}})
	time.Sleep(20 * time.Millisecond)
	if got := sent(); len(got) != 0 {
		t.Fatalf("delivered messages were sent again: %+v", got)
	}
}

// A take no row confirms (the mod's request timed out, or the call it rode
// on ended before its result was stored) goes out when the turn ends, as a
// held prompt always did.
func TestATakeNothingConfirmedGoesOutAtTheTurnsEnd(t *testing.T) {
	rg, mux := heldMux(t, t.TempDir())
	c := running(t, rg, "sid1")
	sent := fakeMod(t, c)
	postTurn(t, mux, "/prompt/demo", `{"text":"one"}`)
	c.takeForSteer()
	postTurn(t, mux, "/prompt/demo", `{"text":"two"}`)
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModTurnEndEvent}})
	if got := prompts(t, sent, 2); !slices.Equal(got, []string{"prompt one", "prompt two"}) {
		t.Fatalf("sent %q", got)
	}
}

// Taken by the mod, a prompt is Claude's: it can no longer be cancelled or
// taken back to the field, which is also how the Text view opens it to edit.
func TestAPromptInFlightCannotBeTakenBack(t *testing.T) {
	rg, mux := heldMux(t, t.TempDir())
	c := running(t, rg, "sid1")
	fakeMod(t, c)
	postTurn(t, mux, "/prompt/demo", `{"text":"one"}`)
	c.takeForSteer()
	for path, body := range map[string]string{
		"/prompt/demo/cancel-queued": `{"text":"one"}`,
		"/prompt/demo/unqueue":       ``,
	} {
		rec := postTurn(t, mux, path, body)
		if r := decodeTake(t, rec.Body.String()); rec.Code != http.StatusOK || r.Restored {
			t.Errorf("%s: status %d reply %q", path, rec.Code, rec.Body.String())
		}
	}
	if q := queueOf(c); !slices.Equal(q, []string{"one"}) {
		t.Fatalf("queue = %q", q)
	}
}

// A Stop that asks for the queue also takes back what the mod took and
// Claude has not stored: the abort can land before the context does, and
// the turn's end must not send it after a Stop.
func TestAStopHandsBackPromptsInFlight(t *testing.T) {
	rg, mux := heldMux(t, t.TempDir())
	c := running(t, rg, "sid1")
	sent := fakeMod(t, c)
	postTurn(t, mux, "/prompt/demo", `{"text":"taken"}`)
	c.takeForSteer()
	postTurn(t, mux, "/prompt/demo", `{"text":"held"}`)
	rec := postTurn(t, mux, "/cancel/demo", `{"restoreQueue":["taken","held"]}`)
	if r := decodeTake(t, rec.Body.String()); !r.Restored || !slices.Equal(r.Queue, []string{"taken", "held"}) {
		t.Fatalf("status %d reply %q", rec.Code, rec.Body.String())
	}
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModTurnEndEvent}})
	if got := prompts(t, sent, 2); !slices.Equal(got, []string{"abort "}) {
		t.Fatalf("mod got %q, want the abort alone", got)
	}
}

// What the mod took survives a restart as held: nothing confirmed it.
func TestPromptsInFlightSurviveARestart(t *testing.T) {
	dir := t.TempDir()
	rg, mux := heldMux(t, dir)
	c := running(t, rg, "sid1")
	postTurn(t, mux, "/prompt/demo", `{"text":"kept"}`)
	c.takeForSteer()

	rg2, _ := heldMux(t, dir)
	rg2.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3", Instance: "i-sid1"})
	c2 := rg2.mods.conn("wizard", "demo")
	sent := fakeMod(t, c2)
	c2.apply([]sessionio.ModEvent{{Type: sessionio.ModHistoryEvent, Running: true, Messages: []sessionio.ModHistoryMessage{{Role: "user", Text: "work"}}}})
	if q := queueOf(c2); !slices.Equal(q, []string{"kept"}) {
		t.Fatalf("queue after the restart = %q", q)
	}
	c2.apply([]sessionio.ModEvent{{Type: sessionio.ModLevelEvent}})
	if got := prompts(t, sent, 1); !slices.Equal(got, []string{"prompt kept"}) {
		t.Fatalf("sent %q", got)
	}
}

// The mod's route: the token names the connection, the reply the texts.
func TestTakeHeldRoute(t *testing.T) {
	rg, mux := heldMux(t, t.TempDir())
	c := running(t, rg, "sid1")
	fakeMod(t, c)
	postTurn(t, mux, "/prompt/demo", `{"text":"one"}`)
	c.mu.Lock()
	token := c.token
	c.mu.Unlock()

	take := func(body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		rg.mods.handleTakeHeld()(rec, httptest.NewRequest(http.MethodPost, "/mod/v1/take-held", strings.NewReader(body)))
		return rec
	}
	rec := take(`{"token":"` + token + `"}`)
	var r struct {
		Texts []string `json:"texts"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &r); rec.Code != http.StatusOK || err != nil || !slices.Equal(r.Texts, []string{"one"}) {
		t.Fatalf("status %d body %q", rec.Code, rec.Body.String())
	}
	if rec := take(`{"token":"` + token + `"}`); !strings.Contains(rec.Body.String(), `"texts":[]`) {
		t.Fatalf("empty take body %q, want an empty list", rec.Body.String())
	}
	if rec := take(`{"token":"nope"}`); rec.Code != http.StatusConflict {
		t.Fatalf("unknown token: status %d", rec.Code)
	}
}
