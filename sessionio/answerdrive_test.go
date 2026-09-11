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
// The stand-in models three measured behaviours that the fixtures cannot show,
// because a static capture has no keyboard:
//
//   - a multi-select question's tab-bar box flips to ☒ on the FIRST Space,
//     before the Enter that leaves the question;
//   - a question revisited with ← draws its earlier pick as "2. Pear ✔" and
//     opens the cursor on that row;
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

	// One toggle of a multi-select, then the Enter that leaves the question.
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

	// Changing the pick, from a cursor that is now sitting on the old one.
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
	// Plum alone. A multi-select row is a TOGGLE and the CLI was holding Pear,
	// so the plan cleared it on the way past: choosing again REPLACES the
	// answer, which is what the design says going back is for. Adding to it
	// would leave a reader who changed their mind having answered both.
	if !strings.Contains(pane, "SUBMITTED Plum | Coffee") {
		t.Errorf("the answers that reached the stand-in are not the ones chosen:\n%s", pane)
	}
}

// Tapping the answer you already gave keeps it.
//
// Space is a toggle, so the plan that pressed one per chosen row deleted the
// pick it was asked for, left the question with nothing chosen — where the
// Enter cannot leave it — and answered "the screen did not move". The reader's
// own answer was the one option they could not choose.
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

// A SECOND PICK ADDS TO THE FIRST, end to end against a real tmux.
//
// This is the gap the walk test above documents from the other side: it
// submits "Plum | Coffee" because {Plum} alone is a replacement, and until
// 2026-09-11 that was the only thing a request could say. AnswerRequest.Choice
// was one label, so answerChoice planned from a one-element set and a reader
// who came back to add a fruit lost the one they had — measured on a pane with
// Apple ticked and the cursor on its row, where the plan for Pear opens with a
// Space on Apple.
//
// Choices carries the desired final state instead, so the same walk ends with
// both fruits. The Enter is still what leaves the question, so adding a pick
// is still a revisit: the card comes back with ← and sends what it wants held.
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

