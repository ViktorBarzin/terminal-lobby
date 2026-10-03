package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"terminal-lobby/sessionio"
	"terminal-lobby/sessionio/siotest"
)

// slotName is the pre-warm slot tmux-user-attach warms for
// ~/code/terminal-lobby: 69 characters, past the 64 the mod's hello used to
// allow, so the slot's mod was refused at every warm-up (141 of 141 between
// 2026-09-26 and 2026-10-03) and a claimed slot waited on its backoff.
const slotName = "__terminal_lobby_prewarmed_pool_slot__home_wizard_code_terminal_lobby"

func TestAModMaySayHelloFromASlotWithALongName(t *testing.T) {
	if len(slotName) <= 64 {
		t.Fatalf("the fixture is %d characters; it must be past the old limit", len(slotName))
	}
	for _, name := range []string{slotName, "demo", "a7b2mh00pc2y", strings.Repeat("a", modSessionMax)} {
		if !validModSession(name) {
			t.Errorf("%q (%d chars) refused", name, len(name))
		}
	}
	for _, name := range []string{"", "a b", "../x", "x;y", strings.Repeat("a", modSessionMax+1)} {
		if validModSession(name) {
			t.Errorf("%q accepted", name)
		}
	}
}

// claimedSlot is a registry whose mod said hello from a pre-warm slot, and a
// mod running the way the real one does: long-polling, and saying hello again
// under its pane's current name whenever a poll is refused. The test then
// claims the slot by renaming it, which is all tmux-user-attach does.
func claimedSlot(t *testing.T) (*registry, *panes, http.Handler) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	opts := siotest.NewFakeOptions("wizard/" + slotName)
	rg := newRegistry(ctx, time.Millisecond, t.TempDir(), opts, "wizard")
	tbl := &panes{in: map[string]string{"%3": slotName}}
	rg.mods.paneSession = tbl.session
	rg.mods.sessionPanes = tbl.sessionPanes

	token, _ := rg.mods.hello("wizard", modHello{SID: "sid1", Session: slotName, Pane: "%3"})
	c := rg.mods.conn("wizard", slotName)
	go func() {
		for ctx.Err() == nil {
			req := httptest.NewRequest("GET", "/mod/v1/poll?token="+token, nil).WithContext(ctx)
			rec := httptest.NewRecorder()
			rg.mods.handlePoll()(rec, req)
			if rec.Code == http.StatusConflict {
				token, _ = rg.mods.hello("wizard", modHello{SID: "sid1", Session: tbl.session("wizard", "%3"), Pane: "%3"})
				continue
			}
			var got struct {
				Commands []modCommand `json:"commands"`
			}
			_ = json.Unmarshal(rec.Body.Bytes(), &got)
			for _, cmd := range got.Commands {
				c.deliver(cmd.ID, modAck{OK: true})
			}
		}
	}()

	opts.Rename("wizard", slotName, "a7b2mh00pc2y")
	tbl.set("%3", "a7b2mh00pc2y")

	mux := http.NewServeMux()
	mux.HandleFunc("POST /prompt/{session}", handlePrompt(rg, &fakeTurns{}))
	mux.HandleFunc("POST /hooks/claimed", handleClaimed(rg))
	return rg, tbl, mux
}

// Measured 2026-10-03: since first prompts went through the mod (2026-10-02),
// a claimed slot's prompt waited for the mod's own retry to notice the new
// name, p90 16.2s. The prompt route asks the mod to follow the rename itself,
// so it waits one hello, not a backoff.
func TestAFirstPromptToAClaimedSlotFollowsItsMod(t *testing.T) {
	_, _, mux := claimedSlot(t)
	start := time.Now()
	rec := postTurn(t, mux, "/prompt/a7b2mh00pc2y", `{"text":"first","awaitReady":true}`)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status %d (%s), want 204", rec.Code, rec.Body.String())
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("the prompt took %s; it waited for something other than one hello", d)
	}
}

