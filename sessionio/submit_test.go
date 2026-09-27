package sessionio

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The input box as Claude Code 2.1.283 draws it, around whatever line it holds.
// The rule above carries a glyph at its right end, as the real one does.
func paneWithBox(scrollback string, box ...string) string {
	rule := strings.Repeat("─", 60)
	return scrollback + "\n" + rule + " ↯ ─\n" + strings.Join(box, "\n") + "\n" + rule +
		"\n  /tmp | opus-5 | 0%\n  ⏸ manual mode on · ← for agents\n"
}

func TestInputHoldsReadsOnlyTheInputBox(t *testing.T) {
	const sent = "Run `ping -c 12 127.0.0.1` in the foreground and tell me the average round trip."
	idle, err := os.ReadFile("testdata/status-claude-idle.txt")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, pane, text string
		want             bool
	}{
		{"the text sits on the input line", paneWithBox("", "❯ "+sent), sent, true},
		{"a first line the box wrapped", paneWithBox("",
			"❯ Run `ping -c 12 127.0.0.1` in the foreground and tell",
			"  me the average round trip."), sent, true},
		{"a paste the box collapsed", paneWithBox("", "❯ [Pasted text #1 +14 lines]"),
			"one\ntwo\nthree", true},
		{"a path the box attached as an image", paneWithBox("", "❯ [Image #1]"),
			"/home/wizard/pic.png", true},
		{"an empty box", paneWithBox("", "❯ "), sent, false},
		{"a real idle capture", string(idle), sent, false},
		// Dim placeholder text reads as plain text in a capture.
		{"the placeholder suggestion", paneWithBox("", `❯ Try "create a util logging.py that..."`), sent, false},
		// Claude echoes a submitted prompt into the conversation with the same
		// mark. Reading that as the box is what pressed extra Enters into the
		// next dialog in a test harness (2026-09-24).
		{"the same prompt already submitted, in scrollback", paneWithBox("❯ "+sent+"\n\n● Pinging now.", "❯ "), sent, false},
		{"a different prompt in the box", paneWithBox("", "❯ something else"), sent, false},
		{"no box at all: a shell", "$ echo hi\nhi\n$ ", "echo hi", false},
		// A dialog's cursor row is not the box, even under a rule.
		{"a dialog row", paneWithBox("", "❯ 1. Yes"), sent, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := inputHolds(tc.pane, tc.text); got != tc.want {
				t.Fatalf("inputHolds = %v, want %v; pane:\n%s", got, tc.want, tc.pane)
			}
		})
	}
}

func TestInputBoxIsFoundOnlyWhereClaudeDrawsOne(t *testing.T) {
	if _, ok := inputBox("$ echo hi\nhi\n$ "); ok {
		t.Fatal("a shell pane has no input box")
	}
	if _, ok := inputBox(paneWithBox("", "❯ ")); !ok {
		t.Fatal("an empty box is still a box")
	}
}

var inputSeq atomic.Int64

// inputSession runs testdata/fakeinput.py in an isolated tmux server, set to
// ignore the first `swallow` Enters that arrive while its box holds text.
func inputSession(t *testing.T, swallow int) (*Injector, string) {
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
	script, err := filepath.Abs("testdata/fakeinput.py")
	if err != nil {
		t.Fatal(err)
	}
	sock := fmt.Sprintf("sio-input-%d-%d", os.Getpid(), inputSeq.Add(1))
	t.Cleanup(func() { killSock(sock) })
	cmd := fmt.Sprintf("FAKEINPUT_SWALLOW=%d python3 %s", swallow, script)
	if err := exec.Command("tmux", "-L", sock, "new-session", "-d", "-s", "demo",
		"-x", "120", "-y", "40", cmd).Run(); err != nil {
		t.Fatalf("new-session: %v", err)
	}
	in := NewInjectorOnSocket(u.Username, sock)
	deadline := time.Now().Add(20 * time.Second)
	for {
		pane, err := in.CapturePane(u.Username, "demo")
		if err == nil && strings.Contains(pane, "INPUT-READY") {
			return in, u.Username
		}
		if !time.Now().Before(deadline) {
			t.Fatalf("the stand-in input box never started; pane:\n%s", pane)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func submittedLines(t *testing.T, in *Injector, osUser string) []string {
	t.Helper()
	pane, err := in.CapturePane(osUser, "demo")
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, l := range strings.Split(pane, "\n") {
		if s, ok := strings.CutPrefix(l, "SUBMITTED="); ok {
			got = append(got, strings.TrimRight(s, " "))
		}
	}
	return got
}

// The defect: POST /prompt answered OK, the text sat on Claude's input line,
// and the Enter that should have submitted it was gone. Prompt now reads the
// box back and presses Enter again while its own text is still there.
func TestPromptPressesEnterAgainWhenTheFirstOneWasSwallowed(t *testing.T) {
	in, osUser := inputSession(t, 1)
	if err := in.Prompt(osUser, "demo", "say banana"); err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	if got := submittedLines(t, in, osUser); len(got) != 1 || got[0] != "say banana" {
		t.Fatalf("submitted = %q, want the prompt exactly once", got)
	}
}

func TestPromptSubmitsOnceWhenTheEnterLands(t *testing.T) {
	in, osUser := inputSession(t, 0)
	for _, text := range []string{"first", "second"} {
		if err := in.Prompt(osUser, "demo", text); err != nil {
			t.Fatalf("Prompt(%q): %v", text, err)
		}
	}
	if got := submittedLines(t, in, osUser); strings.Join(got, ",") != "first,second" {
		t.Fatalf("submitted = %q, want each prompt once, in order", got)
	}
}

// A box that never lets go is reported, so the sender keeps its text instead
// of being told it went.
func TestPromptReportsAPromptThatNeverLeftTheInputLine(t *testing.T) {
	in, osUser := inputSession(t, 100)
	err := in.Prompt(osUser, "demo", "say banana")
	if !errors.Is(err, ErrPromptNotSubmitted) {
		t.Fatalf("Prompt = %v, want ErrPromptNotSubmitted", err)
	}
	if got := submittedLines(t, in, osUser); len(got) != 0 {
		t.Fatalf("submitted = %q, want nothing", got)
	}
}

func TestPromptUnclearedAlsoConfirmsTheSubmit(t *testing.T) {
	in, osUser := inputSession(t, 1)
	if err := in.PromptUncleared(osUser, "demo", "hello"); err != nil {
		t.Fatalf("PromptUncleared: %v", err)
	}
	if got := submittedLines(t, in, osUser); len(got) != 1 || got[0] != "hello" {
		t.Fatalf("submitted = %q, want the prompt exactly once", got)
	}
}
