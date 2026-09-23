package sessionio

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The driver against a real tmux and a real pty.
//
// What is under test is the LOOP — refuse what is not drawn, inject, settle,
// read back, and report a reading either way — so the thing on the other end is
// a stand-in that answers the same keys and draws the same landmarks
// (fakeDialogPy below). A real Claude is not needed to prove any of that, and
// needing one would mean the test could not run anywhere: making the CLI draw
// an AskUserQuestion takes a real model call, which is the same cost that got a
// nightly contract test declined in the design.
//
// The stand-in models measured behaviours that the fixtures cannot show,
// because a static capture has no keyboard. The full list is above
// fakeDialogPy; the ones these tests lean on hardest:
//
//   - a multi-select question's tab-bar box flips to ☒ on the FIRST pick, so
//     it says nothing about whether the question has been left;
//   - on a multi-select, Enter on a numbered row toggles it, and only Enter on
//     the unnumbered commit row leaves the question (CLI 2.1.280, 2026-09-23);
//   - the free-text row of a multi-select is an inline field that a paste
//     types into and ticks, and a Backspace clears only once C-e has put the
//     text cursor at the end: a walk onto the row leaves it at the start;
//   - the conversation above the dialog carries both questions' text and, on a
//     line of its own, the review screen's wording. Both are what a whole-pane
//     comparison matches on: dialog.go recognises the review screen by any
//     trimmed line equal to "Review your answers" anywhere in the capture, and
//     a wrapped paragraph puts one there.

// dialogSeq keeps two stand-ins in one test binary off each other's socket,
// which -count=2 and a parallel run both need.
var dialogSeq atomic.Int64

// theCall is the question list the stand-in is drawing, as a transcript would
// record it. This is what places the drawn question: the pane cannot say which
// tab of a multi-question call is current, because that is drawn in colour.
var theCall = []DialogQuestion{
	{Header: "Fruit", Question: "Pick fruits", MultiSelect: true},
	{Header: "Drink", Question: "Pick one drink"},
}

func dialogSession(t *testing.T) (*Injector, string) {
	t.Helper()
	return dialogSessionEnv(t, "")
}

