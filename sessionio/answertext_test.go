package sessionio

import (
	"os/exec"
	"strings"
	"testing"
	"time"
)

// The AskUserQuestion dialog always offers a free-text "Other" option, and the
// keys route cannot deliver it: answerKeys allows no letters beyond y/n, because
// that allowlist is the whole security boundary of the route.
//
// Prompt cannot deliver it either. It opens with C-e C-u to clear whatever draft
// the pane was holding and closes with an unconditional Enter — inside a dialog
// field that prelude is unverified, and the forced Enter would submit before the
// caller has read the pane back to confirm the text landed. AnswerText is the
// bounded middle: put the text in, and nothing else.
func TestAnswerTextTypesIntoThePaneWithoutSubmitting(t *testing.T) {
	in, osUser, sock := scratchSession(t)

	if err := in.AnswerText(osUser, "demo", "my own answer"); err != nil {
		t.Fatalf("AnswerText: %v", err)
	}
	time.Sleep(400 * time.Millisecond)

	out, err := exec.Command("tmux", "-L", sock, "capture-pane", "-p", "-t", "demo").Output()
	if err != nil {
		t.Fatalf("capture-pane: %v", err)
	}
	pane := string(out)
	if !strings.Contains(pane, "my own answer") {
		t.Fatalf("the text never reached the pane:\n%s", pane)
	}
	// A shell echoes a submitted line and prints a fresh prompt under it. The
	// text sitting on the CURRENT line, un-submitted, is the whole point: the
	// caller sends Enter itself, after reading the pane back.
	lines := strings.Split(strings.TrimRight(pane, "\n"), "\n")
	last := lines[len(lines)-1]
	if !strings.Contains(last, "my own answer") {
		t.Errorf("the text was submitted rather than left on the input line; last line = %q", last)
	}
	if strings.Contains(pane, "not found") || strings.Contains(pane, "command not found") {
		t.Errorf("the text ran as a command, so an Enter was sent:\n%s", pane)
	}
}

// The pane belongs to somebody's session. A browser bug, or a paste of the wrong
// buffer, must not be able to type a document into it.
func TestAnswerTextRefusesWhatIsNotAnAnswer(t *testing.T) {
	in := NewInjectorOnSocket("nobody", "tl-never")
	for _, tc := range []struct {
		name string
		text string
	}{
		{"nothing to type", ""},
		{"whitespace only", "   \t\n"},
		{"longer than any answer", strings.Repeat("x", MaxAnswerText+1)},
		{"a newline would submit mid-text", "first line\nsecond line"},
		{"a carriage return would too", "first\rsecond"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := in.AnswerText("nobody", "s", tc.text); err == nil {
				t.Errorf("AnswerText accepted %q", tc.text)
			}
		})
	}
}

// Text that is legitimate must still get through, including the punctuation an
// answer to a design question actually contains.
func TestAnswerTextAcceptsOrdinaryAnswers(t *testing.T) {
	in, osUser, _ := scratchSession(t)
	for _, ok := range []string{
		"none of these — use the pane instead",
		`something with "quotes" and a $VAR`,
		"-- looks like a flag",
		strings.Repeat("y", MaxAnswerText),
	} {
		if err := in.AnswerText(osUser, "demo", ok); err != nil {
			t.Errorf("AnswerText(%.20q…) refused: %v", ok, err)
		}
	}
}
