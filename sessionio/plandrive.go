package sessionio

import (
	"context"
	"strconv"
	"strings"
	"time"
)

// Answering the plan approval (plandialog.go) through POST /answer.
//
// The rules are answerdrive.go's. A reading is taken before any key, and a
// refusal types nothing and carries that reading. Every acting key waits for a
// reading that proves it will land on the row it is meant for. The reply is a
// reading taken afterwards, never a prediction. What is the plan dialog's own
// was measured on CLI 2.1.281 on 2026-09-24 (memory #13896, and the second
// pass that day in the scratch captures behind testdata/plan-*.txt):
//
//   - A DIGIT IS A SELECTION ONLY OFF THE FEEDBACK ROW. From any other row,
//     digits 1-3 approve at once. With the cursor ON the feedback row a digit
//     is a character in its field: "4. 7". So an approve made from there
//     walks the cursor off the row first.
//   - THE FEEDBACK ROW'S OWN DIGIT DEPENDS ON ITS FIELD. While the field is
//     empty the digit focuses the row (4 on wizard's dialog, 3 on one with two
//     approve options, both checked live). While the field holds words the
//     digit SENDS them, exactly as Enter on the row would: "abc words" typed,
//     ↑ to row 2, then 3, and the plan came back rejected with "the user
//     said: abc words". So the digit focuses the row only when the reading
//     shows the field empty, and otherwise the cursor walks down to it one
//     ↓ at a time.
//   - THE FIELD'S TEXT CURSOR IS NOT WHERE IT LOOKS. After ↑ out of the field
//     and ↓ back in, a typed X landed mid-text ("byte couXnt"). Words already
//     there are cleared with C-e, which goes to the end of the whole wrapped
//     text, and Backspaces, and the new words are pasted into the empty field
//     and read back off the row.
//   - ENTER ON AN EMPTY FEEDBACK ROW IS ESC: the plan is rejected and Claude is
//     told to stop and wait for the user. So the committing key, Enter or
//     Shift+Tab, goes out only on a reading whose feedback row holds exactly
//     the words asked for.
//
// What proves an answer landed is the dialog going away and staying away:
// absent from three readings in a row, a keySettle apart, within two seconds
// of the key (planAwaitGone). A digit took it down 131 ms after the key on an
// idle box. Approving with clear context starts a new conversation in the pane
// about a second later, and feedback sends Claude back to planning, which
// draws a fresh dialog about 8 s later, both well after the dialog has counted
// as gone.
//
// Plan answers to one session take turns (lockSession), so two devices
// answering the same dialog cannot interleave one's paste with the other's
// digit. The second request reads the pane only once the first has finished,
// and so answers whatever that left on screen.

// answerPlan applies one plan request against the reading taken before it.
func (in *Injector) answerPlan(ctx context.Context, osUser, session string, before answerReading, req AnswerRequest) (AnswerResponse, error) {
	p := *req.Plan
	// A request that answers a question as well says two things at once.
	if req.Answers != nil || req.Chat != nil {
		return before.reply(AnswerUnknownOption), nil
	}
	switch {
	case p.Option != 0 && p.Feedback != "":
		return before.reply(AnswerUnknownOption), nil
	case p.Option != 0:
		return in.planApprove(ctx, osUser, session, before, p.Option, p.Label)
	case p.Feedback != "":
		return in.planFeedback(ctx, osUser, session, before, p.Feedback, p.Approve)
	}
	// Neither an option nor words: approving "with this feedback" when there is
	// none would be Shift+Tab on an empty row, which nothing here presses.
	return before.reply(AnswerUnknownOption), nil
}

// planApprove approves with the option numbered `n`, which must still be
// labelled `label`.
func (in *Injector) planApprove(ctx context.Context, osUser, session string, before answerReading, n int, label string) (AnswerResponse, error) {
	opt, ok := planOptionNamed(before.plan.dialog, n, label)
	if !ok {
		return before.reply(AnswerUnknownOption), nil
	}
	cur, reason, err := in.planOffFeedback(ctx, osUser, session, before)
	if err != nil {
		return AnswerResponse{}, err
	}
	if reason != "" {
		return cur.reply(reason), nil
	}
	if err := in.Keys(osUser, session, []string{strconv.Itoa(opt.Number)}); err != nil {
		return cur.reply(AnswerRefused), nil
	}
	return in.planAwaitGone(ctx, osUser, session, cur)
}

