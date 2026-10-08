package sessionio

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"
)

// Approving Claude Code's own plan menu with keys, against a real tmux and the
// stand-in's plan dialog (fakeDialogPy, FAKEDIALOG_CALL=plan), which answers
// keys the way CLI 2.1.281 does. The digits and the feedback row behave the
// same on 2.1.293 (testdata/plan-2.1.293-78col.txt draws the same rows).

// eventually waits for the pane to show `want`, for a key the test sends
// itself, and fails with the pane if it never does.
func eventually(t *testing.T, in *Injector, osUser, want string) string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		pane := paneOf(t, in, osUser)
		if strings.Contains(pane, want) {
			return pane
		}
		if !time.Now().Before(deadline) {
			t.Fatalf("the pane never showed %q:\n%s", want, pane)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func pressPlan(t *testing.T, in *Injector, osUser string, n int, label string) AnswerResponse {
	t.Helper()
	res, err := in.PressPlanRow(context.Background(), osUser, "demo", n, label)
	if err != nil {
		t.Fatalf("PressPlanRow: %v", err)
	}
	return res
}

// The row "approve the plan" means when a caller names none: the first that
// keeps the context and does not switch permissions off. Clearing the context
// would drop the words the mod attaches to an approval, and bypass is a mode
// nobody chose by saying "approve".
func TestPlanApproveRowKeepsTheContext(t *testing.T) {
	for _, tc := range []struct {
		name    string
		options []PlanOption
		want    int
	}{
		{"wizard's three rows", planOptionsWizard, 2},
		{"no clear context and no auto mode", []PlanOption{
			{Number: 1, Label: "Yes, auto-accept edits"},
			{Number: 2, Label: "Yes, manually approve edits"},
		}, 1},
		{"bypass offered first", []PlanOption{
			{Number: 1, Label: "Yes, clear context (6% used) and bypass permissions"},
			{Number: 2, Label: "Yes, and bypass permissions"},
			{Number: 3, Label: "Yes, manually approve edits"},
		}, 3},
		{"every row clears the context", []PlanOption{
			{Number: 1, Label: "Yes, clear context and use auto mode"},
		}, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := PlanApproveRow(&Dialog{Kind: DialogKindPlan, Options: tc.options})
			if tc.want == 0 {
				if ok {
					t.Fatalf("PlanApproveRow = %+v, want none", got)
				}
				return
			}
			if !ok || got.Number != tc.want {
				t.Fatalf("PlanApproveRow = %+v, %v; want row %d", got, ok, tc.want)
			}
		})
	}
	if _, ok := PlanApproveRow(nil); ok {
		t.Error("no reading has no approve row")
	}
}

// ReadPlan is the pane's plan approval as ParsePlanDialog reads it, and nil
// when the pane shows none.
func TestReadPlanReadsThePane(t *testing.T) {
	in, osUser := planSession(t, "")
	d, err := in.ReadPlan(osUser, "demo")
	if err != nil {
		t.Fatal(err)
	}
	if d == nil || d.FeedbackRow != 4 || len(d.Options) != 3 || d.Options[1].Label != "Yes, and use auto mode" {
		t.Fatalf("ReadPlan = %+v", d)
	}

	in, osUser = standIn(t, "FAKEDIALOG_CALL=composer ", "for agents")
	if d, err := in.ReadPlan(osUser, "demo"); err != nil || d != nil {
		t.Fatalf("ReadPlan over the input box = %+v, %v; want nil", d, err)
	}
}

// A row by its number and label: the digit, then the dialog gone.
func TestPressPlanRowApprovesWithTheRowItNames(t *testing.T) {
	in, osUser := planSession(t, "")

	res := pressPlan(t, in, osUser, 2, "Yes, and use auto mode")

	if !res.Applied || !res.Done {
		t.Fatalf("applied=%v done=%v reason=%q, want the dialog gone", res.Applied, res.Done, res.Reason)
	}
	pane := paneOf(t, in, osUser)
	if !strings.Contains(pane, "PLAN APPROVED 2") || !strings.Contains(pane, "auto mode on") {
		t.Fatalf("row 2 did not approve:\n%s", pane)
	}
}

