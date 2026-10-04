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

// step is one event as the connection applies it with every write landing:
// the fold, then the four state options brought up to date, in full on a bye.
func (s *stampState) step(ev sessionio.ModEvent, now time.Time) stampWrite {
	w := s.apply(ev, now)
	f := s.flush(ev.Type == sessionio.ModByeEvent)
	w = mergeWrites(w, f)
	w.from, w.to = f.from, f.to
	s.written = s.opts()
	return w
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
	w := s.step(promptRow(), stampNow)
	if got := writeKeys(w); got != "@claude_state=running @last_activity=1790900000" {
		t.Fatalf("prompt writes %q", got)
	}
	w = s.step(sessionio.ModEvent{Type: sessionio.ModTurnEndEvent, Answer: "all done;"}, stampNow)
	if w.set["@claude_state"] != "done" || w.set["@claude_reply"] != `1790900000 all done\u003b` {
		t.Fatalf("turn_end writes %v", w.set)
	}
}

func TestStampDialogAwaitsUntilSettled(t *testing.T) {
	var s stampState
	s.step(promptRow(), stampNow)
	w := s.step(sessionio.ModEvent{Type: sessionio.ModPlanEvent, ToolID: "toolu_p"}, stampNow)
	if got := writeKeys(w); got != "@claude_ask=toolu_p @claude_state=awaiting" {
		t.Fatalf("plan writes %q", got)
	}
	// A tool call in flight elsewhere must not move it off awaiting.
	s.step(sessionio.ModEvent{Type: sessionio.ModTurnStartEvent}, stampNow)
	if s.state != "awaiting" {
		t.Fatalf("state = %s while the dialog is up", s.state)
	}
	w = s.step(sessionio.ModEvent{Type: sessionio.ModSettledEvent, ToolID: "toolu_p"}, stampNow)
	if got := writeKeys(w); got != "-@claude_ask @claude_state=running" {
		t.Fatalf("settled writes %q", got)
	}
}

func TestStampBackgroundWorkKeepsTheSessionRunning(t *testing.T) {
	var s stampState
	s.step(promptRow(), stampNow)
	s.step(sessionio.ModEvent{Type: sessionio.ModDeltaEvent, AgentID: "abc", Text: "working"}, stampNow)
	s.step(sessionio.ModEvent{Type: sessionio.ModAgentsEvent, Agents: []sessionio.ModAgent{
		{ID: "abc", Type: "teammate", Status: "running", Name: "sleeper"},
		{ID: "wf1", Type: "workflow", Status: "running"},
		{ID: "old", Type: "subagent", Status: "completed"},
	}}, stampNow)
	w := s.step(sessionio.ModEvent{Type: sessionio.ModTurnEndEvent}, stampNow)
	if s.state != "running" || s.bg != "t:sleeper w:wf1" {
		t.Fatalf("state %s bg %q after turn_end with work outstanding (writes %v)", s.state, s.bg, w.set)
	}
	// The teammate goes idle but stays listed as running: it no longer counts.
	s.step(sessionio.ModEvent{Type: sessionio.ModTurnEndEvent, AgentID: "abc"}, stampNow)
	if s.bg != "w:wf1" {
		t.Fatalf("bg = %q after the teammate's loop ended", s.bg)
	}
	w = s.step(sessionio.ModEvent{Type: sessionio.ModAgentsEvent, Agents: []sessionio.ModAgent{
		{ID: "abc", Type: "teammate", Status: "running", Name: "sleeper"},
	}}, stampNow)
	if got := writeKeys(w); got != "-@claude_bg @claude_state=done" {
		t.Fatalf("work finishing writes %q", got)
	}
}

func TestStampSubagentEventsLeaveTheMainThreadAlone(t *testing.T) {
	var s stampState
	s.step(promptRow(), stampNow)
	w := s.step(sessionio.ModEvent{Type: sessionio.ModTurnEndEvent, AgentID: "a1"}, stampNow)
	if !w.empty() || s.state != "running" {
		t.Fatalf("subagent turn_end wrote %v, state %s", w.set, s.state)
	}
}

