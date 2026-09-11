package sessionio

import (
	"context"
	"strings"
	"time"
)

// Applying ONE request to the dialog the pane is drawing.
//
// The rule this file is built on: NOTHING IS PREDICTED. Every reply is a
// reading taken after the action, and every check compares that reading
// against the one taken before it — never against text a caller expected to
// appear. The browser walk this replaces predicted each next screen and, over
// 10 days of field data, four-question answers failed 4 times in 5, always
// because the prediction missed
// (docs/plans/2026-09-10-text-mode-answers-dialogs-design.md).
//
// What that leaves is three things a capture can prove locally: the dialog
// went away, it became the review screen, or this question's box filled. Any
// of those means the keys landed. None of them says what the NEXT question is,
// which is exactly the claim that kept being wrong.
//
// A refusal is as useful as a success here, so it carries the same fresh
// reading. A card that is handed "not this question, here is what is on
// screen" re-renders and the reader carries on; the shipped one latched and
// told them to open the Terminal.

// answerVerify is how long the dialog gets to show that the keys landed,
// polled at keySettle. Both transitions were measured on 2026-09-10 against
// CLI 2.1.267 on an idle box: 154 ms from a digit to the next question, 63 ms
// from a digit to the review screen. 600 ms is four times the slower of the
// two, which covers a loaded box without leaving a tapped row spinning long
// enough to be worth a second tap.
const answerVerify = 600 * time.Millisecond

// answerReading is one look at the pane: the capture, the dialog's own region
// of it, and the parse.
type answerReading struct {
	pane   string
	region []string
	dialog *Dialog
}

// read takes a reading. Every step of every request goes through here, so
// there is exactly one place where the pane becomes a decision.
//
// IT PARSES THE REGION, NOT THE CAPTURE. dialog.go recognises the review screen
// by any trimmed line anywhere in the capture that equals "Review your answers"
// or "Ready to submit your answers?", so a conversation that wraps either onto
// a line of its own — this feature's own design doc does, and so does any
// session discussing it — turns every reading into a review screen while a
// question is on the pane. The card then shows a Submit that is not there and
// the reader cannot answer at all. Scoping the parse to the dialog's own lines
// is the same fix as scoping the comparisons, applied to the parse.
//
// THERE IS NO SECOND ATTEMPT OVER THE WHOLE CAPTURE. One stood here until
// 2026-09-11, for narrow panes: the footer wraps below 60 columns, the region
// stopped at the line it started on, and the parse failed. It reintroduced
// exactly what the scoping removes — on the 58-column capture with the review
// wording anywhere in the conversation it reported "Ready to submit your
// answers?" and no options while the pane drew a question, on the phone the bug
// was filed from. answerRegion now carries the footer's continuation lines, so
// the region parses on its own and a region that will not parse is a screen we
// honestly could not read: the reply shows the pane itself.
func (in *Injector) read(osUser, session string) (answerReading, error) {
	pane, err := in.CapturePane(osUser, session)
	if err != nil {
		return answerReading{}, err
	}
	r := answerReading{pane: pane, region: answerRegion(pane)}
	// No footer, no dialog to drive. The select widget draws one under every
	// screen it owns, this one included, and reviewScreen() in dialog.go does
	// not require it — so a pane that merely QUOTES a tab bar and "Review your
	// answers", which is what reading this feature's design doc in a terminal
	// looks like, would otherwise parse as a review screen and take a Submit.
	// answerRegion is more forgiving on purpose, because a dialog whose footer
	// the CLI has restyled is precisely what the marker fingerprint is for; a
	// screen this route cannot verify against is not one it should be typing
	// into, so the region goes with the footer here.
	if len(r.region) == 0 || footerAt(strings.Split(pane, "\n")) < 0 {
		// THE REVIEW SCREEN IS THE ONE DIALOG WITH NO FOOTER, so the check
		// above throws it away and the last answer of every multi-question
		// call reported Done while the session sat waiting on Submit.
		// reviewTail only matches on all three of its landmarks at once, so
		// this does not give back the quoted-dialog hole the footer closes.
		if tail := reviewTail(strings.Split(pane, "\n")); tail != nil {
			r.region = tail
			r.dialog = ParseDialog(strings.Join(tail, "\n"))
			if r.dialog != nil {
				return r, nil
			}
		}
		return answerReading{pane: pane}, nil
	}
	r.dialog = ParseDialog(strings.Join(r.region, "\n"))
	return r, nil
}