// The free-text row is focused by its digit, typed into, read back, and only
// then committed. An Enter on a field the paste never reached answers the
// question with nothing.
func TestAnswerTypesTheFreeTextOptionAndCommitsIt(t *testing.T) {
	in, osUser := dialogSession(t)
	res, err := in.Answer(context.Background(), osUser, "demo",
		AnswerRequest{Header: "Fruit", Choice: "Type something", Text: "quince"}, theCall)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if !res.Applied || res.Reason != "" {
		t.Fatalf("applied=%v reason=%q on a free-text answer", res.Applied, res.Reason)
	}
	if res.Dialog == nil || res.Dialog.Questions[0].Question != "Pick one drink" {
		t.Fatalf("the free-text answer did not leave the question: %+v", res.Dialog)
	}
	pane, err := in.CapturePane(osUser, "demo")
	if err != nil {
		t.Fatalf("CapturePane: %v", err)
	}
	if !strings.Contains(pane, "● TYPED quince") {
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
// CLI; it is a model of the CONTRACT the driver relies on — a numbered list
// answered by digit, a multi-select toggled with Space and left with Enter, a
// free-text row focused by its digit, ← to an earlier question, and a review
// screen that Submit closes.
//
// It lives here rather than in testdata/ because it is the other half of these
// tests: the assertions above are meaningless without the exact key handling
// below, and a reader should not have to open two files to check one claim.
const fakeDialogPy = `#!/usr/bin/env python3
"""A stand-in AskUserQuestion dialog for answerdrive_test.go.

Raw mode from the first byte, so a bracketed paste (which is how the driver
types free text) arrives as ordinary bytes rather than as line editing.
"""

import os
import sys
import termios
import time
import tty

DEAF = os.environ.get("FAKEDIALOG_DEAF") == "1"
# A full-frame repaint: erase, then take a quarter of a second over the next
# frame. Measured transitions are 63-154 ms on an idle box, so this is what a
# loaded one looks like to capture-pane — a screen with nothing on it.
BLINK = os.environ.get("FAKEDIALOG_BLINK") == "1"

QS = [
    {"header": "Fruit", "text": "Pick fruits", "multi": True,
     "opts": ["Apple", "Pear", "Plum"]},
    {"header": "Drink", "text": "Pick one drink", "multi": False,
     "opts": ["Tea", "Coffee"]},
]
FOOTER = "Enter to select · Tab/Arrow keys to navigate · Esc to cancel"

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

picks = [set(), set()]
typed = []
at = 0
cursor = 0
typing = False
buf = ""


def out(s):
    sys.stdout.write(s)
    sys.stdout.flush()


def tabbar():
    parts = ["←"]
    for i, q in enumerate(QS):
        parts.append(("☒" if picks[i] else "☐") + " " + q["header"])
    parts.append("✔ Submit")
    parts.append("→")
    return "  ".join(parts)


def draw():
    out("\x1b[2J\x1b[H")
    for line in PREAMBLE + typed:
        out(line + "\r\n")
    out("\r\n")
    out(tabbar() + "\r\n\r\n")
    if at >= len(QS):
        out("Review your answers\r\n\r\n")
        out("Ready to submit your answers?\r\n\r\n")
        out("❯ 1. Submit answers\r\n")
        out("  2. Cancel\r\n\r\n")
        out(FOOTER + "\r\n")
        return
    q = QS[at]
    out(q["text"] + "\r\n\r\n")
    n = 0
    for i, o in enumerate(q["opts"]):
        n = i + 1
        mark = "❯" if (i == cursor and not typing) else " "
        box = ""
        if q["multi"]:
            box = "[✔] " if o in picks[at] else "[ ] "
        # A question revisited with ← draws its earlier pick with a tick.
        tick = " ✔" if (not q["multi"] and o in picks[at]) else ""
        out("%s %d. %s%s%s\r\n" % (mark, n, box, o, tick))
    free = n + 1
    mark = "❯" if (cursor == free - 1 and not typing) else " "
    out("%s %d. Type something.\r\n" % (mark, free))
    out("  %d. Chat about this\r\n" % (free + 1))
    if typing:
        out("\r\n  > " + buf + "\r\n")
    out("\r\n" + FOOTER + "\r\n")


def rows():
    if at >= len(QS):
        return 2
    return len(QS[at]["opts"]) + 2


def advance():
    global at, cursor
    at += 1
    cursor = 0
    if BLINK:
        out("\x1b[2J\x1b[H")
        time.sleep(0.25)
    if at < len(QS):
        chosen = [i for i, o in enumerate(QS[at]["opts"]) if o in picks[at]]
        if chosen:
            cursor = chosen[0]


def back():
    global at, cursor
    if at == 0:
        return
    at -= 1
    cursor = 0
    chosen = [i for i, o in enumerate(QS[at]["opts"]) if o in picks[at]]
    if chosen:
        cursor = chosen[0]


def submitted():
    out("\x1b[2J\x1b[H")
    for line in PREAMBLE + typed:
        out(line + "\r\n")
    out("\r\n● SUBMITTED " + " | ".join(", ".join(sorted(p)) for p in picks) + "\r\n")


def read1():
    b = sys.stdin.buffer.read(1)
    return b.decode("utf-8", "replace") if b else ""


def skip_paste():
    while True:
        c = read1()
        if c in ("~", ""):
            return


def main():
    global at, cursor, typing, buf
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
                elif code == "A":
                    cursor = max(0, cursor - 1)
                elif code == "B":
                    cursor = min(rows() - 1, cursor + 1)
                elif code == "D":
                    back()
                draw()
                continue
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
                    draw()
                    continue
                buf += ch
                draw()
                continue
            if ch == " ":
                if at < len(QS) and QS[at]["multi"] and cursor < len(QS[at]["opts"]):
                    o = QS[at]["opts"][cursor]
                    if o in picks[at]:
                        picks[at].discard(o)
                    else:
                        picks[at].add(o)
                draw()
                continue
            if ch in ("\r", "\n"):
                if at >= len(QS):
                    if cursor == 0:
                        submitted()
                        done = True
                        continue
                    draw()
                    continue
                q = QS[at]
                if q["multi"]:
                    if picks[at]:
                        advance()
                elif cursor < len(q["opts"]):
                    picks[at] = set([q["opts"][cursor]])
                    advance()
                draw()
                continue
            if ch.isdigit() and ch != "0":
                i = int(ch) - 1
                if at >= len(QS):
                    if i == 0:
                        submitted()
                        done = True
                        continue
                    draw()
                    continue
                q = QS[at]
                if i < len(q["opts"]):
                    if q["multi"]:
                        # On a multi-select list a digit moves the cursor; the
                        # Space that follows is what toggles.
                        cursor = i
                    else:
                        picks[at] = set([q["opts"][i]])
                        advance()
                elif i == len(q["opts"]):
                    cursor = i
                    typing = True
                    buf = ""
                draw()
                continue
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
	// The digit that focused the field went in, so the question is still the
	// one on screen and the reader can try again against this reading.
	if res.Dialog == nil || res.Dialog.Questions[0].Question != "Pick fruits" {
		t.Errorf("the refusal did not carry the question still on screen: %+v", res.Dialog)
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