func TestStampToolInFlightAndPushNotice(t *testing.T) {
	var s stampState
	s.step(promptRow(), stampNow)
	w := s.step(sessionio.ModEvent{Type: sessionio.ModRowEvent, Door: "response", Message: &sessionio.ModMessage{
		Type: "assistant", Role: "assistant",
		Content: json.RawMessage(`[{"type":"tool_use","id":"toolu_n","name":"PushNotification","input":{"message":"build is green"}}]`),
	}}, stampNow)
	if w.set["@claude_tool"] != "toolu_n" || w.set["@claude_notice"] != "1790900000 build is green" {
		t.Fatalf("tool_use writes %v", w.set)
	}
	w = s.step(sessionio.ModEvent{Type: sessionio.ModResultEvent, ToolID: "toolu_n"}, stampNow)
	if got := writeKeys(w); got != "-@claude_tool" {
		t.Fatalf("result writes %q", got)
	}
}

func TestStampByeClearsEverything(t *testing.T) {
	var s stampState
	s.step(promptRow(), stampNow)
	w := s.step(sessionio.ModEvent{Type: sessionio.ModByeEvent}, stampNow)
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
	s.step(promptRow(), stampNow)
	s.step(sessionio.ModEvent{Type: sessionio.ModTurnEndEvent, Answer: "Waiting for it to finish."}, stampNow)
	w := s.step(sessionio.ModEvent{Type: sessionio.ModAgentsEvent, Agents: []sessionio.ModAgent{
		{ID: "a50611dc2ef8e57df", Type: "general-purpose", Status: "running", Description: "Run sleep and echo command"},
		{ID: "aexp1", Type: "Explore", Status: "running"},
		{ID: "aplug1", Type: "myplugin:reviewer", Status: "running"},
		{ID: "aold", Type: "general-purpose", Status: "completed"},
	}}, stampNow)
	if s.state != "running" || s.bg != "a:a50611dc2ef8e57df a:aexp1 a:aplug1" {
		t.Fatalf("state %s bg %q with background agents running (writes %v)", s.state, s.bg, w.set)
	}
	w = s.step(sessionio.ModEvent{Type: sessionio.ModAgentsEvent, Agents: []sessionio.ModAgent{
		{ID: "a50611dc2ef8e57df", Type: "general-purpose", Status: "completed"},
	}}, stampNow)
	if got := writeKeys(w); got != "-@claude_bg @claude_state=done" {
		t.Fatalf("agents finishing writes %q", got)
	}
}

// subagentToolRow is a background subagent's assistant row calling a tool.
func subagentToolRow(agent, toolID string) sessionio.ModEvent {
	return sessionio.ModEvent{Type: sessionio.ModRowEvent, Door: "response", AgentID: agent, Message: &sessionio.ModMessage{
		Type: "assistant", Role: "assistant",
		Content: json.RawMessage(`[{"type":"tool_use","id":"` + toolID + `","name":"Bash","input":{"command":"time sleep 40"}}]`),
	}}
}

// A background subagent's permission prompt can open a moment before the
// main turn ends. tool.check carries no agent id, so the permission event
// looks like the main thread's. Measured live on 2026-10-02 (rv-r3reg-b):
// permission at 13:11:20.742, main turn_end at 13:11:21.027, and the turn
// end took the ask with it, leaving the dialog on screen behind a session
// that read running and a Caller task nobody could answer.
func TestStampSubagentPermissionSurvivesTheMainTurnEnd(t *testing.T) {
	var s stampState
	s.step(promptRow(), stampNow)
	s.step(sessionio.ModEvent{Type: sessionio.ModTurnStartEvent, AgentID: "aefb"}, stampNow)
	s.step(subagentToolRow("aefb", "toolu_s"), stampNow)
	s.step(sessionio.ModEvent{Type: sessionio.ModPermissionEvent, ToolID: "toolu_s"}, stampNow)
	w := s.step(sessionio.ModEvent{Type: sessionio.ModTurnEndEvent, Answer: "Started it in the background."}, stampNow)
	if s.state != "awaiting" || s.ask != "toolu_s" {
		t.Fatalf("after the main turn_end: state %s ask %q (writes %q)", s.state, s.ask, writeKeys(w))
	}
	if _, cleared := w.set["@claude_ask"]; cleared || containsName(w.unset, "@claude_ask") || w.set["@claude_state"] != "" {
		t.Fatalf("main turn_end rewrote the open ask: %q", writeKeys(w))
	}
	// The agent list that follows every turn_end must not move it either.
	s.step(sessionio.ModEvent{Type: sessionio.ModAgentsEvent, Agents: []sessionio.ModAgent{
		{ID: "aefb", Type: "general-purpose", Status: "running"},
	}}, stampNow)
	if s.state != "awaiting" || s.ask != "toolu_s" {
		t.Fatalf("after the agent list: state %s ask %q", s.state, s.ask)
	}
	w = s.step(sessionio.ModEvent{Type: sessionio.ModSettledEvent, ToolID: "toolu_s"}, stampNow)
	if got := writeKeys(w); got != "-@claude_ask @claude_state=running" {
		t.Fatalf("settled writes %q", got)
	}
}