// dialogSessionEnv starts the stand-in with an environment prefix, for the
// variant that ignores every key.
func dialogSessionEnv(t *testing.T, env string) (*Injector, string) {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available")
	}
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 not available")
	}
	u, err := user.Current()
	if err != nil {
		t.Skip("no current user")
	}
	script := filepath.Join(t.TempDir(), "fakedialog.py")
	if err := os.WriteFile(script, []byte(fakeDialogPy), 0o600); err != nil {
		t.Fatalf("writing the stand-in: %v", err)
	}
	// A socket name nothing else can be holding: -L names a socket in a shared
	// directory, and a run that was interrupted leaves the file behind with no
	// server on it, which tmux then refuses to start a new one on.
	sock := fmt.Sprintf("sio-dialog-%d-%d", os.Getpid(), dialogSeq.Add(1))
	t.Cleanup(func() { killSock(sock) })
	if err := exec.Command("tmux", "-L", sock, "new-session", "-d", "-s", "demo",
		"-x", "100", "-y", "40", env+"python3 "+script).Run(); err != nil {
		t.Fatalf("new-session: %v", err)
	}
	in := NewInjectorOnSocket(u.Username, sock)
	// Wait for the first question to be on screen rather than sleeping at it.
	// Under load python3 takes longer to reach raw mode than any fixed sleep
	// worth writing, and a key sent before then is eaten by the line
	// discipline.
	deadline := time.Now().Add(20 * time.Second)
	for {
		pane, err := in.CapturePane(u.Username, "demo")
		if err == nil && strings.Contains(pane, "Pick fruits") {
			return in, u.Username
		}
		if !time.Now().Before(deadline) {
			t.Fatalf("the stand-in never drew its dialog; pane:\n%s", pane)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// The whole walk, which is the thing four-question answers failed at 4 times in
// 5 in the field: answer, land on the next question, reach the review, go back
// and change a pick, and submit. Every step is checked against what the pane
// draws next, and no step predicts it.
func TestAnswerWalksAMultiQuestionCallEndToEnd(t *testing.T) {
	in, osUser := dialogSession(t)
	ctx := context.Background()

	// A multi-select request without Stay is the commit: the set it names,
	// then Enter on the question's own commit row.
	res, err := in.Answer(ctx, osUser, "demo", AnswerRequest{Header: "Fruit", Choice: "Pear"}, theCall)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if !res.Applied || res.Reason != "" {
		t.Fatalf("answering question one: applied=%v reason=%q dialog=%+v", res.Applied, res.Reason, res.Dialog)
	}
	if res.Dialog == nil || res.Dialog.Questions[0].Question != "Pick one drink" {
		t.Fatalf("the reply is not the next question: %+v", res.Dialog)
	}
	if res.Dialog.Answered != 1 {
		t.Errorf("answered = %d, want the tab bar to show one box filled", res.Dialog.Answered)
	}

	// A single-select question is answered with its digit, and the last one
	// leads to the review screen.
	res, err = in.Answer(ctx, osUser, "demo", AnswerRequest{Header: "Drink", Choice: "Coffee"}, theCall)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if !res.Applied || !res.Review {
		t.Fatalf("answering the last question did not reach the review screen: %+v", res)
	}

	// Back to the first question. The pane shows the earlier pick as a tick,
	// which is the CLI holding the answers rather than us.
	res, err = in.Answer(ctx, osUser, "demo", AnswerRequest{Back: "Fruit"}, theCall)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if !res.Applied || res.Dialog == nil || res.Dialog.Questions[0].Question != "Pick fruits" {
		t.Fatalf("← did not reach the first question: %+v", res)
	}
	if res.Review {
		t.Error("the reply still says review after walking back to a question")
	}

	// Changing the pick. A multi-select drawn again opens its cursor on row
	// one with the old pick still ticked (measured on 2.1.280, 2026-09-23),
	// so the plan walks down to clear it.
	res, err = in.Answer(ctx, osUser, "demo", AnswerRequest{Header: "Fruit", Choice: "Plum"}, theCall)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if !res.Applied {
		t.Fatalf("changing an answer was refused: %+v", res)
	}

	// And out through the review screen.
	if res.Dialog != nil && !res.Review {
		res, err = in.Answer(ctx, osUser, "demo", AnswerRequest{Header: "Drink", Choice: "Coffee"}, theCall)
		if err != nil {
			t.Fatalf("Answer: %v", err)
		}
	}
	if !res.Review {
		t.Fatalf("the walk did not come back to the review screen: %+v", res)
	}
	res, err = in.Answer(ctx, osUser, "demo", AnswerRequest{Submit: true}, theCall)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if !res.Applied || !res.Done {
		t.Fatalf("Submit did not finish the call: %+v", res)
	}
	if res.Dialog != nil || res.Pane != "" {
		t.Errorf("a finished call carries neither a dialog nor a pane: %+v", res)
	}
	pane, err := in.CapturePane(osUser, "demo")
	if err != nil {
		t.Fatalf("CapturePane: %v", err)
	}
	// Plum alone. A request carries the whole set the question should hold,
	// and the CLI was holding Pear, so the plan cleared it on the way past. A
	// reader who changed their mind has not answered both.
	if !strings.Contains(pane, "SUBMITTED Plum | Coffee") {
		t.Errorf("the answers that reached the stand-in are not the ones chosen:\n%s", pane)
	}
}

// Committing the answer the question already holds keeps it.
//
// Space is a toggle, so the plan that pressed one per chosen row deleted the
// pick it was asked for, left the question with nothing chosen, and answered
// "the screen did not move". The reader's own answer was the one option they
// could not choose.
func TestRepickingAMultiSelectAnswerKeepsIt(t *testing.T) {
	in, osUser := dialogSession(t)
	ctx := context.Background()
	for _, step := range []AnswerRequest{
		{Header: "Fruit", Choice: "Pear"},
		{Back: "Fruit"},
		{Header: "Fruit", Choice: "Pear"},
	} {
		res, err := in.Answer(ctx, osUser, "demo", step, theCall)
		if err != nil {
			t.Fatalf("Answer(%+v): %v", step, err)
		}
		if !res.Applied {
			t.Fatalf("Answer(%+v): applied=%v reason=%q", step, res.Applied, res.Reason)
		}
	}
	pane, err := in.CapturePane(osUser, "demo")
	if err != nil {
		t.Fatalf("CapturePane: %v", err)
	}
	// Past the question, with the pick intact: the tab bar still marks Fruit
	// answered and the dialog has moved on to the drink.
	if !strings.Contains(pane, "☒ Fruit") || !strings.Contains(pane, "Pick one drink") {
		t.Errorf("re-picking Pear cleared it or stayed on the question:\n%s", pane)
	}
}

// A SECOND PICK ADDS TO THE FIRST on a question the reader comes back to, end
// to end against a real tmux.
//
// This is the gap the walk test above documents from the other side: it
// submits "Plum | Coffee" because {Plum} alone is a replacement, and until
// 2026-09-11 that was the only thing a request could say. AnswerRequest.Choice
// was one label, so a reader who came back to add a fruit lost the one they
// had: measured on a pane with Apple ticked and the cursor on its row, the plan
// for Pear opened with a Space on Apple.
//
// Choices carries the desired final state instead, so the same walk ends with
// both fruits. Since 2026-09-23 a reader adds a pick with a toggle and never
// leaves the question to do it (TestAToggleChangesThePicksAndStaysOnTheQuestion);
// coming back with ← is still how an answer already committed is changed.
func TestAnswerAddsAPickToAMultiSelectOnARevisit(t *testing.T) {
	in, osUser := dialogSession(t)
	ctx := context.Background()
	for _, step := range []AnswerRequest{
		{Header: "Fruit", Choice: "Pear"},
		{Back: "Fruit"},
		// Both, because this is the state the question should END in — not
		// "also Apple". A delta would be ambiguous the moment anything else
		// moved the dialog.
		{Header: "Fruit", Choices: []string{"Pear", "Apple"}},
		{Header: "Drink", Choice: "Coffee"},
		{Submit: true},
	} {
		res, err := in.Answer(ctx, osUser, "demo", step, theCall)
		if err != nil {
			t.Fatalf("Answer(%+v): %v", step, err)
		}
		if !res.Applied {
			t.Fatalf("Answer(%+v): applied=%v reason=%q", step, res.Applied, res.Reason)
		}
	}
	pane, err := in.CapturePane(osUser, "demo")
	if err != nil {
		t.Fatalf("CapturePane: %v", err)
	}
	if !strings.Contains(pane, "SUBMITTED Apple, Pear | Coffee") {
		t.Errorf("the second pick replaced the first instead of joining it:\n%s", pane)
	}
}

// The reading says which boxes are filled, which is what lets the card work
// out the set to send next. Without it a second tap can only name one label,
// and naming one label on a question that is holding another is a
// replacement.
func TestAnswerReportsTheTicksItLeftOnTheQuestion(t *testing.T) {
	in, osUser := dialogSession(t)
	ctx := context.Background()
	if _, err := in.Answer(ctx, osUser, "demo",
		AnswerRequest{Header: "Fruit", Choice: "Pear"}, theCall); err != nil {
		t.Fatalf("Answer: %v", err)
	}
	res, err := in.Answer(ctx, osUser, "demo", AnswerRequest{Back: "Fruit"}, theCall)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if res.Dialog == nil {
		t.Fatalf("walking back read no dialog: %+v", res)
	}
	ticked := map[string]bool{}
	for _, o := range res.Dialog.Questions[0].Options {
		ticked[o.Label] = o.Checked
	}
	if !ticked["Pear"] || ticked["Apple"] || ticked["Plum"] {
		t.Errorf("the reading's ticks are %v, want Pear alone", ticked)
	}
}

// A request that says two different things is refused with nothing typed.
//
// Choice is shorthand for a one-element set, so the two fields have to agree.
// Resolving the disagreement by preferring one of them would type keys the
// caller did not unambiguously ask for, on a screen where every keystroke is
// an answer somebody has to live with.
func TestAnswerRefusesARequestThatContradictsItself(t *testing.T) {
	in, osUser := dialogSession(t)
	res, err := in.Answer(context.Background(), osUser, "demo",
		AnswerRequest{Header: "Fruit", Choice: "Apple", Choices: []string{"Pear"}}, theCall)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if res.Applied || res.Reason != AnswerUnknownOption {
		t.Fatalf("applied=%v reason=%q, want unknown-option", res.Applied, res.Reason)
	}
	if res.Dialog == nil || res.Dialog.Answered != 0 {
		t.Errorf("the refusal typed something: %+v", res.Dialog)
	}
}

// THE BLOCKER THIS VERIFICATION IS FOR. The CLI erases the whole frame before
// drawing the next question, so a capture taken inside that window carries no
// footer, no region and no dialog — which is exactly what a finished call
// looks like. One such capture used to end the request as {Applied, Done}: the
// card cleared itself, the next question drew 34 ms later, and the session sat
// blocked with nothing on screen to answer it from.
//
// The stand-in erases and takes 250 ms over the next frame, against a real
// tmux and a real pty. Measured transitions are 63-154 ms on an idle box, so
// this is a loaded one.
func TestARepaintIsNotAFinishedCall(t *testing.T) {
	in, osUser := dialogSessionEnv(t, "FAKEDIALOG_BLINK=1 ")
	res, err := in.Answer(context.Background(), osUser, "demo",
		AnswerRequest{Header: "Fruit", Choice: "Pear"}, theCall)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if res.Done {
		t.Fatalf("a mid-repaint capture reported the whole call as done: %+v", res)
	}
	if !res.Applied || res.Dialog == nil {
		t.Fatalf("applied=%v dialog=%+v, want the reply to carry the screen that came back", res.Applied, res.Dialog)
	}
	if res.Dialog.Questions[0].Question != "Pick one drink" {
		t.Errorf("the reply is not the question the repaint was drawing: %+v", res.Dialog)
	}
}

// The refusal that matters: a card holding an older reading asks for a
// question the pane has moved past. Nothing is typed, and the reply carries
// what IS on screen so the card re-renders instead of latching.
func TestAnswerRefusesAQuestionThePaneIsNotDrawing(t *testing.T) {
	in, osUser := dialogSession(t)
	res, err := in.Answer(context.Background(), osUser, "demo",
		AnswerRequest{Header: "Drink", Choice: "Tea"}, theCall)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if res.Applied || res.Reason != AnswerNotDrawn {
		t.Fatalf("applied=%v reason=%q, want a not-drawn refusal", res.Applied, res.Reason)
	}
	if res.Dialog == nil || res.Dialog.Questions[0].Question != "Pick fruits" {
		t.Fatalf("the refusal did not carry the question that IS drawn: %+v", res.Dialog)
	}
	// Nothing may have been typed: the tab bar is still untouched.
	if res.Dialog.Answered != 0 {
		t.Errorf("answered = %d after a refusal, want 0", res.Dialog.Answered)
	}
}

// With no question list the pane cannot say which tab is current, so the header
// check cannot refuse this. The option list does: a question about fruit does
// not offer Tea.
func TestAnswerRefusesAnOptionTheDrawnQuestionDoesNotOffer(t *testing.T) {
	in, osUser := dialogSession(t)
	for _, tc := range []struct{ name, header, choice string }{
		{"an option belonging to another question", "Drink", "Tea"},
		{"the chat row, which abandons the question", "Fruit", "Chat about this"},
		{"an option nothing on screen has", "Fruit", "Durian"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			res, err := in.Answer(context.Background(), osUser, "demo",
				AnswerRequest{Header: tc.header, Choice: tc.choice}, nil)
			if err != nil {
				t.Fatalf("Answer: %v", err)
			}
			if res.Applied || res.Reason != AnswerUnknownOption {
				t.Fatalf("applied=%v reason=%q, want unknown-option", res.Applied, res.Reason)
			}
			if res.Dialog == nil || res.Dialog.Answered != 0 {
				t.Errorf("the refusal typed something: %+v", res.Dialog)
			}
		})
	}
}

// A header from another call entirely is refused even with nothing known,
// because the tab bar still says which questions this call has.
func TestAnswerRefusesAHeaderThatIsNotInTheCall(t *testing.T) {
	in, osUser := dialogSession(t)
	res, err := in.Answer(context.Background(), osUser, "demo",
		AnswerRequest{Header: "Colour", Choice: "Apple"}, nil)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if res.Applied || res.Reason != AnswerNotDrawn {
		t.Fatalf("applied=%v reason=%q, want not-drawn", res.Applied, res.Reason)
	}
}

// Submit is the one key that commits everything, so it is refused anywhere but
// the screen that asks for it. On a question, Enter would commit whatever row
// the cursor is on — an answer nobody picked.
func TestSubmitIsRefusedAwayFromTheReviewScreen(t *testing.T) {
	in, osUser := dialogSession(t)
	res, err := in.Answer(context.Background(), osUser, "demo", AnswerRequest{Submit: true}, theCall)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if res.Applied || res.Reason != AnswerNotDrawn {
		t.Fatalf("applied=%v reason=%q, want not-drawn", res.Applied, res.Reason)
	}
	if res.Done {
		t.Fatal("a refused Submit reported the call as done")
	}
	if res.Dialog == nil || res.Dialog.Answered != 0 {
		t.Errorf("the refused Submit typed something: %+v", res.Dialog)
	}
}

// Going back needs the call's question list. Without it the driver cannot tell
// where the walk is, and pressing ← blind lands the dialog somewhere nobody
// asked for — so it refuses and says what is on screen.
func TestBackRefusesWhenItCannotPlaceTheWalk(t *testing.T) {
	in, osUser := dialogSession(t)
	res, err := in.Answer(context.Background(), osUser, "demo", AnswerRequest{Back: "Fruit"}, nil)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if res.Applied || res.Reason != AnswerNotDrawn {
		t.Fatalf("applied=%v reason=%q, want not-drawn", res.Applied, res.Reason)
	}
	if res.Dialog == nil || res.Dialog.Questions[0].Question != "Pick fruits" {
		t.Errorf("the refusal did not carry the current reading: %+v", res.Dialog)
	}
}

// FREE TEXT ON A MULTI-SELECT IS ONE MORE PICK, committed with the others.
//
// The row is an inline field there (measured on CLI 2.1.280, 2026-09-23): the
// cursor is walked onto it, the text is pasted and read back, and the paste
// ticks the row. No Enter goes to the field, because on that row Enter flips
// the box it has just ticked. The commit then leaves the question with the
// options and the text together.
func TestAnswerCommitsFreeTextWithTheOtherPicks(t *testing.T) {
	in, osUser := dialogSession(t)
	ctx := context.Background()
	res, err := in.Answer(ctx, osUser, "demo",
		AnswerRequest{Header: "Fruit", Choices: []string{"Apple", "Type something"}, Text: "quince"}, theCall)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if !res.Applied || res.Reason != "" {
		t.Fatalf("applied=%v reason=%q on a free-text answer", res.Applied, res.Reason)
	}
	if res.Dialog == nil || res.Dialog.Questions[0].Question != "Pick one drink" {
		t.Fatalf("the commit did not leave the question: %+v", res.Dialog)
	}
	for _, step := range []AnswerRequest{{Header: "Drink", Choice: "Coffee"}, {Submit: true}} {
		if res, err := in.Answer(ctx, osUser, "demo", step, theCall); err != nil || !res.Applied {
			t.Fatalf("Answer(%+v): %+v %v", step, res, err)
		}
	}
	pane, err := in.CapturePane(osUser, "demo")
	if err != nil {
		t.Fatalf("CapturePane: %v", err)
	}
	if !strings.Contains(pane, "SUBMITTED Apple, quince | Coffee") {
		t.Errorf("the typed pick did not go in with the option:\n%s", pane)
	}
}

// Free text on a SINGLE-select is unchanged: the digit focuses the field, the
// text is typed and read back, and only then does the Enter commit it. An
// Enter on a field the paste never reached answers the question with nothing.
func TestAnswerTypesSingleSelectFreeTextAndCommitsIt(t *testing.T) {
	in, osUser := dialogSession(t)
	ctx := context.Background()
	if res, err := in.Answer(ctx, osUser, "demo", AnswerRequest{Header: "Fruit", Choice: "Pear"}, theCall); err != nil || !res.Applied {
		t.Fatalf("committing the first question: %+v %v", res, err)
	}
	res, err := in.Answer(ctx, osUser, "demo",
		AnswerRequest{Header: "Drink", Choice: "Type something", Text: "oolong"}, theCall)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if !res.Applied || !res.Review {
		t.Fatalf("applied=%v review=%v, want the free-text answer to reach the review", res.Applied, res.Review)
	}
	pane, err := in.CapturePane(osUser, "demo")
	if err != nil {
		t.Fatalf("CapturePane: %v", err)
	}
	if !strings.Contains(pane, "● TYPED oolong") {
		t.Errorf("the text never reached the stand-in's field:\n%s", pane)
	}
}

// Free text with nothing to type is refused before the digit goes in, because
// the digit opens the field and the Enter after it would answer with an empty
// one.
func TestAnswerRefusesFreeTextWithNothingToType(t *testing.T) {
	in, osUser := dialogSession(t)
	res, err := in.Answer(context.Background(), osUser, "demo",
		AnswerRequest{Header: "Fruit", Choice: "Type something", Text: "   "}, theCall)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if res.Applied || res.Reason != AnswerUnknownOption {
		t.Fatalf("applied=%v reason=%q, want a refusal", res.Applied, res.Reason)
	}
}

// A pane with no dialog on it: the card gets the screen itself plus the
// fingerprint, and no keys are sent.
func TestAnswerReportsAPaneWithNoDialog(t *testing.T) {
	in, osUser, _ := scratchSession(t)
	res, err := in.Answer(context.Background(), osUser, "demo",
		AnswerRequest{Header: "Fruit", Choice: "Apple"}, theCall)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if res.Applied || res.Reason != AnswerNoDialog {
		t.Fatalf("applied=%v reason=%q, want no-dialog", res.Applied, res.Reason)
	}
	if res.Dialog != nil {
		t.Errorf("a shell prompt parsed as a dialog: %+v", res.Dialog)
	}
	if res.Pane == "" || res.Markers == nil {
		t.Errorf("the card was given nothing to show: pane=%q markers=%+v", res.Pane, res.Markers)
	}
	if res.Markers.Footer || res.Markers.TabBar {
		t.Errorf("a shell fingerprinted as a dialog: %+v", res.Markers)
	}
}

// The escape hatch for a screen the parser could not read. Its allowlist is the
// keys route's own — the security boundary of that route — rather than a second
// copy that could drift from it.
func TestRawKeysUseTheKeysRouteAllowlist(t *testing.T) {
	in, osUser := dialogSession(t)
	ctx := context.Background()
	for _, tc := range []struct {
		name string
		keys []string
		want string
	}{
		{"a letter is not an answer key", []string{"a"}, AnswerRefused},
		{"more than one answer's worth", make([]string, MaxKeys+1), AnswerRefused},
		{"an arrow is", []string{"Down"}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			keys := tc.keys
			for i := range keys {
				if keys[i] == "" {
					keys[i] = "Down"
				}
			}
			res, err := in.Answer(ctx, osUser, "demo", AnswerRequest{Keys: keys}, nil)
			if err != nil {
				t.Fatalf("Answer: %v", err)
			}
			if res.Reason != tc.want {
				t.Fatalf("reason = %q, want %q", res.Reason, tc.want)
			}
			if res.Dialog == nil {
				t.Error("the reply carried no reading")
			}
		})
	}
}

