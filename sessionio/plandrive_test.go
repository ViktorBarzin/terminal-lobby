package sessionio

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"
)

// Answering the plan approval through POST /answer's driver, against a real
// tmux and the stand-in's plan dialog (fakeDialogPy, FAKEDIALOG_CALL=plan),
// which answers keys the way CLI 2.1.281 does.

// planSession starts the stand-in on its plan approval.
func planSession(t *testing.T, env string) (*Injector, string) {
	t.Helper()
	return standIn(t, "FAKEDIALOG_CALL=plan "+env, "Would you like to proceed?")
}

// paneOf reads the stand-in's pane.
func paneOf(t *testing.T, in *Injector, osUser string) string {
	t.Helper()
	pane, err := in.CapturePane(osUser, "demo")
	if err != nil {
		t.Fatalf("CapturePane: %v", err)
	}
	return pane
}

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

// planKeys sends keys through the raw-key hatch and waits for the pane to show
// `want`.
func planKeys(t *testing.T, in *Injector, osUser, want string, keys ...string) {
	t.Helper()
	if err := in.Keys(osUser, "demo", keys); err != nil {
		t.Fatalf("keys %v: %v", keys, err)
	}
	eventually(t, in, osUser, want)
}

func planAnswer(t *testing.T, in *Injector, osUser string, p PlanAnswer) AnswerResponse {
	t.Helper()
	res, err := in.Answer(context.Background(), osUser, "demo", AnswerRequest{Plan: &p})
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	return res
}

// The reading the answer route returns is the plan's own: its kind, the
// approve options as drawn and the feedback row. A refusal carries it, so the
// card redraws against what is on screen.
func TestAnswerReturnsThePlanReading(t *testing.T) {
	in, osUser := planSession(t, "")

	res := planAnswer(t, in, osUser, PlanAnswer{Option: 2, Label: "Yes, and use auto mode, please"})

	if res.Applied || res.Reason != AnswerUnknownOption {
		t.Fatalf("applied=%v reason=%q, want a refusal: the drawn label differs", res.Applied, res.Reason)
	}
	d := res.Dialog
	if d == nil || d.Kind != DialogKindPlan || d.FeedbackRow != 4 || len(d.Options) != 3 {
		t.Fatalf("the refusal must carry the plan reading: %+v", d)
	}
	if d.Options[1] != (PlanOption{Number: 2, Label: "Yes, and use auto mode"}) {
		t.Errorf("option 2 = %+v", d.Options[1])
	}
	if res.Action != ActionPlanApprove {
		t.Errorf("action = %q, want %q", res.Action, ActionPlanApprove)
	}
	if pane := paneOf(t, in, osUser); strings.Contains(pane, "PLAN ") {
		t.Fatalf("a refused request typed something:\n%s", pane)
	}
}

// An approve option by its number and label: the digit, then the dialog gone.
func TestAnswerApprovesThePlanWithTheOptionItNames(t *testing.T) {
	in, osUser := planSession(t, "")

	res := planAnswer(t, in, osUser, PlanAnswer{Option: 2, Label: "Yes, and use auto mode"})

	if !res.Applied || !res.Done {
		t.Fatalf("applied=%v done=%v reason=%q, want the dialog gone", res.Applied, res.Done, res.Reason)
	}
	pane := paneOf(t, in, osUser)
	if !strings.Contains(pane, "PLAN APPROVED 2") || !strings.Contains(pane, "auto mode on") {
		t.Fatalf("option 2 did not approve:\n%s", pane)
	}
}

