package main

import (
	"os"
	"strings"
	"testing"
)

// A mid-turn send queues in Claude, so the lobby's turn gate went away.
//
// The rule was first written for two surfaces — this service's POST /prompt and
// the T3 bridge's Attacher.Send — and the bridge is gone (ADR-0029), leaving
// this the only sender. The test stays because the gate is easy to reintroduce
// by reflex: a prompt that arrives mid-turn belongs in Claude's own queue, and
// answering 409 instead loses it with no way for the composer to say why.
//
// The TURN STATE is what must not be read here. One 409 does live in the
// handler — a session the idle sweep suspended, which has no Claude to queue
// anything (TestPromptRefusesASuspendedSession) — so this asks about the state
// rather than about the status code.
func TestPromptDoesNotGateOnTheTurnState(t *testing.T) {
	raw, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	prompt := promptHandler(t, string(raw))
	for _, gate := range []string{"StateRunning", "injector.State(", "sessionio.OptionAsk"} {
		if strings.Contains(prompt, gate) {
			t.Errorf("POST /prompt gates on %s, which is the turn state again:\n%s", gate, prompt)
		}
	}
}

// promptHandler is POST /prompt and nothing else.
//
// Bounded by the handler REGISTERED NEXT rather than by /cancel, which is nine
// handlers further down: a section that wide answers questions about the wrong
// code, and two of those handlers do read the turn state for their own
// reasons.
func promptHandler(t *testing.T, body string) string {
	t.Helper()
	return section(t, body, `web.HandleFunc("POST /prompt/{session}"`, `web.HandleFunc("GET /earlier/{session}"`)
}

// section returns the text between two markers, for a handler that lives inline
// in main().
func section(t *testing.T, body, from, to string) string {
	t.Helper()
	i := strings.Index(body, from)
	if i < 0 {
		t.Fatalf("main.go has no %q handler any more", from)
	}
	rest := body[i:]
	if j := strings.Index(rest, to); j > 0 {
		return rest[:j]
	}
	return rest
}

// A prompt is refused for a session the idle sweep put to sleep, and the check
// runs BEFORE the injection.
//
// Source assertions for the reason the file's other tests give: the handler
// lives inline in main() and the mux cannot be built from a test.
//
// The failure it guards is silent in two different ways, both measured on tmux
// 3.4, 2026-09-19. Into a DEAD pane, `send-keys` exits 0 and the text
// disappears (paste-buffer does answer "target pane has exited", so the caller
// sees a 502 rather than a loss). Into a pane whose wrapper shell OUTLIVED its
// Claude — the tmux-persist shape, which is every session on the box after a
// reboot — both succeed and the message is typed at a bash prompt and RUN as a
// shell command. Neither is something awaitReady can see: a frozen scrollback
// still shows a settled prompt.
func TestPromptRefusesASuspendedSession(t *testing.T) {
	raw, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	prompt := promptHandler(t, string(raw))

	guard := strings.Index(prompt, "sessionio.OptionSuspended")
	inject := strings.Index(prompt, "injector.Prompt(")
	if guard < 0 {
		t.Fatalf("POST /prompt no longer reads %s, so a prompt into a suspended session is accepted and lost:\n%s",
			"sessionio.OptionSuspended", prompt)
	}
	if inject < 0 {
		t.Fatalf("POST /prompt no longer injects:\n%s", prompt)
	}
	if guard > inject {
		t.Error("the suspended check runs after the injection, which is no check at all")
	}
	if !strings.Contains(prompt[guard:inject], "StatusConflict") {
		t.Error("a prompt into a suspended session is not answered 409")
	}
}
