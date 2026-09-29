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

// ErrInputGone is a prompt that met a pane whose Claude input box had gone by
// the time it was pasted or submitted: Claude drew a dialog in its place (a
// permission, a question, the plan approval). Nothing was submitted and no
// Enter was pressed, since an Enter there picks the dialog's highlighted row.
// Words pasted before the dialog drew stay in Claude's box, out of sight, and
// the next Prompt clears them.
var ErrInputGone = errors.New("the input box went away before the prompt was sent: a dialog took its place")

// ErrSubmitUnconfirmed is a prompt whose Enter was pressed with the text in
// Claude's input box, and the box was gone by the next read: a dialog took
// its place. Claude may have submitted the prompt just before the dialog drew,
// or the dialog may have taken the Enter as nothing and kept the text out of
// sight (the live check on 2026-09-28 lost a prompt that way, with no row
// picked). The pane cannot tell the two apart; the transcript can.
var ErrSubmitUnconfirmed = errors.New("the input box went away at the Enter: whether the prompt was submitted is not known")

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
	// pictureAttachWait bounds the wait for Claude to attach one pasted
	// picture (pasteAttaching). Measured on CLI 2.1.283 on 2026-09-29: a
	// small PNG attached in 25 ms and a 12 MB JPEG in 240 ms.
	pictureAttachWait = 5 * time.Second
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
//
// boxed says the pane showed Claude's input box when the caller last read it.
// Such a pane is read again before the paste, and again before the Enter when
// the paste never showed, and a box gone by then is ErrInputGone. Found in
// deployed review round 4 (2026-09-28): a prompt sent as Claude drew a
// permission dialog was answered 204, never reached Claude, and its Enter
// picked "1. Yes", 5 times in 5 through the API. The route's one read of the
// pane came before the clear, and awaitHeld gives up at once on a pane with
// no box, where the Enter then went to the dialog.
func (in *Injector) pasteAndSubmit(osUser, session, text string, boxed bool) error {
	if boxed && !in.hasInputBox(osUser, session) {
		return ErrInputGone
	}
	if err := in.pasteAttaching(osUser, session, text); err != nil {
		return err
	}
	shown := in.awaitHeld(osUser, session, text)
	if !shown && boxed && !in.hasInputBox(osUser, session) {
		return ErrInputGone
	}
	if err := in.enter(osUser, session); err != nil {
		return err
	}
	if !shown {
		return nil
	}
	return in.confirmSubmitted(osUser, session, text)
}

// pasteAttaching is paste for Claude's input box: after a piece that ends
// with a picture's path it waits for Claude to attach the picture before it
// pastes the next piece.
//
// WHY. Claude Code reads a pasted picture's file before it draws "[Image #N]",
// shows nothing of that paste meanwhile, and then draws the placeholder at the
// end of the box (measured on CLI 2.1.283 on 2026-09-29: 25 ms for a small
// PNG, 240 ms for a 12 MB JPEG). Deployed review round 1 of the T3 pass sent
// two photos and some words as one message: the box showed the first picture
// and the words, the Enter went out, and the second picture attached after the
// submit, left in the box for the next send to wipe. Waiting after each
// picture keeps every one of them in the message, in the order written.
//
// A pane with no input box gets the plain paste.
func (in *Injector) pasteAttaching(osUser, session, text string) error {
	pane, err := in.CapturePane(osUser, session)
	box, ok := inputBox(pane)
	if err != nil || !ok {
		return in.paste(osUser, session, text)
	}
	attached := picturesIn(box)
	for _, chunk := range pasteChunks(text) {
		if err := in.pasteOne(osUser, session, chunk); err != nil {
			return err
		}
		if path, ok := endingPicture(chunk); ok {
			attached = in.awaitAttached(osUser, session, path, attached+1)
		}
	}
	return nil
}

// awaitAttached waits for the box to show want pictures, and answers how many
// it shows. It stops early when the box holds path as text (Claude did not
// take it as a picture: no such file, say) or has gone, and after
// pictureAttachWait.
func (in *Injector) awaitAttached(osUser, session, path string, want int) int {
	deadline := time.Now().Add(pictureAttachWait)
	got := want - 1
	for {
		pane, err := in.CapturePane(osUser, session)
		if err == nil {
			box, ok := inputBox(pane)
			if !ok {
				return got
			}
			got = picturesIn(box)
			if got >= want || strings.Contains(squashSpace(box), squashSpace(path)) {
				return got
			}
		}
		if !time.Now().Before(deadline) {
			return got
		}
		time.Sleep(submitPoll)
	}
}

// picturesIn counts the pictures a box shows attached.
func picturesIn(box string) int {
	return strings.Count(squashSpace(box), "[Image#")
}

// hasInputBox reports whether the pane shows Claude's input box. A pane that
// cannot be read says nothing against it, and counts as showing one.
func (in *Injector) hasInputBox(osUser, session string) bool {
	pane, err := in.CapturePane(osUser, session)
	if err != nil {
		return true
	}
	_, ok := inputBox(pane)
	return ok
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
//
// A box that is gone rather than empty is ErrSubmitUnconfirmed, except for a
// slash command, whose submit opens a screen of its own there (a picker,
// /config).
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
		if _, ok := inputBox(pane); !ok && !strings.HasPrefix(strings.TrimSpace(text), "/") {
			return ErrSubmitUnconfirmed
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
