package sessionio

import (
	"context"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The driver against a real tmux and a real pty. The thing under test is the
// WALK — pin the list at its top, step one row at a time, read the cursor back
// between steps, and commit with the session-only key — so the pane on the
// other end is a stand-in that answers those keys and records which one
// committed (testdata/fakepicker.py). A CLI is not needed to prove any of that,
// and needing one would mean the test could not run anywhere.

func pickerSession(t *testing.T) (*Injector, string) {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available")
	}
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 not available")
	}
	u, err := user.Current()
	if err != nil {
		t.Skip("no current user")
	}
	script, err := filepath.Abs("testdata/fakepicker.py")
	if err != nil {
		t.Fatalf("locating the stand-in picker: %v", err)
	}
	sock := "sio-picker-" + strings.NewReplacer("/", "-", " ", "-").Replace(t.Name())
	exec.Command("tmux", "-L", sock, "kill-server").Run()
	if err := exec.Command("tmux", "-L", sock, "new-session", "-d", "-s", "demo",
		"-x", "120", "-y", "40", "python3 "+script).Run(); err != nil {
		t.Fatalf("new-session: %v", err)
	}
	t.Cleanup(func() { exec.Command("tmux", "-L", sock, "kill-server").Run() })
	time.Sleep(300 * time.Millisecond)
	return NewInjectorOnSocket(u.Username, sock), u.Username
}

func TestSetModelWalksToTheRowAndCommitsForThisSessionOnly(t *testing.T) {
	in, osUser := pickerSession(t)

	got, err := in.SetModel(context.Background(), osUser, "demo", HarnessClaude, ModelState{Model: "Haiku"})
	if err != nil {
		t.Fatalf("SetModel: %v", err)
	}
	if got.Model != "Haiku" {
		t.Fatalf("state = %+v, want the model it was asked for", got)
	}
	pane, err := in.CapturePane(osUser, "demo")
	if err != nil {
		t.Fatalf("CapturePane: %v", err)
	}
	if !strings.Contains(pane, "MODEL=Haiku") {
		t.Fatalf("the picker did not commit Haiku for the session; pane:\n%s", pane)
	}
	// Enter is the CLI's "save as the account default". Pressing it would move
	// every session started afterwards, which is the whole reason the driver
	// walks instead of pressing a digit.
	if strings.Contains(pane, "DEFAULT=") {
		t.Fatalf("the driver committed an account default; pane:\n%s", pane)
	}
}

// Walking UP is the same walk: the list is pinned at its top first, so where
// the cursor started makes no difference.
func TestSetModelReachesARowAboveWhereTheCursorStarted(t *testing.T) {
	in, osUser := pickerSession(t)

	if _, err := in.SetModel(context.Background(), osUser, "demo", HarnessClaude, ModelState{Model: "Sonnet"}); err != nil {
		t.Fatalf("SetModel: %v", err)
	}
	pane, _ := in.CapturePane(osUser, "demo")
	if !strings.Contains(pane, "MODEL=Sonnet") {
		t.Fatalf("pane:\n%s", pane)
	}
}

// A model this account is not offered must come back as an error naming what it
// IS offered, with the picker closed behind it — never as a different model
// picked quietly.
func TestSetModelRefusesAModelThePickerDoesNotList(t *testing.T) {
	in, osUser := pickerSession(t)

	_, err := in.SetModel(context.Background(), osUser, "demo", HarnessClaude, ModelState{Model: "Fable"})
	if err == nil {
		t.Fatal("a model that is not on the list was accepted")
	}
	if !strings.Contains(err.Error(), "Haiku") {
		t.Fatalf("error = %v, want it to name what the session does list", err)
	}
	time.Sleep(300 * time.Millisecond)
	pane, _ := in.CapturePane(osUser, "demo")
	if strings.Contains(pane, "MODEL=") || strings.Contains(pane, "DEFAULT=") {
		t.Fatalf("a refused choice committed something anyway; pane:\n%s", pane)
	}
}

func TestSetModelRefusesASessionWithNothingToPick(t *testing.T) {
	in := NewInjector("nobody")
	if _, err := in.SetModel(context.Background(), "nobody", "demo", "shell", ModelState{Model: "opus"}); err == nil {
		t.Fatal("a plain shell was asked to change model")
	}
	if _, err := in.SetModel(context.Background(), "nobody", "demo", HarnessClaude, ModelState{}); err == nil {
		t.Fatal("an empty choice was accepted")
	}
}

func TestEffortStepsCountsTheArrowPressesToALevel(t *testing.T) {
	ladder := ClaudeEfforts
	for want, steps := range map[string]int{"low": 0, "medium": 1, "high": 2, "xhigh": 3, "max": 4, "ultracode": 5} {
		got, ok := effortSteps(ladder, want)
		if !ok || got != steps {
			t.Errorf("effortSteps(%q) = %d, %v; want %d", want, got, ok, steps)
		}
	}
	if _, ok := effortSteps(ladder, "ultra"); ok {
		t.Error("codex's top step was found on Claude's ladder")
	}
}
