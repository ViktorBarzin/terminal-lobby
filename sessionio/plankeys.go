package sessionio

import (
	"context"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Approving Claude Code's own plan menu with a key, for the lobby's mod.
//
// WHY KEYS AGAIN. From 2026-10-02 the mod held ExitPlanMode in tool.check
// behind a dialog of its own and answered `allow`, which approved the plan on
// CLI 2.1.287. On 2.1.293 it does not: the engine's types say a hook "only
// tightens" for a tool that needs the person, and Claude draws its own "Ready
// to code?" menu after the hook's allow (measured 2026-10-08, ADR-0036). A
// settings PermissionRequest hook answering allow with setMode leaves the menu
// up too. So an approval is a digit in the pane. Rejecting needs no key: the
// mod's tool.call answers {deny} and the menu goes.
//
// What the keys do was measured on CLI 2.1.281 on 2026-09-24 (memory #13896)
// and the rows are drawn the same on 2.1.293 (testdata/plan-2.1.293-78col.txt):
//
//   - A DIGIT APPROVES ONLY OFF THE FEEDBACK ROW. From any other row digits
//     1-3 approve at once. With the cursor ON the feedback row a digit is a
//     character in its field ("4. 7"), so the driver walks off the row first
//     with one ↑ and reads the cursor back.
//   - What proves the approval landed is the menu going away and staying away:
//     absent from three readings in a row, a keySettle apart, within two
//     seconds of the digit. A digit took it down 131 ms after the key on an
//     idle box.
//
// The words a person sends with an approval never go into the pane: the mod
// keeps them and hands them to Claude with the approved result.
//
// Presses to one session take turns with each other and with the mode walk
// (lockSession), so two devices approving at once press one row between them.

// planVerify is how long the menu gets to show the cursor moved, polled at
// keySettle: four times the slower of the transitions measured on 2.1.267
// (154 ms), which covers a loaded box.
const planVerify = 600 * time.Millisecond

// planGonePolls and planGoneWindow are when the menu counts as gone: absent
// from planGonePolls readings in a row, a keySettle apart, within
// planGoneWindow of the digit. Three readings, not one: a frame caught
// mid-repaint carries no dialog either, and repaints were measured at 63-154
// ms on an idle box; three readings 120 ms apart span 240 ms of absence.
const (
	planGonePolls  = 3
	planGoneWindow = 2 * time.Second
)

// ReadPlan reads the plan approval off the session's pane, nil when the pane
// is not showing one.
func (in *Injector) ReadPlan(osUser, session string) (*Dialog, error) {
	pane, err := in.CapturePane(osUser, session)
	if err != nil {
		return nil, err
	}
	return ParsePlanDialog(pane), nil
}

// reClearsContext and reBypass are what PlanApproveRow reads off a label: the
// option that starts a new conversation with the plan, and the one that turns
// permission prompts off.
var (
	reClearsContext = regexp.MustCompile(`(?i)\bclear context\b`)
	reBypass        = regexp.MustCompile(`(?i)\bbypass\b`)
)

// PlanApproveRow is the row a caller means by "approve the plan" without
// naming one: the first approve row that neither clears the context nor turns
// permission prompts off. Clearing the context would drop the words the mod
// attaches to the approved result, and nobody chose bypass by saying approve.
// false when no row qualifies.
func PlanApproveRow(d *Dialog) (PlanOption, bool) {
	if d == nil {
		return PlanOption{}, false
	}
	for _, o := range d.Options {
		if !reClearsContext.MatchString(o.Label) && !reBypass.MatchString(o.Label) {
			return o, true
		}
	}
	return PlanOption{}, false
}

// PressPlanRow approves the plan menu on the pane with the row numbered n,
// which must still be labelled `label` on a reading taken under the session's
// lock, and waits for the menu to go.
//
// The reply carries the reading the refusal was made against, or the plan
// still on screen when the digit did not take. Nothing is pressed when the
// pane shows no plan menu (not-drawn), when the label does not match
// (unknown-option), or when no reading draws the cursor anywhere
// (unverified). The error is for a pane that could not be read at all.
func (in *Injector) PressPlanRow(ctx context.Context, osUser, session string, n int, label string) (AnswerResponse, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	unlock, err := in.lockSession(ctx, osUser, session)
	if err != nil {
		return AnswerResponse{}, err
	}
	defer unlock()

	cur, ok, err := in.readPlanScreen(osUser, session)
	if err != nil {
		return AnswerResponse{}, err
	}
	if !ok {
		return AnswerResponse{Reason: AnswerNotDrawn}, nil
	}
	opt, ok := PlanOptionNamed(cur.dialog, n, label)
	if !ok {
		return planReply(cur, AnswerUnknownOption), nil
	}
	cur, reason, err := in.planOffFeedback(ctx, osUser, session, cur)
	if err != nil {
		return AnswerResponse{}, err
	}
	if reason != "" {
		return planReply(cur, reason), nil
	}
	if err := in.Keys(osUser, session, []string{strconv.Itoa(opt.Number)}); err != nil {
		return planReply(cur, AnswerRefused), nil
	}
	return in.planAwaitGone(ctx, osUser, session, cur)
}

// readPlanScreen takes one reading of the plan menu; ok is false when the
// pane is not showing one.
func (in *Injector) readPlanScreen(osUser, session string) (planScreen, bool, error) {
	pane, err := in.CapturePane(osUser, session)
	if err != nil {
		return planScreen{}, false, err
	}
	s, ok := parsePlan(strings.Split(pane, "\n"))
	return s, ok, nil
}

// planReply is a refusal carrying the reading it was made against.
func planReply(s planScreen, reason string) AnswerResponse {
	return AnswerResponse{Reason: reason, Dialog: s.dialog}
}

// planOffFeedback makes sure the cursor is on an approve row, so a digit
// selects rather than typing into the feedback field. One ↑, read back. A
// reading that draws the cursor nowhere is refused: it cannot say the digit
// would not land in the field.
func (in *Injector) planOffFeedback(ctx context.Context, osUser, session string, cur planScreen) (planScreen, string, error) {
	fb := cur.dialog.FeedbackRow
	switch cur.cursor {
	case 0:
		return cur, AnswerUnverified, nil
	case fb:
	default:
		return cur, "", nil
	}
	if err := in.Keys(osUser, session, []string{"Up"}); err != nil {
		return cur, AnswerRefused, nil
	}
	deadline := time.Now().Add(planVerify)
	for {
		if err := answerWait(ctx, keySettle); err != nil {
			return cur, "", err
		}
		next, ok, err := in.readPlanScreen(osUser, session)
		if err != nil {
			return cur, "", err
		}
		if !ok {
			// Something else answered it meanwhile.
			return planScreen{}, AnswerNotDrawn, nil
		}
		cur = next
		if cur.cursor != 0 && cur.cursor != fb {
			return cur, "", nil
		}
		if !time.Now().Before(deadline) {
			return cur, AnswerUnverified, nil
		}
	}
}

// planAwaitGone reads the pane after the digit until the plan menu has counted
// as gone, or the window runs out with it still up. Gone means no plan menu,
// whatever else is drawn: approving in manual mode can put a permission prompt
// up straight away, and that is Claude starting on the plan.
func (in *Injector) planAwaitGone(ctx context.Context, osUser, session string, before planScreen) (AnswerResponse, error) {
	deadline := time.Now().Add(planGoneWindow)
	last, absent := before, 0
	for {
		if err := answerWait(ctx, keySettle); err != nil {
			return AnswerResponse{}, err
		}
		next, ok, err := in.readPlanScreen(osUser, session)
		if err != nil {
			return AnswerResponse{}, err
		}
		if ok {
			last, absent = next, 0
		} else if absent++; absent >= planGonePolls {
			return AnswerResponse{Applied: true, Done: true}, nil
		}
		if !time.Now().Before(deadline) {
			return planReply(last, AnswerUnverified), nil
		}
	}
}

// PlanOptionNamed finds the approve option numbered `n`, provided it is still
// labelled `label`. Whitespace is compared collapsed, because a label wrapped
// on a narrow pane is joined back with single spaces; every other character
// has to match, the "(6% used)" included.
func PlanOptionNamed(d *Dialog, n int, label string) (PlanOption, bool) {
	want := strings.Join(strings.Fields(label), " ")
	if want == "" || d == nil {
		return PlanOption{}, false
	}
	for _, o := range d.Options {
		if o.Number == n && strings.Join(strings.Fields(o.Label), " ") == want {
			return o, true
		}
	}
	return PlanOption{}, false
}