// gone reports that THIS CAPTURE carries no dialog at all, as opposed to
// carrying one the parser could not read. The difference matters: the first is
// what a finished dialog looks like, and calling the second one Done would tell
// a reader their answer went in when the screen is still sitting there waiting
// for it.
//
// One such capture is not the dialog being over — see stillGone. Nothing calls
// this to decide Done on its own.
func (r answerReading) gone() bool {
	return r.dialog == nil && len(r.region) == 0
}

// reply packages a reading for the wire. An empty reason means the request was
// applied.
func (r answerReading) reply(reason string) AnswerResponse {
	resp := AnswerResponse{Applied: reason == "", Reason: reason}
	if r.dialog != nil {
		resp.Dialog = r.dialog
		resp.Review = reviewOnScreen(r.region)
		return resp
	}
	// A screen the parser could not read is shown to the reader as itself,
	// with the fingerprint of which landmarks it carried so drift in the CLI
	// turns into a signal rather than a bug report.
	resp.Pane = r.pane
	m := ParseDialogMarkers(r.pane)
	resp.Markers = &m
	return resp
}

// replyDone is the reply for a dialog that has finished. It carries no pane:
// the transcript has the answers from here, and the card has nothing left to
// draw.
func (r answerReading) replyDone() AnswerResponse {
	return AnswerResponse{Applied: true, Done: true}
}

// Answer applies one request to the session's AskUserQuestion and answers with
// a fresh reading of whatever the pane shows afterwards.
//
// `known` is the call's own question list, as the transcript records it, and
// it is what places the pane: a multi-question dialog draws no per-question
// header, and which tab is current is drawn in colour, which `capture-pane -p`
// does not carry. With it, the driver can prove the pane is drawing the
// question a request names, and ← can walk to a named one. Without it (nil),
// placement falls back to three weaker checks: the header has to be one of the
// tab bar's, its box there must not already be ticked, and the option has to be
// one the drawn question offers. A client holding the previous question's
// reading is caught by the second — that question has an answer, so the dialog
// is not waiting on it — and by the third whenever the two questions offer
// different labels. Going back is refused outright, because arrival cannot be
// proved without the list.
//
// The error return is for a pane that could not be read at all, which is a
// session that has gone away. Every other outcome, refusals included, is a
// normal response carrying the current reading.
func (in *Injector) Answer(ctx context.Context, osUser, session string, req AnswerRequest, known []DialogQuestion) (AnswerResponse, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	before, err := in.read(osUser, session)
	if err != nil {
		return AnswerResponse{}, err
	}
	// The escape hatch goes first: raw keys are what the card offers for a
	// screen the parser could not read, so they cannot require a parse.
	if len(req.Keys) > 0 {
		return in.answerKeys(ctx, osUser, session, before, req.Keys)
	}
	if before.dialog == nil {
		return before.reply(AnswerNoDialog), nil
	}
	switch {
	case req.Submit:
		return in.answerSubmit(ctx, osUser, session, before)
	case req.Back != "":
		return in.answerBack(ctx, osUser, session, before, req.Back, known)
	}
	return in.answerChoice(ctx, osUser, session, before, req, known)
}

// answerKeys sends raw keys through the same allowlist and the same cap as
// POST /keys — Injector.Keys is that check, and there is deliberately no
// second copy of it here.
//
// Nothing is verified afterwards, because this route exists for screens we
// could not read in the first place and there is no "moved" to define. Applied
// means the keys were delivered; the reading that comes back is the evidence.
//
// Done needs a dialog to have finished, so it needs there to have been one.
// This route's own screens — the ones the parser could not read — have no
// region and no dialog before OR after, which is indistinguishable from a
// dialog that ended; reporting Done there told the card its call was over and
// took away the pane it was navigating, mid-navigation, on every arrow press.
func (in *Injector) answerKeys(ctx context.Context, osUser, session string, before answerReading, keys []string) (AnswerResponse, error) {
	if err := in.Keys(osUser, session, keys); err != nil {
		return before.reply(AnswerRefused), nil
	}
	if err := answerWait(ctx, keySettle); err != nil {
		return AnswerResponse{}, err
	}
	after, err := in.read(osUser, session)
	if err != nil {
		return AnswerResponse{}, err
	}
	if before.dialog != nil && after.gone() {
		last, ok, err := in.stillGone(ctx, osUser, session, after, time.Now().Add(answerVerify))
		if err != nil {
			return AnswerResponse{}, err
		}
		if ok {
			return last.replyDone(), nil
		}
		after = last
	}
	return after.reply(""), nil
}

