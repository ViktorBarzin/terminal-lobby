package main

import (
	"terminal-lobby/sessionio"
	"terminal-lobby/telemetry"
)

// permissionReasonMax caps Claude's reason for asking, in runes.
const permissionReasonMax = 200

// permissionAsked records a permission prompt the mod is holding
// (`claude.permission_asked`).
//
// Sessions started with --dangerously-skip-permissions still raised the
// mod's "approve this command" dialog now and then (2026-10-11), and nothing
// said which call asked or why: Claude Code's own telemetry logs the mod's
// dialog as an AskUserQuestion, never as the tool it guards. The reason is
// Claude Code's own words for why the call needs approval, not conversation
// content; the command stays out, and tl.tool_id finds it in the transcript.
//
// Called before the event is folded into c.st, so an open dialog for the same
// call means a resent batch, which records nothing.
func (c *modConn) permissionAsked(ev sessionio.ModEvent) {
	if ev.Type != sessionio.ModPermissionEvent || ev.ToolID == "" {
		return
	}
	c.mu.Lock()
	_, seen := c.st.dialogs[ev.ToolID]
	c.mu.Unlock()
	if seen {
		return
	}
	reason := []rune(ev.Reason)
	if len(reason) > permissionReasonMax {
		reason = reason[:permissionReasonMax]
	}
	events.Emit("claude.permission_asked", c.user, telemetry.Attrs{
		"tl.session": c.sessionName(),
		"tl.tool":    ev.Tool,
		"tl.tool_id": ev.ToolID,
		"tl.reason":  string(reason),
		"tl.agent":   ev.AgentID != "",
	})
}
