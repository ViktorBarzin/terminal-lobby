package main

import (
	"testing"
	"time"
)

// What the wait DOES, and that POST /prompt asks for it only when told to, is
// tested against the route itself in turn_routes_test.go and against a real
// tmux server in sessionio's ready_test.go.

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
