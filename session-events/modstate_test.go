package main

import (
	"encoding/json"
	"sort"
	"strings"
	"testing"
	"time"

	"terminal-lobby/sessionio"
)

var stampNow = time.Unix(1790900000, 0)

func promptRow() sessionio.ModEvent {
	return sessionio.ModEvent{Type: sessionio.ModRowEvent, Door: "prompt",
		Message: &sessionio.ModMessage{Type: "user", Role: "user", Content: json.RawMessage(`[{"type":"text","text":"hi"}]`)}}
}

func writeKeys(w stampWrite) string {
	var k []string
	for name, v := range w.set {
		k = append(k, name+"="+v)
	}
	for _, name := range w.unset {
		k = append(k, "-"+name)
	}
	sort.Strings(k)
	return strings.Join(k, " ")
}

func TestStampPromptRunsAndTurnEndIsDone(t *testing.T) {
	var s stampState
	w := s.apply(promptRow(), stampNow)
	if got := writeKeys(w); got != "@claude_state=running @last_activity=1790900000" {
		t.Fatalf("prompt writes %q", got)
	}
	w = s.apply(sessionio.ModEvent{Type: sessionio.ModTurnEndEvent, Answer: "all done;"}, stampNow)
	if w.set["@claude_state"] != "done" || w.set["@claude_reply"] != `1790900000 all done;` {
		t.Fatalf("turn_end writes %v", w.set)
	}
}

func TestStampDialogAwaitsUntilSettled(t *testing.T) {
	var s stampState
	s.apply(promptRow(), stampNow)
	w := s.apply(sessionio.ModEvent{Type: sessionio.ModPlanEvent, ToolID: "toolu_p"}, stampNow)
	if got := writeKeys(w); got != "@claude_ask=toolu_p @claude_state=awaiting" {
		t.Fatalf("plan writes %q", got)
	}
	// A tool call in flight elsewhere must not move it off awaiting.
	s.apply(sessionio.ModEvent{Type: sessionio.ModTurnStartEvent}, stampNow)
	if s.state != "awaiting" {
		t.Fatalf("state = %s while the dialog is up", s.state)
	}
	w = s.apply(sessionio.ModEvent{Type: sessionio.ModSettledEvent, ToolID: "toolu_p"}, stampNow)
	if got := writeKeys(w); got != "-@claude_ask @claude_state=running" {
		t.Fatalf("settled writes %q", got)
	}
}

func TestStampBackgroundWorkKeepsTheSessionRunning(t *testing.T) {
	var s stampState
	s.apply(promptRow(), stampNow)
	s.apply(sessionio.ModEvent{Type: sessionio.ModDeltaEvent, AgentID: "abc", Text: "working"}, stampNow)
	s.apply(sessionio.ModEvent{Type: sessionio.ModAgentsEvent, Agents: []sessionio.ModAgent{
		{ID: "abc", Type: "teammate", Status: "running", Name: "sleeper"},
		{ID: "wf1", Type: "workflow", Status: "running"},
		{ID: "old", Type: "subagent", Status: "completed"},
	}}, stampNow)
	w := s.apply(sessionio.ModEvent{Type: sessionio.ModTurnEndEvent}, stampNow)
	if s.state != "running" || s.bg != "t:sleeper w:wf1" {
		t.Fatalf("state %s bg %q after turn_end with work outstanding (writes %v)", s.state, s.bg, w.set)
	}
	// The teammate goes idle but stays listed as running: it no longer counts.
	s.apply(sessionio.ModEvent{Type: sessionio.ModTurnEndEvent, AgentID: "abc"}, stampNow)
	if s.bg != "w:wf1" {
		t.Fatalf("bg = %q after the teammate's loop ended", s.bg)
	}
	w = s.apply(sessionio.ModEvent{Type: sessionio.ModAgentsEvent, Agents: []sessionio.ModAgent{
		{ID: "abc", Type: "teammate", Status: "running", Name: "sleeper"},
	}}, stampNow)
	if got := writeKeys(w); got != "-@claude_bg @claude_state=done" {
		t.Fatalf("work finishing writes %q", got)
	}
}

