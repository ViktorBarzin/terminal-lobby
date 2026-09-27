package sessionio

import (
	"context"
	"strings"
	"time"
	"unicode/utf8"
)

// Applying ONE request to the plan approval the pane is drawing.
//
// An AskUserQuestion is not answered here any more: the lobby's hook holds it
// and the answers go to the CLI as data (ADR-0034, session-events hold.go).
// What is left is Claude Code's plan approval, still answered by keys
// (ADR-0010).
//
// The rule this file is built on: NOTHING IS PREDICTED. Every reply is a
// reading taken after the action, and every check compares that reading
// against the one taken before it, never against text a caller expected to
// appear. A refusal carries the same fresh reading, so a card that is handed
// "not this, here is what is on screen" re-renders and the reader carries on.

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
	// plan is the whole reading of a plan approval, set whenever dialog is
	// one: where the cursor is and what the feedback row holds, which the
	// driver needs and the wire does not carry.
	plan *planScreen
}

// read takes a reading. Every step of every request goes through here, so
// there is exactly one place where the pane becomes a decision. Only the plan
// approval is read: it is the one dialog this driver answers.
func (in *Injector) read(osUser, session string) (answerReading, error) {
	pane, err := in.CapturePane(osUser, session)
	if err != nil {
		return answerReading{}, err
	}
	lines := strings.Split(pane, "\n")
	if s, ok := parsePlan(lines); ok {
		return answerReading{pane: pane, region: lines[s.top:s.end], dialog: s.dialog, plan: &s}, nil
	}
	return answerReading{pane: pane}, nil
}

// reply packages a reading for the wire. An empty reason means the request was
// applied.
func (r answerReading) reply(reason string) AnswerResponse {
	return AnswerResponse{Applied: reason == "", Reason: reason, Dialog: r.dialog}
}

// replyDone is the reply for a dialog that has finished. It carries no pane:
// the transcript has the answers from here, and the card has nothing left to
// draw.
func (r answerReading) replyDone() AnswerResponse {
	return AnswerResponse{Applied: true, Done: true}
}

// Answer applies one plan answer to the session's plan approval and answers
// with a fresh reading of whatever the pane shows afterwards. A request that
// answers no plan is refused as not-held without reading anything: the
// AskUserQuestion it would answer goes through the hook or the terminal.
//
// The error return is for a pane that could not be read at all, which is a
// session that has gone away. Every other outcome, refusals included, is a
// normal response carrying the current reading.
func (in *Injector) Answer(ctx context.Context, osUser, session string, req AnswerRequest) (AnswerResponse, error) {
	if req.Plan == nil {
		return AnswerResponse{Reason: AnswerNotHeld, Action: AnswerAction(req)}, nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	// A plan answer takes its turn with any other plan answer or mode walk on
	// the same session, and reads the pane only once it has it (plandrive.go).
	unlock, err := in.lockSession(ctx, osUser, session)
	if err != nil {
		return AnswerResponse{}, err
	}
	defer unlock()
	before, err := in.read(osUser, session)
	if err != nil {
		return AnswerResponse{}, err
	}
	resp, err := in.answer(ctx, osUser, session, before, req)
	resp.Action = AnswerAction(req)
	return resp, err
}

// answer dispatches one plan answer against the reading taken before it.
func (in *Injector) answer(ctx context.Context, osUser, session string, before answerReading, req AnswerRequest) (AnswerResponse, error) {
	if before.dialog == nil {
		return before.reply(AnswerNoDialog), nil
	}
	return in.answerPlan(ctx, osUser, session, before, req)
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

// maxWalkRuns bounds walkOnto: the planned run of arrows and up to two more
// from wherever the cursor stopped. The chat row costs one more; the second is
// room for one retry. A run only follows one that stopped part of the way
// (short), so a widget that has stopped taking keys ends the walk after the
// first.
const maxWalkRuns = 3

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

// answerWait is a settle that a cancelled request does not sit through.
func answerWait(ctx context.Context, d time.Duration) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(d):
		return nil
	}
}