// The labels are compared as drawn, so a card built from another session's
// reading, or from a reading taken before the context meter moved, is refused
// with nothing typed rather than approving with whatever row now has that
// number. The feedback row is not an approve option at all.
func TestAnswerRefusesAPlanOptionItCannotMatch(t *testing.T) {
	for _, tc := range []struct {
		name string
		p    PlanAnswer
	}{
		{"a label that moved", PlanAnswer{Option: 1, Label: "Yes, clear context (9% used) and use auto mode"}},
		{"no label", PlanAnswer{Option: 1}},
		{"the feedback row", PlanAnswer{Option: 4, Label: "Tell Claude what to change"}},
		{"a row the dialog does not draw", PlanAnswer{Option: 7, Label: "Yes"}},
		{"an option and feedback both", PlanAnswer{Option: 2, Label: "Yes, and use auto mode", Feedback: "and also"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in, osUser := planSession(t, "")
			res := planAnswer(t, in, osUser, tc.p)
			if res.Applied || res.Reason != AnswerUnknownOption {
				t.Fatalf("applied=%v reason=%q, want unknown-option", res.Applied, res.Reason)
			}
			if pane := paneOf(t, in, osUser); strings.Contains(pane, "PLAN ") || !strings.Contains(pane, "❯ 1.") {
				t.Fatalf("a refused request moved the dialog:\n%s", pane)
			}
		})
	}
}

// A digit typed while the cursor is on the feedback row goes INTO the field
// (measured on 2.1.281: "4. 7"), so an approve made there would type its digit
// into the reader's words and approve nothing. The driver steps off the row
// first and reads the cursor back.
func TestAnswerStepsOffTheFeedbackRowBeforeTheDigit(t *testing.T) {
	in, osUser := planSession(t, "")
	planKeys(t, in, osUser, "❯ 4. Tell Claude what to change", "4")
	if err := in.AnswerText(osUser, "demo", "keep these words"); err != nil {
		t.Fatal(err)
	}
	eventually(t, in, osUser, "keep these words")

	res := planAnswer(t, in, osUser, PlanAnswer{Option: 3, Label: "Yes, manually approve edits"})

	if !res.Applied || !res.Done {
		t.Fatalf("applied=%v reason=%q, want option 3 to approve", res.Applied, res.Reason)
	}
	pane := paneOf(t, in, osUser)
	if !strings.Contains(pane, "PLAN APPROVED 3") || !strings.Contains(pane, "manual mode on") {
		t.Fatalf("the digit did not approve:\n%s", pane)
	}
}

// Feedback goes in through the feedback row: its digit focuses it, the words
// are pasted and read back off the row, and only then does Enter send them.
func TestAnswerSendsPlanFeedback(t *testing.T) {
	in, osUser := planSession(t, "")

	res := planAnswer(t, in, osUser, PlanAnswer{Feedback: "Name the loop variable n."})

	if !res.Applied || !res.Done {
		t.Fatalf("applied=%v done=%v reason=%q", res.Applied, res.Done, res.Reason)
	}
	if res.Action != ActionPlanFeedback {
		t.Errorf("action = %q, want %q", res.Action, ActionPlanFeedback)
	}
	pane := paneOf(t, in, osUser)
	if !strings.Contains(pane, "PLAN FEEDBACK Name the loop variable n.") {
		t.Fatalf("the feedback did not go back:\n%s", pane)
	}
}

// Approve with this feedback is Shift+Tab on the row once the words are in.
func TestAnswerApprovesThePlanWithFeedback(t *testing.T) {
	in, osUser := planSession(t, "")

	res := planAnswer(t, in, osUser, PlanAnswer{Feedback: "Name the loop variable n.", Approve: true})

	if !res.Applied || !res.Done {
		t.Fatalf("applied=%v done=%v reason=%q", res.Applied, res.Done, res.Reason)
	}
	if res.Action != ActionPlanFeedback {
		t.Errorf("action = %q, want %q: the words went through the feedback row", res.Action, ActionPlanFeedback)
	}
	pane := paneOf(t, in, osUser)
	if !strings.Contains(pane, "PLAN APPROVED WITH FEEDBACK Name the loop variable n.") {
		t.Fatalf("the plan was not approved with the words:\n%s", pane)
	}
}

