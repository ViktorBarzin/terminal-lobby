package sessionio

import (
	"errors"
	"testing"
)

// Deployed review round 4 (2026-09-28): a prompt sent as Claude drew a
// permission dialog was answered 204 and never reached Claude, and its Enter
// picked the dialog's highlighted row, "1. Yes": a Bash command ran with
// nobody pressing anything. The route had read the pane once, before the
// clear. Prompt now reads the box again before it pastes and before it
// presses Enter, and presses nothing where the box has gone.
func TestPromptPressesNoEnterWhereADialogTookTheBoxsPlace(t *testing.T) {
	for _, when := range []string{"clear", "paste"} {
		t.Run(when, func(t *testing.T) {
			in, osUser := fakeInputSession(t, "FAKEINPUT_DIALOG="+when)
			err := in.Prompt(osUser, "demo", "queued note 12")
			if !errors.Is(err, ErrInputGone) {
				t.Fatalf("Prompt = %v, want ErrInputGone", err)
			}
			if got := paneLines(t, in, osUser, "ANSWERED="); len(got) != 0 {
				t.Fatalf("the dialog was answered %q by a prompt", got)
			}
			if got := submittedLines(t, in, osUser); len(got) != 0 {
				t.Fatalf("submitted = %q, want nothing", got)
			}
		})
	}
}

// The live check of that fix (2026-09-28) lost one prompt in 6 trials: it had
// shown in the box, its Enter went, and the box was gone by the next read,
// with the text neither submitted nor on show. A dialog drawn that moment
// takes the Enter as nothing (no row was picked). Nothing on the pane says
// whether an Enter that met a dialog submitted, so Prompt says it cannot tell
// (ErrSubmitUnconfirmed), and the caller asks the transcript.
func TestPromptSaysItCannotTellWhenTheBoxGoesAtTheEnter(t *testing.T) {
	in, osUser := fakeInputSession(t, "FAKEINPUT_DIALOG=enter")
	err := in.Prompt(osUser, "demo", "queued note 12")
	if !errors.Is(err, ErrSubmitUnconfirmed) {
		t.Fatalf("Prompt = %v, want ErrSubmitUnconfirmed", err)
	}
	if got := paneLines(t, in, osUser, "ANSWERED="); len(got) != 0 {
		t.Fatalf("the dialog was answered %q by a prompt", got)
	}
}

// The Stop replay failed in CI on 2026-09-30: a long prompt went, Claude
// took it, and POST /prompt answered 409 dialog-open, so the sender kept the
// text as unsent while Claude ran it. The read after the Enter had caught
// the pane half repainted, the box's rows overwritten from the top and no
// whole box anywhere, and took that for a dialog; a re-read a moment later
// showed the empty box. A box that is back within boxGoneSettle was being
// repainted, not replaced.
func TestPromptTakesAHalfDrawnFrameForARepaint(t *testing.T) {
	in, osUser := fakeInputSession(t, "FAKEINPUT_TEAR_MS=100")
	if err := in.Prompt(osUser, "demo", "queued note 12"); err != nil {
		t.Fatalf("Prompt = %v, want nil", err)
	}
	if got := submittedLines(t, in, osUser); len(got) != 1 || got[0] != "queued note 12" {
		t.Fatalf("submitted = %q, want the prompt exactly once", got)
	}
}

// A slash command opens a screen of its own in the box's place (/config, a
// picker), which is its submit working.
func TestPromptTakesACommandThatOpensAScreenAsSubmitted(t *testing.T) {
	in, osUser := fakeInputSession(t, "FAKEINPUT_DIALOG=enter")
	if err := in.Prompt(osUser, "demo", "/config"); err != nil {
		t.Fatalf("Prompt(/config) = %v, want nil", err)
	}
}

// The same check lost a prompt a third way: the dialog had already taken the
// box's place by the time Prompt first read the pane, so the pane read like a
// shell's, which gets its Enter unchecked. The route had seen the box a moment
// before, in its guard's read, and says so (PromptInto); the prompt then stops
// short of the dialog.
func TestPromptIntoAPaneThatShowedTheBoxStopsAtADialogAlreadyUp(t *testing.T) {
	in, osUser := fakeInputSession(t, "FAKEINPUT_DIALOG=start")
	err := in.PromptInto(osUser, "demo", "queued note 12", true)
	if !errors.Is(err, ErrInputGone) {
		t.Fatalf("PromptInto = %v, want ErrInputGone", err)
	}
	if got := paneLines(t, in, osUser, "ANSWERED="); len(got) != 0 {
		t.Fatalf("the dialog was answered %q by a prompt", got)
	}
}
