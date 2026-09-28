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