// The same race when the subagent's row has not been seen yet: an ask that
// no row places, opened while a subagent loop is active, could be the
// subagent's, so the main turn end leaves it standing.
func TestStampUnplacedAskWithASubagentActiveSurvivesTheMainTurnEnd(t *testing.T) {
	var s stampState
	s.step(promptRow(), stampNow)
	s.step(sessionio.ModEvent{Type: sessionio.ModTurnStartEvent, AgentID: "aefb"}, stampNow)
	s.step(sessionio.ModEvent{Type: sessionio.ModPermissionEvent, ToolID: "toolu_x"}, stampNow)
	s.step(sessionio.ModEvent{Type: sessionio.ModTurnEndEvent}, stampNow)
	if s.state != "awaiting" || s.ask != "toolu_x" {
		t.Fatalf("state %s ask %q", s.state, s.ask)
	}
	// The subagent's own turn ending is the safety net for its asks.
	s.step(sessionio.ModEvent{Type: sessionio.ModTurnEndEvent, AgentID: "aefb"}, stampNow)
	if s.ask != "" || s.state != "done" {
		t.Fatalf("after the subagent's turn_end: state %s ask %q", s.state, s.ask)
	}
}

// A main-thread ask is still cleared by the main turn end, which is the
// safety net for a dialog whose settled event never arrived.
func TestStampMainThreadAskIsClearedByTheMainTurnEnd(t *testing.T) {
	var s stampState
	s.step(promptRow(), stampNow)
	s.step(sessionio.ModEvent{Type: sessionio.ModRowEvent, Door: "response", Message: &sessionio.ModMessage{
		Type: "assistant", Role: "assistant",
		Content: json.RawMessage(`[{"type":"tool_use","id":"toolu_m","name":"Bash","input":{}}]`),
	}}, stampNow)
	s.step(sessionio.ModEvent{Type: sessionio.ModTurnStartEvent, AgentID: "aefb"}, stampNow)
	s.step(sessionio.ModEvent{Type: sessionio.ModPermissionEvent, ToolID: "toolu_m"}, stampNow)
	w := s.step(sessionio.ModEvent{Type: sessionio.ModTurnEndEvent}, stampNow)
	if s.ask != "" || !containsName(w.unset, "@claude_ask") {
		t.Fatalf("main ask survived the main turn_end: ask %q writes %q", s.ask, writeKeys(w))
	}
}

// Two dialogs open at once: settling one shows the other.
func TestStampTwoOpenAsksSettleIndependently(t *testing.T) {
	var s stampState
	s.step(promptRow(), stampNow)
	s.step(subagentToolRow("a1", "toolu_a"), stampNow)
	s.step(subagentToolRow("a2", "toolu_b"), stampNow)
	s.step(sessionio.ModEvent{Type: sessionio.ModPermissionEvent, ToolID: "toolu_a"}, stampNow)
	s.step(sessionio.ModEvent{Type: sessionio.ModPermissionEvent, ToolID: "toolu_b"}, stampNow)
	w := s.step(sessionio.ModEvent{Type: sessionio.ModSettledEvent, ToolID: "toolu_b"}, stampNow)
	if s.state != "awaiting" || s.ask != "toolu_a" || w.set["@claude_ask"] != "toolu_a" {
		t.Fatalf("state %s ask %q writes %q", s.state, s.ask, writeKeys(w))
	}
}