// Words already in the field, typed at the terminal or left by an attempt
// that did not verify, are replaced rather than added to. A walk back onto
// the field leaves its text cursor mid-text, so the clear starts with C-e.
func TestAnswerReplacesWordsAlreadyInTheFeedbackRow(t *testing.T) {
	in, osUser := planSession(t, "")
	planKeys(t, in, osUser, "❯ 4. Tell Claude what to change", "4")
	if err := in.AnswerText(osUser, "demo", "some older words"); err != nil {
		t.Fatal(err)
	}
	eventually(t, in, osUser, "some older words")
	planKeys(t, in, osUser, "❯ 3. Yes, manually approve edits", "Up")

	res := planAnswer(t, in, osUser, PlanAnswer{Feedback: "brand new words"})

	if !res.Applied {
		t.Fatalf("reason=%q", res.Reason)
	}
	pane := paneOf(t, in, osUser)
	if !strings.Contains(pane, "PLAN FEEDBACK brand new words") || strings.Contains(pane, "older") {
		t.Fatalf("the old words were not replaced:\n%s", pane)
	}
}

// NEVER ENTER ON AN EMPTY FEEDBACK ROW: it is Esc there, a plain rejection
// that tells Claude to stop (measured on 2.1.281). Words that never reach the
// field end the request before the Enter, with the dialog still up.
func TestAnswerSendsNoEnterWhenTheFeedbackDidNotLand(t *testing.T) {
	in, osUser := planSession(t, "FAKEDIALOG_DROP_PASTE=1 ")

	res := planAnswer(t, in, osUser, PlanAnswer{Feedback: "these never arrive"})

	if res.Applied || res.Reason != AnswerUnverified {
		t.Fatalf("applied=%v reason=%q, want unverified", res.Applied, res.Reason)
	}
	pane := paneOf(t, in, osUser)
	if strings.Contains(pane, "PLAN REJECTED") || strings.Contains(pane, "PLAN FEEDBACK") {
		t.Fatalf("an Enter went to the feedback row:\n%s", pane)
	}
	if res.Dialog == nil || res.Dialog.Kind != DialogKindPlan {
		t.Fatalf("the reply must carry the plan still on screen: %+v", res.Dialog)
	}
}

// Feedback with nothing in it is refused before any key, for the same reason
// a blank free-text answer is (checkAnswerText).
func TestAnswerRefusesBlankPlanFeedback(t *testing.T) {
	in, osUser := planSession(t, "")

	for _, p := range []PlanAnswer{{Feedback: "   "}, {Approve: true}, {}} {
		res := planAnswer(t, in, osUser, p)
		if res.Applied {
			t.Fatalf("%+v was applied", p)
		}
	}
	if pane := paneOf(t, in, osUser); !strings.Contains(pane, "❯ 1.") || strings.Contains(pane, "PLAN ") {
		t.Fatalf("a refused request moved the dialog:\n%s", pane)
	}
}

// A request for the other dialog is refused with nothing typed. The driver
// reads only the plan approval: an AskUserQuestion is answered through the
// lobby's hook as data (ADR-0034), never by keys.
func TestAnswerKeepsPlanAndQuestionRequestsApart(t *testing.T) {
	t.Run("a plan answer while a question is drawn", func(t *testing.T) {
		in, osUser := dialogSession(t)
		res := planAnswer(t, in, osUser, PlanAnswer{Option: 1, Label: "Apple"})
		if res.Applied || res.Reason != AnswerNoDialog {
			t.Fatalf("applied=%v reason=%q, want no-dialog", res.Applied, res.Reason)
		}
	})
	t.Run("a question answer while the plan is drawn", func(t *testing.T) {
		in, osUser := planSession(t, "")
		res, err := in.Answer(context.Background(), osUser, "demo",
			AnswerRequest{Answers: map[string][]string{"Pick fruits": {"Pear"}}})
		if err != nil {
			t.Fatal(err)
		}
		if res.Applied || res.Reason != AnswerNotHeld {
			t.Fatalf("applied=%v reason=%q, want not-held", res.Applied, res.Reason)
		}
		if pane := paneOf(t, in, osUser); strings.Contains(pane, "PLAN ") {
			t.Fatalf("a refused request typed something:\n%s", pane)
		}
	})
	t.Run("a plan answer that also names a question", func(t *testing.T) {
		in, osUser := planSession(t, "")
		res, err := in.Answer(context.Background(), osUser, "demo", AnswerRequest{
			Answers: map[string][]string{"Pick fruits": {"Pear"}},
			Plan:    &PlanAnswer{Option: 2, Label: "Yes, and use auto mode"},
		})
		if err != nil {
			t.Fatal(err)
		}
		if res.Applied || res.Reason != AnswerUnknownOption {
			t.Fatalf("applied=%v reason=%q, want a refusal: the request says two things", res.Applied, res.Reason)
		}
	})
}