// The labels are compared as drawn, so a card built from another reading is
// refused with nothing typed rather than approving with whatever row now has
// that number. The feedback row is not an approve row. The refusal carries
// the reading, so the card redraws against what is on screen.
func TestPressPlanRowRefusesARowItCannotMatch(t *testing.T) {
	for _, tc := range []struct {
		name  string
		n     int
		label string
	}{
		{"a label that moved", 1, "Yes, clear context (9% used) and use auto mode"},
		{"no label", 1, ""},
		{"the feedback row", 4, "Tell Claude what to change"},
		{"a row the dialog does not draw", 7, "Yes"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in, osUser := planSession(t, "")
			res := pressPlan(t, in, osUser, tc.n, tc.label)
			if res.Applied || res.Reason != AnswerUnknownOption {
				t.Fatalf("applied=%v reason=%q, want unknown-option", res.Applied, res.Reason)
			}
			if res.Dialog == nil || res.Dialog.Kind != DialogKindPlan || len(res.Dialog.Options) != 3 {
				t.Fatalf("the refusal must carry the plan reading: %+v", res.Dialog)
			}
			if pane := paneOf(t, in, osUser); strings.Contains(pane, "PLAN ") || !strings.Contains(pane, "❯ 1.") {
				t.Fatalf("a refused request moved the dialog:\n%s", pane)
			}
		})
	}
}

// A digit typed while the cursor is on the feedback row goes INTO the field
// (measured on 2.1.281: "4. 7"), so the driver steps off the row first and
// reads the cursor back before the digit goes.
func TestPressPlanRowStepsOffTheFeedbackRowFirst(t *testing.T) {
	in, osUser := planSession(t, "")
	if err := in.Keys(osUser, "demo", []string{"4"}); err != nil {
		t.Fatal(err)
	}
	eventually(t, in, osUser, "❯ 4. Tell Claude what to change")
	if err := in.AnswerText(osUser, "demo", "keep these words"); err != nil {
		t.Fatal(err)
	}
	eventually(t, in, osUser, "keep these words")

	res := pressPlan(t, in, osUser, 3, "Yes, manually approve edits")

	if !res.Applied || !res.Done {
		t.Fatalf("applied=%v reason=%q, want row 3 to approve", res.Applied, res.Reason)
	}
	pane := paneOf(t, in, osUser)
	if !strings.Contains(pane, "PLAN APPROVED 3") || !strings.Contains(pane, "manual mode on") {
		t.Fatalf("the digit did not approve:\n%s", pane)
	}
}

// No plan approval on the pane: nothing typed, and the reply says so.
func TestPressPlanRowTypesNothingWithoutTheDialog(t *testing.T) {
	in, osUser := standIn(t, "FAKEDIALOG_CALL=composer ", "for agents")
	before := paneOf(t, in, osUser)

	res := pressPlan(t, in, osUser, 2, "Yes, and use auto mode")

	if res.Applied || res.Reason != AnswerNotDrawn {
		t.Fatalf("applied=%v reason=%q, want not-drawn", res.Applied, res.Reason)
	}
	if after := paneOf(t, in, osUser); after != before {
		t.Fatalf("the pane changed:\n%s", after)
	}
}

// A BLANK REPAINT IS NOT AN ANSWER. The stand-in blanks the screen for 150 ms
// on the digit and draws the same dialog again: the key did not take. The
// dialog has to be absent from three readings in a row before it counts.
func TestPressPlanRowDoesNotTakeABlankRepaintForAnAnswer(t *testing.T) {
	in, osUser := planSession(t, "FAKEDIALOG_PLAN_STUBBORN=1 ")

	res := pressPlan(t, in, osUser, 3, "Yes, manually approve edits")

	if res.Applied || res.Done || res.Reason != AnswerUnverified {
		t.Fatalf("applied=%v done=%v reason=%q, want unverified", res.Applied, res.Done, res.Reason)
	}
	if res.Dialog == nil || res.Dialog.Kind != DialogKindPlan {
		t.Fatalf("the reply must carry the plan still on screen: %+v", res.Dialog)
	}
}

// TWO DEVICES, ONE MENU. Two approvals sent together take turns: the first
// presses its digit, and the second reads the pane after it and finds the
// menu gone, so only one row is ever pressed.
func TestConcurrentPlanPressesTakeTurns(t *testing.T) {
	in, osUser := planSession(t, "")

	var wg sync.WaitGroup
	results := make([]AnswerResponse, 2)
	for i, row := range []PlanOption{{Number: 2, Label: "Yes, and use auto mode"}, {Number: 3, Label: "Yes, manually approve edits"}} {
		wg.Add(1)
		go func(i int, row PlanOption) {
			defer wg.Done()
			res, err := in.PressPlanRow(context.Background(), osUser, "demo", row.Number, row.Label)
			if err != nil {
				t.Errorf("PressPlanRow: %v", err)
			}
			results[i] = res
		}(i, row)
	}
	wg.Wait()

	applied := 0
	for _, r := range results {
		if r.Applied {
			applied++
		}
	}
	if applied != 1 {
		t.Fatalf("%d of the two presses applied, want exactly one: %+v", applied, results)
	}
	if pane := paneOf(t, in, osUser); strings.Count(pane, "PLAN APPROVED") != 1 {
		t.Fatalf("want one approval on the pane:\n%s", pane)
	}
}