func containsName(names []string, want string) bool {
	for _, n := range names {
		if n == want {
			return true
		}
	}
	return false
}

// A prompt the lobby hands to the mod never makes Claude Code write a summary
// into the pane title, so the mod writes one of its own and it lands here, on
// the option tmux-api's auto-title rule reads when the pane has nothing.
func TestStampSummaryLandsOnItsOption(t *testing.T) {
	var s stampState
	s.step(promptRow(), stampNow)
	w := s.step(sessionio.ModEvent{Type: sessionio.ModSummaryEvent, Text: "  Notification titles fall back to ids \n"}, stampNow)
	if got := writeKeys(w); got != sessionio.OptionSummary+"=Notification titles fall back to ids" {
		t.Fatalf("summary writes %q", got)
	}
	for _, ev := range []sessionio.ModEvent{
		{Type: sessionio.ModSummaryEvent, Text: "   "},
		{Type: sessionio.ModSummaryEvent, Text: "A subagent's own task", AgentID: "a1"},
	} {
		if got := writeKeys(s.step(ev, stampNow)); strings.Contains(got, sessionio.OptionSummary) {
			t.Errorf("%+v wrote %q", ev, got)
		}
	}
}

// session-events keeps the turn in memory, so a restart mid-turn starts the
// state over knowing nothing. The history the mod sends after its next hello
// says whether a main-thread turn is running; without it, the first dialog to
// close dropped a working session to done (2026-10-04: a grilling turn opened
// at 15:23, session-events restarted at 15:52, the next answer read done).
func TestStampHistoryReopensATurnThatSpannedARestart(t *testing.T) {
	var s stampState
	s.step(sessionio.ModEvent{Type: sessionio.ModHistoryEvent, Running: true, More: true}, stampNow)
	w := s.step(sessionio.ModEvent{Type: sessionio.ModHistoryEvent, Running: true}, stampNow)
	if got := writeKeys(w); got != "@claude_state=running" {
		t.Fatalf("history of a running turn writes %q", got)
	}
	s.step(sessionio.ModEvent{Type: sessionio.ModAskEvent, ToolID: "toolu_q"}, stampNow)
	w = s.step(sessionio.ModEvent{Type: sessionio.ModResultEvent, ToolID: "toolu_q"}, stampNow)
	if got := writeKeys(w); got != "-@claude_ask @claude_state=running" {
		t.Fatalf("answering a question mid-turn writes %q", got)
	}
}

func TestStampHistoryOfAnIdleSessionIsDone(t *testing.T) {
	var s stampState
	s.step(promptRow(), stampNow)
	// Only the last chunk speaks for the turn.
	s.step(sessionio.ModEvent{Type: sessionio.ModHistoryEvent, More: true}, stampNow)
	if s.state != "running" {
		t.Fatalf("a non-final history chunk moved the state to %s", s.state)
	}
	w := s.step(sessionio.ModEvent{Type: sessionio.ModHistoryEvent}, stampNow)
	if got := writeKeys(w); got != "@claude_state=done" {
		t.Fatalf("history of an idle session writes %q", got)
	}
}