// answerSubmit presses the review screen's Submit.
func (in *Injector) answerSubmit(ctx context.Context, osUser, session string, before answerReading) (AnswerResponse, error) {
	if !reviewOnScreen(before.region) {
		// On a question, Enter answers with whatever row the cursor is on.
		return before.reply(AnswerNotDrawn), nil
	}
	if err := in.Keys(osUser, session, []string{"Enter"}); err != nil {
		return before.reply(AnswerRefused), nil
	}
	after, ok, err := in.awaitMoved(ctx, osUser, session, before)
	if err != nil {
		return AnswerResponse{}, err
	}
	if !ok || !after.gone() {
		return after.reply(AnswerUnverified), nil
	}
	return after.replyDone(), nil
}

// answerBack walks ← to an earlier question, one press at a time, reading the
// pane between presses.
//
// It never presses more times than the call has questions, and it stops the
// moment the named question is on screen. A walk that ends somewhere else is a
// refusal with the current reading rather than a longer walk: ← is cheap to
// repeat and typing into the wrong question is not.
func (in *Injector) answerBack(ctx context.Context, osUser, session string, before answerReading, header string, known []DialogQuestion) (AnswerResponse, error) {
	if len(known) == 0 {
		// Arrival is proved by matching the drawn question against the call's
		// own list, and with no list nothing can ever match — a multi-question
		// dialog draws no per-question header, and which tab is current is
		// colour. Refusing here rather than at the end of the walk is the
		// difference between "nothing was typed", which is what not-drawn
		// promises (answerapi.go), and pressing ← the whole distance and then
		// reporting a refusal for a walk that had in fact arrived.
		return before.reply(AnswerNotDrawn), nil
	}
	to := -1
	from, placed := answerPosition(before, known)
	if placed {
		var n int
		if n, placed = leftPresses(before.dialog.Headers, from, header); placed {
			to = from - n
		}
	}
	if !placed {
		// Either the header is not one this call has, is ahead rather than
		// behind, or the capture cannot say where the walk currently is —
		// which is the case for a multi-question dialog with no known question
		// list, since the pane does not draw the current header anywhere.
		return before.reply(AnswerNotDrawn), nil
	}
	cur := before
	for presses := from - to; presses > 0; presses-- {
		if at, ok := questionOnScreen(cur.dialog, known); ok && at == to {
			return cur.reply(""), nil
		}
		if err := in.Keys(osUser, session, []string{"Left"}); err != nil {
			return cur.reply(AnswerRefused), nil
		}
		if err := answerWait(ctx, keySettle); err != nil {
			return AnswerResponse{}, err
		}
		next, err := in.read(osUser, session)
		if err != nil {
			return AnswerResponse{}, err
		}
		cur = next
		if cur.dialog == nil {
			// Something else ended the dialog while we were walking.
			return cur.reply(AnswerUnverified), nil
		}
	}
	if at, ok := questionOnScreen(cur.dialog, known); ok && at == to {
		return cur.reply(""), nil
	}
	return cur.reply(AnswerNotDrawn), nil
}

