package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"terminal-lobby/sessionio"
	"terminal-lobby/sessionio/siotest"
)

// modTurnMux is turnMux with the registry handed back, so a test can connect a
// mod for the session first.
func modTurnMux(t *testing.T, f *fakeTurns) (*registry, http.Handler) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	rg := newRegistry(ctx, time.Millisecond, t.TempDir(), siotest.NewFakeOptions("wizard/demo"), "wizard")
	mux := http.NewServeMux()
	mux.HandleFunc("POST /prompt/{session}", handlePrompt(rg, f))
	mux.HandleFunc("POST /cancel/{session}", handleCancel(rg, f))
	mux.HandleFunc("POST /model/{session}", handleModel(f))
	return rg, mux
}

// fakeMod acks every command the connection is sent until the test ends, and
// collects them.
func fakeMod(t *testing.T, c *modConn) func() []modCommand {
	t.Helper()
	got := make(chan modCommand, 64)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			c.mu.Lock()
			cmds := c.cmds
			c.cmds = nil
			c.mu.Unlock()
			for _, cmd := range cmds {
				got <- cmd
				c.deliver(cmd.ID, modAck{OK: true})
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Millisecond):
			}
		}
	}()
	t.Cleanup(func() { cancel(); <-done })
	return func() []modCommand {
		var out []modCommand
		for {
			select {
			case cmd := <-got:
				out = append(out, cmd)
			default:
				return out
			}
		}
	}
}

func TestAClaudePromptGoesThroughItsMod(t *testing.T) {
	f := &fakeTurns{}
	rg, mux := modTurnMux(t, f)
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	sent := fakeMod(t, rg.mods.conn("wizard", "demo"))
	rec := postTurn(t, mux, "/prompt/demo", `{"text":"hello there"}`)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status %d (%s), want 204", rec.Code, rec.Body.String())
	}
	cmds := sent()
	if len(cmds) != 1 || cmds[0].Op != "prompt" || cmds[0].Text != "hello there" {
		t.Fatalf("mod got %+v", cmds)
	}
	if f.called("Prompt") || f.called("CapturePane") {
		t.Fatalf("the pane was touched: %q", f.calls)
	}
}

func TestAClaudePromptWithNoModIsNotReady(t *testing.T) {
	f := &fakeTurns{}
	_, mux := modTurnMux(t, f)
	rec := postTurn(t, mux, "/prompt/demo", `{"text":"hello"}`)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d, want 503", rec.Code)
	}
	if f.called("Prompt") {
		t.Fatal("a prompt was typed into a Claude pane")
	}
}

func TestAFirstPromptWaitsForTheModToSayHello(t *testing.T) {
	f := &fakeTurns{}
	rg, mux := modTurnMux(t, f)
	go func() {
		time.Sleep(30 * time.Millisecond)
		rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
		fakeMod(t, rg.mods.conn("wizard", "demo"))
	}()
	rec := postTurn(t, mux, "/prompt/demo", `{"text":"first","awaitReady":true}`)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status %d (%s), want 204 once the mod connected", rec.Code, rec.Body.String())
	}
}

// A first prompt to a slot whose Claude is still booting is held until the
// hello, however long past PromptReadyWait the boot runs: the browser's
// retries join the same attempt (promptonce.go), so the prompt goes in the
// moment Claude can take it rather than at the next rung of the ladder
// (docs/plans/2026-10-04-warm-slot-at-send-design.md). It says how long it
// waited, which tells the composer a booted slot from a booting one.
func TestAFirstPromptIsHeldUntilAHelloPastTheUsualWait(t *testing.T) {
	f := &fakeTurns{}
	rg, mux := modTurnMux(t, f)
	go func() {
		time.Sleep(PromptReadyWait + 300*time.Millisecond)
		rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
		fakeMod(t, rg.mods.conn("wizard", "demo"))
	}()
	rec := postTurn(t, mux, "/prompt/demo", `{"text":"first","awaitReady":true,"id":"req1"}`)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status %d (%s), want 204 once the mod connected", rec.Code, rec.Body.String())
	}
	waited, err := strconv.Atoi(rec.Header().Get(helloWaitHeader))
	if err != nil || waited < int(PromptReadyWait/time.Millisecond) {
		t.Fatalf("%s = %q, want the wait in ms", helloWaitHeader, rec.Header().Get(helloWaitHeader))
	}
}

