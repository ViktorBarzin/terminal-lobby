package sessionio

import (
	"encoding/json"
	"strings"
	"testing"
)

// steerMainRow is the row the mod forwards for context its tool.call hook
// attached, in the shape captured live on CLI 2.1.296 (2026-10-10): the
// entries joined by newlines inside one system reminder.
func steerMainRow(t *testing.T, entries ...string) ModEvent {
	t.Helper()
	ev := modRow(t, "attachment", "user", "hook-context", []map[string]any{{
		"type": "text",
		"text": "<system-reminder>\ntool.call hook additional context: " + strings.Join(entries, "\n") + "\n</system-reminder>",
	}})
	ev.Message.Name = "hook_additional_context"
	ev.Origin = json.RawMessage(`{"kind":"plugin","event":"tool.call"}`)
	return ev
}

// steerMainLine is the same attachment as the transcript stores it, also
// captured live: one content entry per context string.
func steerMainLine(t *testing.T, sidechain bool, entries ...string) []byte {
	t.Helper()
	b, err := json.Marshal(map[string]any{
		"isSidechain": sidechain,
		"type":        "attachment",
		"uuid":        "82d7b879",
		"timestamp":   "2026-10-10T20:53:52.072Z",
		"attachment": map[string]any{
			"type": "hook_additional_context", "content": entries, "hookName": "tool.call",
			"toolUseID": "toolu_014P-context", "hookEvent": "PostToolUse",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestFrameMainSteerLeadsWithTheLine(t *testing.T) {
	got := FrameMainSteer("  look at the tests first \n")
	if got != MainSteerLead+"\n\nlook at the tests first" {
		t.Fatalf("FrameMainSteer = %q", got)
	}
	if strings.Contains(MainSteerLead, "\n") {
		t.Fatal("the lead is matched as one line")
	}
}

// A live row names each message the lobby delivered, in order, and nothing
// else the row carries: the plan feedback the mod attaches on a plan approval
// comes first in the same row.
func TestMainSteerTextsReadsALiveRow(t *testing.T) {
	ev := steerMainRow(t,
		"The person who approved this plan added: keep it small",
		FrameMainSteer("first message"),
		FrameMainSteer("second\n\nmessage"),
	)
	got := MainSteerTexts(ev)
	if strings.Join(got, "|") != "first message|second\n\nmessage" {
		t.Fatalf("MainSteerTexts = %q", got)
	}
}

func TestMainSteerTextsIgnoresOtherRows(t *testing.T) {
	theirs := steerMainRow(t, "some other plugin's note")
	sub := steerMainRow(t, FrameMainSteer("for the subagent"))
	sub.AgentID = "a1"
	hook := steerMainRow(t, FrameMainSteer("from a settings hook"))
	hook.Origin = json.RawMessage(`{"kind":"hook","event":"UserPromptSubmit"}`)
	prompt := modRow(t, "user", "user", "prompt", []map[string]any{{"type": "text", "text": FrameMainSteer("typed")}})
	for name, ev := range map[string]ModEvent{"no lead": theirs, "subagent": sub, "settings hook": hook, "prompt row": prompt} {
		if got := MainSteerTexts(ev); len(got) != 0 {
			t.Errorf("%s: MainSteerTexts = %q, want none", name, got)
		}
	}
}

// Live, the delivered message draws as the reader's own bubble, opening its
// own turn as an absorbed prompt does.
func TestModFeedDrawsADeliveredMessageAsAPrompt(t *testing.T) {
	fs := NewModSource("s", "", nil)
	fs.Feed(modRow(t, "user", "user", "prompt", []map[string]any{{"type": "text", "text": "research it"}}))
	fs.Feed(steerMainRow(t, FrameMainSteer("stop, look at the ADRs instead")))
	var users []Event
	for _, e := range fs.Replay(0) {
		if e.Kind == KindUser {
			users = append(users, e)
		}
	}
	if len(users) != 2 || users[1].Body != "stop, look at the ADRs instead" {
		t.Fatalf("user events = %+v, want the prompt and then the delivered message", users)
	}
	if users[0].TurnID == users[1].TurnID {
		t.Errorf("the delivered message shares turn %q with the prompt, want a turn of its own", users[1].TurnID)
	}
}

// Rebuilt from the transcript, the same message draws the same way, and two
// delivered at one boundary are two bubbles.
func TestTranscriptDrawsDeliveredMessages(t *testing.T) {
	line := steerMainLine(t, false, FrameMainSteer("first"), FrameMainSteer("second"))
	got := userEvents(NewNormalizer("demo").Line(line))
	if len(got) != 2 || got[0].Body != "first" || got[1].Body != "second" {
		t.Fatalf("user events = %+v, want first and second", got)
	}
}

func TestTranscriptIgnoresOtherHookContext(t *testing.T) {
	for name, line := range map[string][]byte{
		"plan feedback": steerMainLine(t, false, "The person who approved this plan added: x"),
		"sidechain":     steerMainLine(t, true, FrameMainSteer("a subagent's")),
	} {
		if got := userEvents(NewNormalizer("demo").Line(line)); len(got) != 0 {
			t.Errorf("%s drew as the reader's prompt: %+v", name, got)
		}
	}
}