// answerChoice answers the question on screen with one of its options.
func (in *Injector) answerChoice(ctx context.Context, osUser, session string, before answerReading, req AnswerRequest, known []DialogQuestion) (AnswerResponse, error) {
	if strings.TrimSpace(req.Header) == "" {
		// A request that names no question cannot be checked against the one
		// on screen, and checking is the whole point.
		return before.reply(AnswerNotDrawn), nil
	}
	if drawnHeader(before.dialog, before.region, req.Header, known) == drawnElsewhere {
		return before.reply(AnswerNotDrawn), nil
	}
	choices, err := requestChoices(req)
	if err != nil {
		// A request that says two different things. Refused with the current
		// reading and nothing typed, under the same reason as a label the
		// question does not offer: in both cases the server cannot say which
		// option the caller meant, and no new word on the wire is worth a
		// case only a malformed client can reach.
		return before.reply(AnswerUnknownOption), nil
	}
	plan, err := planChoice(before.dialog, before.region, choices, req.Text)
	if err != nil {
		return before.reply(AnswerUnknownOption), nil
	}

	for i, batch := range plan.Batches {
		if i > 0 {
			// A settle between batches, which is where the committing
			// keystroke sits: planChoice puts the Enter in a batch of its own
			// for this. The model picker on this same TUI settles in exactly
			// these two places, between runs of keys and before the one that
			// commits (setmodel.go:173-183), and sends each run as a single
			// send-keys like this does; the answer path allowed nothing at
			// all, which is one of the four candidates the field data could
			// not rule out.
			if err := answerWait(ctx, keySettle); err != nil {
				return AnswerResponse{}, err
			}
		}
		if err := in.Keys(osUser, session, batch); err != nil {
			after, rerr := in.read(osUser, session)
			if rerr != nil {
				return AnswerResponse{}, rerr
			}
			return after.reply(AnswerRefused), nil
		}
	}

	if plan.Text != "" {
		typed, reason, err := in.typeAnswer(ctx, osUser, session, plan.Text)
		if err != nil {
			return AnswerResponse{}, err
		}
		if reason != "" {
			// Either the paste was refused or the text is not on screen. Both
			// end the request here: the Enter that commits the field would
			// answer the question with an empty one.
			return typed.reply(reason), nil
		}
		if err := in.Keys(osUser, session, plan.After); err != nil {
			return typed.reply(AnswerRefused), nil
		}
	}

	after, ok, err := in.awaitMoved(ctx, osUser, session, before)
	if err != nil {
		return AnswerResponse{}, err
	}
	if !ok {
		return after.reply(AnswerUnverified), nil
	}
	if after.gone() {
		return after.replyDone(), nil
	}
	return after.reply(""), nil
}

// typeAnswer puts free text into the focused field and reads it back off the
// pane before anybody presses Enter on it.
//
// The read-back is scoped to the dialog region, and it asks whether the region
// GAINED the text rather than whether it holds it. Presence on its own confirms
// anything the dialog already drew: the region is where the question, every
// option label and every description live, so a reader answering in the
// question's own words — "Include apples." is option one's description on
// dialog-multi.txt — read back as landed against a field the paste never
// reached, and the Enter that follows answers the question with an empty one.
// The comparison is against a reading taken after the digit focused the field
// and before anything was typed, which is the only reading that can say what
// was already there.
func (in *Injector) typeAnswer(ctx context.Context, osUser, session, text string) (answerReading, string, error) {
	if err := answerWait(ctx, keySettle); err != nil {
		return answerReading{}, "", err
	}
	beforeTyping, err := in.read(osUser, session)
	if err != nil {
		return answerReading{}, "", err
	}
	if err := in.AnswerText(osUser, session, text); err != nil {
		// AnswerText checks the text before it sends any of it — empty, too
		// long, or carrying a newline that would submit the field halfway
		// through — so nothing was typed. That is a refusal, and telling the
		// reader "the screen did not move" instead would send them looking at
		// the terminal for a problem that is in what they typed.
		cur, rerr := in.read(osUser, session)
		return cur, AnswerRefused, rerr
	}
	deadline := time.Now().Add(answerVerify)
	for {
		if err := answerWait(ctx, keySettle); err != nil {
			return answerReading{}, "", err
		}
		cur, err := in.read(osUser, session)
		if err != nil {
			return answerReading{}, "", err
		}
		if answerRegionGained(beforeTyping.region, cur.region, text) {
			return cur, "", nil
		}
		if !time.Now().Before(deadline) {
			return cur, AnswerUnverified, nil
		}
	}
}

