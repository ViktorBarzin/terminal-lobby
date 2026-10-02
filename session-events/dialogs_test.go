package main

import (
	"encoding/json"
	"strings"
	"testing"

	"terminal-lobby/sessionio"
)

func askEvent(toolID, question string) sessionio.ModEvent {
	return sessionio.ModEvent{Type: sessionio.ModAskEvent, ToolID: toolID,
		Questions: json.RawMessage(`[{"question":"` + question + `","options":[{"label":"A"},{"label":"B"}]}]`)}
}

// Claude asks two questions at once more often than not when it grills. One
// held dialog per session meant the second overwrote the first, and settling
// either took both off the card while the other still waited in the mod.
func TestParallelQuestionsAreShownOneAfterTheOther(t *testing.T) {
	rg, _ := newTestRegistry(t, "wizard/demo")
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	c := rg.mods.conn("wizard", "demo")
	fs, _ := rg.source("wizard", "demo")
	c.apply([]sessionio.ModEvent{askEvent("toolu_1", "First?"), askEvent("toolu_2", "Second?")})
	held := lastMeta(fs, sessionio.MetaHeld)
	var body struct {
		Questions []struct{ Question string } `json:"questions"`
		Calls     []json.RawMessage           `json:"calls"`
	}
	if err := json.Unmarshal([]byte(held), &body); err != nil || len(body.Questions) != 1 || body.Questions[0].Question != "First?" || len(body.Calls) != 2 {
		t.Fatalf("held = %s, want the oldest call first and both calls listed", held)
	}
	if d := c.dialogNow(); d == nil || d.toolID != "toolu_1" {
		t.Fatalf("dialogNow = %+v, want the oldest", d)
	}
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModSettledEvent, ToolID: "toolu_1", By: "web"}})
	if held := lastMeta(fs, sessionio.MetaHeld); !strings.Contains(held, "Second?") || strings.Contains(held, "First?") {
		t.Fatalf("after the first settles, held = %s, want the second", held)
	}
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModSettledEvent, ToolID: "toolu_2", By: "web"}})
	if held := lastMeta(fs, sessionio.MetaHeld); held != "" {
		t.Fatalf("after both settle, held = %q, want empty", held)
	}
}

// A question and a permission prompt can be open together (a background
// subagent's prompt while the main thread asks). Each answer goes to the
// dialog of its own kind.
func TestAnAnswerGoesToTheDialogOfItsKind(t *testing.T) {
	rg, _ := newTestRegistry(t, "wizard/demo")
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	c := rg.mods.conn("wizard", "demo")
	c.apply([]sessionio.ModEvent{
		{Type: sessionio.ModPermissionEvent, ToolID: "toolu_p", Tool: "Bash", Input: json.RawMessage(`{"command":"ls"}`)},
		askEvent("toolu_q", "Which?"),
	})
	_, sent := answered(t, c, sessionio.AnswerRequest{Answers: map[string][]string{"Which?": {"A"}}})
	if len(sent) != 1 || sent[0].ToolID != "toolu_q" {
		t.Fatalf("question answer sent %+v", sent)
	}
	_, sent = answered(t, c, sessionio.AnswerRequest{Permission: &sessionio.PermissionAnswer{Option: 1}})
	if len(sent) != 1 || sent[0].ToolID != "toolu_p" || sent[0].Decision != "allow" {
		t.Fatalf("permission answer sent %+v", sent)
	}
}

// An answer that names its call goes to that call or nowhere: between reading
// a dialog and answering it, the next one can open in its place.
func TestAnAnswerNamingItsCallGoesOnlyThere(t *testing.T) {
	rg, _ := newTestRegistry(t, "wizard/demo")
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	c := rg.mods.conn("wizard", "demo")
	c.apply([]sessionio.ModEvent{askEvent("toolu_1", "Same?"), askEvent("toolu_2", "Same?")})
	_, sent := answered(t, c, sessionio.AnswerRequest{ToolID: "toolu_2", Answers: map[string][]string{"Same?": {"B"}}})
	if len(sent) != 1 || sent[0].ToolID != "toolu_2" {
		t.Fatalf("sent %+v, want the named call", sent)
	}
	resp, sent := answered(t, c, sessionio.AnswerRequest{ToolID: "toolu_gone", Answers: map[string][]string{"Same?": {"B"}}})
	if resp.Reason != sessionio.AnswerNotHeld || len(sent) != 0 {
		t.Fatalf("a call no longer open: %+v, sent %+v", resp, sent)
	}
	resp, _ = answered(t, c, sessionio.AnswerRequest{ToolID: "toolu_1", Permission: &sessionio.PermissionAnswer{Option: 1}})
	if resp.Reason != sessionio.AnswerNotDrawn {
		t.Fatalf("a permission answer naming a question: %+v", resp)
	}
}

// "Keep planning" with no words: the mod turns a blank reason into its own
// keep-planning message.
func TestKeepPlanningNeedsNoWords(t *testing.T) {
	rg, _ := newTestRegistry(t, "wizard/demo")
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	c := rg.mods.conn("wizard", "demo")
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModPlanEvent, ToolID: "toolu_p", Plan: "do it"}})
	resp, sent := answered(t, c, sessionio.AnswerRequest{Plan: &sessionio.PlanAnswer{Option: 2}})
	if !resp.Applied || len(sent) != 1 || sent[0].Decision != "deny" || sent[0].Reason != "" {
		t.Fatalf("resp %+v, sent %+v", resp, sent)
	}
}

// The dialog keeps what a program needs to read it without the pane.
func TestADialogKeepsWhatItShows(t *testing.T) {
	rg, _ := newTestRegistry(t, "wizard/demo")
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	c := rg.mods.conn("wizard", "demo")
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModPlanEvent, ToolID: "toolu_p", Plan: "1. build\n2. ship", PlanFilePath: "/tmp/plan.md"}})
	if d := c.dialogNow(); d == nil || d.plan != "1. build\n2. ship" || d.planFilePath != "/tmp/plan.md" {
		t.Fatalf("plan dialog = %+v", d)
	}
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModSettledEvent, ToolID: "toolu_p", By: "web"},
		{Type: sessionio.ModPermissionEvent, ToolID: "toolu_b", Tool: "Bash", Reason: "outside the project",
			Input: json.RawMessage(`{"command":"rm -rf build","description":"Clean"}`)}})
	d := c.dialogNow()
	if d == nil || d.tool != "Bash" || d.title != "Bash command" || d.reason != "outside the project" ||
		len(d.detail) != 2 || d.detail[0] != "rm -rf build" {
		t.Fatalf("permission dialog = %+v", d)
	}
}
