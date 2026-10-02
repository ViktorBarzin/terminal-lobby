package sessionio

import (
	"strings"
)

// The pure half of answering an AskUserQuestion: which question the pane is
// drawing, which keys answer it, whether this is the review screen, and how
// far back a chip is. Nothing here touches tmux, so all of it runs against the
// captures under testdata/.
//
// WHY IT IS PURE AND WHY IT LIVES HERE. This is the logic that used to run in
// the browser (frontend-v2 answer.logic.ts), where it planned a whole walk
// before typing anything and predicted what each next screen would say. Over
// 10 days of field data four-question answers failed 4 times in 5, every
// failure a `desync`: the prediction missed
// (docs/plans/2026-09-10-text-mode-answers-dialogs-design.md). Moving it next
// to the parser means the keystroke, the capture and the check are one local
// sequence, and the only thing ever compared is a reading against a reading.
//
// EVERY COMPARISON IS SCOPED TO THE DIALOG REGION. The shipped landed()
// searched the whole capture, conversation scrollback included, so a check
// could pass on text that was on screen before anything was typed — a session
// that has already answered three questions carries all three in its history.
// answerRegion is that fix, and every function below takes the region rather
// than the pane.

// maxRegionLines bounds a region that has no option list to derive its shape
// from: a screen carrying the footer and a top edge but nothing numbered
// between them, which ParseDialog refuses and only the marker fingerprint ever
// reads. The widest real capture here is dialog-narrow-footer.txt at 58
// columns, where wrapping puts 27 lines between the tab bar and the footer.
//
// It is NOT how an answerable dialog is bounded. It used to be: with no tab bar
// and no header the region was "the 48 lines above the footer", which on a
// short pane is the whole capture, conversation included — the whole-capture
// comparison this file exists to remove, reintroduced by the fallback. The
// dialog's own shape says where it starts, and dialogTop reads that instead.
const maxRegionLines = 48

// footerWrapLines is how many lines the footer may occupy. It mirrors the bound
// inside footerAt (dialog.go), which is a local constant there and cannot be
// referenced; the two have to move together. 60 characters of footer wrap into
// at most three lines at any width somebody could read a dialog in.
const footerWrapLines = 3

// reviewFoot is the line "Ready to submit your answers?" sits on when the pane
// shows only the FOOT of the review screen, or -1.
//
// A review screen taller than the pane loses both ends. Measured 2026-09-27 on
// an 80x23 pane after a four-question call with questions of about forty words:
// the tab bar and "Review your answers" had scrolled off the top, and the
// "Enter to select … Esc to cancel" footer was cut off the bottom, so nothing
// reviewTail looks for was on screen. The reading went nil and the card kept
// drawing question 1 of 4 with no Submit. A phone makes this likelier, since
// narrow columns wrap each question onto more rows.
//
// With the tab bar gone the foot is the only landmark left, so it has to be
// the foot of the pane and nothing else: the wording, a blank, "1. Submit
// answers" and "2. Cancel" as the last rows, with at most the widget's own
// footer under them. The same lines quoted in a conversation have the composer
// drawn below them, and the composer is not drawn while a dialog is up.
func reviewFoot(lines []string) int {
	end := len(lines)
	trimBlank := func() {
		for end > 0 && strings.TrimSpace(stripDialogBorder(lines[end-1])) == "" {
			end--
		}
	}
	trimBlank()
	if f := footerAt(lines[:end]); f >= 0 && f >= end-footerWrapLines {
		end = f
		trimBlank()
	}
	if end < 3 {
		return -1
	}
	row := func(i, n int, label string) bool {
		m := reOption.FindStringSubmatch(lines[i])
		return m != nil && atoi(m[1]) == n && strings.TrimSpace(m[3]) == label
	}
	if !row(end-1, 2, "Cancel") || !row(end-2, 1, submitRow) {
		return -1
	}
	i := end - 3
	for ; i >= 0 && strings.TrimSpace(stripDialogBorder(lines[i])) == ""; i-- {
	}
	if i < 0 || strings.TrimSpace(stripDialogBorder(lines[i])) != readyPrompt {
		return -1
	}
	return i
}

// submitRow is the label of the review screen's commit row. The tab bar draws
// "✔ Submit" for the same step; this is the numbered row underneath.
const submitRow = "Submit answers"
