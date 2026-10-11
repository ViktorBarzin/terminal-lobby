package main

import (
	"encoding/json"
	"strings"
	"testing"

	"terminal-lobby/sessionio"
)

func permissionEvent(toolID, agentID, reason string) sessionio.ModEvent {
	return sessionio.ModEvent{
		Type: sessionio.ModPermissionEvent, ToolID: toolID, AgentID: agentID, Tool: "Bash",
		Input:  json.RawMessage(`{"command":"git push origin HEAD:master"}`),
		Reason: reason,
	}
}

// Sessions run in bypass mode still raise "approve this command" now and
// then, and nothing recorded which call asked or why (2026-10-11). The
// mod's permission event carries both, so session-events records it.
func TestAPermissionPromptIsRecordedWithClaudesReason(t *testing.T) {
	sink := captureEvents(t)
	rg, _ := newTestRegistry(t, "wizard/demo")
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	c := rg.mods.conn("wizard", "demo")

	c.apply([]sessionio.ModEvent{permissionEvent("toolu_b1", "", "This command requires approval")})

	got := sink.only(t, "claude.permission_asked")
	want := map[string]any{
		"tl.session": "demo", "tl.tool": "Bash", "tl.tool_id": "toolu_b1",
		"tl.reason": "This command requires approval", "tl.agent": false,
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %v, want %v (all: %v)", k, got[k], v, got)
		}
	}
	for k, v := range got {
		if s, ok := v.(string); ok && strings.Contains(s, "git push") {
			t.Errorf("%s carries the command itself: %q", k, s)
		}
	}
}

// A batch the mod resends, or a level that lists the same dialog again,
// is the same prompt: it counts once.
func TestAPermissionPromptCountsOncePerToolCall(t *testing.T) {
	sink := captureEvents(t)
	rg, _ := newTestRegistry(t, "wizard/demo")
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	c := rg.mods.conn("wizard", "demo")

	ev := permissionEvent("toolu_b1", "", "")
	c.apply([]sessionio.ModEvent{ev})
	c.apply([]sessionio.ModEvent{ev})
	c.apply([]sessionio.ModEvent{permissionEvent("toolu_b2", "", "")})

	if n := countOf(sink.names(t), "claude.permission_asked"); n != 2 {
		t.Fatalf("%d claude.permission_asked, want 2", n)
	}
}

func TestASubagentsPermissionPromptSaysSo(t *testing.T) {
	sink := captureEvents(t)
	rg, _ := newTestRegistry(t, "wizard/demo")
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	c := rg.mods.conn("wizard", "demo")

	c.apply([]sessionio.ModEvent{permissionEvent("toolu_b1", "a1f2", "")})

	if got := sink.only(t, "claude.permission_asked"); got["tl.agent"] != true {
		t.Fatalf("tl.agent = %v, want true", got["tl.agent"])
	}
}

func TestAPermissionReasonIsCapped(t *testing.T) {
	sink := captureEvents(t)
	rg, _ := newTestRegistry(t, "wizard/demo")
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	c := rg.mods.conn("wizard", "demo")

	c.apply([]sessionio.ModEvent{permissionEvent("toolu_b1", "", strings.Repeat("é", 500))})

	got, _ := sink.only(t, "claude.permission_asked")["tl.reason"].(string)
	if n := len([]rune(got)); n != permissionReasonMax {
		t.Fatalf("reason is %d runes, want %d", n, permissionReasonMax)
	}
}
