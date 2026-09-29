package sessionio

import (
	"slices"
	"strings"
	"testing"
	"time"
)

// Stop with prompts queued mid-turn. Measured on CLI 2.1.283 (2026-09-27): C-c
// and Escape both interrupt and then SUBMIT every queued prompt as the next
// turn, so a plain Cancel runs the very prompts the reader meant to take back.
// Up on an empty box pops them into the input box instead ("popAll"), and an
// interrupt after that leaves them there, unsent. ClearQueue is the pop plus a
// clear of the box, so the interrupt that follows runs nothing.
//
// These run against testdata/fakeinput.py, which models that contract.

// fakeQueue is the FAKEINPUT_QUEUE value for these prompts.
func fakeQueue(prompts ...string) string {
	return "FAKEINPUT_QUEUE='" + strings.ReplaceAll(strings.Join(prompts, "|"), "\n", `\n`) + "'"
}

// paneLines reads the fake's own report lines with the given prefix.
func paneLines(t *testing.T, in *Injector, osUser, prefix string) []string {
	t.Helper()
	pane, err := in.CapturePane(osUser, "demo")
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, l := range strings.Split(pane, "\n") {
		if s, ok := strings.CutPrefix(l, prefix); ok {
			got = append(got, strings.TrimRight(s, " "))
		}
	}
	return got
}

// awaitPane polls the pane until ok holds for it, for up to two seconds.
func awaitPane(t *testing.T, in *Injector, osUser string, ok func(string) bool) string {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		pane, err := in.CapturePane(osUser, "demo")
		if err == nil && ok(pane) {
			return pane
		}
		if !time.Now().Before(deadline) {
			t.Fatalf("the pane never reached the expected state:\n%s", pane)
		}
		time.Sleep(40 * time.Millisecond)
	}
}

// The control: the fake does what the CLI does, so the test below means
// something. A plain Cancel with two prompts queued runs both of them.
func TestCancelAloneRunsWhatIsQueued(t *testing.T) {
	in, osUser := fakeInputSession(t, fakeQueue("alpha", "beta\nline two"))
	if err := in.Cancel(osUser, "demo"); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	awaitPane(t, in, osUser, func(p string) bool { return strings.Contains(p, "INTERRUPTED") })
	if got := paneLines(t, in, osUser, "SUBMITTED="); !slices.Equal(got, []string{"alpha", "beta⏎line two"}) {
		t.Fatalf("submitted = %q, want both queued prompts, as CLI 2.1.283 does", got)
	}
}

func TestClearQueueTakesTheQueueOffBeforeTheInterrupt(t *testing.T) {
	in, osUser := fakeInputSession(t, fakeQueue("alpha", "beta\nline two\nline three"))

	took, err := in.ClearQueue(osUser, "demo", []string{"alpha", "beta\nline two\nline three"})
	if err != nil {
		t.Fatalf("ClearQueue: %v", err)
	}
	if !took {
		t.Fatal("ClearQueue said it did not take the queue")
	}
	if err := in.Cancel(osUser, "demo"); err != nil {
		t.Fatalf("Cancel: %v", err)
	}

	pane := awaitPane(t, in, osUser, func(p string) bool { return strings.Contains(p, "INTERRUPTED") })
	if got := paneLines(t, in, osUser, "SUBMITTED="); len(got) != 0 {
		t.Fatalf("submitted %q after a Stop that took the queue back, want nothing", got)
	}
	if got := paneLines(t, in, osUser, "QUEUED="); len(got) != 0 {
		t.Fatalf("still queued: %q", got)
	}
	// All three lines of the popped text are gone, not just the last one:
	// Prompt's C-e C-u prelude kills one line, and the next Send would be
	// submitted concatenated onto whatever was left.
	if box, _ := inputBox(pane); strings.TrimSpace(box) != "" {
		t.Fatalf("the input box still holds %q; pane:\n%s", box, pane)
	}
}

// Nothing handed back, nothing typed.
func TestClearQueueWithNothingQueuedTypesNothing(t *testing.T) {
	in, argv := recordingInjector(t)
	took, err := in.ClearQueue("wizard", "demo", nil)
	if err != nil || took {
		t.Fatalf("ClearQueue(nil) = (%v, %v), want (false, nil)", took, err)
	}
	if runs := argv(); len(runs) != 0 {
		t.Fatalf("tmux ran %v for an empty queue", runs)
	}
}

