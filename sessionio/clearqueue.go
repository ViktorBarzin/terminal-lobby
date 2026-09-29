package sessionio

import (
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

// queueClearMargin is how many Backspaces ClearQueue presses beyond the length
// of the text it was handed. The caller's copy of a queued prompt is trimmed
// (the Text view reads it from the transcript that way), and an empty input box
// takes a Backspace as nothing, so spare presses cost nothing.
const queueClearMargin = 8

// ClearQueue takes the prompts Claude Code has queued mid-turn off its queue
// without running them, for a Stop that hands them back to the composer. The
// caller interrupts afterwards (Cancel), and the interrupt then runs nothing.
//
// WHY BEFORE THE INTERRUPT. Measured on CLI 2.1.283 on 2026-09-27 with two
// prompts queued behind a running turn: C-c interrupted and then SUBMITTED
// both queued prompts as the next turn, and so did Escape. Up on an empty
// input box pops the whole queue into the box instead (the transcript's
// "popAll"), joined by line breaks, and an interrupt after that leaves the text
// in the box with nothing sent.
//
// The box is then cleared in full (wipeBox): C-e, then C-u and Backspace in
// pairs, a row at a time, enough for the popped text. Prompt's old C-e C-u
// prelude would not do it: C-u kills one line of a multi-line box, and the
// next prompt would be submitted concatenated onto the rest. A long paste pops back as its collapsed "[Pasted text #1 +29
// lines]" stand-in; the same count clears it, measured the same day.
//
// queued is the text the caller expects the queue to hold, oldest first. It
// sizes the clear and confirms the pop: the Backspaces are sent only once the
// box shows that text, since Backspaces that reach the box before the pop has
// drawn would delete nothing and leave the popped text in it.
//
// Answers true when the queue was popped and the box cleared. False, with no
// error, when there was nothing to take: no text handed over, a blocking dialog
// on the pane (StateAwaiting, where Up would move the dialog's highlighted row),
// a pane with no Claude input box, or a box that never showed the queue.
func (in *Injector) ClearQueue(osUser, session string, queued []string) (bool, error) {
	if len(queued) == 0 {
		return false, nil
	}
	if in.State(osUser, session) == StateAwaiting {
		return false, nil
	}
	pane, err := in.CapturePane(osUser, session)
	if err != nil {
		return false, err
	}
	if _, ok := inputBox(pane); !ok {
		return false, nil
	}
	if err := in.Command(osUser, "send-keys", "-t", exactPane(session), "Up").Run(); err != nil {
		return false, err
	}
	text := strings.Join(queued, "\n")
	held := in.awaitHeld(osUser, session, text)
	// Up on an EMPTY queue recalls the last prompt from history, under a rule
	// titled "History N/M" (CLI 2.1.284, measured 2026-09-29). That is where a
	// Stop lands a moment after Claude took the queued prompt into its turn:
	// the caller still thinks it is queued, the recall shows the same words,
	// and it came back as a draft Claude had already answered (deployed
	// review round 2 of the T3 pass). Down leaves the recall with the box as
	// it was.
	if pane, err := in.CapturePane(osUser, session); err == nil && recallingHistory(pane) {
		if err := in.Command(osUser, "send-keys", "-t", exactPane(session), "Down").Run(); err != nil {
			return false, err
		}
		return false, nil
	}
	if !held {
		return false, nil
	}
	if err := in.wipeBox(osUser, session, utf8.RuneCountInString(text)); err != nil {
		return false, err
	}
	return true, nil
}

// historyRule is the rule Claude Code draws above its input box while the box
// shows a prompt recalled from history: "─── History 4/4 ───…".
var historyRule = regexp.MustCompile(`^\s*─+ History \d+/\d+ ─`)

// recallingHistory reports whether the input box shows a prompt recalled from
// history rather than text typed or popped into it.
func recallingHistory(pane string) bool {
	lines := strings.Split(pane, "\n")
	for i := len(lines) - 1; i > 0; i-- {
		if strings.HasPrefix(lines[i], promptMark) && isBoxRule(lines[i-1]) {
			return historyRule.MatchString(lines[i-1])
		}
	}
	return false
}

// reclaimWait bounds how long ReclaimInterrupted waits for the interrupted
// prompt to land back on the input line. CLI 2.1.283 put it there 40 to 270 ms
// after the C-c in every one of six measured Stops (2026-09-28), so this is
// several times the slowest while still short enough for a Stop that answers
// once it is over.
const reclaimWait = 1500 * time.Millisecond

// ReclaimInterrupted takes a prompt the interrupt put back on Claude Code's
// input line off it again, for a Stop that hands it back to the composer. The
// caller has just interrupted (Cancel).
//
// WHY. A Stop that lands before Claude has written anything for the turn takes
// the prompt out of the conversation: Claude Code puts it back on its input
// line and its own view no longer shows it (measured 2026-09-28). The Text
// view never shows that line, and the next Prompt's clear erases it, so left
// there the prompt is lost while the chat shows it as sent.
//
// text is the prompt the caller expects back. The line is read until it shows
// that text or reclaimWait passes, and only then cleared, the way ClearQueue
// clears a popped queue: C-e, then one Backspace per character plus
// queueClearMargin. Whatever else is on the line (Claude had started
// answering and nothing came back, or the reader's own draft) is left alone.
//
// Answers true when the prompt was there and the line was cleared. A pane
// that shows no input box is read again until reclaimWait passes.
func (in *Injector) ReclaimInterrupted(osUser, session, text string) (bool, error) {
	if strings.TrimSpace(text) == "" {
		return false, nil
	}
	deadline := time.Now().Add(reclaimWait)
	for {
		pane, err := in.CapturePane(osUser, session)
		if err != nil {
			return false, err
		}
		// No box drawn is a reason to keep reading: right after the interrupt
		// something can stand in its place for a moment (Claude Code's
		// feedback-draft panel did in the round 7 check, 2026-09-28), and the
		// prompt lands on the line once it goes.
		box, ok := inputBoxUpTo(pane, strings.Count(pane, "\n"))
		if ok && inputHolds(pane, text) {
			if err := in.wipeBox(osUser, session, max(utf8.RuneCountInString(box), utf8.RuneCountInString(text))); err != nil {
				return false, err
			}
			return true, nil
		}
		if !time.Now().Before(deadline) {
			return false, nil
		}
		time.Sleep(submitPoll)
	}
}
