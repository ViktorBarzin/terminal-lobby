package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"terminal-lobby/sessionio"
)

// A first prompt carries a request id, and session-events sends each id once.
//
// The browser gives up on a request after 8s (frontend-v2 lib/http.ts) and
// sends the same prompt again, while the server can take longer than that: up
// to 4s waiting for the mod and 10s for its ack. A request the browser gave up
// on also left its command queued for the mod (modConn.send drops only the ack
// waiter). So on a slow link a prompt Claude had taken could be sent twice.

// slowMod acks every command after `delay`, and counts them.
func slowMod(t *testing.T, c *modConn, delay time.Duration) func() int {
	t.Helper()
	var mu sync.Mutex
	n := 0
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		for ctx.Err() == nil {
			c.mu.Lock()
			cmds := c.cmds
			c.cmds = nil
			c.mu.Unlock()
			for _, cmd := range cmds {
				mu.Lock()
				n++
				mu.Unlock()
				go func(id string) {
					time.Sleep(delay)
					c.deliver(id, modAck{OK: true})
				}(cmd.ID)
			}
			time.Sleep(time.Millisecond)
		}
	}()
	t.Cleanup(func() { cancel(); <-done })
	return func() int {
		mu.Lock()
		defer mu.Unlock()
		return n
	}
}

func postPromptCtx(ctx context.Context, h http.Handler, session, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", "/prompt/"+session, strings.NewReader(body))
	req = req.WithContext(context.WithValue(ctx, osUserKey, "wizard"))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestTwoRequestsWithOneIDSendThePromptOnce(t *testing.T) {
	rg, mux := modTurnMux(t, &fakeTurns{})
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	sent := slowMod(t, rg.mods.conn("wizard", "demo"), 50*time.Millisecond)
	body := `{"text":"fix it","awaitReady":true,"id":"r-1"}`

	var wg sync.WaitGroup
	codes := make([]int, 2)
	for i := range codes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes[i] = postTurn(t, mux, "/prompt/demo", body).Code
		}()
	}
	wg.Wait()
	if codes[0] != http.StatusNoContent || codes[1] != http.StatusNoContent {
		t.Fatalf("codes %v, want both 204", codes)
	}
	if rec := postTurn(t, mux, "/prompt/demo", body); rec.Code != http.StatusNoContent {
		t.Fatalf("a retry after success answered %d", rec.Code)
	}
	if n := sent(); n != 1 {
		t.Fatalf("the mod was sent the prompt %d times, want 1", n)
	}
}

// The browser giving up does not abandon the attempt: it runs on, and the
// retry is answered by it.
func TestARetryAfterTheBrowserGaveUpGetsTheFirstAttemptsAnswer(t *testing.T) {
	rg, mux := modTurnMux(t, &fakeTurns{})
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	sent := slowMod(t, rg.mods.conn("wizard", "demo"), 150*time.Millisecond)
	body := `{"text":"fix it","awaitReady":true,"id":"r-2"}`

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	postPromptCtx(ctx, mux, "demo", body) // the browser's deadline passes

	if rec := postTurn(t, mux, "/prompt/demo", body); rec.Code != http.StatusNoContent {
		t.Fatalf("the retry answered %d (%s), want 204", rec.Code, rec.Body.String())
	}
	if n := sent(); n != 1 {
		t.Fatalf("the mod was sent the prompt %d times, want 1", n)
	}
}

// "Not yet" is not remembered: the retry is a fresh attempt.
func TestANotReadyAnswerIsNotReplayed(t *testing.T) {
	rg, mux := modTurnMux(t, &fakeTurns{})
	body := `{"text":"fix it","id":"r-3"}`
	if rec := postTurn(t, mux, "/prompt/demo", body); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d, want 503 with no mod", rec.Code)
	}
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	sent := fakeMod(t, rg.mods.conn("wizard", "demo"))
	if rec := postTurn(t, mux, "/prompt/demo", body); rec.Code != http.StatusNoContent {
		t.Fatalf("the retry answered %d, want 204", rec.Code)
	}
	if len(sent()) != 1 {
		t.Fatal("the retry did not send")
	}
}

// Ids are per user and per session: the same id elsewhere is another prompt.
func TestAnIDIsScopedToItsSession(t *testing.T) {
	rg, mux := modTurnMux(t, &fakeTurns{})
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	rg.mods.hello("wizard", modHello{SID: "sid2", Session: "other", Pane: "%4"})
	a := fakeMod(t, rg.mods.conn("wizard", "demo"))
	b := fakeMod(t, rg.mods.conn("wizard", "other"))
	postTurn(t, mux, "/prompt/demo", `{"text":"x","id":"same"}`)
	postTurn(t, mux, "/prompt/other", `{"text":"y","id":"same"}`)
	if len(a()) != 1 || len(b()) != 1 {
		t.Fatal("the same id on another session was not sent")
	}
}

// A mod that took the command and then went away, or never acked, may still
// submit it: commands in hand go out again to the next hello. Sending it again
// would make two, so that answer is remembered, as 504, and not retried.
func TestAPromptTheModMayStillSubmitIsNotSentAgain(t *testing.T) {
	rg, mux := modTurnMux(t, &fakeTurns{})
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	c := rg.mods.conn("wizard", "demo")
	go func() {
		for {
			c.mu.Lock()
			n := len(c.cmds)
			c.cmds = nil
			c.mu.Unlock()
			if n > 0 {
				c.apply([]sessionio.ModEvent{{Type: sessionio.ModByeEvent}})
				return
			}
			time.Sleep(time.Millisecond)
		}
	}()
	body := `{"text":"fix it","id":"r-5"}`
	if rec := postTurn(t, mux, "/prompt/demo", body); rec.Code != http.StatusGatewayTimeout {
		t.Fatalf("status %d (%s), want 504", rec.Code, rec.Body.String())
	}
	if rec := postTurn(t, mux, "/prompt/demo", body); rec.Code != http.StatusGatewayTimeout {
		t.Fatalf("the retry answered %d, want the remembered 504", rec.Code)
	}
}

func TestABadIDIsRefused(t *testing.T) {
	_, mux := modTurnMux(t, &fakeTurns{})
	for _, id := range []string{`"a b"`, `"` + strings.Repeat("x", 65) + `"`} {
		if rec := postTurn(t, mux, "/prompt/demo", `{"text":"x","id":`+id+`}`); rec.Code != http.StatusBadRequest {
			t.Errorf("id %s: status %d, want 400", id, rec.Code)
		}
	}
}
