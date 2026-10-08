package main

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"terminal-lobby/sessionio"
)

// Claude Code 2.1.293 draws its own plan menu whatever the mod answers, so a
// mod that lists `plan-keys` (0.5.0) has its plan approvals pressed in the
// pane, and the card shows the rows that menu draws. Keep planning and words
// sent back go to the mod as a deny, which takes the menu down with no key.

// fakePlanKeys stands in for the Injector's plan menu: what the pane reads,
// and every row pressed.
type fakePlanKeys struct {
	mu      sync.Mutex
	reading *sessionio.Dialog
	reads   int
	presses []sessionio.PlanOption
	press   sessionio.AnswerResponse
}

func (f *fakePlanKeys) ReadPlan(osUser, session string) (*sessionio.Dialog, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reads++
	return f.reading, nil
}

func (f *fakePlanKeys) PressPlanRow(_ context.Context, osUser, session string, n int, label string) (sessionio.AnswerResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.presses = append(f.presses, sessionio.PlanOption{Number: n, Label: label})
	return f.press, nil
}

func (f *fakePlanKeys) setReading(d *sessionio.Dialog) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reading = d
}

func (f *fakePlanKeys) pressed() []sessionio.PlanOption {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]sessionio.PlanOption(nil), f.presses...)
}

func (f *fakePlanKeys) readCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reads
}

// The rows wizard's sessions draw on 2.1.293 (testdata/plan-2.1.293-78col.txt).
func nativePlan() *sessionio.Dialog {
	return &sessionio.Dialog{
		Kind: sessionio.DialogKindPlan,
		Options: []sessionio.PlanOption{
			{Number: 1, Label: "Yes, clear context (7% used) and use auto mode"},
			{Number: 2, Label: "Yes, and use auto mode"},
			{Number: 3, Label: "Yes, manually approve edits"},
		},
		FeedbackRow: 4,
		PlanPath:    "~/.claude/plans/sequential-panda.md",
	}
}

// planKeysConn is a plan-keys mod's connection with a plan dialog open, and
// the pane behind it reading `reading`.
func planKeysConn(t *testing.T, ops []string, reading *sessionio.Dialog) (*registry, *modConn, *fakePlanKeys) {
	t.Helper()
	was := planReadEvery
	planReadEvery = time.Millisecond
	t.Cleanup(func() { planReadEvery = was })
	rg, _ := newTestRegistry(t, "wizard/demo")
	keys := &fakePlanKeys{reading: reading, press: sessionio.AnswerResponse{Applied: true, Done: true}}
	rg.mods.plans = keys
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3", Ops: ops})
	c := rg.mods.conn("wizard", "demo")
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModPlanEvent, ToolID: "toolu_p", Plan: "# Plan", PlanFilePath: "/p.md"}})
	return rg, c, keys
}

var planKeysOps = []string{"decide", "decide-feedback", "plan-keys"}

// asking waits for the card's reading to contain `want`.
func askingShows(t *testing.T, rg *registry, want string) string {
	t.Helper()
	fs, _ := rg.source("wizard", "demo")
	deadline := time.Now().Add(2 * time.Second)
	for {
		got := lastMeta(fs, sessionio.MetaAsking)
		if strings.Contains(got, want) {
			return got
		}
		if !time.Now().Before(deadline) {
			t.Fatalf("the card's reading never showed %q: %s", want, got)
		}
		time.Sleep(time.Millisecond)
	}
}

// The card shows Claude's own rows once the pane draws them, with the
// feedback row, and the synthetic row until then.
func TestAPlanKeysModsCardShowsTheMenusOwnRows(t *testing.T) {
	rg, c, keys := planKeysConn(t, planKeysOps, nil)
	// The plan's text rides the reading from the start: Claude Code 2.1.293
	// writes some plan calls into the transcript with an empty input.
	if got := askingShows(t, rg, "Yes, approve the plan"); !strings.Contains(got, `"plan":"# Plan"`) {
		t.Errorf("the synthetic reading lacks the plan: %s", got)
	}

	keys.setReading(nativePlan())
	got := askingShows(t, rg, "Yes, and use auto mode")
	for _, want := range []string{"Yes, clear context (7% used) and use auto mode", "Yes, manually approve edits", `"feedbackRow":4`, `"plan":"# Plan"`} {
		if !strings.Contains(got, want) {
			t.Errorf("the reading lacks %q: %s", want, got)
		}
	}
	if d := c.dialogFor("plan", "toolu_p"); d == nil {
		t.Fatal("the dialog closed")
	}
	// The poll stops once it has a reading.
	n := keys.readCount()
	time.Sleep(20 * time.Millisecond)
	if keys.readCount() != n {
		t.Error("the pane is still being read after the menu was read")
	}
}

// An older mod answers the plan through its own dialog: the pane is never
// read and the card keeps the one approve row.
func TestAnOlderModsPlanCardIsNotReadOffThePane(t *testing.T) {
	rg, _, keys := planKeysConn(t, []string{"decide", "decide-feedback"}, nativePlan())
	askingShows(t, rg, "Yes, approve the plan")
	time.Sleep(20 * time.Millisecond)
	if keys.readCount() != 0 {
		t.Fatalf("the pane was read %d times for an older mod", keys.readCount())
	}
}