// The raw-keys route on the screens it exists for: ones the parser could not
// read. There is no dialog before the key and none after it, which is the same
// pair of readings a finished call leaves — so Done used to come back on every
// arrow press, and with it a reply carrying no pane and no markers. The card
// was navigating that pane, and was told its call was over and handed nothing.
func TestRawKeysOnAnUnreadableScreenAreNotADoneCall(t *testing.T) {
	in, osUser, _ := scratchSession(t)
	res, err := in.Answer(context.Background(), osUser, "demo", AnswerRequest{Keys: []string{"Down"}}, nil)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if res.Done {
		t.Fatalf("a key press on a screen with no dialog reported the call as done: %+v", res)
	}
	if res.Pane == "" || res.Markers == nil {
		t.Errorf("the card was left with nothing to draw: pane=%q markers=%+v", res.Pane, res.Markers)
	}
}

// Going back needs the call's question list, and the refusal has to come
// BEFORE the keys: not-drawn means nothing was typed (answerapi.go). From the
// review screen the walk could work out how far to go — the review sits one
// past the last question, which the tab bar alone can say — and then had no
// way to recognise arrival, so it pressed ← the whole distance and reported a
// refusal for a walk that had arrived.
func TestBackWithNoQuestionListTypesNothing(t *testing.T) {
	in, osUser := dialogSession(t)
	ctx := context.Background()
	for _, step := range []AnswerRequest{
		{Header: "Fruit", Choice: "Pear"},
		{Header: "Drink", Choice: "Coffee"},
	} {
		if res, err := in.Answer(ctx, osUser, "demo", step, theCall); err != nil || !res.Applied {
			t.Fatalf("Answer(%+v): %+v %v", step, res, err)
		}
	}
	before, err := in.CapturePane(osUser, "demo")
	if err != nil {
		t.Fatalf("CapturePane: %v", err)
	}
	res, err := in.Answer(ctx, osUser, "demo", AnswerRequest{Back: "Fruit"}, nil)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if res.Applied || res.Reason != AnswerNotDrawn {
		t.Fatalf("applied=%v reason=%q, want not-drawn", res.Applied, res.Reason)
	}
	after, err := in.CapturePane(osUser, "demo")
	if err != nil {
		t.Fatalf("CapturePane: %v", err)
	}
	if after != before {
		t.Errorf("the refusal moved the dialog:\nbefore:\n%s\nafter:\n%s", before, after)
	}
}

