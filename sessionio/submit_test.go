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
		// Deployed review round 3 of the T3 pass (CLI 2.1.284, 2026-09-29): an
		// early Stop on "words <picture> words" put the prompt back drawn with
		// "[Image #N]" where each path was, and a match on the path text alone
		// never came, so the prompt was left on the line and lost.
		{"words before the pictures the box attached", paneWithBox("",
			"❯ Look at [Image #5]  and [Image #6]  then think hard and write a 200 word poem about both."),
			"Look at /var/lib/clipboard-store/wizard/s/pasted-a.png  and /var/lib/clipboard-store/wizard/s/pasted-b.png  then think hard and write a 200 word poem about both.", true},
		{"a short prompt ending on a picture", paneWithBox("", "❯ hi [Image #1]"),
			"hi /var/lib/clipboard-store/wizard/s/pasted-a.png", true},
		{"a picture and other words", paneWithBox("", "❯ Look at [Image #1] and something else"),
			"Look at /var/lib/clipboard-store/wizard/s/pasted-a.png and a different ending", false},
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
	return fakeInputSession(t, fmt.Sprintf("FAKEINPUT_SWALLOW=%d", swallow))
}

// fakeInputSession runs testdata/fakeinput.py with env, a shell-quoted
// VAR=value prefix, in an isolated tmux server.
func fakeInputSession(t *testing.T, env string) (*Injector, string) {
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
	cmd := fmt.Sprintf("%s python3 %s", env, script)
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

// A Stop that lands before Claude's first token puts the interrupted prompt
// back on the input line, and a long one wraps. C-u kills one visual line, so
// the old C-e C-u prelude left the first line behind and the next prompt was
// submitted onto it. Found in the live check of the T3 pass on 2026-09-27: the
// draft a Stop handed back went out as "...about the history of the " followed
// by the draft, on an 80-column pane.
func TestPromptClearsALeftoverThatSpansLines(t *testing.T) {
	in, osUser := fakeInputSession(t,
		`FAKEINPUT_LINE='Without using any tools, write a 3000-word essay about the history of the \ntelephone.'`)
	if err := in.Prompt(osUser, "demo", "say banana"); err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	if got := submittedLines(t, in, osUser); len(got) != 1 || got[0] != "say banana" {
		t.Fatalf("submitted = %q, want only the prompt", got)
	}
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

// Two pictures in one message: Claude Code reads a pasted picture's file
// before it draws "[Image #N]", and a large one takes longer. Deployed review
// round 1 of the T3 pass (2026-09-29) found the Enter pressed once the FIRST
// picture showed, with the second still being read: it attached after the
// submit, was left in the box, and the next send wiped it. Each picture is now
// attached before anything after it is pasted, so the message goes out whole
// and in the order it was written.
func TestPromptWaitsForEveryPictureBeforeTheEnter(t *testing.T) {
	in, osUser := fakeInputSession(t, "FAKEINPUT_IMAGE_MS=20,400")
	const text = "/var/tmp/one.png /var/tmp/two.jpg Name both colours."
	if err := in.Prompt(osUser, "demo", text); err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	want := "[Image #1] [Image #2] Name both colours."
	deadline := time.Now().Add(3 * time.Second)
	for {
		got := submittedLines(t, in, osUser)
		if len(got) == 1 && got[0] == want {
			break
		}
		if !time.Now().Before(deadline) {
			t.Fatalf("submitted = %q, want only %q", got, want)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if pane, _ := in.CapturePane(osUser, "demo"); strings.Contains(pane, "❯ [Image") {
		t.Fatalf("a picture was left in the box; pane:\n%s", pane)
	}
}

// Claude Code draws a picture's "[Image #N]" at the front of the paste that
// attached it. Deployed review round 2 of the T3 pass (2026-09-29) sent
// "Colour of first picture: <red>  and colour of second picture: <blue>" and
// Claude got "[Image #3]Colour of first picture:[Image #4]  and colour of
// second picture:", each picture one slot early. Every picture stays where
// the person put it.
func TestPromptKeepsEveryPictureWhereItWasWritten(t *testing.T) {
	in, osUser := fakeInputSession(t, "FAKEINPUT_IMAGE_MS=20")
	const text = "Colour of first picture: /var/tmp/one.png  and second: /var/tmp/two.jpg  Reply."
	if err := in.Prompt(osUser, "demo", text); err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	want := "Colour of first picture: [Image #1]  and second: [Image #2]  Reply."
	deadline := time.Now().Add(3 * time.Second)
	for {
		got := submittedLines(t, in, osUser)
		if len(got) == 1 && got[0] == want {
			break
		}
		if !time.Now().Before(deadline) {
			t.Fatalf("submitted = %q, want only %q", got, want)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// A path to a picture Claude cannot attach (no such file) stays in the box as
// text. The send does not wait on it.
func TestPromptDoesNotWaitOnAPictureThatStaysText(t *testing.T) {
	in, osUser := inputSession(t, 0)
	start := time.Now()
	if err := in.Prompt(osUser, "demo", "/var/tmp/gone.png then words"); err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	if took := time.Since(start); took > pictureAttachWait/2 {
		t.Fatalf("Prompt took %v", took)
	}
	if got := submittedLines(t, in, osUser); len(got) != 1 || got[0] != "/var/tmp/gone.png then words" {
		t.Fatalf("submitted = %q", got)
	}
}