// The poll gives up once the dialog is settled, rather than reading the pane
// for its whole bound.
func TestThePlanPollStopsWhenTheDialogSettles(t *testing.T) {
	_, c, keys := planKeysConn(t, planKeysOps, nil)
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModSettledEvent, ToolID: "toolu_p", By: "terminal"}})
	time.Sleep(20 * time.Millisecond)
	n := keys.readCount()
	time.Sleep(20 * time.Millisecond)
	if keys.readCount() != n {
		t.Fatal("the pane is still being read for a settled dialog")
	}
}

// How each answer lands on a plan-keys mod. The label decides what an answer
// means, never the number: agent-api's "Keep planning" is row 2, and row 2 of
// Claude's menu approves.
func TestAPlanKeysModsAnswersPressOrDeny(t *testing.T) {
	approveRow := sessionio.PlanOption{Number: 2, Label: "Yes, and use auto mode"}
	for _, tc := range []struct {
		name    string
		plan    sessionio.PlanAnswer
		cmds    string
		presses []sessionio.PlanOption
	}{
		{"a row from the card", sessionio.PlanAnswer{Option: 3, Label: "Yes, manually approve edits"},
			"decide:allow::", []sessionio.PlanOption{{Number: 3, Label: "Yes, manually approve edits"}}},
		{"the row that clears the context, when the reader picks it", sessionio.PlanAnswer{Option: 1, Label: "Yes, clear context (7% used) and use auto mode"},
			"decide:allow::", []sessionio.PlanOption{{Number: 1, Label: "Yes, clear context (7% used) and use auto mode"}}},
		{"agent-api's Approve plan", sessionio.PlanAnswer{Option: 1, Label: "Approve plan"},
			"decide:allow::", []sessionio.PlanOption{approveRow}},
		{"the card's row before the menu was read", sessionio.PlanAnswer{Option: 1, Label: "Yes, approve the plan"},
			"decide:allow::", []sessionio.PlanOption{approveRow}},
		{"approve with words", sessionio.PlanAnswer{Feedback: "use sqlite", Approve: true},
			"decide:allow:use sqlite:", []sessionio.PlanOption{approveRow}},
		{"agent-api's Keep planning", sessionio.PlanAnswer{Option: 2, Label: "Keep planning"},
			"decide:deny::", nil},
		{"words sent back", sessionio.PlanAnswer{Feedback: "use sqlite"},
			"decide:deny::use sqlite", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, c, keys := planKeysConn(t, planKeysOps, nativePlan())
			p := tc.plan
			resp, sent := answered(t, c, sessionio.AnswerRequest{Plan: &p})
			var got []string
			for _, cmd := range sent {
				got = append(got, cmd.Op+":"+cmd.Decision+":"+cmd.Feedback+":"+cmd.Reason)
			}
			if !resp.Applied || strings.Join(got, " ") != tc.cmds {
				t.Errorf("sent %q (%+v), want %q", strings.Join(got, " "), resp, tc.cmds)
			}
			for _, cmd := range sent {
				if cmd.ToolID != "toolu_p" {
					t.Errorf("a command names %q, not the plan's tool call", cmd.ToolID)
				}
			}
			if pressed := keys.pressed(); !samePresses(pressed, tc.presses) {
				t.Errorf("pressed %+v, want %+v", pressed, tc.presses)
			}
		})
	}
}

func samePresses(a, b []sessionio.PlanOption) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// A row the menu does not draw now, or a menu that is not on the pane, is
// refused with nothing sent and nothing pressed. The unknown-option carries
// the reading, so the card redraws against what is on screen.
func TestAPlanKeysModRefusesARowTheMenuDoesNotDraw(t *testing.T) {
	_, c, keys := planKeysConn(t, planKeysOps, nativePlan())
	resp, sent := answered(t, c, sessionio.AnswerRequest{Plan: &sessionio.PlanAnswer{Option: 1, Label: "Yes, clear context (9% used) and use auto mode"}})
	if resp.Applied || resp.Reason != sessionio.AnswerUnknownOption || resp.Dialog == nil || len(resp.Dialog.Options) != 3 {
		t.Fatalf("resp = %+v, want unknown-option with the reading", resp)
	}
	if len(sent) != 0 || len(keys.pressed()) != 0 {
		t.Fatalf("sent %+v, pressed %+v; want nothing", sent, keys.pressed())
	}

	keys.setReading(nil)
	resp, sent = answered(t, c, sessionio.AnswerRequest{Plan: &sessionio.PlanAnswer{Option: 2, Label: "Yes, and use auto mode"}})
	if resp.Applied || resp.Reason != sessionio.AnswerNotDrawn || len(sent) != 0 || len(keys.pressed()) != 0 {
		t.Fatalf("resp = %+v sent %+v pressed %+v; want not-drawn and nothing done", resp, sent, keys.pressed())
	}
}

// A digit that did not take is reported as the driver saw it.
func TestAPlanKeysModReportsAPressThatDidNotTake(t *testing.T) {
	_, c, keys := planKeysConn(t, planKeysOps, nativePlan())
	keys.press = sessionio.AnswerResponse{Reason: sessionio.AnswerUnverified, Dialog: nativePlan()}
	resp, _ := answered(t, c, sessionio.AnswerRequest{Plan: &sessionio.PlanAnswer{Option: 2, Label: "Yes, and use auto mode"}})
	if resp.Applied || resp.Reason != sessionio.AnswerUnverified || resp.Dialog == nil {
		t.Fatalf("resp = %+v, want unverified with the menu still drawn", resp)
	}
}