// Keys that go in and change nothing are reported as unverified, and nothing
// further is typed. This is the case the old client called a `desync` and
// latched on; here it is one reply carrying the screen as it is.
func TestAnswerReportsUnverifiedWhenTheScreenDoesNotMove(t *testing.T) {
	in, osUser := dialogSessionEnv(t, "FAKEDIALOG_DEAF=1 ")
	res, err := in.Answer(context.Background(), osUser, "demo",
		AnswerRequest{Header: "Fruit", Choice: "Pear"}, theCall)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if res.Applied || res.Reason != AnswerUnverified {
		t.Fatalf("applied=%v reason=%q, want unverified", res.Applied, res.Reason)
	}
	if res.Dialog == nil || res.Dialog.Questions[0].Question != "Pick fruits" {
		t.Fatalf("the reply is not a fresh reading of the stuck screen: %+v", res.Dialog)
	}
}

// answerMoved is the whole of the verification, and it is deliberately blind
// to what comes next: only that the question it was given has been dealt with.
func TestAnswerMovedIsLocalEvidenceOnly(t *testing.T) {
	first := readingOf(t, "dialog-multi.txt")
	second := readingOf(t, "dialog-multi-second.txt")
	review := readingOf(t, "dialog-multi-review.txt")

	if !answerMoved(first, second) {
		t.Error("a different question drawn is the dialog moving")
	}
	if !answerMoved(second, review) {
		t.Error("reaching the review screen is the dialog moving")
	}
	if answerMoved(first, first) {
		t.Error("the same screen twice is the dialog standing still")
	}
	if !answerMoved(first, answerReading{}) {
		t.Error("the dialog going away is the dialog moving")
	}
	// The multi-select case: the same question is still drawn and its box has
	// filled, which is the toggle landing and arrives before the Enter.
	ticked := readingOf(t, "dialog-multi.txt")
	filled := *ticked.dialog
	filled.Answered = 1
	ticked.dialog = &filled
	if !answerMoved(first, ticked) {
		t.Error("a box filling on the tab bar is the dialog moving")
	}
	// A screen the parser lost is not evidence that anything landed.
	lost := answerReading{pane: first.pane, region: first.region}
	if answerMoved(first, lost) {
		t.Error("losing the parse was read as the answer landing")
	}
}

// readingOf is a capture as the driver holds one.
func readingOf(t *testing.T, name string) answerReading {
	t.Helper()
	pane := fixture(t, name)
	r := answerReading{pane: pane, region: answerRegion(pane), dialog: ParseDialog(pane)}
	if r.dialog == nil {
		t.Fatalf("%s no longer parses", name)
	}
	return r
}

