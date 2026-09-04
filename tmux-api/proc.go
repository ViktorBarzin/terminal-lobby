package main

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// procTree is a one-shot snapshot of the process table, used as the
// liveness backstop for @claude_state: a session's state only survives if
// a claude process is still alive under its pane. pane_current_command is
// NOT usable for this — it reports the pane tty's foreground process-group
// leader, which for launcher-started sessions (start-claude.sh runs npx
// without exec, no job control in non-interactive bash) is "bash" even
// while claude runs as a child. That false "it's a shell" reading blanked
// every launcher user's state dot.
type procTree struct {
	children map[int][]int
	comm     map[int]string
}

// procTreeFrom scans procDir (normally /proc) once — a few ms, no forks.
// Processes that exit mid-scan are skipped.
func procTreeFrom(procDir string) (procTree, error) {
	t := procTree{children: map[int][]int{}, comm: map[int]string{}}
	entries, err := os.ReadDir(procDir)
	if err != nil {
		return t, err
	}
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(procDir, e.Name(), "stat"))
		if err != nil {
			continue
		}
		comm, ppid, ok := parseProcStat(string(raw))
		if !ok {
			continue
		}
		t.comm[pid] = comm
		t.children[ppid] = append(t.children[ppid], pid)
	}
	if len(t.comm) == 0 {
		return t, errors.New("empty proc scan")
	}
	return t, nil
}

// parseProcStat extracts (comm) and ppid from a /proc/<pid>/stat line.
// comm may itself contain spaces and parens — it ends at the LAST ')'.
func parseProcStat(s string) (comm string, ppid int, ok bool) {
	open := strings.IndexByte(s, '(')
	close := strings.LastIndexByte(s, ')')
	if open < 0 || close < open {
		return "", 0, false
	}
	// After the comm: "S <ppid> <pgrp> ..."
	fields := strings.Fields(s[close+1:])
	if len(fields) < 2 {
		return "", 0, false
	}
	p, err := strconv.Atoi(fields[1])
	if err != nil {
		return "", 0, false
	}
	return s[open+1 : close], p, true
}

// hasClaudeUnder reports whether pid or any descendant is a claude
// process — the same BFS tmux-persist uses to snapshot conversations.
func (t procTree) hasClaudeUnder(pid int) bool {
	queue := []int{pid}
	for len(queue) > 0 {
		p := queue[0]
		queue = queue[1:]
		if t.comm[p] == "claude" {
			return true
		}
		queue = append(queue, t.children[p]...)
	}
	return false
}

// Tool values on the wire — which command a session is running, for the
// sidebar's tool mark next to the state dot.
const (
	toolClaude = "claude"
	toolCodex  = "codex"
	toolShell  = "shell"
)

// agentComms maps a process comm to its tool. Only the REAL agent processes
// are listed: codex's own wrapper layers report "bash" (the /usr/local/bin
// shell wrapper, which does not exec) and "MainThread" (its node shim), so
// matching the vendored rust binary's comm is what actually identifies it.
var agentComms = map[string]string{
	"claude": toolClaude,
	"codex":  toolCodex,
}

// toolUnder names the tool running under pid: the SHALLOWEST agent in the
// pane's process tree, so a session's own command outranks any agent it
// spawned as a subprocess (a claude that shells out to codex is still a
// claude session, and vice versa). A pane with no agent underneath is a
// shell. Returns "" when pid is unknown to the tree — an unknown pane is not
// evidence of a shell, and the caller renders no mark rather than a wrong one.
//
// Ties at equal depth resolve by agentPrecedence rather than by /proc readdir
// order, so the same tree always yields the same answer.
func (t procTree) toolUnder(pid int) string {
	if _, known := t.comm[pid]; !known {
		return ""
	}
	level := []int{pid}
	for len(level) > 0 {
		found := ""
		next := []int{}
		for _, p := range level {
			if tool, ok := agentComms[t.comm[p]]; ok && (found == "" || agentPrecedence(tool) < agentPrecedence(found)) {
				found = tool
			}
			next = append(next, t.children[p]...)
		}
		if found != "" {
			return found
		}
		level = next
	}
	return toolShell
}

// agentPrecedence breaks depth ties deterministically (lower wins).
func agentPrecedence(tool string) int {
	if tool == toolClaude {
		return 0
	}
	return 1
}

// annotateTools stamps each session's Tool from the pane's process tree. An
// empty tree (failed /proc scan) leaves every Tool empty: no mark at all
// beats relabelling every live agent row as a bare shell.
func annotateTools(sessions []Session, t procTree) {
	if len(t.comm) == 0 {
		return
	}
	for i := range sessions {
		if sessions[i].PanePID <= 0 {
			continue
		}
		sessions[i].Tool = t.toolUnder(sessions[i].PanePID)
	}
}

// clearDeadStates drops @claude_state from sessions whose pane has no live
// claude underneath — claude died without firing SessionEnd (kill -9, OOM
// of the claude process alone) and the launcher fell back to a shell. An
// empty tree (failed scan) fails OPEN: better a briefly stale dot than
// blanking every user's indicators.
//
// The outstanding-work count goes with the state, and for a stronger reason
// than tidiness. Background tasks live INSIDE the claude process, so a claude
// that died took them with it; the ids it left behind can never be retired by
// the notification that would normally do it. This is the backstop that keeps
// such a session from sitting at "running" forever, since there is deliberately
// no expiry on an id (2026-09-04).
func clearDeadStates(sessions []Session, t procTree) {
	if len(t.comm) == 0 {
		return
	}
	for i := range sessions {
		if sessions[i].State == "" && sessions[i].Background == nil {
			continue
		}
		if sessions[i].PanePID <= 0 || !t.hasClaudeUnder(sessions[i].PanePID) {
			sessions[i].State = ""
			sessions[i].Background = nil
		}
	}
}
