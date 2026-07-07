package main

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// fabricated /proc: pid -> (comm, ppid)
func writeFakeProc(t *testing.T, procs map[int]struct {
	comm string
	ppid int
}) string {
	t.Helper()
	dir := t.TempDir()
	for pid, p := range procs {
		pdir := filepath.Join(dir, strconv.Itoa(pid))
		if err := os.MkdirAll(pdir, 0o755); err != nil {
			t.Fatal(err)
		}
		// Real /proc/<pid>/stat shape: pid (comm) state ppid pgrp ...
		stat := strconv.Itoa(pid) + " (" + p.comm + ") S " + strconv.Itoa(p.ppid) + " 1 1 0 -1 0 0\n"
		if err := os.WriteFile(filepath.Join(pdir, "stat"), []byte(stat), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// The emo pattern that broke the pane_current_command backstop:
// pane(bash start-claude.sh) -> npx(node) -> claude. The pane command says
// "bash", but claude is alive underneath — state must be KEPT.
func TestHasClaudeUnderFindsDeepDescendant(t *testing.T) {
	dir := writeFakeProc(t, map[int]struct {
		comm string
		ppid int
	}{
		100: {"bash", 1},   // pane: start-claude.sh
		101: {"node", 100}, // npx shim
		102: {"claude", 101},
		200: {"zsh", 1},    // pane: plain shell, no claude
		300: {"claude", 1}, // pane IS claude (direct exec)
		// comm with spaces and parens must not break stat parsing
		400: {"weird) (comm", 1},
	})
	tree, err := procTreeFrom(dir)
	if err != nil {
		t.Fatalf("procTreeFrom: %v", err)
	}
	if !tree.hasClaudeUnder(100) {
		t.Fatal("claude under bash wrapper (pane 100) not found")
	}
	if tree.hasClaudeUnder(200) {
		t.Fatal("plain shell (pane 200) must have no claude")
	}
	if !tree.hasClaudeUnder(300) {
		t.Fatal("pane that IS claude (300) not found")
	}
	if got := tree.comm[400]; got != "weird) (comm" {
		t.Fatalf("hostile comm parsed as %q", got)
	}
}

func TestClearDeadStates(t *testing.T) {
	dir := writeFakeProc(t, map[int]struct {
		comm string
		ppid int
	}{
		100: {"bash", 1},
		101: {"claude", 100},
		200: {"zsh", 1}, // claude died, shell remains, hook never fired
	})
	tree, err := procTreeFrom(dir)
	if err != nil {
		t.Fatal(err)
	}
	sessions := []Session{
		{Name: "alive", State: "running", PanePID: 100},
		{Name: "dead", State: "running", PanePID: 200},
		{Name: "stateless", State: "", PanePID: 200},
		{Name: "no-pane", State: "done", PanePID: 0},
	}
	clearDeadStates(sessions, tree)
	if sessions[0].State != "running" {
		t.Fatalf("alive session cleared: %+v", sessions[0])
	}
	if sessions[1].State != "" {
		t.Fatalf("dead session kept state: %+v", sessions[1])
	}
	if sessions[2].State != "" {
		t.Fatalf("stateless session grew state: %+v", sessions[2])
	}
	if sessions[3].State != "" {
		t.Fatalf("pane-less session kept state: %+v", sessions[3])
	}
}

// An empty/failed proc scan must FAIL OPEN (keep hook states) — clearing
// everything because /proc was unreadable would blank every dot.
func TestClearDeadStatesFailsOpenOnEmptyTree(t *testing.T) {
	sessions := []Session{{Name: "s", State: "running", PanePID: 100}}
	clearDeadStates(sessions, procTree{children: map[int][]int{}, comm: map[int]string{}})
	if sessions[0].State != "running" {
		t.Fatalf("empty tree must not clear states: %+v", sessions[0])
	}
}

// Smoke against the real /proc on this box: our own process must be present
// with a non-empty comm.
func TestProcTreeFromRealProc(t *testing.T) {
	tree, err := procTreeFrom("/proc")
	if err != nil {
		t.Skipf("/proc not readable: %v", err)
	}
	if tree.comm[os.Getpid()] == "" {
		t.Fatalf("own pid %d missing from proc tree", os.Getpid())
	}
}