// planFeedback types `text` into the feedback row and sends it: Enter to send
// it back for more planning, Shift+Tab to approve the plan with it.
func (in *Injector) planFeedback(ctx context.Context, osUser, session string, before answerReading, text string, approve bool) (AnswerResponse, error) {
	// Checked before any key, as AnswerText would check it after the walk.
	if err := checkAnswerText(text); err != nil {
		return before.reply(AnswerRefused), nil
	}
	cur, reason, err := in.planFocusFeedback(ctx, osUser, session, before)
	if err == nil && reason == "" && cur.plan.holdsText {
		cur, reason, err = in.planClearFeedback(ctx, osUser, session, cur)
	}
	if err != nil {
		return AnswerResponse{}, err
	}
	if reason != "" {
		return cur.reply(reason), nil
	}
	fb := cur.plan.dialog.FeedbackRow
	typed, reason, err := in.typeAnswer(ctx, osUser, session, text, func(_, r answerReading) bool {
		return onPlan(r) && r.plan.cursor == fb && typedMatches(r.plan.typed, text)
	})
	if err != nil {
		return AnswerResponse{}, err
	}
	if reason != "" {
		// The words are not on the row, so neither key goes in: Enter on the
		// row as it stands could be Enter on an empty row.
		return typed.reply(reason), nil
	}
	key := "Enter"
	if approve {
		key = "BTab"
	}
	if err := in.Keys(osUser, session, []string{key}); err != nil {
		return typed.reply(AnswerRefused), nil
	}
	return in.planAwaitGone(ctx, osUser, session, typed)
}

// planOffFeedback makes sure the cursor is on an approve row, so a digit
// selects rather than typing into the feedback field. One ↑, read back.
//
// A reading that draws the cursor nowhere is refused: it cannot say the digit
// would not land in the field.
func (in *Injector) planOffFeedback(ctx context.Context, osUser, session string, before answerReading) (answerReading, string, error) {
	fb := before.plan.dialog.FeedbackRow
	switch before.plan.cursor {
	case 0:
		return before, AnswerUnverified, nil
	case fb:
	default:
		return before, "", nil
	}
	if err := in.Keys(osUser, session, []string{"Up"}); err != nil {
		return in.refusal(osUser, session)
	}
	return in.planAwaitCursor(ctx, osUser, session, func(s *planScreen) bool {
		return s.cursor != 0 && s.cursor != fb
	})
}

// planFocusFeedback puts the cursor on the feedback row.
//
// With the row's digit only while the reading shows its field empty: the digit
// on the row itself would be typed into the field, and with words in the field
// it sends them (see the top of this file). Otherwise the cursor walks down,
// one ↓ per run, each press read back before the next, and never further than
// the number of rows.
func (in *Injector) planFocusFeedback(ctx context.Context, osUser, session string, before answerReading) (answerReading, string, error) {
	fb := before.plan.dialog.FeedbackRow
	switch before.plan.cursor {
	case fb:
		return before, "", nil
	case 0:
		return before, AnswerUnverified, nil
	}
	if !before.plan.holdsText {
		if err := in.Keys(osUser, session, []string{strconv.Itoa(fb)}); err != nil {
			return in.refusal(osUser, session)
		}
		return in.planAwaitCursor(ctx, osUser, session, func(s *planScreen) bool { return s.cursor == fb })
	}
	cur := before
	for presses := 0; presses < fb; presses++ {
		from := cur.plan.cursor
		if err := in.Keys(osUser, session, []string{"Down"}); err != nil {
			return in.refusal(osUser, session)
		}
		next, reason, err := in.planAwaitCursor(ctx, osUser, session, func(s *planScreen) bool {
			return s.cursor != from && s.cursor != 0
		})
		if err != nil || reason != "" {
			return next, reason, err
		}
		if cur = next; cur.plan.cursor == fb {
			return cur, "", nil
		}
		if cur.plan.cursor < from {
			return cur, AnswerUnverified, nil
		}
	}
	return cur, AnswerUnverified, nil
}

