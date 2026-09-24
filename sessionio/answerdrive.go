package sessionio

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"
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
// What that leaves is three things a capture can prove locally about an
// answer: the dialog went away, it became the review screen, or this
// question's box filled. Any of those means the keys landed. None of them says
// what the NEXT question is, which is exactly the claim that kept being wrong.
//
// A multi-select toggle leaves the question where it is, so it proves a fourth
// thing instead: the boxes on screen are the ones the request asked for
// (applyMulti). A commit is proved the first way, once the fourth has held.
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
// different labels. The second lets through the one ticked box that is the
// drawn multi-select's own, filled by the ticks the reader is still making
// (ownBox). Going back is refused outright, because arrival cannot be proved
// without the list.
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
	resp, err := in.answer(ctx, osUser, session, before, req, known)
	// Stamped from the reading taken BEFORE the keys: the reply's own reading
	// is of whatever came next, which for a commit is another question.
	resp.Action = AnswerAction(req, before.dialog, known)
	return resp, err
}

// answer dispatches one request against the reading taken before it.
func (in *Injector) answer(ctx context.Context, osUser, session string, before answerReading, req AnswerRequest, known []DialogQuestion) (AnswerResponse, error) {
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
	if q := before.dialog.Questions; len(q) > 0 && q[0].MultiSelect {
		return in.answerMulti(ctx, osUser, session, before, choices, req.Text, req.Stay)
	}
	if req.Stay {
		// Stay asks for the question to be held open, and a single-select
		// has nothing to hold: its digit answers and moves on in one press.
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
		typed, reason, err := in.typeAnswer(ctx, osUser, session, plan.Text, gainedText(plan.Text))
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

// maxFreeSteps bounds settleFreeText. Getting the row from any state to any
// other takes at most a walk, a clear, a paste and an Enter, each read back
// before the next, so eight is room for one of them to be retried and no room
// for a loop that has stopped making progress.
const maxFreeSteps = 8

// clearMargin is how many Backspaces beyond the characters a reading shows go
// into clearing the free-text field. The capture trims trailing spaces, so a
// field holding "Mango " shows five characters and a field holding a lone
// space shows none. Measured on CLI 2.1.280 on 2026-09-23, a Backspace on the
// empty field does nothing, so the extra presses cost nothing once it is clear.
const clearMargin = 2

// clearFieldKeys is the one run of keys that empties a multi-select's
// free-text field while the reading shows `shown` in it: C-e, then a Backspace
// for every character shown plus clearMargin.
//
// C-E COMES FIRST. A walk onto the row with ↑ or ↓ puts the field's text
// cursor at the START of the words, and a Backspace there takes nothing out.
// The live check on CLI 2.1.280 found it on 2026-09-23: a typed "X" landed in
// front of "Kiwi", and six Backspaces left "Kiwi" in the field and ticked.
// Only straight after a paste is the cursor at the end, so a clear straight
// after typing worked and the same clear after one click on another option
// came back unverified, the reader's pick stuck. C-e moves the cursor to the
// end of the whole text, a wrapped one included: C-e and 170 Backspaces in one
// run cleared a 166-character field wrapped over two lines, starting from
// position 0. End is no substitute, since it stops at the end of the first
// visual line, and neither is C-u, which kills one visual line.
func clearFieldKeys(shown string) []string {
	return append([]string{"C-e"}, repeat("BSpace", utf8.RuneCountInString(shown)+clearMargin)...)
}

// answerMulti applies one request to the multi-select question on screen: the
// set it names, read back off the pane, and then, unless it is a toggle, the
// commit.
//
// Everything that can refuse the request is checked against the reading taken
// before any key goes in: a label the question does not offer, free text with
// nothing in it or too much, a free-text pick on a question drawing no such
// row, and a commit with nothing picked or no commit row to press. A refusal
// types nothing.
func (in *Injector) answerMulti(ctx context.Context, osUser, session string, before answerReading, choices []string, text string, stay bool) (AnswerResponse, error) {
	want, err := wantOf(before.dialog.Questions[0], choices, text)
	switch {
	case errors.Is(err, errBadText):
		return before.reply(AnswerRefused), nil
	case err != nil:
		return before.reply(AnswerUnknownOption), nil
	}
	rows := answerRows(before.region)
	if want.free && freeIndex(rows) < 0 {
		return before.reply(AnswerUnknownOption), nil
	}
	if !stay && (want.empty() || commitIndex(rows) < 0) {
		return before.reply(AnswerUnknownOption), nil
	}
	cur, reason, err := in.applyMulti(ctx, osUser, session, before, want)
	if err != nil {
		return AnswerResponse{}, err
	}
	if reason != "" || stay {
		return cur.reply(reason), nil
	}
	return in.commitMulti(ctx, osUser, session, cur)
}

// applyMulti brings a multi-select to the state `want` asks for and returns
// the reading that shows it, or the reason it could not.
//
// AN ACTING KEY IS ONLY SENT AGAINST A READING THAT SHOWS THE CURSOR ON ITS
// ROW. A Space that arrives on the free-text row types a space into the
// reader's words, and an Enter on the commit row leaves the question, so a
// walk must never have its key land on the wrong row. Every walk goes through
// walkOnto, which hands back either a reading that draws the cursor on the row
// or a reason, and every Space, the first included, goes out on such a
// reading. The free-text row is changed one read-back step at a time
// (settleFreeText). Where the cursor is comes from the mark drawn in front of
// a row and nowhere else (cutCursor).
//
// THE CHECK IS THE BOXES THEMSELVES. A toggle that adds a second pick changes
// none of the things answerMoved watches: the tab bar filled on the first pick
// and the question on screen is the same one. So the verdict is a reading that
// shows every box, and the free-text row, the way the set asks, polled until
// it does or answerVerify runs out.
func (in *Injector) applyMulti(ctx context.Context, osUser, session string, before answerReading, want multiWant) (answerReading, string, error) {
	q := before.dialog.Questions[0]
	rows := answerRows(before.region)
	cur, sent := before, false
	for _, step := range planToggles(q, rows, want) {
		if sent {
			if err := answerWait(ctx, keySettle); err != nil {
				return answerReading{}, "", err
			}
		}
		// Every step, the first included. A walk of no keys is the plan
		// saying the cursor is on the row already, and that is only as good
		// as the reading it was made from. One that draws no cursor at all
		// puts focusedRow on row one, and a Space sent on that claim ticked
		// whichever row the cursor really held; walkOnto refuses it.
		label := rows[step.row].label
		walked, reason, err := in.walkOnto(ctx, osUser, session, before, cur, step.walk, func(rs []answerRow) int {
			return rowIndex(rs, label)
		})
		if err != nil || reason != "" {
			return walked, reason, err
		}
		cur = walked
		if err = in.Keys(osUser, session, []string{"Space"}); err != nil {
			return in.refusal(osUser, session)
		}
		sent = true
	}
	if at := freeIndex(rows); at >= 0 && freeTextNext(rows[at], want) != freeNone {
		var reason string
		var err error
		if cur, reason, err = in.settleFreeText(ctx, osUser, session, before, want); err != nil || reason != "" {
			return cur, reason, err
		}
		sent = false // settleFreeText ends on a reading taken after its last key
	}
	if !sent && holdsWant(before, cur, want) {
		return cur, "", nil
	}
	after, ok, err := in.awaitHolds(ctx, osUser, session, before, want)
	if err != nil {
		return answerReading{}, "", err
	}
	if !ok {
		return after, AnswerUnverified, nil
	}
	return after, "", nil
}

// settleFreeText brings a multi-select's free-text row to what `want` asks,
// one step at a time, each decided on a fresh reading: walk the cursor onto
// the row (walkOnto), then Enter to flip its box, C-e and Backspaces to clear
// it, or a paste to fill it (freeTextNext says which).
//
// Clearing goes through rawKeys, never the keys route. Neither C-e nor BSpace
// is in answerKeys, and that allowlist is the whole security boundary of the
// public POST /keys route, so it stays narrow. The count is bounded by what
// the reading shows in the row plus clearMargin (clearFieldKeys), and it is
// only sent while the reading shows the cursor on that row. A run that takes
// nothing out ends the request rather than sending another.
func (in *Injector) settleFreeText(ctx context.Context, osUser, session string, before answerReading, want multiWant) (answerReading, string, error) {
	var cur answerReading
	cleared, lastClear := false, ""
	walked := false // cur is walkOnto's reading, and no key has gone in since
	for step := 0; step < maxFreeSteps; step++ {
		if !walked {
			if err := answerWait(ctx, keySettle); err != nil {
				return answerReading{}, "", err
			}
			next, err := in.read(osUser, session)
			if err != nil {
				return answerReading{}, "", err
			}
			cur = next
		}
		walked = false
		rows := answerRows(cur.region)
		at := freeIndex(rows)
		if !stillOn(before, cur) || at < 0 {
			return cur, AnswerUnverified, nil
		}
		act := freeTextNext(rows[at], want)
		if act == freeNone {
			return cur, "", nil
		}
		// The row's own cursor mark, rather than "the first focused row is
		// this one". The key below goes to whatever row really holds the
		// cursor, so it waits for a reading that draws the cursor here.
		if !rows[at].focused {
			on, reason, err := in.walkOnto(ctx, osUser, session, before, cur, chunkKeys(walkTo(focusedRow(rows), at)), freeIndex)
			if err != nil || reason != "" {
				return on, reason, err
			}
			// walkOnto read the pane after the walk, so the next pass decides
			// on that reading rather than taking another.
			cur, walked = on, true
			continue
		}
		switch act {
		case freeToggle:
			if err := in.Keys(osUser, session, []string{"Enter"}); err != nil {
				return in.refusal(osUser, session)
			}
		case freeClear:
			shown := rows[at].text
			if cleared && shown == lastClear {
				return cur, AnswerUnverified, nil
			}
			cleared, lastClear = true, shown
			if err := in.rawKeys(osUser, session, clearFieldKeys(shown)...); err != nil {
				return in.refusal(osUser, session)
			}
		case freeType:
			// A bracketed paste, which lands in the inline field and ticks
			// it: measured on 2.1.280 on 2026-09-23 with "Kiwi fruit", the
			// space included. typeAnswer reads it back off the row itself
			// (rowShows) before anything else is pressed.
			typed, reason, err := in.typeAnswer(ctx, osUser, session, want.text, rowShows(before, want.text))
			if err != nil || reason != "" {
				return typed, reason, err
			}
		}
	}
	return cur, AnswerUnverified, nil
}

// commitMulti leaves a multi-select through its commit row: walk there
// (walkOnto), and press Enter in a batch of its own once a reading draws the
// cursor on that row. On a multi-select Enter anywhere else is a toggle, or on
// the chat row abandons the question, so an Enter without that reading is
// never sent.
//
// `cur` is the reading that showed the set in place, and the move is checked
// against the one walkOnto hands back, taken after it with the cursor on the
// commit row. Checking against the reading from before the toggles would let
// the first box filling on the tab bar pass for the commit landing.
func (in *Injector) commitMulti(ctx context.Context, osUser, session string, cur answerReading) (AnswerResponse, error) {
	walk, err := planCommit(answerRows(cur.region))
	if err != nil {
		return cur.reply(AnswerUnverified), nil
	}
	on, reason, err := in.walkOnto(ctx, osUser, session, cur, cur, walk, commitIndex)
	if err != nil {
		return AnswerResponse{}, err
	}
	if reason != "" {
		return on.reply(reason), nil
	}
	if err := in.Keys(osUser, session, []string{"Enter"}); err != nil {
		return on.reply(AnswerRefused), nil
	}
	after, ok, err := in.awaitMoved(ctx, osUser, session, on)
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

// maxWalkRuns bounds walkOnto: the planned run of arrows and up to two more
// from wherever the cursor stopped. The chat row costs one more; the second is
// room for one retry. A run only follows one that stopped part of the way
// (short), so a widget that has stopped taking keys ends the walk after the
// first.
const maxWalkRuns = 3

// walkOnto moves the cursor onto the row `find` picks out of a reading's rows,
// starting with the planned run `walk`, and returns a reading that draws the
// cursor on that row, or the reason it could not. `cur` is the reading the
// walk was planned from, and `before` the one the request started on. An
// empty walk is the plan saying the cursor is there already, which only a
// reading can confirm.
//
// A WALK THAT STOPPED PART OF THE WAY GOES ON FROM WHERE IT STOPPED. The CLI's
// chat row keeps one key of a run: with the cursor on "Chat about this", one
// send-keys run of three ↑ moved it a single row, onto the commit row, and the
// rest was lost (CLI 2.1.280, four times out of four in the live check of
// 2026-09-24). A toggle walked to its row in one run, so a click made while
// the cursor sat on the chat row came back unverified with no box changed, and
// only a second click worked. A run from the commit row, or any row above it,
// goes the whole way, measured the same day.
//
// NEVER ON ONE READING. A run the widget has not finished drawing looks just
// like one that stopped, and walking on from it stacks a second run on the
// first: the cursor overshoots, and a reading taken between the two draws it
// on the row just before the rest arrives, so the acting key lands a row or
// two further on. awaitCursor waits for the cursor to reach the row or to hold
// still over two readings, the same second look the model picker's walk takes
// before it presses again (setmodel.go), and only a cursor that has stopped
// part of the way is walked on from (short).
func (in *Injector) walkOnto(ctx context.Context, osUser, session string, before, cur answerReading, walk [][]string, find func([]answerRow) int) (answerReading, string, error) {
	for runs := 0; ; runs++ {
		rows := answerRows(cur.region)
		from, to := cursorRow(rows), find(rows)
		switch {
		case to < 0:
			return cur, AnswerUnverified, nil
		case from == to:
			return cur, "", nil
		case len(walk) == 0 || runs == maxWalkRuns:
			return cur, AnswerUnverified, nil
		}
		refused, err := in.press(ctx, osUser, session, walk)
		if err != nil {
			return answerReading{}, "", err
		}
		if refused {
			return in.refusal(osUser, session)
		}
		if cur, err = in.awaitCursor(ctx, osUser, session, before, find); err != nil {
			return answerReading{}, "", err
		}
		if !stillOn(before, cur) {
			return cur, AnswerUnverified, nil
		}
		walk = nil
		rows = answerRows(cur.region)
		if at := cursorRow(rows); find(rows) == to && short(from, at, to) {
			walk = chunkKeys(walkTo(at, to))
		}
	}
}

// awaitCursor reads the pane after a run of arrows until the cursor is on the
// row `find` picks out, or has held still over two readings in a row, or the
// verify window runs out, and returns the last reading. A reading that is no
// longer of the question `before` was drawing ends it at once.
func (in *Injector) awaitCursor(ctx context.Context, osUser, session string, before answerReading, find func([]answerRow) int) (answerReading, error) {
	deadline := time.Now().Add(answerVerify)
	last, seen := 0, false
	for {
		if err := answerWait(ctx, keySettle); err != nil {
			return answerReading{}, err
		}
		cur, err := in.read(osUser, session)
		if err != nil {
			return answerReading{}, err
		}
		if !stillOn(before, cur) {
			return cur, nil
		}
		rows := answerRows(cur.region)
		at := cursorRow(rows)
		if at >= 0 && at == find(rows) {
			return cur, nil
		}
		if (seen && at == last) || !time.Now().Before(deadline) {
			return cur, nil
		}
		last, seen = at, true
	}
}

// awaitHolds reads the pane until it shows the state `want` asks for on the
// question `before` was drawing, or until the verify window runs out.
func (in *Injector) awaitHolds(ctx context.Context, osUser, session string, before answerReading, want multiWant) (answerReading, bool, error) {
	deadline := time.Now().Add(answerVerify)
	for {
		if err := answerWait(ctx, keySettle); err != nil {
			return answerReading{}, false, err
		}
		cur, err := in.read(osUser, session)
		if err != nil {
			return answerReading{}, false, err
		}
		if holdsWant(before, cur, want) {
			return cur, true, nil
		}
		if !time.Now().Before(deadline) {
			return cur, false, nil
		}
	}
}

// holdsWant reports whether a reading shows the multi-select `before` was
// drawing, still on screen, in the state `want` asks for. A reading of another
// question, or of the review screen, never holds: boxes that happen to match on
// a different question are not the request landing.
func holdsWant(before, cur answerReading, want multiWant) bool {
	if !stillOn(before, cur) {
		return false
	}
	q := cur.dialog.Questions[0]
	return q.MultiSelect && rowsHold(q, answerRows(cur.region), want)
}

// stillOn reports whether a reading is still drawing the question `before`
// was, and not the review screen. A reader at the terminal can move the dialog
// on while a request runs, and a key meant for one question must not land on
// the next, where the same rows would take it.
func stillOn(before, cur answerReading) bool {
	return cur.dialog != nil && len(cur.dialog.Questions) > 0 && !reviewOnScreen(cur.region) &&
		answerSameQuestion(drawnQuestion(before), drawnQuestion(cur))
}

// press sends key runs in order with a settle between each two, so no run is
// packed behind another. refused is tmux not taking a run; err is the request
// being cancelled.
func (in *Injector) press(ctx context.Context, osUser, session string, batches [][]string) (bool, error) {
	for i, batch := range batches {
		if i > 0 {
			if err := answerWait(ctx, keySettle); err != nil {
				return false, err
			}
		}
		if err := in.Keys(osUser, session, batch); err != nil {
			return true, nil
		}
	}
	return false, nil
}

// refusal is the reply for keys tmux would not take: a fresh reading, since
// some of the request's keys may already have landed.
func (in *Injector) refusal(osUser, session string) (answerReading, string, error) {
	cur, err := in.read(osUser, session)
	if err != nil {
		return answerReading{}, "", err
	}
	return cur, AnswerRefused, nil
}

// typeAnswer puts free text into the focused field and reads it back off the
// pane before anybody presses anything else, polling until `landed` holds for
// a reading or answerVerify runs out. `landed` is handed the reading taken
// just before the paste and the one being checked.
//
// WHAT COUNTS AS LANDED DEPENDS ON THE FIELD, which is why the caller says:
// gainedText for a single-select's field, rowShows for a multi-select's
// inline row.
func (in *Injector) typeAnswer(ctx context.Context, osUser, session, text string, landed func(beforeTyping, cur answerReading) bool) (answerReading, string, error) {
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
		if landed(beforeTyping, cur) {
			return cur, "", nil
		}
		if !time.Now().Before(deadline) {
			return cur, AnswerUnverified, nil
		}
	}
}

// gainedText is typeAnswer's read-back for a single-select's free-text field,
// which the digit opens below the options.
//
// It asks whether the dialog region GAINED the text rather than whether it
// holds it. Presence on its own confirms anything the dialog already drew,
// since the region is where the question, every option label and every
// description live. A reader answering in the question's own words ("Include
// apples." is option one's description on dialog-multi.txt) read back as
// landed against a field the paste never reached, and the Enter that follows
// answers the question with an empty one. The comparison is against the
// reading taken after the digit focused the field and before anything was
// typed, which is the only reading that can say what was already there.
func gainedText(text string) func(beforeTyping, cur answerReading) bool {
	return func(beforeTyping, cur answerReading) bool {
		return answerRegionGained(beforeTyping.region, cur.region, text)
	}
}

// rowShows is typeAnswer's read-back for a multi-select's free-text row: the
// question `before` was drawing is still on screen, and its row's field holds
// the words.
//
// NOT gainedText. On a multi-select the paste goes into the row itself and
// REPLACES its placeholder, "4. [ ] Type something" becoming "4. [✔] Mango"
// (CLI 2.1.280, 2026-09-23), so the region does not gain the words when they
// are part of "type something": "Something", "Some", "Type", a lone "e". The
// count held level as the placeholder went, and the review of 2026-09-24 had
// each of those come back unverified while the same reply drew them in the
// row and ticked. The row is exact where the region count is not, and it is
// the check freeTextNext makes of the row on the next pass anyway.
func rowShows(before answerReading, text string) func(beforeTyping, cur answerReading) bool {
	return func(_, cur answerReading) bool {
		if !stillOn(before, cur) {
			return false
		}
		rows := answerRows(cur.region)
		at := freeIndex(rows)
		return at >= 0 && rows[at].holdsText && typedMatches(rows[at].text, text)
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
//
// A multi-select toggle never comes here: adding a second pick changes none of
// the three, so it is checked by its boxes instead (holdsWant). A commit does,
// with `before` being the reading taken once its set was in place, right
// before its Enter.
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
		// The tab bar's box for this question filling in. On a multi-select
		// it fills on the first pick rather than on the commit that leaves
		// the question, measured 2026-09-10 and again on 2.1.280. So a commit
		// is checked against the reading taken once its picks were in place.
		// By then the box has filled, and only the commit can move anything.
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
