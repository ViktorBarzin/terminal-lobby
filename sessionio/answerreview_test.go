package sessionio

import (
	"strings"
	"testing"
)

// A review screen taller than the pane loses its top AND its bottom: the tab
// bar scrolls off above, and the footer is cut off below. What is left is the
// foot of the screen, "Ready to submit your answers?" over the two numbered
// rows, as the last thing on the pane.
//
// Found on 2026-09-27 on an 80x23 pane after a four-question call with
// questions of about forty words each: every landmark reviewTail wanted was
// off screen, the reading went nil, and the card kept showing question 1 of 4
// with no Submit until a tap on it was refused. ParseDialog is still what the
// prompt guard and the mode dial ask whether a question is on screen.
func TestATallReviewScreenReadsWithItsTopAndFooterCutOff(t *testing.T) {
	base := fixture(t, "dialog-review-tall-clipped.txt")
	for _, tc := range []struct{ name, pane string }{
		{"no footer", base},
		{"footer drawn", strings.TrimRight(base, "\n") + "\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n"},
		{"footer wrapped on a narrow pane", strings.TrimRight(base, "\n") + "\n\nEnter to select · ↑/↓ to navigate ·\nEsc to cancel\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// The prompt guard and the mode dial parse the whole capture.
			d := ParseDialog(tc.pane)
			if d == nil {
				t.Fatal("the pane watcher read no dialog while the session sat on Submit")
			}
			if !d.Partial || len(d.Questions) != 1 || len(d.Questions[0].Options) != 0 ||
				d.Questions[0].Question != readyPrompt {
				t.Fatalf("not read as the review screen: %+v", d)
			}
		})
	}
}

// Without the tab bar the foot of the pane is the only landmark, so it has to
// BE the foot: the wording and the two rows quoted anywhere else, with the
// composer drawn under them, is a conversation and not the screen.
func TestAClippedReviewScreenMustBeTheFootOfThePane(t *testing.T) {
	for _, tc := range []struct{ name, pane string }{
		{"quoted above the composer",
			"● The CLI ends with:\n\nReady to submit your answers?\n\n❯ 1. Submit answers\n  2. Cancel\n\n────────\n❯ \n────────\n  ? for shortcuts\n"},
		{"a third row under Cancel",
			"Ready to submit your answers?\n\n❯ 1. Submit answers\n  2. Cancel\n  3. Something else\n"},
		{"rows without the wording",
			" ● Which fruit\n   → Pear\n\n❯ 1. Submit answers\n  2. Cancel\n"},
		{"wording without the rows",
			" ● Which fruit\n   → Pear\n\nReady to submit your answers?\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if d := ParseDialog(tc.pane); d != nil {
				t.Errorf("parsed as a dialog: %+v", d)
			}
		})
	}
}