// planClearFeedback empties the feedback field while the reading shows the
// cursor on it: C-e, then a Backspace for every character shown and
// clearMargin more (clearFieldKeys, and its reasons). Measured on 2.1.281, C-e
// and 112 Backspaces in one run cleared a field of about 100 characters
// wrapped over three lines, and the row read "Tell Claude what to change"
// again with the cursor still on it; the Backspaces past the start took
// nothing else out.
//
// The keys go through rawKeys: neither C-e nor BSpace is in the answerKeys
// allowlist, which is the whole security boundary of the public POST /keys
// route and stays narrow. One run, and a run that leaves words behind ends the
// request rather than sending another.
func (in *Injector) planClearFeedback(ctx context.Context, osUser, session string, cur answerReading) (answerReading, string, error) {
	fb := cur.plan.dialog.FeedbackRow
	if err := in.rawKeys(osUser, session, clearFieldKeys(cur.plan.typed)...); err != nil {
		return in.refusal(osUser, session)
	}
	return in.planAwaitCursor(ctx, osUser, session, func(s *planScreen) bool {
		return s.cursor == fb && !s.holdsText
	})
}

// planAwaitCursor reads the pane until the plan approval is still up and
// `ok` holds for it, or the verify window runs out. A reading without the
// dialog ends the wait at once: something else answered it.
func (in *Injector) planAwaitCursor(ctx context.Context, osUser, session string, ok func(*planScreen) bool) (answerReading, string, error) {
	deadline := time.Now().Add(answerVerify)
	for {
		if err := answerWait(ctx, keySettle); err != nil {
			return answerReading{}, "", err
		}
		cur, err := in.read(osUser, session)
		if err != nil {
			return answerReading{}, "", err
		}
		if !onPlan(cur) {
			return cur, AnswerUnverified, nil
		}
		if ok(cur.plan) {
			return cur, "", nil
		}
		if !time.Now().Before(deadline) {
			return cur, AnswerUnverified, nil
		}
	}
}

// planGonePolls and planGoneWindow are when the plan approval counts as gone:
// absent from planGonePolls readings in a row, a keySettle apart, within
// planGoneWindow of the committing key.
//
// THREE READINGS, NOT ONE, for the reason stillGone gives: a frame caught
// mid-repaint carries no dialog either, and the question dialog's repaints
// were measured at 63-154 ms on an idle box. Three readings 120 ms apart span
// 240 ms of absence, longer than any repaint measured. Two seconds is the
// window the design gives it: a loaded box, and nothing a person would wait
// on for longer before looking at the Terminal.
const (
	planGonePolls  = 3
	planGoneWindow = 2 * time.Second
)

// planAwaitGone reads the pane after the committing key until the plan
// approval has counted as gone, or the window runs out with it still up.
//
// Gone means no plan approval, whatever else is drawn. Approving in manual
// mode can put a permission prompt up straight away, and that is Claude
// starting on the plan, not the plan still waiting.
func (in *Injector) planAwaitGone(ctx context.Context, osUser, session string, before answerReading) (AnswerResponse, error) {
	return in.awaitGone(ctx, osUser, session, before, onPlan)
}

// awaitGone reads the pane after a committing key until the dialog `on`
// recognises has counted as gone, or the window runs out with it still up.
// The permission prompt uses the plan's window and polls (permdrive.go): the
// next prompt a decline leads to comes after a round trip to the model,
// seconds rather than milliseconds.
func (in *Injector) awaitGone(ctx context.Context, osUser, session string, before answerReading, on func(answerReading) bool) (AnswerResponse, error) {
	deadline := time.Now().Add(planGoneWindow)
	cur, absent := before, 0
	for {
		if err := answerWait(ctx, keySettle); err != nil {
			return AnswerResponse{}, err
		}
		next, err := in.read(osUser, session)
		if err != nil {
			return AnswerResponse{}, err
		}
		cur = next
		if on(cur) {
			absent = 0
		} else if absent++; absent >= planGonePolls {
			return cur.replyDone(), nil
		}
		if !time.Now().Before(deadline) {
			return cur.reply(AnswerUnverified), nil
		}
	}
}

// onPlan reports whether a reading is of the plan approval.
func onPlan(r answerReading) bool {
	return r.plan != nil && r.dialog != nil && r.dialog.Kind == DialogKindPlan
}

// planOptionNamed finds the approve option numbered `n`, provided it is still
// labelled `label`. Whitespace is compared collapsed, because a label wrapped
// on a narrow pane is joined back with single spaces; every other character
// has to match, the "(6% used)" included.
func planOptionNamed(d *Dialog, n int, label string) (PlanOption, bool) {
	want := strings.Join(strings.Fields(label), " ")
	if want == "" {
		return PlanOption{}, false
	}
	for _, o := range d.Options {
		if o.Number == n && strings.Join(strings.Fields(o.Label), " ") == want {
			return o, true
		}
	}
	return PlanOption{}, false
}