// The claim tells session-events the slot's new name the moment it has one,
// so the mod is under it before the browser's first prompt arrives.
func TestAClaimMovesTheSlotsModToItsNewName(t *testing.T) {
	rg, _, mux := claimedSlot(t)
	rec := postTurn(t, mux, "/hooks/claimed", `{"user":"wizard","session":"a7b2mh00pc2y"}`)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status %d (%s), want 202", rec.Code, rec.Body.String())
	}
	deadline := time.Now().Add(time.Second)
	for rg.mods.conn("wizard", "a7b2mh00pc2y") == nil {
		if time.Now().After(deadline) {
			t.Fatal("the mod is not under the claimed name a second after the claim")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if rg.mods.conn("wizard", slotName) != nil {
		t.Fatal("the slot's name still resolves to the connection")
	}
}

func TestAClaimNeedsASessionName(t *testing.T) {
	_, _, mux := claimedSlot(t)
	for _, body := range []string{`{"user":"wizard"}`, `{"user":"wizard","session":"a b"}`, `nope`} {
		if rec := postTurn(t, mux, "/hooks/claimed", body); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status %d, want 400", body, rec.Code)
		}
	}
}

// userRow is the mod's row for a prompt Claude has written to its transcript.
func userRow(text string) sessionio.ModEvent {
	content, _ := json.Marshal(text)
	return sessionio.ModEvent{
		Type: sessionio.ModRowEvent, UUID: "u-" + text, Door: "prompt",
		Message: &sessionio.ModMessage{Type: "user", Role: "user", Content: content},
	}
}

// A first prompt is timed from the Send press to two moments: Accepted (the
// mod's ack, which is when the POST returns) and Shown (Claude's own record of
// the prompt arriving as a row). The browser says how long ago Send was; the
// server measures the rest on its own clock.
func TestAFirstPromptRecordsWhenItWasAcceptedAndShown(t *testing.T) {
	sink := captureEvents(t)
	f := &fakeTurns{}
	rg, mux := modTurnMux(t, f)
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	c := rg.mods.conn("wizard", "demo")
	fakeMod(t, c)

	rec := postTurn(t, mux, "/prompt/demo", `{"text":"fix the build  ","awaitReady":true,"sinceSendMs":120,"hidden":true}`)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status %d (%s)", rec.Code, rec.Body.String())
	}
	if names := sink.names(t); contains(names, "prompt.landed") {
		t.Fatal("recorded before the prompt was shown")
	}
	time.Sleep(20 * time.Millisecond)
	// The CLI trims trailing whitespace from what it records.
	c.apply([]sessionio.ModEvent{userRow("fix the build")})

	got := sink.only(t, "prompt.landed")
	post, _ := got["tl.post_ms"].(float64)
	settle, _ := got["tl.settle_ms"].(float64)
	if post < 120 || settle < post+20 {
		t.Fatalf("post %v, settle %v: want post >= 120 and settle >= post+20", post, settle)
	}
	if got["tl.first"] != true || got["tl.hidden"] != true || got["tl.session"] != "demo" {
		t.Fatalf("recorded %v", got)
	}
	if n, _ := got["tl.n"].(float64); n != float64(len("fix the build  ")) {
		t.Fatalf("tl.n %v", got["tl.n"])
	}

	// One row accounts for one prompt.
	c.apply([]sessionio.ModEvent{userRow("fix the build")})
	if n := countOf(sink.names(t), "prompt.landed"); n != 1 {
		t.Fatalf("%d prompt.landed, want 1", n)
	}
}

// Only the composer's first prompt carries a Send time, so only it is timed.
func TestAnOrdinaryPromptIsNotTimed(t *testing.T) {
	sink := captureEvents(t)
	rg, mux := modTurnMux(t, &fakeTurns{})
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	c := rg.mods.conn("wizard", "demo")
	fakeMod(t, c)
	if rec := postTurn(t, mux, "/prompt/demo", `{"text":"again"}`); rec.Code != http.StatusNoContent {
		t.Fatalf("status %d", rec.Code)
	}
	c.apply([]sessionio.ModEvent{userRow("again")})
	if contains(sink.names(t), "prompt.landed") {
		t.Fatal("an ordinary prompt was timed")
	}
}

// A first prompt that never shows (a slash command Claude does not record)
// does not hold its mark forever.
func TestAnUnshownFirstPromptIsForgotten(t *testing.T) {
	c := &modConn{}
	old := time.Now().Add(-firstPromptMarkTTL - time.Second)
	c.markFirstPrompt(firstPromptMark{text: "/clear", sent: old})
	c.markFirstPrompt(firstPromptMark{text: "hello", sent: time.Now()})
	if len(c.firstPrompts) != 1 || c.firstPrompts[0].text != "hello" {
		t.Fatalf("marks %+v", c.firstPrompts)
	}
}

func contains(list []string, s string) bool { return countOf(list, s) > 0 }

func countOf(list []string, s string) int {
	n := 0
	for _, x := range list {
		if x == s {
			n++
		}
	}
	return n
}
