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

// A slash command opens a screen of its own in the box's place (/config, a
// picker), which is its submit working.
func TestPromptTakesACommandThatOpensAScreenAsSubmitted(t *testing.T) {
	in, osUser := fakeInputSession(t, "FAKEINPUT_DIALOG=enter")
	if err := in.Prompt(osUser, "demo", "/config"); err != nil {
		t.Fatalf("Prompt(/config) = %v, want nil", err)
	}
}
