package main

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestWhyASessionHasNoStream(t *testing.T) {
	const lobbyStart = `/bin/zsh -lic "claude --dangerously-skip-permissions"`
	cases := []struct {
		name    string
		stamped bool
		panes   []paneProc
		want    noStream
	}{
		{"a plain shell", false, []paneProc{{Cmd: "zsh"}}, noStreamShell},
		{"a pi session", false, []paneProc{{Cmd: "pi", Start: "pi"}}, noStreamShell},
		{"a new Claude before its hello", false, []paneProc{{Cmd: "claude", Start: lobbyStart}}, noStreamStarting},
		// The login shell runs .zshrc before it execs claude, so the pane's
		// command reads zsh for the first second of a new session.
		{"a login shell about to exec claude", false, []paneProc{{Cmd: "zsh", Start: lobbyStart}}, noStreamStarting},
		{"a Claude from before the mod", true, []paneProc{{Cmd: "claude", Start: lobbyStart}}, noStreamNoMod},
		{"a Claude that exited", true, []paneProc{{Cmd: "zsh", Start: `zsh -lic 'claude --resume 4ad6'`}}, noStreamExited},
		{"a Claude run by hand and quit", true, []paneProc{{Cmd: "zsh"}}, noStreamExited},
		{"a Claude in a second pane", true, []paneProc{{Cmd: "zsh"}, {Cmd: "claude"}}, noStreamNoMod},
		// Panes that could not be read say nothing, so the stamps decide as
		// they did before.
		{"stamped, panes unreadable", true, nil, noStreamNoMod},
		{"unstamped, panes unreadable", false, nil, noStreamShell},
	}
	for _, c := range cases {
		if got := classifyNoStream(c.stamped, c.panes); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

// serveUntilHello runs serveNoStream until the mod says hello `after` in, and
// returns what the stream carried.
func serveUntilHello(t *testing.T, why noStream, recheck func() noStream, startingFor, after time.Duration) string {
	t.Helper()
	rg, _ := newTestRegistry(t, "wizard/demo")
	req := httptest.NewRequest("GET", "/events/demo", nil)
	req.SetPathValue("session", "demo")
	req = req.WithContext(context.WithValue(req.Context(), osUserKey, "wizard"))
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		serveNoStream(rec, req, rg, time.Hour, why, recheck, startingFor)
	}()
	time.Sleep(after)
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the stream did not end when the mod said hello")
	}
	return rec.Body.String()
}

func TestAStartingClaudeHoldsTheStreamUntilItsHello(t *testing.T) {
	body := serveUntilHello(t, noStreamStarting, func() noStream { return noStreamStarting }, time.Hour, 30*time.Millisecond)
	if !strings.Contains(body, "event: starting") {
		t.Fatalf("no starting frame: %q", body)
	}
	if strings.Contains(body, "event: nomod") {
		t.Fatalf("a Claude that said hello in time was called mod-less: %q", body)
	}
}

func TestAStartingClaudeWithNoHelloInTimeGetsTheNoModNote(t *testing.T) {
	body := serveUntilHello(t, noStreamStarting, func() noStream { return noStreamStarting }, 10*time.Millisecond, 80*time.Millisecond)
	s, n := strings.Index(body, "event: starting"), strings.Index(body, "event: nomod")
	if s < 0 || n < s {
		t.Fatalf("want starting then nomod: %q", body)
	}
	if !strings.Contains(body[n:], `"restart":"when-idle"`) {
		t.Fatalf("the nomod frame lost its restart note: %q", body[n:])
	}
}

func TestAStartingClaudeThatExitsSaysClaudeIsNotRunning(t *testing.T) {
	body := serveUntilHello(t, noStreamStarting, func() noStream { return noStreamExited }, 10*time.Millisecond, 80*time.Millisecond)
	n := strings.Index(body, "event: nomod")
	if n < 0 || !strings.Contains(body[n:], `"claude":"exited"`) {
		t.Fatalf("want a nomod frame saying Claude exited: %q", body)
	}
	if strings.Contains(body[n:], "when-idle") {
		t.Fatalf("an exited Claude was promised a restart: %q", body[n:])
	}
}

func TestAnExitedClaudeIsNotPromisedARestart(t *testing.T) {
	body := serveUntilHello(t, noStreamExited, nil, 0, 30*time.Millisecond)
	if !strings.Contains(body, "event: nomod") || !strings.Contains(body, `"claude":"exited"`) || strings.Contains(body, "when-idle") {
		t.Fatalf("body = %q", body)
	}
}