// A blocking dialog is on the pane while the session awaits, and Up there
// moves the dialog's highlighted row rather than popping the queue.
func TestClearQueueLeavesADialogAlone(t *testing.T) {
	in, osUser := fakeInputSession(t, fakeQueue("alpha"))
	if err := in.SetOption(osUser, "demo", OptionState, StateAwaiting); err != nil {
		t.Fatal(err)
	}
	took, err := in.ClearQueue(osUser, "demo", []string{"alpha"})
	if err != nil || took {
		t.Fatalf("ClearQueue while awaiting = (%v, %v), want (false, nil)", took, err)
	}
	if got := paneLines(t, in, osUser, "QUEUED="); !slices.Equal(got, []string{"alpha"}) {
		t.Fatalf("queued = %q, want the queue untouched", got)
	}
}

// A pane with no Claude input box (a shell) has no queue to pop.
func TestClearQueueNeedsClaudesInputBox(t *testing.T) {
	in, osUser, _ := scratchSession(t)
	took, err := in.ClearQueue(osUser, "demo", []string{"alpha"})
	if err != nil || took {
		t.Fatalf("ClearQueue on a shell = (%v, %v), want (false, nil)", took, err)
	}
}

// A Stop that lands before Claude has written anything for the turn puts the
// prompt back on the input line (CLI 2.1.283, measured 2026-09-28). Left
// there, the Text view never shows it and the next send's clear erases it, so
// the prompt is lost while the chat shows it as sent. ReclaimInterrupted takes
// it off the input line so the caller can hand it back to the composer.
func TestReclaimInterruptedTakesThePromptBackOffTheInputLine(t *testing.T) {
	in, osUser := fakeInputSession(t, "FAKEINPUT_RUNNING='Write a long story about a lighthouse keeper, one that wraps over the width of the pane and then some more words to be sure it does.' FAKEINPUT_RESTORE_MS=200")
	if err := in.Cancel(osUser, "demo"); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	took, err := in.ReclaimInterrupted(osUser, "demo", "Write a long story about a lighthouse keeper, one that wraps over the width of the pane and then some more words to be sure it does.")
	if err != nil {
		t.Fatalf("ReclaimInterrupted: %v", err)
	}
	if !took {
		t.Fatal("ReclaimInterrupted did not find the prompt on the input line")
	}
	awaitPane(t, in, osUser, func(p string) bool {
		box, ok := inputBox(p)
		return ok && strings.TrimSpace(box) == ""
	})
	if got := paneLines(t, in, osUser, "SUBMITTED="); len(got) != 0 {
		t.Fatalf("submitted %q, want nothing", got)
	}
}

// Round 7 (2026-09-28): right after the interrupt the pane drew something in
// the input box's place (Claude Code's feedback-draft panel), and the reclaim
// gave up on its first read. The prompt landed on the line a moment later,
// where the next send's clear took only its last visual line and the new
// prompt went in glued to the rest. The box not being drawn yet is a reason
// to keep reading, not to stop.
func TestReclaimInterruptedWaitsForTheBoxToBeDrawnAgain(t *testing.T) {
	const text = "Write a long story about a lighthouse keeper."
	in, osUser := fakeInputSession(t, "FAKEINPUT_RUNNING='"+text+"' FAKEINPUT_RESTORE_MS=100 FAKEINPUT_HIDE_MS=500")
	if err := in.Cancel(osUser, "demo"); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	took, err := in.ReclaimInterrupted(osUser, "demo", text)
	if err != nil {
		t.Fatalf("ReclaimInterrupted: %v", err)
	}
	if !took {
		t.Fatal("ReclaimInterrupted gave up while the box was not drawn")
	}
	awaitPane(t, in, osUser, func(p string) bool {
		box, ok := inputBox(p)
		return ok && strings.TrimSpace(box) == ""
	})
}