// awaitMoved reads the pane until it shows that the keys landed, or until the
// verify window runs out.
//
// It polls the CONDITION rather than sleeping a guessed duration: a fixed
// sleep returns success at the same moment whether the dialog moved, failed,
// or never got the keys.
func (in *Injector) awaitMoved(ctx context.Context, osUser, session string, before answerReading) (answerReading, bool, error) {
	deadline := time.Now().Add(answerVerify)
	for {
		if err := answerWait(ctx, keySettle); err != nil {
			return answerReading{}, false, err
		}
		after, err := in.read(osUser, session)
		if err != nil {
			return answerReading{}, false, err
		}
		if after.gone() {
			last, ok, err := in.stillGone(ctx, osUser, session, after, deadline)
			if err != nil {
				return answerReading{}, false, err
			}
			if ok {
				return last, true, nil
			}
			// The dialog came back: it was a repaint, and this is the reading
			// that says what the keys actually did.
			after = last
		}
		if answerMoved(before, after) {
			return after, true, nil
		}
		if !time.Now().Before(deadline) {
			return after, false, nil
		}
	}
}

// stillGone re-reads until the window is out and reports whether the dialog
// stayed away for the whole of it.
//
// ONE EMPTY CAPTURE IS NOT A FINISHED DIALOG. The CLI erases the frame before
// it draws the next question — measured 2026-09-10, 154 ms from the digit to
// the next question drawn on an idle box, and the first poll here is at
// keySettle, 120 ms, inside that window — so a capture taken mid-repaint has
// no footer, no region and no dialog, which is exactly what a dialog that has
// finished looks like. Reproduced against a real pty with a stand-in that
// erases and takes 250 ms over the next frame: the call came back
// {Applied:true, Done:true} with no pane while question two was 34 ms from
// being drawn, so the card cleared itself and the session sat blocked.
//
// Done is the one answer a card cannot recover from on its own, which is why
// it is the one answer worth a second look. The window is answerVerify, the
// same bound the rest of this file gives a transition, because a blank frame
// can only be a repaint for as long as a repaint can take. The cost is paid
// only when the dialog really has gone: any reading that carries one returns
// immediately.
func (in *Injector) stillGone(ctx context.Context, osUser, session string, first answerReading, deadline time.Time) (answerReading, bool, error) {
	cur := first
	for time.Now().Before(deadline) {
		if err := answerWait(ctx, keySettle); err != nil {
			return answerReading{}, false, err
		}
		next, err := in.read(osUser, session)
		if err != nil {
			return answerReading{}, false, err
		}
		cur = next
		if !cur.gone() {
			return cur, false, nil
		}
	}
	return cur, true, nil
}

// answerMoved reports whether the dialog changed the way answering a question
// changes it.
//
// Three signals, all of them locally true of the question that was just
// answered. What is deliberately NOT here is any expectation about the next
// question's text: that prediction is what failed in the field, and it is not
// needed — the reply carries whatever came next, and the reader's next tap is
// made against that reading.
func answerMoved(before, after answerReading) bool {
	if after.gone() {
		// The dialog is not on the pane any more. awaitMoved only hands a
		// reading like this over once stillGone has watched it stay away, so
		// by here it is the end of the call rather than one blank frame.
		return true
	}
	if after.dialog == nil {
		// A dialog is still up and the parser lost it. That is not evidence of
		// anything, least of all of an answer landing.
		return false
	}
	if reviewOnScreen(after.region) && !reviewOnScreen(before.region) {
		return true
	}
	if before.dialog != nil {
		// The tab bar's box for this question filling in. For a multi-select
		// this happens on the first Space rather than on the Enter that leaves
		// the question — measured 2026-09-10 — so it proves the keys were
		// taken, not that the question was left. The reading that comes back
		// says which, and the card renders that.
		if after.dialog.Answered > before.dialog.Answered {
			return true
		}
		return !answerSameQuestion(drawnQuestion(before), drawnQuestion(after))
	}
	return false
}

// drawnQuestion is the text of the question a reading is showing.
func drawnQuestion(r answerReading) string {
	if r.dialog == nil || len(r.dialog.Questions) == 0 {
		return ""
	}
	return r.dialog.Questions[0].Question
}

// answerPosition is where in the call the pane currently is: the index of the
// question it is drawing, or one past the last question when it is showing the
// review screen.
func answerPosition(r answerReading, known []DialogQuestion) (int, bool) {
	if r.dialog == nil {
		return 0, false
	}
	if reviewOnScreen(r.region) {
		return len(r.dialog.Headers), true
	}
	return questionOnScreen(r.dialog, known)
}

// answerWait is a settle that a cancelled request does not sit through.
func answerWait(ctx context.Context, d time.Duration) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(d):
		return nil
	}
}