func TestAFirstPromptToAConnectedModSaysItDidNotWait(t *testing.T) {
	f := &fakeTurns{}
	rg, mux := modTurnMux(t, f)
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	fakeMod(t, rg.mods.conn("wizard", "demo"))
	rec := postTurn(t, mux, "/prompt/demo", `{"text":"first","awaitReady":true,"id":"req2"}`)
	if rec.Code != http.StatusNoContent || rec.Header().Get(helloWaitHeader) != "0" {
		t.Fatalf("status %d, %s = %q", rec.Code, helloWaitHeader, rec.Header().Get(helloWaitHeader))
	}
}

func TestAPromptToAClaudeOnItsTrustDialogSaysSo(t *testing.T) {
	f := &fakeTurns{pane: "Accessing workspace:\n\n /home/u/x\n\n Do you trust this folder?\n❯ 1. Yes, I trust this folder\n  2. No, exit\n"}
	_, mux := modTurnMux(t, f)
	rec := postTurn(t, mux, "/prompt/demo", `{"text":"hello"}`)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), trustOpenReason) {
		t.Fatalf("status %d (%s), want 409 trust-open", rec.Code, rec.Body.String())
	}
}

func TestAPromptToASuspendedClaudeIsRefused(t *testing.T) {
	f := &fakeTurns{options: map[string]string{sessionio.OptionSuspended: "1790000000"}}
	rg, mux := modTurnMux(t, f)
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	sent := fakeMod(t, rg.mods.conn("wizard", "demo"))
	if rec := postTurn(t, mux, "/prompt/demo", `{"text":"hello"}`); rec.Code != http.StatusConflict {
		t.Fatalf("status %d, want 409", rec.Code)
	}
	if len(sent()) != 0 {
		t.Fatal("a suspended session's mod was sent the prompt")
	}
}

func TestStopGoesThroughTheMod(t *testing.T) {
	f := &fakeTurns{}
	rg, mux := modTurnMux(t, f)
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	sent := fakeMod(t, rg.mods.conn("wizard", "demo"))
	rec := postTurn(t, mux, "/cancel/demo", `{"restoreQueue":["later"]}`)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"restored":false`) {
		t.Fatalf("status %d (%s)", rec.Code, rec.Body.String())
	}
	if cmds := sent(); len(cmds) != 1 || cmds[0].Op != "abort" {
		t.Fatalf("mod got %+v", cmds)
	}
	if f.called("Cancel") || f.called("CancelHarness") || f.called("ClearQueue") {
		t.Fatalf("keys were sent: %q", f.calls)
	}
}

func TestTheStreamSaysNoModUntilHello(t *testing.T) {
	rg, opts := newTestRegistry(t, "wizard/demo")
	if err := opts.SetOption("wizard", "demo", sessionio.OptionState, "done"); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("GET", "/events/demo", nil)
	req.SetPathValue("session", "demo")
	req = req.WithContext(context.WithValue(req.Context(), osUserKey, "wizard"))
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		if !claudeSession(opts, "wizard", "demo") {
			t.Error("a session with a Claude state is not a Claude session")
			return
		}
		serveNoStream(rec, req, rg, time.Hour, noStreamNoMod, nil, 0)
	}()
	time.Sleep(30 * time.Millisecond)
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the stream did not end when the mod said hello")
	}
	if !strings.Contains(rec.Body.String(), "event: nomod") {
		t.Fatalf("body = %q", rec.Body.String())
	}
}