// Claude had started answering, so nothing comes back, and a draft of the
// reader's own on the input line is left alone.
func TestReclaimInterruptedLeavesOtherWordsAlone(t *testing.T) {
	in, osUser := fakeInputSession(t, "FAKEINPUT_LINE='my own draft'")
	if err := in.Cancel(osUser, "demo"); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	took, err := in.ReclaimInterrupted(osUser, "demo", "Write a long story")
	if err != nil || took {
		t.Fatalf("ReclaimInterrupted = (%v, %v), want (false, nil)", took, err)
	}
	pane, err := in.CapturePane(osUser, "demo")
	if err != nil {
		t.Fatal(err)
	}
	if box, _ := inputBox(pane); strings.TrimSpace(box) != "my own draft" {
		t.Fatalf("the input line holds %q, want the reader's draft untouched", box)
	}
}

// Emptying Claude's input box one Backspace per character took seconds for a
// long prompt: CLI 2.1.283 repaints the box after every key, and a 3,167
// character prompt a Stop had handed back sat in the box for about 11 s, where
// an Enter in the Terminal would resend it (deployed review round 5). C-u
// kills one visual line, and a Backspace after it joins the line above:
// measured on 2026-09-29, 30 such pairs emptied a 1,800 character, 18-row box
// in 0.12 s where 1,900 Backspaces took 2.8 s. The pairs are counted for a
// pane as narrow as wipeWidth columns, with a margin.
func TestWipeKeysKillALineAtATime(t *testing.T) {
	keys := wipeKeys(1800)
	if keys[0] != "C-e" {
		t.Fatalf("keys start %q, want C-e", keys[0])
	}
	pairs := (len(keys) - 1) / 2
	if want := 1800/wipeWidth + wipeMargin; pairs != want {
		t.Errorf("%d C-u/BSpace pairs, want %d", pairs, want)
	}
	for i := 1; i < len(keys); i += 2 {
		if keys[i] != "C-u" || keys[i+1] != "BSpace" {
			t.Fatalf("key %d is %q %q, want C-u BSpace", i, keys[i], keys[i+1])
		}
	}
	if got := len(wipeKeys(10_000_000)); got > 1+2*wipeMaxPairs {
		t.Errorf("a huge box asked for %d keys, want at most %d", got, 1+2*wipeMaxPairs)
	}
}

// Stop a moment after Claude took the queued prompt into its turn. The page
// still thinks it is queued, so it asks for it back, and Up on the now empty
// queue RECALLS the prompt from history instead of popping it: the box shows
// the same words under a rule titled "History N/M" (CLI 2.1.284, measured
// 2026-09-29). Deployed review round 2 of the T3 pass: a picture message came
// back as a draft that Claude had already answered, and a Send would have
// delivered it twice. A recall is not the queue, and the box is left empty.
func TestClearQueueDoesNotTakeAPromptRecalledFromHistory(t *testing.T) {
	for _, text := range []string{"[Image #1]  pic in queue", "queued words Claude already took"} {
		t.Run(text, func(t *testing.T) {
			in, osUser := fakeInputSession(t, "FAKEINPUT_HISTORY='"+text+"'")
			took, err := in.ClearQueue(osUser, "demo", []string{text})
			if err != nil {
				t.Fatalf("ClearQueue: %v", err)
			}
			if took {
				t.Fatal("ClearQueue took a prompt Up recalled from history as the queue")
			}
			pane := awaitPane(t, in, osUser, func(p string) bool {
				box, ok := inputBox(p)
				return ok && strings.TrimSpace(box) == ""
			})
			if strings.Contains(pane, "History") {
				t.Fatalf("the box was left browsing history:\n%s", pane)
			}
		})
	}
}

// The rows as CLI 2.1.284 drew them on 2026-09-29, after Up on an empty queue
// and after Up on a real one.
func TestRecallingHistoryReadsTheRuleAboveTheBox(t *testing.T) {
	rule := strings.Repeat("─", 100)
	recalled := "· Jitterbugging…\n─── History 4/4 " + rule + "\n❯ queued two say FIG\n" + rule + "\n  ⏸ manual mode on\n"
	popped := "  timing of each constituent.\n" + rule + " ↯ ─\n❯ queued three say KIWI\n" + rule + "\n  ⏸ manual mode on\n"
	if !recallingHistory(recalled) {
		t.Error("a recalled prompt was not seen as one")
	}
	if recallingHistory(popped) {
		t.Error("a popped queue was read as a history recall")
	}
}
