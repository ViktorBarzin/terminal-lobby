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

// The bob pattern that broke the pane_current_command backstop:
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

// toolUnder answers "which tool is this session running" from the process
// tree, because pane_current_command cannot: BOTH agents ship non-exec
// wrapper scripts, so the pane's foreground pgroup leader is a shell while
// the agent runs underneath. The codex tree below is the REAL one observed on
// the devvm 2026-08-02:
//
//	bash /usr/local/bin/codex   (wrapper script, no exec)
//	└─ node /usr/bin/codex      (comm "MainThread")
//	   └─ codex                 (the vendored rust binary)
//	      └─ codex-code-mode    (host helper)
func TestToolUnder(t *testing.T) {
	dir := writeFakeProc(t, map[int]struct {
		comm string
		ppid int
	}{
		// pane IS the agent (direct exec)
		100: {"claude", 1},
		// bob launcher pattern: bash wrapper -> npx shim -> claude
		200: {"bash", 1},
		201: {"node", 200},
		202: {"claude", 201},
		// the real codex tree behind its bash wrapper
		300: {"zsh", 1},
		301: {"bash", 300},
		302: {"MainThread", 301},
		303: {"codex", 302},
		304: {"codex-code-mode", 303},
		// plain interactive shell, no agent at all
		400: {"zsh", 1},
		401: {"vim", 400},
		// claude session that spawned codex as a subagent: the SESSION's own
		// command is the shallower one and must win
		500: {"claude", 1},
		501: {"bash", 500},
		502: {"codex", 501},
		// and the mirror image: codex driving claude
		600: {"codex", 1},
		601: {"claude", 600},
		// both at the SAME depth — resolution must be deterministic, not
		// dependent on /proc readdir order
		700: {"zsh", 1},
		701: {"codex", 700},
		702: {"claude", 700},
	})
	tree, err := procTreeFrom(dir)
	if err != nil {
		t.Fatalf("procTreeFrom: %v", err)
	}
	cases := []struct {
		name string
		pane int
		want string
	}{
		{"pane is claude", 100, toolClaude},
		{"claude under a non-exec bash wrapper", 200, toolClaude},
		{"codex under its wrapper + node", 300, toolCodex},
		{"no agent anywhere under the pane", 400, toolShell},
		{"claude outranks the codex it spawned", 500, toolClaude},
		{"codex outranks the claude it spawned", 600, toolCodex},
		{"tie at equal depth resolves to claude", 700, toolClaude},
		{"unknown pane pid is not reported as a shell", 0, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tree.toolUnder(tc.pane); got != tc.want {
				t.Fatalf("toolUnder(%d) = %q, want %q", tc.pane, got, tc.want)
			}
		})
	}
}

func TestAnnotateTools(t *testing.T) {
	dir := writeFakeProc(t, map[int]struct {
		comm string
		ppid int
	}{
		100: {"bash", 1},
		101: {"claude", 100},
		200: {"bash", 1},
		201: {"codex", 200},
		300: {"zsh", 1},
	})
	tree, err := procTreeFrom(dir)
	if err != nil {
		t.Fatal(err)
	}
	sessions := []Session{
		{Name: "agent", PanePID: 100},
		{Name: "codex", PanePID: 200},
		{Name: "plain", PanePID: 300},
		{Name: "no-pane", PanePID: 0},
	}
	annotateTools(sessions, tree)
	want := []string{toolClaude, toolCodex, toolShell, ""}
	for i, w := range want {
		if sessions[i].Tool != w {
			t.Fatalf("%s: Tool = %q, want %q", sessions[i].Name, sessions[i].Tool, w)
		}
	}
}

// A failed /proc scan must leave Tool EMPTY rather than call every session a
// shell: an empty field renders no icon, whereas a blanket "shell" would
// silently relabel every live agent row as a bare terminal.
func TestAnnotateToolsLeavesToolEmptyOnFailedScan(t *testing.T) {
	sessions := []Session{{Name: "s", PanePID: 100}}
	annotateTools(sessions, procTree{children: map[int][]int{}, comm: map[int]string{}})
	if sessions[0].Tool != "" {
		t.Fatalf("failed scan must not guess a tool, got %q", sessions[0].Tool)
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

// @claude_state is stamped by CLAUDE's hooks only, so the liveness backstop
// stays claude-specific even though tool detection now knows about codex: a
// codex session must not keep a stale state left behind by a claude that ran
// in that pane earlier, and a claude nested under codex still counts as live.
func TestClearDeadStatesIgnoresCodex(t *testing.T) {
	dir := writeFakeProc(t, map[int]struct {
		comm string
		ppid int
	}{
		100: {"bash", 1},
		101: {"codex", 100}, // codex only: no live claude behind the state
		200: {"codex", 1},
		201: {"claude", 200}, // claude under codex: still live
	})
	tree, err := procTreeFrom(dir)
	if err != nil {
		t.Fatal(err)
	}
	sessions := []Session{
		{Name: "codex-only", State: "done", PanePID: 100},
		{Name: "claude-under-codex", State: "running", PanePID: 200},
	}
	clearDeadStates(sessions, tree)
	if sessions[0].State != "" {
		t.Fatalf("codex-only session kept a claude state: %+v", sessions[0])
	}
	if sessions[1].State != "running" {
		t.Fatalf("claude under codex was treated as dead: %+v", sessions[1])
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
