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

// clearDeadStates drops @claude_state from sessions whose pane has no live
// claude underneath — claude died without firing SessionEnd (kill -9, OOM
// of the claude process alone) and the launcher fell back to a shell. An
// empty tree (failed scan) fails OPEN: better a briefly stale dot than
// blanking every user's indicators.
func clearDeadStates(sessions []Session, t procTree) {
	if len(t.comm) == 0 {
		return
	}
	for i := range sessions {
		if sessions[i].State == "" {
			continue
		}
		if sessions[i].PanePID <= 0 || !t.hasClaudeUnder(sessions[i].PanePID) {
			sessions[i].State = ""
		}
	}
}
