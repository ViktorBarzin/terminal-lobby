package main

import (
	"os"
	"strings"
	"testing"
	"time"
)

// The first prompt of a session waits for the pane to be able to take it.
//
// Source assertions, like TestPromptDoesNotGateOnTheTurnState next door and for
// the same reason: the handler lives inline in main(), so the mux cannot be
// built from a test. What the wait itself DOES is covered where it lives, in
// sessionio's ready_test.go, against a real tmux server.
//
// The failure this guards is silent, which is why it is pinned at all. A
// session tmux has created accepts send-keys seconds before the Claude in it is
// reading them: `tmux send-keys` exits 0, this route answers 204, and the text
// never reaches the conversation. Measured 2026-09-04 by injecting at fixed
// offsets from creation — lost at +0s and +1s, landed at +2s and +3s.
func TestPromptCanWaitForThePaneToBeReady(t *testing.T) {
	raw, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	prompt := section(t, string(raw), "POST /prompt/{session}", "POST /cancel/{session}")

	for _, want := range []string{
		`AwaitReady bool `,          // the caller can ask
		"injector.AwaitInputReady(", // through sessionio's own check
		"PromptReadyWait",           // bounded
		"StatusServiceUnavailable",  // and says "come back" rather than injecting
	} {
		if !strings.Contains(prompt, want) {
			t.Errorf("POST /prompt no longer has %q:\n%s", want, prompt)
		}
	}
}

// Off by default. Every caller but the first prompt of a session is talking to
// a pane someone is already looking at, and the check costs a capture-pane per
// tick — so a body that does not ask must reach the injector unchanged.
func TestWaitingIsOptIn(t *testing.T) {
	raw, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	prompt := section(t, string(raw), "POST /prompt/{session}", "POST /cancel/{session}")
	guard := strings.Index(prompt, "if body.AwaitReady {")
	inject := strings.Index(prompt, "injector.Prompt(")
	if guard < 0 || inject < 0 {
		t.Fatalf("POST /prompt no longer guards the wait or no longer injects:\n%s", prompt)
	}
	if guard > inject {
		t.Error("the readiness wait runs after the injection, which is no wait at all")
	}
	if !strings.Contains(prompt[guard:inject], "AwaitInputReady") {
		t.Error("the AwaitReady guard no longer wraps the readiness wait")
	}
}

// The wait has to fit inside the ladder that retries it. Four rungs at
// 700/1600/3000/6000ms carry the retries; a wait longer than the last rung
// would mean the caller gave up before this answered.
func TestTheWaitFitsInsideTheLaddersLastRung(t *testing.T) {
	if PromptReadyWait <= 0 || PromptReadyWait > 6*time.Second {
		t.Errorf("PromptReadyWait = %s, which does not fit a 6s last rung", PromptReadyWait)
	}
	if PromptReadyPoll <= 0 || PromptReadyPoll > PromptReadyWait {
		t.Errorf("PromptReadyPoll = %s, which cannot tick inside a %s wait",
			PromptReadyPoll, PromptReadyWait)
	}
}