// Q-F5, L-F6: a subagent or workflow is background work while it is pending,
// running or waiting, and a teammate counts by its own loop whatever its
// status.
func TestBgTokensCountsEveryAgentThatHasNotFinished(t *testing.T) {
	cases := []struct {
		agent  sessionio.ModAgent
		active bool
		want   string
	}{
		{sessionio.ModAgent{ID: "a1", Type: "general-purpose", Status: "pending"}, false, "a:a1"},
		{sessionio.ModAgent{ID: "a1", Type: "general-purpose", Status: "running"}, false, "a:a1"},
		{sessionio.ModAgent{ID: "a1", Type: "Explore", Status: "waiting"}, false, "a:a1"},
		// Between turns until a message wakes it: a finished subagent can be
		// listed so, and would keep the session running for good.
		{sessionio.ModAgent{ID: "a1", Type: "general-purpose", Status: "idle"}, false, ""},
		{sessionio.ModAgent{ID: "a1", Type: "general-purpose", Status: ""}, false, ""},
		{sessionio.ModAgent{ID: "a1", Type: "general-purpose", Status: "completed"}, false, ""},
		{sessionio.ModAgent{ID: "a1", Type: "general-purpose", Status: "failed"}, false, ""},
		{sessionio.ModAgent{ID: "a1", Type: "general-purpose", Status: "killed"}, false, ""},
		{sessionio.ModAgent{ID: "w1", Type: "workflow", Status: "running"}, false, "w:w1"},
		{sessionio.ModAgent{ID: "w1", Type: "workflow", Status: "completed"}, false, ""},
		{sessionio.ModAgent{ID: "t1", Type: "teammate", Status: "idle", Name: "rev"}, true, "t:rev"},
		{sessionio.ModAgent{ID: "t1", Type: "teammate", Status: "running", Name: "rev"}, false, ""},
	}
	for _, c := range cases {
		got := bgTokens([]sessionio.ModAgent{c.agent}, map[string]bool{c.agent.ID: c.active})
		if got != c.want {
			t.Errorf("%s %s (active %v): bg %q, want %q", c.agent.Type, c.agent.Status, c.active, got, c.want)
		}
	}
}

// tmux reads an argument ending in ';' as a command separator and drops the
// semicolon (measured on tmux 3.4), so a final one is escaped and the decode
// brings it back. Ported from sessionio's hook script test.
func TestStampTextEndingInASemicolonKeepsIt(t *testing.T) {
	v := stampText(stampNow, "done; see PR;")
	if strings.HasSuffix(v, ";") {
		t.Fatalf("stampText = %q ends in a semicolon tmux would drop", v)
	}
	if n, _ := sessionio.ParseNotice(v); n.Text != "done; see PR;" {
		t.Fatalf("notice text = %q, want the trailing semicolon kept", n.Text)
	}
}

// S-F3: a permission the mod placed in a subagent (mod 0.3.0) survives the
// main turn's end even when no row placed it, as after a restart.
func TestStampPermissionNamingItsSubagentSurvivesTheMainTurnEnd(t *testing.T) {
	var s stampState
	s.step(promptRow(), stampNow)
	s.step(sessionio.ModEvent{Type: sessionio.ModPermissionEvent, ToolID: "toolu_s", AgentID: "ag1"}, stampNow)
	s.step(sessionio.ModEvent{Type: sessionio.ModTurnEndEvent}, stampNow)
	if s.ask != "toolu_s" || s.state != "awaiting" {
		t.Fatalf("ask %q state %s after the main turn ended", s.ask, s.state)
	}
}

// A level lists the dialogs open now, oldest first: the order it gives is the
// order kept, and @claude_ask names the newest.
func TestStampLevelSetsTheOpenDialogsInItsOrder(t *testing.T) {
	var s stampState
	s.step(sessionio.ModEvent{Type: sessionio.ModAskEvent, ToolID: "toolu_b"}, stampNow)
	s.step(sessionio.ModEvent{Type: sessionio.ModAskEvent, ToolID: "toolu_a"}, stampNow)
	s.step(sessionio.ModEvent{Type: sessionio.ModLevelEvent, Asks: []string{"toolu_a", "toolu_b", "toolu_a"}}, stampNow)
	if got := strings.Join(s.asks, ","); got != "toolu_a,toolu_b" || s.ask != "toolu_b" {
		t.Fatalf("asks %s ask %s", got, s.ask)
	}
}

// flush writes all four options when asked to, whatever was written before.
func TestStampFlushInFullSetsAndUnsetsEveryOption(t *testing.T) {
	s := stampState{state: "done", written: stampOpts{state: "done", bg: "a:x"}}
	if got := writeKeys(s.flush(false)); got != "-@claude_bg" {
		t.Fatalf("diff = %q", got)
	}
	if got := writeKeys(s.flush(true)); got != "-@claude_ask -@claude_bg -@claude_tool @claude_state=done" {
		t.Fatalf("full = %q", got)
	}
}