// The stand-in's two-option variant: no clear context and no auto mode, so the
// feedback row is 3 and its digit is what focuses it.
func TestAnswerSendsFeedbackWhenTheFeedbackRowIsThree(t *testing.T) {
	in, osUser := planSession(t, "FAKEDIALOG_PLAN_OPTS='Yes, auto-accept edits|Yes, manually approve edits' ")

	res := planAnswer(t, in, osUser, PlanAnswer{Feedback: "Smaller steps."})

	if !res.Applied {
		t.Fatalf("reason=%q dialog=%+v", res.Reason, res.Dialog)
	}
	if pane := paneOf(t, in, osUser); !strings.Contains(pane, "PLAN FEEDBACK Smaller steps.") {
		t.Fatalf("the feedback did not go back:\n%s", pane)
	}
}

// A BLANK REPAINT IS NOT AN ANSWER. The stand-in here blanks the screen for
// 150 ms on the digit and draws the same dialog again: the key did not take.
// The dialog has to be absent from three readings in a row before the answer
// counts, so the blank frame the first poll catches is not a Done.
func TestAnswerDoesNotTakeABlankRepaintForAnAnswer(t *testing.T) {
	in, osUser := planSession(t, "FAKEDIALOG_PLAN_STUBBORN=1 ")

	res := planAnswer(t, in, osUser, PlanAnswer{Option: 3, Label: "Yes, manually approve edits"})

	if res.Applied || res.Done || res.Reason != AnswerUnverified {
		t.Fatalf("applied=%v done=%v reason=%q, want unverified", res.Applied, res.Done, res.Reason)
	}
	if res.Dialog == nil || res.Dialog.Kind != DialogKindPlan {
		t.Fatalf("the reply must carry the plan still on screen: %+v", res.Dialog)
	}
}

// TWO DEVICES, ONE DIALOG. Two feedback requests sent together take turns: the
// first types and sends its words, and the second reads the pane after it and
// finds the dialog gone. Interleaved, one's paste would land in the other's
// field, and the words Claude got would be neither reader's.
func TestConcurrentPlanAnswersTakeTurns(t *testing.T) {
	in, osUser := planSession(t, "")

	var wg sync.WaitGroup
	results := make([]AnswerResponse, 2)
	for i, words := range []string{"first reader words", "second reader words"} {
		wg.Add(1)
		go func(i int, words string) {
			defer wg.Done()
			res, err := in.Answer(context.Background(), osUser, "demo",
				AnswerRequest{Plan: &PlanAnswer{Feedback: words}})
			if err != nil {
				t.Errorf("Answer: %v", err)
			}
			results[i] = res
		}(i, words)
	}
	wg.Wait()

	applied := 0
	for _, r := range results {
		if r.Applied {
			applied++
		}
	}
	if applied != 1 {
		t.Fatalf("%d of the two requests applied, want exactly one: %+v", applied, results)
	}
	pane := paneOf(t, in, osUser)
	if !strings.Contains(pane, "PLAN FEEDBACK first reader words\n") &&
		!strings.Contains(pane, "PLAN FEEDBACK second reader words\n") {
		t.Fatalf("the words Claude got are not one reader's:\n%s", pane)
	}
}
