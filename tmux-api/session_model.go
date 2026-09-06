package main

import "strings"

type Session struct {
	// ID is tmux's own session id ($0, $1, …). It survives a rename, which
	// nothing else about a session does, so a client that had this session
	// selected can follow it to its new name rather than holding a name whose
	// attach would create a fresh empty session. omitempty keeps the old wire
	// shape for consumers that predate it.
	ID       string `json:"id,omitempty"`
	Name     string `json:"name"`
	Attached int    `json:"attached"`
	// Driven is true when at least one attached client is READ-WRITE.
	// Distinct from Attached, which counts watchers too: the lobby joins a
	// new device as a viewer only when someone is actually driving.
	Driven       bool  `json:"driven"`
	LastActivity int64 `json:"lastActivity"`
	// LastDrive is when a human last had hands on this session: the newest
	// moment a READ-WRITE client was attached, kept in @last_drive (lastdrive.go).
	// This is what the session list shows, NOT LastActivity — tmux bumps
	// session_activity on any attach, a read-only one included, so a viewer used
	// to reset the number just by looking. Seeded from Created for a session that
	// has not been driven since the option existed, so it is never empty.
	LastDrive int64 `json:"lastDrive"`
	Created   int64 `json:"created"`
	// State of the Claude conversation inside the session: "running",
	// "awaiting", "done", or "" when no live Claude. omitempty keeps the
	// old wire shape for stateless sessions (external /sessions pollers).
	State string `json:"state,omitempty"`
	// Project the session is assigned to (global project store); "" =
	// ungrouped.
	Project string `json:"project,omitempty"`
	// Owner is the OS user whose server the session runs on. For the caller's
	// own sessions this is the caller; for a foreign session surfaced via a
	// shared project or a direct share it is the real owner. omitempty keeps
	// the old wire shape for external pollers of their own sessions.
	Owner string `json:"owner,omitempty"`
	// Access is how the CALLER may attach a foreign session: "ro" (watch) or
	// "rw" (drive-as-owner). Empty for the caller's own sessions (full control).
	Access string `json:"access,omitempty"`
	// Command/PaneTitle mirror the active pane's #{pane_current_command} /
	// #{pane_title} (Task 2.5): the lobby's live-command chip and the
	// attached-tab title read them. omitempty keeps the old wire shape
	// for consumers that predate the fields.
	Command   string `json:"pane_current_command,omitempty"`
	PaneTitle string `json:"pane_title,omitempty"`
	// Title is the DISPLAY TITLE a person chose — arbitrary text, up to 64
	// runes, read from the session's @title option. Distinct from PaneTitle,
	// which whatever is running in the pane sets for itself. Empty means the
	// session has no title and its name is what gets shown, which is where
	// every session that predates the feature sits.
	Title string `json:"title,omitempty"`
	// BornAs is the name this session was FIRST created with, present only on
	// a session that has since been renamed (sessionio.OptionBornAs). It is
	// how a client that never saw the session under its original name still
	// finds it: ADR-0022 renames a fresh session seconds after creation, often
	// before any poll has listed it, and a browser holding the name it minted
	// has nothing else to match on. Empty for a session that never moved.
	BornAs string `json:"bornAs,omitempty"`
	// Tool is WHICH command the session runs — "claude", "codex" or "shell"
	// — resolved from the pane's process tree (proc.go), never from Command:
	// both agents launch through non-exec wrapper scripts, so the pane's
	// foreground pgroup leader is a shell while the agent runs underneath.
	// The lobby renders it as a brand mark beside the state dot. Empty when
	// the /proc scan failed (no mark) — omitempty keeps the old wire shape.
	Tool string `json:"tool,omitempty"`
	// Background is the session's OUTSTANDING WORK, counted by kind. Present
	// only when there is some, so a session that backgrounded nothing serves
	// the object it always did.
	//
	// It is what stops State reading "done" the moment the main turn ends: a
	// background agent, a workflow or a background command keeps producing
	// output long after Stop fires, and the session will speak again with
	// nobody prompting it. State stays "running" for as long as this is
	// non-nil, which every consumer of State already handles.
	Background *Background `json:"bg,omitempty"`
	// PanePID is the session's active-pane process — internal input to
	// the claude-liveness backstop (proc.go), never serialized.
	PanePID int `json:"-"`
}

// Background counts what a session is waiting on, by kind, so the sidebar can
// tell a 30-second command from a 30-minute workflow rather than showing one
// undifferentiated number.
type Background struct {
	Agents    int `json:"agents,omitempty"`
	Commands  int `json:"commands,omitempty"`
	Workflows int `json:"workflows,omitempty"`
}

// parseBackground reads the hook's `<kind>:<id>` tokens (sessionio.OptionBackground).
// nil means nothing is outstanding, which is the overwhelmingly common case and
// the one the wire shape is optimised for.
//
// A token whose kind this does not know counts as nothing. The hook validates
// every id before writing it, so an unrecognised shape came from somewhere else,
// and treating it as work would hold the session at "running" with no event able
// to retire it.
func parseBackground(tokens string) *Background {
	var b Background
	for _, tok := range strings.Fields(tokens) {
		kind, id, ok := strings.Cut(tok, ":")
		if !ok || id == "" {
			continue
		}
		switch kind {
		case "a":
			b.Agents++
		case "b":
			b.Commands++
		case "w":
			b.Workflows++
		}
	}
	if b == (Background{}) {
		return nil
	}
	return &b
}

// Claude state values as stamped into @claude_state by the hook script.
const (
	stateRunning  = "running"
	stateAwaiting = "awaiting"
	stateDone     = "done"
)

var knownStates = map[string]bool{stateRunning: true, stateAwaiting: true, stateDone: true}
