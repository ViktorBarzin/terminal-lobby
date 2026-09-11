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