// A stand-in for Claude Code's AskUserQuestion dialog. It is not a model of the
// CLI; it is a model of the CONTRACT the driver relies on, drawn the way CLI
// 2.1.280 draws it and answering keys the way that build answers them, as
// measured by driving real dialogs on 2026-09-23:
//
//   - a single-select question is answered by its digit, or by Enter on a row;
//   - on a multi-select every numbered row is a toggle, by Space, by Enter or
//     by its digit, and a digit leaves the cursor where it was;
//   - an unnumbered commit row under the free-text row is what leaves a
//     multi-select, "Next" on every question but the last and "Submit" on the
//     last, so a one-question call says "Submit"; Enter there commits even
//     with nothing ticked, and the question is left unanswered;
//   - a multi-select's free-text row is an inline field: printable keys and a
//     paste go into it and tick it, Space types a space, Backspace to empty
//     clears the box, and Enter flips the box and keeps the text;
//   - that field has a text cursor, and a walk onto the row with ↑ or ↓ puts
//     it at the START of the text: a typed "X" lands before the words and a
//     Backspace takes nothing out. Typing and a paste insert at it, so it is
//     at the end straight after a paste, and C-e moves it to the end of the
//     whole text, a wrapped one included (the live check, 2026-09-23);
//   - the tab box fills on the first pick and empties when none is left;
//   - the review screen follows the last question, for a one-question call
//     too, and is drawn with no footer;
//   - ← to an answered question opens a single-select on its pick, drawn
//     "2. Coffee ✔", and a multi-select on row one with its boxes kept.
//
// The one assumption: a digit typed with the cursor on the free-text field
// goes into the field. Space does, measured, and nothing here presses a digit
// on a multi-select.
//
// It lives here rather than in testdata/ because it is the other half of these
// tests: the assertions above are meaningless without the exact key handling
// below, and a reader should not have to open two files to check one claim.
const fakeDialogPy = `#!/usr/bin/env python3
"""A stand-in AskUserQuestion dialog for answerdrive_test.go.

Raw mode from the first byte, so a bracketed paste (which is how the driver
types free text) arrives as ordinary bytes rather than as line editing.

It draws and answers keys the way Claude Code 2.1.280 does, as measured by
driving real dialogs on 2026-09-23. On a multi-select every numbered row is a
toggle, whether by Space, Enter or its digit, and none of them leaves the
question; an unnumbered commit row under the free-text row does, saying
"Next" on every question but the last and "Submit" on the last. The free-text
row of a multi-select is an inline field.
"""

import os
import sys
import termios
import time
import tty

DEAF = os.environ.get("FAKEDIALOG_DEAF") == "1"
# A full-frame repaint: erase, then take a quarter of a second over the next
# frame. Measured transitions are 63-154 ms on an idle box, so this is what a
# loaded one looks like to capture-pane: a screen with nothing on it.
BLINK = os.environ.get("FAKEDIALOG_BLINK") == "1"

QS = [
    {"header": "Fruit", "text": "Pick fruits", "multi": True,
     "opts": ["Apple", "Pear", "Plum"]},
    {"header": "Drink", "text": "Pick one drink", "multi": False,
     "opts": ["Tea", "Coffee"]},
]
# A one-question call: the multi-select alone. Its commit row says "Submit",
# and it still goes to the review screen.
if os.environ.get("FAKEDIALOG_CALL") == "one":
    QS = QS[:1]

RULE = "─" * 60

# The conversation above the dialog. A real capture carries the prompt that
# asked for the questions and whatever the call before it left behind, so both
# questions' text and the review wording are already on the pane before
# anything is answered. A comparison scoped to the whole capture matches them.
PREAMBLE = [
    "❯ Ask two questions: Fruit (Pick fruits) and Drink (Pick one drink).",
    "● I will put the four picks in front of you at the end, so you can",
    "  Review your answers",
    "  before any of them is sent.",
]

picks = [set() for _ in QS]      # the option labels ticked, per question
field = ["" for _ in QS]         # a multi-select's inline free-text field
field_on = [False for _ in QS]   # and its box
fpos = 0                         # the text cursor in the field on screen
typed = []                       # lines single-select free text leaves behind
at = 0                           # the question on screen; len(QS) is the review
cursor = 0
typing = False                   # a single-select's free-text field is open
buf = ""


def out(s):
    sys.stdout.write(s)
    sys.stdout.flush()


def multi():
    return at < len(QS) and QS[at]["multi"]


def nopts():
    return len(QS[at]["opts"])


def free_row():
    return nopts()


def commit_row():
    # The commit row sits directly under a multi-select's free-text row. A
    # single-select commits with its digit and draws none.
    return nopts() + 1 if multi() else -1


def rows():
    # Where the cursor can stop: the options, the free-text row, the commit
    # row on a multi-select, and the chat row.
    if at >= len(QS):
        return 2
    return nopts() + (3 if multi() else 2)


def answered(i):
    # The tab box fills on the first tick and empties when every box is clear.
    # A ticked free-text row with nothing typed does not fill it: the CLI
    # drops that pick at commit.
    if QS[i]["multi"]:
        return bool(picks[i]) or (field_on[i] and field[i] != "")
    return bool(picks[i])


def tabbar():
    parts = ["←"]
    for i, q in enumerate(QS):
        parts.append(("☒" if answered(i) else "☐") + " " + q["header"])
    parts.append("✔ Submit")
    parts.append("→")
    return "  ".join(parts)


def footer():
    parts = ["Enter to select"]
    parts.append("↑/↓ to navigate" if len(QS) == 1 else "Tab/Arrow keys to navigate")
    # Shown while the cursor is on the free-text or commit row of a
    # multi-select, and gone again on the option rows.
    if multi() and cursor in (free_row(), commit_row()):
        parts.append("ctrl+g to edit in Vim")
    parts.append("Esc to cancel")
    return " · ".join(parts)


def answer_of(i):
    q = QS[i]
    if not q["multi"]:
        return sorted(picks[i])
    got = [o for o in q["opts"] if o in picks[i]]
    if field_on[i] and field[i].strip():
        got.append(field[i].strip())
    return got


def mark(row):
    return "❯" if (row == cursor and not typing) else " "


def draw():
    out("\x1b[2J\x1b[H")
    for line in PREAMBLE + typed:
        out(line + "\r\n")
    out("\r\n")
    out(tabbar() + "\r\n\r\n")
    if at >= len(QS):
        # The review screen, which the CLI draws with NO footer.
        out("Review your answers\r\n\r\n")
        if all(answered(i) for i in range(len(QS))):
            for i, q in enumerate(QS):
                out(" ● " + q["text"] + "\r\n")
                out("   → " + ", ".join(answer_of(i)) + "\r\n")
        else:
            out("⚠ You have not answered all questions\r\n")
        out("\r\nReady to submit your answers?\r\n\r\n")
        out(mark(0) + " 1. Submit answers\r\n")
        out(mark(1) + " 2. Cancel\r\n")
        return
    q = QS[at]
    out(q["text"] + "\r\n\r\n")
    n = nopts()
    for i, o in enumerate(q["opts"]):
        if q["multi"]:
            box = "[✔] " if o in picks[at] else "[ ] "
            out("%s %d. %s%s\r\n" % (mark(i), i + 1, box, o))
        else:
            # A single-select revisited with the left arrow draws its earlier
            # pick with a tick.
            tick = " ✔" if o in picks[at] else ""
            out("%s %d. %s%s\r\n" % (mark(i), i + 1, o, tick))
    if q["multi"]:
        box = "[✔]" if field_on[at] else "[ ]"
        label = field[at] if field[at] != "" else "Type something"
        # The terminal keeps no trailing spaces, so a field holding only a
        # space reads "4. [✔]".
        out(("%s %d. %s %s" % (mark(n), n + 1, box, label)).rstrip() + "\r\n")
        out("%s    %s\r\n" % (mark(n + 1), "Submit" if at == len(QS) - 1 else "Next"))
    else:
        out("%s %d. Type something.\r\n" % (mark(n), n + 1))
    out(RULE + "\r\n")
    out("%s %d. Chat about this\r\n" % (mark(rows() - 1), n + 2))
    if typing:
        out("\r\n  > " + buf + "\r\n")
    out("\r\n" + footer() + "\r\n")


def advance():
    global at, cursor
    at += 1
    cursor = 0
    if BLINK:
        out("\x1b[2J\x1b[H")
        time.sleep(0.25)
    open_on_pick()


def back():
    global at, cursor, typing, buf
    if at == 0:
        return
    at -= 1
    typing = False
    buf = ""
    cursor = 0
    open_on_pick()


def open_on_pick():
    # A single-select question drawn again opens on the pick it holds. A
    # multi-select one opens on row one, its picks drawn as boxes.
    global cursor
    if at < len(QS) and not QS[at]["multi"]:
        chosen = [i for i, o in enumerate(QS[at]["opts"]) if o in picks[at]]
        if chosen:
            cursor = chosen[0]


def toggle(i):
    o = QS[at]["opts"][i]
    if o in picks[at]:
        picks[at].discard(o)
    else:
        picks[at].add(o)


def type_into_field(s):
    # Inserted at the text cursor, which then moves past it. A paste arrives
    # as ordinary bytes, one call per character, so it inserts the same way.
    global fpos
    field[at] = field[at][:fpos] + s + field[at][fpos:]
    fpos += len(s)
    field_on[at] = True


def backspace_field():
    # Takes out the character BEFORE the text cursor, so a Backspace with the
    # cursor at the start of the text takes out nothing.
    global fpos
    if fpos > 0:
        field[at] = field[at][:fpos - 1] + field[at][fpos:]
        fpos -= 1
        if field[at] == "":
            field_on[at] = False


def submitted():
    out("\x1b[2J\x1b[H")
    for line in PREAMBLE + typed:
        out(line + "\r\n")
    out("\r\n● SUBMITTED " + " | ".join(", ".join(answer_of(i)) for i in range(len(QS))) + "\r\n")


def read1():
    b = sys.stdin.buffer.read(1)
    if not b:
        return ""
    extra = 3 if b[0] >= 0xF0 else 2 if b[0] >= 0xE0 else 1 if b[0] >= 0xC0 else 0
    if extra:
        b += sys.stdin.buffer.read(extra)
    return b.decode("utf-8", "replace")


def skip_paste():
    while True:
        c = read1()
        if c in ("~", ""):
            return


def multi_key(ch):
    """One key on a multi-select question."""
    global cursor, fpos
    n = nopts()
    on_field = cursor == free_row()
    if ch in ("\x7f", "\x08"):
        if on_field:
            backspace_field()
        return
    if ch == "\x05":
        # C-e: the text cursor to the end of the field's text.
        if on_field:
            fpos = len(field[at])
        return
    if ch in ("\r", "\n"):
        if cursor < n:
            toggle(cursor)
        elif on_field:
            field_on[at] = not field_on[at]
        elif cursor == commit_row():
            # Commits even with nothing ticked: the question is left
            # unanswered, and the review screen says so.
            advance()
        return
    if on_field and ch.isprintable():
        # The inline field takes every printable key, Space and digits
        # included. Space typing a space is measured; a digit going into the
        # field rather than toggling its row is assumed from that.
        type_into_field(ch)
        return
    if ch == " ":
        if cursor < n:
            toggle(cursor)
        return
    if ch.isdigit() and ch != "0":
        # A digit toggles its row and leaves the cursor where it is.
        i = int(ch) - 1
        if i < n:
            toggle(i)
        elif i == n:
            field_on[at] = not field_on[at]
        return
    # Anything else with the cursor off the field goes nowhere, which is what
    # a paste with the cursor on an option row does.


def single_key(ch):
    """One key on a single-select question."""
    global cursor, typing, buf
    q = QS[at]
    n = nopts()
    if typing:
        if ch in ("\r", "\n"):
            if buf.strip():
                picks[at] = set([buf.strip()])
                typed.append("● TYPED " + buf.strip())
                typing = False
                buf = ""
                advance()
            else:
                typing = False
                buf = ""
        elif ch in ("\x7f", "\x08"):
            buf = buf[:-1]
        else:
            buf += ch
        return
    if ch in ("\r", "\n"):
        if cursor < n:
            picks[at] = set([q["opts"][cursor]])
            advance()
        return
    if ch.isdigit() and ch != "0":
        i = int(ch) - 1
        if i < n:
            picks[at] = set([q["opts"][i]])
            advance()
        elif i == n:
            cursor = i
            typing = True
            buf = ""


def review_key(ch):
    """One key on the review screen. True once the call is submitted."""
    if (ch in ("\r", "\n") and cursor == 0) or ch == "1":
        submitted()
        return True
    return False


def main():
    global cursor, fpos
    fd = sys.stdin.fileno()
    saved = termios.tcgetattr(fd)
    tty.setraw(fd)
    try:
        draw()
        done = False
        while True:
            ch = read1()
            if ch == "":
                return
            if DEAF or done:
                continue
            if ch == "\x1b":
                nxt = read1()
                if nxt != "[":
                    continue
                code = read1()
                if code.isdigit():
                    skip_paste()  # a bracketed-paste marker
                elif typing:
                    pass
                elif code in ("A", "B"):
                    was = cursor
                    if code == "A":
                        cursor = max(0, cursor - 1)
                    else:
                        cursor = min(rows() - 1, cursor + 1)
                    if multi() and cursor == free_row() and cursor != was:
                        # Arriving on the inline field puts its text cursor
                        # at the start of the text, not the end.
                        fpos = 0
                elif code == "D":
                    back()
                draw()
                continue
            if at >= len(QS):
                done = review_key(ch)
                if not done:
                    draw()
                continue
            if multi():
                multi_key(ch)
            else:
                single_key(ch)
            draw()
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)


main()
`

