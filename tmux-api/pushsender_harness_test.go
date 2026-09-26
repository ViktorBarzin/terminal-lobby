package main

import (
	"encoding/json"
	"testing"
)

// A push names the agent that is waiting or finished, from the session's tool,
// instead of calling every one of them Claude. Pi stamps the same session state
// Claude does, so its sessions ring too.
func TestPushWordingNamesTheHarness(t *testing.T) {
	for _, tc := range []struct {
		tool, awaiting, done string
	}{
		{toolClaude, "Claude is awaiting your input.", "Claude finished its turn."},
		{toolPi, "Pi is awaiting your input.", "Pi finished its turn."},
		{toolCodex, "Codex is awaiting your input.", "Codex finished its turn."},
		// A failed process scan leaves the tool empty. Only Claude and pi stamp
		// a state at all, and Claude is by far the likelier, so it keeps the
		// wording every push had before.
		{"", "Claude is awaiting your input.", "Claude finished its turn."},
		{toolShell, "Claude is awaiting your input.", "Claude finished its turn."},
	} {
		var aw, dn map[string]any
		if err := json.Unmarshal(buildPushPayloadFor(tc.tool, "Worktree cleanup", "k7m2q9x4tp0v", 1, nil, testPushOrigin), &aw); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(buildDonePayloadFor(tc.tool, "Worktree cleanup", "k7m2q9x4tp0v", 1, nil, testPushOrigin), &dn); err != nil {
			t.Fatal(err)
		}
		if aw["body"] != tc.awaiting || dn["body"] != tc.done {
			t.Errorf("tool %q: bodies %q / %q, want %q / %q", tc.tool, aw["body"], dn["body"], tc.awaiting, tc.done)
		}
		// The declarative half carries the same words, or an iPhone reads
		// something different from every other device.
		if note, _ := aw["notification"].(map[string]any); note["body"] != tc.awaiting {
			t.Errorf("tool %q: declarative body %q", tc.tool, note["body"])
		}
		// The title is the session's own label either way.
		if aw["title"] != "Worktree cleanup needs input" || dn["title"] != "Worktree cleanup finished" {
			t.Errorf("tool %q: titles %q / %q", tc.tool, aw["title"], dn["title"])
		}
	}
}

// The live stater reads each session's tool out of the same list it reads the
// states from, so naming the harness costs no call of its own.
func TestStatesAndTitlesCarryEachSessionsTool(t *testing.T) {
	states, titles, tools := statesTitlesAndTools([]Session{
		{Name: "a", State: stateRunning, Tool: toolPi, Title: "Pi work"},
		{Name: "b", State: stateDone, Tool: toolClaude},
		{Name: "c", Tool: toolShell},
	})
	if states["a"] != stateRunning || titles["a"] != "Pi work" || tools["a"] != toolPi || tools["b"] != toolClaude {
		t.Fatalf("states %v titles %v tools %v", states, titles, tools)
	}
	if _, ok := titles["b"]; ok {
		t.Errorf("an untitled session is in the titles map: %v", titles)
	}
}
