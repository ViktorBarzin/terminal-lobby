package sessionio

import (
	"strings"
	"testing"
)

// Deployed review round 4 (2026-09-28). Claude Code's input box shows only
// the last rows of a prompt taller than it (measured on CLI 2.1.283: a
// 954-character prompt with 4 line breaks showed its last 10 rows, starting
// with the prompt mark). A Stop a second after such a prompt put it back on
// the input line, the reclaim compared the box's first row with the prompt's
// first words and found no match, and the next send's clear took only the
// rows on show. Claude received the rest of the stopped prompt with the new
// one glued on.

// tallText is a prompt of 8 lines, 5 taller than a 3-row box.
const tallText = "Queued line one.\nQueued line two.\nNote A: alpha words here\nNote A: beta words here\nNote B: gamma words here\nNote B: delta words here\nNote C: epsilon words here\nNote C: omega."

func fakeEnv(text string) string { return strings.ReplaceAll(text, "\n", `\n`) }

func TestReclaimInterruptedFindsAPromptTallerThanTheBox(t *testing.T) {
	in, osUser := fakeInputSession(t, "FAKEINPUT_BOX_ROWS=3 FAKEINPUT_RESTORE_MS=100 FAKEINPUT_RUNNING='"+fakeEnv(tallText)+"'")
	if err := in.Cancel(osUser, "demo"); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	took, err := in.ReclaimInterrupted(osUser, "demo", tallText)
	if err != nil {
		t.Fatalf("ReclaimInterrupted: %v", err)
	}
	if !took {
		t.Fatal("ReclaimInterrupted did not find a prompt the box shows only the end of")
	}
	// The whole prompt goes, not only the rows on show: the next prompt is
	// submitted alone.
	if err := in.Prompt(osUser, "demo", "say NEXTOK"); err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	if got := submittedLines(t, in, osUser); len(got) != 1 || got[0] != "say NEXTOK" {
		t.Fatalf("submitted = %q, want only the new prompt", got)
	}
}

// The same box left there by anything else, a draft typed in the Terminal
// say, is cleared in full before a prompt goes in.
func TestPromptClearsALeftoverTallerThanTheBox(t *testing.T) {
	in, osUser := fakeInputSession(t, "FAKEINPUT_BOX_ROWS=3 FAKEINPUT_LINE='"+fakeEnv(tallText)+"'")
	if err := in.Prompt(osUser, "demo", "say banana"); err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	if got := submittedLines(t, in, osUser); len(got) != 1 || got[0] != "say banana" {
		t.Fatalf("submitted = %q, want only the prompt", got)
	}
}

// A long prompt pasted into a box that shows only its end still reads as
// held, so the Enter is confirmed rather than pressed blind after a second.
func TestInputHoldsATallPromptTheBoxShowsTheEndOf(t *testing.T) {
	pane := "\n" + strings.Repeat("─", 60) + " ↯ ─\n" +
		promptMark + " Note B: delta words here\n  Note C: epsilon words here\n  Note C: omega.\n" +
		strings.Repeat("─", 60) + "\n"
	if !inputHolds(pane, tallText) {
		t.Fatal("inputHolds did not see the tall prompt in a box showing its last rows")
	}
	if inputHolds(pane, "Something else entirely, with other words in it.") {
		t.Fatal("inputHolds matched a box that holds other words")
	}
}

// Two prompts queued behind the last reply ran as one batch, and a Stop put
// both back on the input line, one per line. The Text view names the whole
// batch, a blank line between each.
func TestReclaimInterruptedTakesBackABatch(t *testing.T) {
	in, osUser := fakeInputSession(t, `FAKEINPUT_RESTORE_MS=100 FAKEINPUT_RUNNING='queued msg 1 t3000\nqueued msg 2 t3000'`)
	if err := in.Cancel(osUser, "demo"); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	took, err := in.ReclaimInterrupted(osUser, "demo", "queued msg 1 t3000\n\nqueued msg 2 t3000")
	if err != nil || !took {
		t.Fatalf("ReclaimInterrupted = (%v, %v), want the batch taken back", took, err)
	}
	awaitPane(t, in, osUser, func(p string) bool {
		box, ok := inputBox(p)
		return ok && strings.TrimSpace(box) == ""
	})
}
