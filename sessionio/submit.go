package sessionio

import (
	"errors"
	"strings"
	"time"
	"unicode"
)

// ErrPromptNotSubmitted is a prompt that reached the pane and was not
// submitted: after every Enter this package was willing to press, Claude
// Code's input box still held the text. The text is left there, and the next
// Prompt clears it before it pastes.
var ErrPromptNotSubmitted = errors.New("the prompt is still on the input line: Enter did not submit it")

// The waits that confirm a submit. Vars only as a test seam.
var (
	// submitPoll is how often the box is read back.
	submitPoll = 40 * time.Millisecond
	// pasteShownWait bounds the wait for the paste to appear in the box before
	// the first Enter. A pane that never shows it gets the Enter anyway, and
	// is not checked afterwards: there is nothing to compare against.
	pasteShownWait = time.Second
	// enterRetryAfter is how long the box may keep holding the text after an
	// Enter before another one is pressed. An Enter Claude takes clears the
	// box within one repaint, so this is long enough that a slow repaint is
	// not mistaken for a lost key, which matters because a second Enter that
	// lands after a slow first one reaches whatever the submit opened.
	enterRetryAfter = 800 * time.Millisecond
	// maxEnters is every Enter one prompt may press, the first included.
	maxEnters = 3
)

// pasteAndSubmit pastes text into the pane and presses Enter, then reads
// Claude Code's input box back to confirm the Enter took.
//
// WHY. Measured 2026-09-27 on a live session: POST /prompt answered OK, the
// text sat on the input line with the session idle, and the transcript never
// recorded it. The paste landed and the Enter did not, which is the same
// half-landing AwaitInputReady exists for, on a pane that was already drawn
// and settled. A harness on this box hit it too (the Enter sent 0.5-1s after a
// paste-buffer "is often swallowed and a second Enter submits"). Nothing in
// tmux reports it, so the box is the only evidence there is.
//
// The check reads the INPUT BOX and nothing else (inputBox). Claude echoes a
// submitted prompt into the conversation under the same mark, and a check
// that matched that echo would press Enter into whatever came next, a
// dialog's highlighted row included.
//
// A pane with no Claude input box (a shell, pi, codex) is not checked at all
// and gets exactly the one Enter it always did.
func (in *Injector) pasteAndSubmit(osUser, session, text string) error {
	if err := in.paste(osUser, session, text); err != nil {
		return err
	}
	shown := in.awaitHeld(osUser, session, text)
	if err := in.enter(osUser, session); err != nil {
		return err
	}
	if !shown {
		return nil
	}
	return in.confirmSubmitted(osUser, session, text)
}

func (in *Injector) enter(osUser, session string) error {
	return in.Command(osUser, "send-keys", "-t", exactPane(session), "Enter").Run()
}

// awaitHeld waits for the box to show the pasted text. False when the pane
// has no input box, or never showed the text within pasteShownWait.
func (in *Injector) awaitHeld(osUser, session, text string) bool {
	deadline := time.Now().Add(pasteShownWait)
	for {
		pane, err := in.CapturePane(osUser, session)
		if err == nil {
			if _, ok := inputBox(pane); !ok {
				return false
			}
			if inputHolds(pane, text) {
				return true
			}
		}
		if !time.Now().Before(deadline) {
			return false
		}
		time.Sleep(submitPoll)
	}
}

// confirmSubmitted waits for the box to let go of text, pressing Enter again
// each time it has held on for enterRetryAfter, up to maxEnters in all.
func (in *Injector) confirmSubmitted(osUser, session, text string) error {
	enters := 1
	pressed := time.Now()
	for {
		time.Sleep(submitPoll)
		pane, err := in.CapturePane(osUser, session)
		if err != nil {
			// The Enter was sent and the pane cannot be read: nothing says it
			// failed, and a read that fails does not say the session is gone.
			return nil
		}
		if !inputHolds(pane, text) {
			return nil
		}
		if time.Since(pressed) < enterRetryAfter {
			continue
		}
		if enters >= maxEnters {
			return ErrPromptNotSubmitted
		}
		if err := in.enter(osUser, session); err != nil {
			return err
		}
		enters++
		pressed = time.Now()
	}
}

// boxMaxLines bounds how many lines of a multi-line input are read. The
// comparison needs only the start of the text.
const boxMaxLines = 12

// inputBox returns what Claude Code's input box holds, and whether the pane
// has one.
//
// The box is the line starting with the prompt mark DIRECTLY under a rule,
// plus any continuation lines down to the rule that closes it, the lowest such
// box in the pane. The rule is what tells it from Claude's echo of an earlier
// prompt, which starts with the same mark in the conversation above.
func inputBox(pane string) (string, bool) {
	return inputBoxUpTo(pane, boxMaxLines)
}

// inputBoxUpTo is inputBox reading up to maxLines continuation lines.
func inputBoxUpTo(pane string, maxLines int) (string, bool) {
	box, _, ok := boxUpTo(pane, maxLines)
	return box, ok
}

// boxRows is the whole box, as inputBox reads it, and how many rows it takes.
func boxRows(pane string) (string, int, bool) {
	return boxUpTo(pane, strings.Count(pane, "\n"))
}

func boxUpTo(pane string, maxLines int) (string, int, bool) {
	lines := strings.Split(pane, "\n")
	for i := len(lines) - 1; i > 0; i-- {
		rest, ok := strings.CutPrefix(lines[i], promptMark)
		if !ok || !isBoxRule(lines[i-1]) {
			continue
		}
		var b strings.Builder
		b.WriteString(rest)
		rows := 1
		for j := i + 1; j < len(lines) && j <= i+maxLines && !isBoxRule(lines[j]); j++ {
			b.WriteString(" ")
			b.WriteString(lines[j])
			rows++
		}
		return b.String(), rows, true
	}
	return "", 0, false
}

// isBoxRule is one of the rules around the input box. The top one carries
// glyphs at its right end (a fast-mode mark, "/effort" hints), so only its
// start is read.
func isBoxRule(line string) bool {
	return strings.HasPrefix(strings.TrimSpace(line), "───")
}

// boxCompare is how many leading characters of the text, whitespace aside,
// the box must agree with. The start is enough to tell the text from the
// placeholder suggestion an empty box shows, and not asking for more is what
// lets a first line the box wrapped or cut short still count.
const boxCompare = 32

// inputHolds reports whether the input box still holds text: its start, with
// all whitespace ignored (a wrap, the non-breaking space after the mark), or
// the stand-in Claude draws for a paste it collapsed or a path it attached.
//
// A text taller than the box shows only its last rows, the first of them
// starting with the prompt mark and nothing to say more is above (measured on
// CLI 2.1.283 on 2026-09-28: a 954-character prompt with 4 line breaks showed
// its last 10 rows). The box then holds a run of the text rather than its
// start, and at least boxCompare characters of it are asked to match, so a
// few words that happen to occur in the text do not count.
func inputHolds(pane, text string) bool {
	box, ok := inputBox(pane)
	if !ok {
		return false
	}
	got := []rune(squashSpace(box))
	if len(got) == 0 {
		return false
	}
	if s := string(got); strings.HasPrefix(s, "[Pastedtext#") || strings.HasPrefix(s, "[Image#") {
		return true
	}
	want := []rune(squashSpace(text))
	n := min(len(got), len(want), boxCompare)
	if n > 0 && string(got[:n]) == string(want[:n]) {
		return true
	}
	return len(got) >= boxCompare && strings.Contains(string(want), string(got))
}

func squashSpace(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return r
	}, s)
}
