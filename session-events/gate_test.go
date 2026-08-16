package main

import (
	"os"
	"strings"
	"testing"
)

// Decision 9 of the T3 bridge design: a mid-turn send queues in Claude, on BOTH
// surfaces, and the lobby's turn gate goes away.
//
// The two surfaces reach the same pane by different routes — this service's
// POST /prompt and the bridge's Attacher.Send — so nothing in either one can
// observe the other. This test pins the halves to each other the way the
// sentinel constant is pinned across the same boundary: the bridge says
// out loud that it does not read @claude_state, and so must this.
//
// What it is guarding against is not a crash. It is the same prompt at the same
// moment running from T3 and being refused with 409 from the lobby composer,
// which is a difference nobody can explain from either window.
func TestPromptDoesNotGateOnTheTurnState(t *testing.T) {
	raw, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	body := string(raw)
	prompt := section(t, body, "POST /prompt/{session}", "POST /cancel/{session}")
	if strings.Contains(prompt, "StatusConflict") || strings.Contains(prompt, "StateRunning") {
		t.Errorf("POST /prompt still gates on the turn state:\n%s", prompt)
	}

	bridge, err := os.ReadFile("../t3-bridge/attach.go")
	if err != nil {
		t.Skipf("the bridge is not in this tree: %v", err)
	}
	if !strings.Contains(string(bridge), "reads @claude_state — gating on it is what the lobby's old 409 did") {
		t.Error("t3-bridge/attach.go no longer states that Send is ungated; the two surfaces may have drifted")
	}
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