// A pane that merely QUOTES a dialog is not one. Someone reading this feature's
// design doc in their terminal has a tab bar and the review wording on screen,
// and dialog.go recognises the review screen without needing a footer under it
// — so without a guard, Submit would press Enter into whatever that session was
// actually doing.
func TestAnswerRefusesADialogQuotedInTheConversation(t *testing.T) {
	in, osUser, sock := scratchSession(t)
	quote := "printf '%s\\n%s\\n' '←  ☒ Fruit  ☒ Drink  ✔ Submit  →' 'Review your answers'"
	if err := exec.Command("tmux", "-L", sock, "send-keys", "-t", "demo", quote, "Enter").Run(); err != nil {
		t.Fatalf("send-keys: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		pane, err := in.CapturePane(osUser, "demo")
		if err == nil && strings.Contains(pane, "Review your answers") {
			break
		}
		if !time.Now().Before(deadline) {
			t.Fatalf("the quote never reached the pane; pane:\n%s", pane)
		}
		time.Sleep(100 * time.Millisecond)
	}
	for _, req := range []AnswerRequest{
		{Submit: true},
		{Header: "Fruit", Choice: "Apple"},
		{Back: "Fruit"},
	} {
		res, err := in.Answer(context.Background(), osUser, "demo", req, theCall)
		if err != nil {
			t.Fatalf("Answer(%+v): %v", req, err)
		}
		if res.Applied || res.Reason != AnswerNoDialog {
			t.Errorf("Answer(%+v): applied=%v reason=%q, want no-dialog", req, res.Applied, res.Reason)
		}
		if res.Done {
			t.Errorf("Answer(%+v) reported a call it invented as done", req)
		}
	}
}

// Free text that AnswerText will not send — too long for one answer — is a
// refusal, not a screen that failed to move. The two send a reader looking in
// different places, and only one of them is where the problem is.
func TestAnswerReportsRefusedTextAsRefused(t *testing.T) {
	in, osUser := dialogSession(t)
	res, err := in.Answer(context.Background(), osUser, "demo", AnswerRequest{
		Header: "Fruit",
		Choice: "Type something",
		Text:   strings.Repeat("x", MaxAnswerText+1),
	}, theCall)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if res.Applied || res.Reason != AnswerRefused {
		t.Fatalf("applied=%v reason=%q, want refused", res.Applied, res.Reason)
	}
	// Refused before the cursor was walked anywhere: the question is still
	// the one on screen, untouched, and the reader can try again against
	// this reading.
	if res.Dialog == nil || res.Dialog.Questions[0].Question != "Pick fruits" {
		t.Errorf("the refusal did not carry the question still on screen: %+v", res.Dialog)
	}
	if res.Dialog != nil && res.Dialog.Questions[0].Typed != "" {
		t.Errorf("a refused text reached the field: %+v", res.Dialog.Questions[0])
	}
}

// A request that names nothing is not an answer. It reads as a bug in the
// client rather than as a reader's intent, and the pane is somebody's live
// session, so it costs a reading and no keystrokes.
func TestAnswerRefusesARequestThatNamesNothing(t *testing.T) {
	in, osUser := dialogSession(t)
	res, err := in.Answer(context.Background(), osUser, "demo", AnswerRequest{}, theCall)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if res.Applied {
		t.Fatalf("an empty request was applied: %+v", res)
	}
	pane, err := in.CapturePane(osUser, "demo")
	if err != nil {
		t.Fatalf("CapturePane: %v", err)
	}
	if strings.Contains(pane, "TYPED") || strings.Contains(pane, "[✔]") {
		t.Errorf("an empty request typed something:\n%s", pane)
	}
}

// A session that is gone is the one outcome that is an ERROR rather than a
// refusal: there is no reading to attach, so there is nothing for a card to
// render and the caller answers 502 instead of drawing a screen that is not
// there.
func TestAnswerErrorsWhenThePaneCannotBeRead(t *testing.T) {
	in := NewInjectorOnSocket("nobody", "tl-never")
	res, err := in.Answer(context.Background(), "nobody", "gone", AnswerRequest{Submit: true}, nil)
	if err == nil {
		t.Fatalf("reading a session that does not exist should fail; got %+v", res)
	}
	if res.Dialog != nil || res.Pane != "" || res.Applied {
		t.Errorf("an error carries no reading: %+v", res)
	}
}

// oneCall is the question list of the stand-in's one-question variant.
var oneCall = []DialogQuestion{{Header: "Fruit", Question: "Pick fruits", MultiSelect: true}}

// ticksOf is which options a reading draws ticked.
func ticksOf(t *testing.T, res AnswerResponse) map[string]bool {
	t.Helper()
	if res.Dialog == nil || len(res.Dialog.Questions) == 0 {
		t.Fatalf("the reply carries no question: %+v", res)
	}
	ticked := map[string]bool{}
	for _, o := range res.Dialog.Questions[0].Options {
		if o.Checked {
			ticked[o.Label] = true
		}
	}
	return ticked
}

// sameTicks compares a reading's ticks with the labels a test expects.
func sameTicks(got map[string]bool, want ...string) bool {
	if len(got) != len(want) {
		return false
	}
	for _, w := range want {
		if !got[w] {
			return false
		}
	}
	return true
}

// THE BUG THIS CHANGE FIXES, end to end. Viktor, 2026-09-23: "multi answer
// questions now move on to the next step on the first selection and the user
// can't select more than one answer." Every click on a multi-select option
// sent the set AND walked to the commit row and pressed Enter.
//
// A toggle is a request with Stay: the set goes on the boxes and the cursor
// stays on the question. Each reply is the reading the card redraws its ticks
// from, so the card holds no model of the dialog. Clicking the last ticked row
// unticks it like any checkbox, and an empty set is a valid thing to ask for.
func TestAToggleChangesThePicksAndStaysOnTheQuestion(t *testing.T) {
	in, osUser := dialogSession(t)
	ctx := context.Background()
	for _, step := range []struct {
		choices []string
		want    []string
	}{
		{[]string{"Apple"}, []string{"Apple"}},
		{[]string{"Apple", "Pear"}, []string{"Apple", "Pear"}},
		{[]string{"Pear"}, []string{"Pear"}},
		{nil, nil},
		{[]string{"Plum", "Apple"}, []string{"Apple", "Plum"}},
	} {
		res, err := in.Answer(ctx, osUser, "demo",
			AnswerRequest{Header: "Fruit", Choices: step.choices, Stay: true}, theCall)
		if err != nil {
			t.Fatalf("Answer(%v): %v", step.choices, err)
		}
		if !res.Applied || res.Reason != "" {
			t.Fatalf("toggle to %v: applied=%v reason=%q dialog=%+v", step.choices, res.Applied, res.Reason, res.Dialog)
		}
		if res.Review || res.Done {
			t.Fatalf("toggle to %v left the question: %+v", step.choices, res)
		}
		if q := res.Dialog.Questions[0]; q.Question != "Pick fruits" || q.Commit != "Next" {
			t.Fatalf("toggle to %v: the reply is %q with commit %q, want the same question", step.choices, q.Question, q.Commit)
		}
		if got := ticksOf(t, res); !sameTicks(got, step.want...) {
			t.Errorf("toggle to %v: the reading ticks %v", step.choices, got)
		}
	}
	// And only now does the question move: the commit carries the set the
	// card is showing.
	res, err := in.Answer(ctx, osUser, "demo",
		AnswerRequest{Header: "Fruit", Choices: []string{"Apple", "Plum"}}, theCall)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if !res.Applied || res.Dialog == nil || res.Dialog.Questions[0].Question != "Pick one drink" {
		t.Fatalf("the commit did not move on: %+v", res)
	}
}

// FREE TEXT IS ONE MORE PICK, and a toggle puts it in without leaving the
// question. The paste lands in the inline field and ticks it, and nothing
// presses Enter: on that row Enter flips the box off again. Replacing the text
// clears the field with C-e and Backspaces first, and leaving the pick out of
// the set clears it altogether. The cursor never leaves the field between
// these steps; TestAToggleClearsFreeTextAfterAnotherRowWasClicked is the same
// clear after a walk away and back.
func TestAToggleTypesFreeTextWithoutLeavingTheQuestion(t *testing.T) {
	in, osUser := dialogSession(t)
	ctx := context.Background()
	for _, step := range []struct {
		name    string
		choices []string
		text    string
		typed   string
		checked bool
	}{
		{"typed in", []string{"Apple", "Type something"}, "Mango", "Mango", true},
		{"replaced", []string{"Apple", "Type something"}, "Kiwi fruit", "Kiwi fruit", true},
		{"left out of the set", []string{"Apple"}, "", "", false},
		{"typed again, alone", []string{"Type something"}, "Quince", "Quince", true},
	} {
		res, err := in.Answer(ctx, osUser, "demo",
			AnswerRequest{Header: "Fruit", Choices: step.choices, Text: step.text, Stay: true}, theCall)
		if err != nil {
			t.Fatalf("%s: %v", step.name, err)
		}
		if !res.Applied || res.Reason != "" || res.Dialog == nil {
			t.Fatalf("%s: applied=%v reason=%q dialog=%+v", step.name, res.Applied, res.Reason, res.Dialog)
		}
		q := res.Dialog.Questions[0]
		if q.Question != "Pick fruits" {
			t.Fatalf("%s: the toggle left the question for %q", step.name, q.Question)
		}
		if q.Typed != step.typed || q.TypedChecked != step.checked {
			t.Errorf("%s: typed=%q checked=%v, want %q and %v", step.name, q.Typed, q.TypedChecked, step.typed, step.checked)
		}
		if len(q.Options) != 3 {
			t.Errorf("%s: the typed text came back as an option: %+v", step.name, q.Options)
		}
	}
}

// Enter on the free-text row flips its box and keeps the text. A reader who
// did that at the terminal has left words the card shows as not picked, and a
// toggle that picks them again presses the Enter back rather than retyping.
func TestAToggleTicksFreeTextTheTerminalUnticked(t *testing.T) {
	in, osUser := dialogSession(t)
	ctx := context.Background()
	if res, err := in.Answer(ctx, osUser, "demo", AnswerRequest{Header: "Fruit",
		Choices: []string{"Type something"}, Text: "Mango", Stay: true}, theCall); err != nil || !res.Applied {
		t.Fatalf("typing the text: %+v %v", res, err)
	}
	// The cursor is on the field after the paste, so a raw Enter is the
	// reader's own keystroke at the terminal.
	res, err := in.Answer(ctx, osUser, "demo", AnswerRequest{Keys: []string{"Enter"}}, theCall)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if q := res.Dialog.Questions[0]; q.Typed != "Mango" || q.TypedChecked {
		t.Fatalf("typed=%q checked=%v, want the text kept and the box cleared", q.Typed, q.TypedChecked)
	}
	res, err = in.Answer(ctx, osUser, "demo", AnswerRequest{Header: "Fruit",
		Choices: []string{"Type something"}, Text: "Mango", Stay: true}, theCall)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if q := res.Dialog.Questions[0]; !res.Applied || q.Typed != "Mango" || !q.TypedChecked {
		t.Fatalf("applied=%v typed=%q checked=%v, want Mango picked again", res.Applied, q.Typed, q.TypedChecked)
	}
}

// Space on the free-text row types a space rather than ticking it, which is
// what a reader used to ticking boxes with Space does at the terminal. The
// capture trims the space, so the row reads "[✔]" and the reading reports no
// text; a toggle that leaves the pick out still clears it, with the Backspace
// the reading cannot count. That toggle walks up to Pear and back down, so the
// clear starts with the text cursor in front of the space, and it is the C-e
// that puts the cursor behind it.
func TestAToggleClearsASpaceTypedIntoTheFreeTextRow(t *testing.T) {
	in, osUser := dialogSession(t)
	ctx := context.Background()
	for _, keys := range [][]string{{"Down", "Down", "Down"}, {"Space"}} {
		if res, err := in.Answer(ctx, osUser, "demo", AnswerRequest{Keys: keys}, theCall); err != nil || !res.Applied {
			t.Fatalf("keys %v: %+v %v", keys, res, err)
		}
	}
	pane, err := in.CapturePane(osUser, "demo")
	if err != nil {
		t.Fatalf("CapturePane: %v", err)
	}
	if !strings.Contains(pane, "❯ 4. [✔]\n") {
		t.Fatalf("the stand-in did not type the space into its field:\n%s", pane)
	}
	res, err := in.Answer(ctx, osUser, "demo",
		AnswerRequest{Header: "Fruit", Choices: []string{"Pear"}, Stay: true}, theCall)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if !res.Applied || res.Reason != "" {
		t.Fatalf("applied=%v reason=%q", res.Applied, res.Reason)
	}
	if q := res.Dialog.Questions[0]; q.Typed != "" || q.TypedChecked {
		t.Errorf("typed=%q checked=%v, want the field empty and clear", q.Typed, q.TypedChecked)
	}
	if got := ticksOf(t, res); !sameTicks(got, "Pear") {
		t.Errorf("the reading ticks %v, want Pear", got)
	}
}

// FREE TEXT CAN STILL BE TAKEN BACK AFTER THE READER CLICKS ANOTHER ROW, in
// the order the card sends it: the words typed in, an option clicked, then the
// words cleared or replaced.
//
// The live check on CLI 2.1.280 (2026-09-23, its probe X2) found both of the
// last two coming back unverified with "Kiwi" still ticked. A walk onto the
// free-text row with ↑ or ↓ puts the field's text cursor at the START of the
// words, and the clear was Backspaces alone, each one taking out nothing.
// Straight after a paste the cursor is at the end, which is why the clear and
// the replace in TestAToggleTypesFreeTextWithoutLeavingTheQuestion always
// passed: that test never walks away from the field between them.
func TestAToggleClearsFreeTextAfterAnotherRowWasClicked(t *testing.T) {
	in, osUser := dialogSession(t)
	ctx := context.Background()
	for _, step := range []struct {
		name    string
		choices []string
		text    string
		typed   string
		checked bool
		ticks   []string
	}{
		{"typed in", []string{"Type something"}, "Kiwi", "Kiwi", true, nil},
		{"Apple clicked", []string{"Apple", "Type something"}, "Kiwi", "Kiwi", true, []string{"Apple"}},
		{"cleared", []string{"Apple"}, "", "", false, []string{"Apple"}},
		{"typed in again", []string{"Apple", "Type something"}, "Kiwi", "Kiwi", true, []string{"Apple"}},
		{"Pear clicked", []string{"Apple", "Pear", "Type something"}, "Kiwi", "Kiwi", true, []string{"Apple", "Pear"}},
		{"replaced", []string{"Apple", "Pear", "Type something"}, "Mango", "Mango", true, []string{"Apple", "Pear"}},
	} {
		res, err := in.Answer(ctx, osUser, "demo",
			AnswerRequest{Header: "Fruit", Choices: step.choices, Text: step.text, Stay: true}, theCall)
		if err != nil {
			t.Fatalf("%s: %v", step.name, err)
		}
		if !res.Applied || res.Reason != "" || res.Dialog == nil {
			t.Fatalf("%s: applied=%v reason=%q dialog=%+v", step.name, res.Applied, res.Reason, res.Dialog)
		}
		q := res.Dialog.Questions[0]
		if q.Question != "Pick fruits" {
			t.Fatalf("%s: the toggle left the question for %q", step.name, q.Question)
		}
		if q.Typed != step.typed || q.TypedChecked != step.checked {
			t.Errorf("%s: typed=%q checked=%v, want %q and %v", step.name, q.Typed, q.TypedChecked, step.typed, step.checked)
		}
		if got := ticksOf(t, res); !sameTicks(got, step.ticks...) {
			t.Errorf("%s: the reading ticks %v, want %v", step.name, got, step.ticks)
		}
	}
}

// A COMMIT THAT CARRIES A DIFFERENT SET clears the free-text pick the set
// leaves out, and only then leaves the question.
//
// The card commits the set it is showing, so the diff is normally empty. One
// that is not walks the cursor up through the options before it comes back to
// the field, and by then the text cursor is at the start of the words. The
// live check's probe X1d, on CLI 2.1.280 on 2026-09-23: Apple unticked, Pear
// ticked, the typed words still there and still ticked, and the request came
// back unverified with nothing committed.
func TestACommitClearsTheFreeTextItsSetLeavesOut(t *testing.T) {
	in, osUser := dialogSession(t)
	ctx := context.Background()
	res, err := in.Answer(ctx, osUser, "demo", AnswerRequest{Header: "Fruit",
		Choices: []string{"Apple", "Type something"}, Text: "Kiwi fruit", Stay: true}, theCall)
	if err != nil || !res.Applied {
		t.Fatalf("typing the text: %+v %v", res, err)
	}
	res, err = in.Answer(ctx, osUser, "demo",
		AnswerRequest{Header: "Fruit", Choices: []string{"Pear"}}, theCall)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if !res.Applied || res.Reason != "" || res.Dialog == nil || res.Dialog.Questions[0].Question != "Pick one drink" {
		t.Fatalf("applied=%v reason=%q dialog=%+v, want the commit to land on the drink", res.Applied, res.Reason, res.Dialog)
	}
	for _, req := range []AnswerRequest{{Header: "Drink", Choice: "Coffee"}, {Submit: true}} {
		if res, err = in.Answer(ctx, osUser, "demo", req, theCall); err != nil || !res.Applied {
			t.Fatalf("Answer(%+v): %+v %v", req, res, err)
		}
	}
	pane, err := in.CapturePane(osUser, "demo")
	if err != nil {
		t.Fatalf("CapturePane: %v", err)
	}
	if !strings.Contains(pane, "SUBMITTED Pear | Coffee") {
		t.Errorf("the answer that reached the stand-in is not Pear alone:\n%s", pane)
	}
}

// A single-select question has no boxes to hold, so a toggle there is refused
// with nothing typed: its digit answers and moves on, which is the opposite of
// what Stay asks for.
func TestAToggleOnASingleSelectIsRefused(t *testing.T) {
	in, osUser := dialogSession(t)
	ctx := context.Background()
	if res, err := in.Answer(ctx, osUser, "demo", AnswerRequest{Header: "Fruit", Choice: "Pear"}, theCall); err != nil || !res.Applied {
		t.Fatalf("committing the first question: %+v %v", res, err)
	}
	res, err := in.Answer(ctx, osUser, "demo", AnswerRequest{Header: "Drink", Choice: "Tea", Stay: true}, theCall)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if res.Applied || res.Reason != AnswerUnknownOption {
		t.Fatalf("applied=%v reason=%q, want unknown-option", res.Applied, res.Reason)
	}
	if res.Dialog == nil || res.Dialog.Questions[0].Question != "Pick one drink" || res.Dialog.Answered != 1 {
		t.Errorf("the refusal typed something: %+v", res.Dialog)
	}
}

// A commit with nothing picked is refused with nothing typed. The CLI itself
// would take it: Enter on the commit row with no box ticked leaves the question
// unanswered, the review warns "You have not answered all questions", and
// Claude is told "The user did not answer the questions." (measured on 2.1.280,
// 2026-09-23). The card never asks for that, so the server does not do it for
// a card that has gone wrong.
func TestACommitWithNothingPickedIsRefused(t *testing.T) {
	in, osUser := dialogSessionEnv(t, "FAKEDIALOG_CALL=one ")
	ctx := context.Background()
	res, err := in.Answer(ctx, osUser, "demo", AnswerRequest{Header: "Fruit", Choices: []string{}}, oneCall)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if res.Applied || res.Reason != AnswerUnknownOption {
		t.Fatalf("applied=%v reason=%q, want unknown-option", res.Applied, res.Reason)
	}
	if res.Dialog == nil || res.Dialog.Questions[0].Question != "Pick fruits" || res.Review {
		t.Fatalf("the refusal moved the dialog: %+v", res)
	}
	// What the CLI would have done, by hand: walk to "Submit" and press
	// Enter. The question goes to the review unanswered.
	for _, keys := range [][]string{{"Down", "Down", "Down", "Down"}, {"Enter"}} {
		if res, err = in.Answer(ctx, osUser, "demo", AnswerRequest{Keys: keys}, oneCall); err != nil {
			t.Fatalf("keys %v: %v", keys, err)
		}
	}
	if !res.Review || res.Dialog == nil || res.Dialog.Answered != 0 {
		t.Fatalf("an empty commit at the terminal: %+v, want the review with nothing answered", res)
	}
}

// A ONE-QUESTION CALL goes to the review screen too. Its only question is the
// last, so its commit row says "Submit", and Enter there opens the review,
// drawn with no footer, where Submit is one more request.
func TestACommitOnAOneQuestionCallGoesToTheReviewScreen(t *testing.T) {
	in, osUser := dialogSessionEnv(t, "FAKEDIALOG_CALL=one ")
	ctx := context.Background()
	res, err := in.Answer(ctx, osUser, "demo",
		AnswerRequest{Header: "Fruit", Choices: []string{"Apple"}, Stay: true}, oneCall)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if !res.Applied || res.Dialog.Questions[0].Commit != "Submit" {
		t.Fatalf("applied=%v commit=%q, want Submit on the only question", res.Applied, res.Dialog.Questions[0].Commit)
	}
	res, err = in.Answer(ctx, osUser, "demo",
		AnswerRequest{Header: "Fruit", Choices: []string{"Apple", "Type something"}, Text: "Mango"}, oneCall)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if !res.Applied || !res.Review {
		t.Fatalf("applied=%v review=%v reason=%q, want the review screen", res.Applied, res.Review, res.Reason)
	}
	res, err = in.Answer(ctx, osUser, "demo", AnswerRequest{Submit: true}, oneCall)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if !res.Applied || !res.Done {
		t.Fatalf("Submit did not finish the call: %+v", res)
	}
	pane, err := in.CapturePane(osUser, "demo")
	if err != nil {
		t.Fatalf("CapturePane: %v", err)
	}
	if !strings.Contains(pane, "SUBMITTED Apple, Mango") {
		t.Errorf("the answer that reached the stand-in is not the one chosen:\n%s", pane)
	}
}

// A cursor parked on the commit row, where a reader at the terminal can leave
// it and where a commit that did not take does. The pane draws it as
// "❯    Next", which until 2026-09-23 made the whole reading nil, so a toggle
// from there came back no-dialog. Now it walks up to the row it toggles.
func TestAToggleFromTheCommitRowWalksBackUp(t *testing.T) {
	in, osUser := dialogSession(t)
	ctx := context.Background()
	res, err := in.Answer(ctx, osUser, "demo", AnswerRequest{Keys: []string{"Down", "Down", "Down", "Down"}}, theCall)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if res.Dialog == nil {
		t.Fatalf("the cursor on the commit row left the pane unreadable: %+v", res)
	}
	res, err = in.Answer(ctx, osUser, "demo",
		AnswerRequest{Header: "Fruit", Choices: []string{"Pear"}, Stay: true}, theCall)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if !res.Applied || !sameTicks(ticksOf(t, res), "Pear") {
		t.Fatalf("applied=%v reason=%q ticks=%v, want Pear", res.Applied, res.Reason, ticksOf(t, res))
	}
}
