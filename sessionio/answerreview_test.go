package sessionio

import (
	"os"
	"strings"
	"testing"
)

// The review screen is the one dialog the CLI draws with NO footer, and a
// reading that insists on a footer calls it "no dialog at all".
//
// Found by driving a real four-question call to its end through the deployed
// route on 2026-09-11, CLI 2.1.268: the last answer came back Done while the
// pane sat on "Ready to submit your answers?" waiting for a keystroke. The
// card would have shown nothing and the session would have stayed blocked,
// which is the silence the whole feature exists to end.
//
// testdata/dialog-review-nofooter.txt is that screen, captured off the pane.
func TestReviewScreenIsReadWithoutAFooter(t *testing.T) {
	b, err := os.ReadFile("testdata/dialog-review-nofooter.txt")
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}
	lines := strings.Split(string(b), "\n")

	if footerAt(lines) >= 0 {
		t.Fatal("this fixture is meant to have no footer; it has one now")
	}
	tail := reviewTail(lines)
	if tail == nil {
		t.Fatal("reviewTail found no review screen on a real review screen")
	}
	if !reviewOnScreen(tail) {
		t.Error("reviewOnScreen said no on the tail reviewTail returned")
	}
	d := ParseDialog(strings.Join(tail, "\n"))
	if d == nil {
		t.Fatal("the review tail did not parse as a dialog")
	}
	if d.Count != 4 || d.Answered != 4 {
		t.Errorf("answered %d of %d, want 4 of 4 on a finished review screen", d.Answered, d.Count)
	}
}

// The guard the footer used to provide: a pane that merely QUOTES the review
// wording must not read as the review screen, because a Submit there presses
// Enter into somebody's shell. All three landmarks have to be present.
func TestReviewTailRefusesAQuotedReviewScreen(t *testing.T) {
	for _, tc := range []struct{ name, pane string }{
		{"wording alone, no tab bar and no submit row",
			"$ cat design.md\nReview your answers\nReady to submit your answers?\n$ "},
		{"tab bar and wording but no submit row",
			"←  ☒ Fruit  ☒ Drink  ✔ Submit  →\nReady to submit your answers?\n"},
		{"tab bar and submit row but no wording",
			"←  ☒ Fruit  ☒ Drink  ✔ Submit  →\n❯ 1. Submit answers\n  2. Cancel\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tail := reviewTail(strings.Split(tc.pane, "\n")); tail != nil {
				t.Errorf("read %d lines as a review screen, want none", len(tail))
			}
		})
	}
}

// A review screen taller than the pane loses its top AND its bottom: the tab
// bar scrolls off above, and the footer is cut off below. What is left is the
// foot of the screen, "Ready to submit your answers?" over the two numbered
// rows, as the last thing on the pane.
//
// Found on 2026-09-27 on an 80x23 pane after a four-question call with
// questions of about forty words each: every landmark reviewTail wanted was
// off screen, the reading went nil, and the card kept showing question 1 of 4
// with no Submit until a tap on it was refused.
func TestATallReviewScreenReadsWithItsTopAndFooterCutOff(t *testing.T) {
	base := fixture(t, "dialog-review-tall-clipped.txt")
	for _, tc := range []struct{ name, pane string }{
		{"no footer", base},
		{"footer drawn", strings.TrimRight(base, "\n") + "\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n"},
		{"footer wrapped on a narrow pane", strings.TrimRight(base, "\n") + "\n\nEnter to select · ↑/↓ to navigate ·\nEsc to cancel\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			lines := strings.Split(tc.pane, "\n")
			// The pane watcher parses the whole capture.
			d := ParseDialog(tc.pane)
			if d == nil {
				t.Fatal("the pane watcher read no dialog while the session sat on Submit")
			}
			if !d.Partial || len(d.Questions) != 1 || len(d.Questions[0].Options) != 0 ||
				d.Questions[0].Question != readyPrompt {
				t.Fatalf("not read as the review screen: %+v", d)
			}
			// The answer route reads the review screen through its tail.
			tail := reviewTail(lines)
			if tail == nil {
				t.Fatal("reviewTail found no review screen")
			}
			if !reviewOnScreen(tail) {
				t.Error("reviewOnScreen said no on the tail reviewTail returned")
			}
			if ParseDialog(strings.Join(tail, "\n")) == nil {
				t.Error("the review tail did not parse")
			}
		})
	}
}

// With the tab bar gone the position of the review screen comes from the
// call's own question list: one past its last question.
func TestAClippedReviewScreenIsPlacedByTheCallsQuestions(t *testing.T) {
	lines := strings.Split(fixture(t, "dialog-review-tall-clipped.txt"), "\n")
	tail := reviewTail(lines)
	r := answerReading{region: tail, dialog: ParseDialog(strings.Join(tail, "\n"))}
	known := []DialogQuestion{{Header: "Planting"}, {Header: "Sunlight"}, {Header: "Layout"}, {Header: "Time"}}
	if at, ok := answerPosition(r, known); !ok || at != 4 {
		t.Errorf("answerPosition = %d, %v; want 4, true", at, ok)
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
			if tail := reviewTail(strings.Split(tc.pane, "\n")); tail != nil {
				t.Errorf("read %d lines as a review screen, want none", len(tail))
			}
			if d := ParseDialog(tc.pane); d != nil {
				t.Errorf("parsed as a dialog: %+v", d)
			}
		})
	}
}
