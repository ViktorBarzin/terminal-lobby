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