func TestStampSubagentEventsLeaveTheMainThreadAlone(t *testing.T) {
	var s stampState
	s.apply(promptRow(), stampNow)
	w := s.apply(sessionio.ModEvent{Type: sessionio.ModTurnEndEvent, AgentID: "a1"}, stampNow)
	if !w.empty() || s.state != "running" {
		t.Fatalf("subagent turn_end wrote %v, state %s", w.set, s.state)
	}
}

func TestStampToolInFlightAndPushNotice(t *testing.T) {
	var s stampState
	s.apply(promptRow(), stampNow)
	w := s.apply(sessionio.ModEvent{Type: sessionio.ModRowEvent, Door: "response", Message: &sessionio.ModMessage{
		Type: "assistant", Role: "assistant",
		Content: json.RawMessage(`[{"type":"tool_use","id":"toolu_n","name":"PushNotification","input":{"message":"build is green"}}]`),
	}}, stampNow)
	if w.set["@claude_tool"] != "toolu_n" || w.set["@claude_notice"] != "1790900000 build is green" {
		t.Fatalf("tool_use writes %v", w.set)
	}
	w = s.apply(sessionio.ModEvent{Type: sessionio.ModResultEvent, ToolID: "toolu_n"}, stampNow)
	if got := writeKeys(w); got != "-@claude_tool" {
		t.Fatalf("result writes %q", got)
	}
}

func TestStampByeClearsEverything(t *testing.T) {
	var s stampState
	s.apply(promptRow(), stampNow)
	w := s.apply(sessionio.ModEvent{Type: sessionio.ModByeEvent}, stampNow)
	if len(w.unset) != 4 {
		t.Fatalf("bye unsets %v", w.unset)
	}
}

func TestStampTextIsReadableAsANotice(t *testing.T) {
	v := stampText(stampNow, "line one\nline \"two\"")
	n, ok := sessionio.ParseNotice(v)
	if !ok || n.At != 1790900000 || !strings.Contains(n.Text, `line "two"`) {
		t.Fatalf("ParseNotice(%q) = %+v, %v", v, n, ok)
	}
}

func TestBgTokensRejectsIdsOutsideTheCharset(t *testing.T) {
	got := bgTokens([]sessionio.ModAgent{{ID: "a b", Type: "subagent", Status: "running"}, {ID: "ok_1", Type: "subagent", Status: "running"}}, nil)
	if got != "a:ok_1" {
		t.Fatalf("bgTokens = %q", got)
	}
}

// $.agent.list() names a subagent's TYPE by its agent definition
// (general-purpose, Explore, a plugin's own), not "subagent" as the Stop
// hook's registry does. Measured live on 2026-10-02: a turn that launched a
// background general-purpose agent stamped done at its turn_end while the
// agent worked for another 46 s.
func TestStampBackgroundSubagentOfAnyDefinitionKeepsTheSessionRunning(t *testing.T) {
	var s stampState
	s.apply(promptRow(), stampNow)
	s.apply(sessionio.ModEvent{Type: sessionio.ModTurnEndEvent, Answer: "Waiting for it to finish."}, stampNow)
	w := s.apply(sessionio.ModEvent{Type: sessionio.ModAgentsEvent, Agents: []sessionio.ModAgent{
		{ID: "a50611dc2ef8e57df", Type: "general-purpose", Status: "running", Description: "Run sleep and echo command"},
		{ID: "aexp1", Type: "Explore", Status: "running"},
		{ID: "aplug1", Type: "myplugin:reviewer", Status: "running"},
		{ID: "aold", Type: "general-purpose", Status: "completed"},
	}}, stampNow)
	if s.state != "running" || s.bg != "a:a50611dc2ef8e57df a:aexp1 a:aplug1" {
		t.Fatalf("state %s bg %q with background agents running (writes %v)", s.state, s.bg, w.set)
	}
	w = s.apply(sessionio.ModEvent{Type: sessionio.ModAgentsEvent, Agents: []sessionio.ModAgent{
		{ID: "a50611dc2ef8e57df", Type: "general-purpose", Status: "completed"},
	}}, stampNow)
	if got := writeKeys(w); got != "-@claude_bg @claude_state=done" {
		t.Fatalf("agents finishing writes %q", got)
	}
}
