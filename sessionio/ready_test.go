package sessionio

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"strings"
	"testing"
	"time"
)

// paneSession starts an isolated tmux server running cmd, so a test can watch a
// pane that draws late — which is the whole subject here.
func paneSession(t *testing.T, cmd string) (*Injector, string, string) {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available")
	}
	u, err := user.Current()
	if err != nil {
		t.Skip("no current user")
	}
	// Pid for the reason scratchSession gives: concurrent runs of this package
	// otherwise share a socket, and the kill-server below is unconditional.
	sock := fmt.Sprintf("se-ready-%d-%s", os.Getpid(),
		strings.NewReplacer("/", "-", " ", "-").Replace(t.Name()))
	exec.Command("tmux", "-L", sock, "kill-server").Run()
	if err := exec.Command("tmux", "-L", sock, "new-session", "-d", "-s", "demo", cmd).Run(); err != nil {
		t.Fatalf("new-session: %v", err)
	}
	t.Cleanup(func() { killSock(sock) })
	return NewInjectorOnSocket(u.Username, sock), u.Username, sock
}

// The failure this exists to prevent, measured on 2026-08-16: `claude --resume`
// leaves the pane EMPTY for about a second while it loads the transcript. Input
// sent in that window is not simply buffered and replayed — the pasted text
// arrived intact but the Enter that should have submitted it was swallowed, so
// the prompt sat on the input line unsent and the turn never ran. Waiting for
// the pane to be drawn before typing is the fix.
func TestAwaitInputReadyWaitsForALateDrawingTUI(t *testing.T) {
	// Draws nothing for 1.5s, then paints a prompt and holds.
	in, osUser, _ := paneSession(t, `sh -c 'sleep 1.5; printf "\n`+promptMark+` "; sleep 60'`)

	start := time.Now()
	if err := in.AwaitInputReady(context.Background(), osUser, "demo", 20*time.Second, 100*time.Millisecond); err != nil {
		t.Fatalf("AwaitInputReady: %v", err)
	}
	waited := time.Since(start)

	if waited < 1200*time.Millisecond {
		t.Fatalf("returned after %v — it cannot have waited for the prompt to be drawn", waited)
	}
	if waited > 10*time.Second {
		t.Fatalf("took %v to notice a prompt drawn at 1.5s", waited)
	}
}

// A pane that never draws a prompt must not block forever, and must say so
// rather than reporting readiness it did not observe. The caller's decision —
// type anyway, or give up — belongs to the caller.
func TestAwaitInputReadyGivesUpOnAPaneThatNeverDraws(t *testing.T) {
	in, osUser, _ := paneSession(t, `sh -c 'sleep 60'`)

	err := in.AwaitInputReady(context.Background(), osUser, "demo", 1500*time.Millisecond, 100*time.Millisecond)
	if err == nil {
		t.Fatal("expected an error for a pane that never drew a prompt")
	}
	if !strings.Contains(err.Error(), "demo") {
		t.Fatalf("error should name the session, got: %v", err)
	}
}

// A cancelled context ends the wait promptly: a Stop pressed while a
// resurrection waits must not sit behind the full timeout.
func TestAwaitInputReadyHonoursContextCancellation(t *testing.T) {
	in, osUser, _ := paneSession(t, `sh -c 'sleep 60'`)

	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(300 * time.Millisecond); cancel() }()

	start := time.Now()
	if err := in.AwaitInputReady(ctx, osUser, "demo", 30*time.Second, 100*time.Millisecond); err == nil {
		t.Fatal("expected an error when the context is cancelled")
	}
	if waited := time.Since(start); waited > 5*time.Second {
		t.Fatalf("cancellation took %v to take effect", waited)
	}
}

// An already-drawn pane is ready immediately — the wait must not add latency to
// the ordinary case, which is every prompt sent to a session that is just
// sitting there.
func TestAwaitInputReadyReturnsAtOnceForADrawnPane(t *testing.T) {
	in, osUser, _ := paneSession(t, `sh -c 'printf "\n`+promptMark+` "; sleep 60'`)
	time.Sleep(400 * time.Millisecond)

	start := time.Now()
	if err := in.AwaitInputReady(context.Background(), osUser, "demo", 20*time.Second, 100*time.Millisecond); err != nil {
		t.Fatalf("AwaitInputReady: %v", err)
	}
	if waited := time.Since(start); waited > 2*time.Second {
		t.Fatalf("a drawn pane should be ready at once, waited %v", waited)
	}
}

// Codex draws its › at the head of its input line and as the cursor of every
// menu. Measured on codex-cli 0.158.0 on 2026-09-28: a fresh session drew its
// input line and, 0.2 s later, a dialog whose cursor row is "› 2. Cancel"; a
// prompt and Enter pasted then would pick that row.
func TestCodexInputReadyTellsTheInputLineFromAMenu(t *testing.T) {
	read := func(name string) string {
		t.Helper()
		b, err := os.ReadFile("testdata/" + name)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	cases := []struct {
		name string
		pane string
		want bool
	}{
		{"an idle codex", read("status-codex-idle.txt"), true},
		{"the background-server dialog", read("codex-dialog-daemon.txt"), false},
		{"a menu with its cursor on the first row", "  Trust this folder?\n\n› 1. Yes, continue\n  2. No, quit\n", false},
		{"typed text on the input line", "\n› say pong\n\n  gpt medium · ~/code\n", true},
		{"a pane with no codex yet", "\n\n$ \n", false},
		{"Claude's prompt", "\n❯ \n", false},
	}
	for _, c := range cases {
		if got := CodexInputReady(c.pane); got != c.want {
			t.Errorf("%s: CodexInputReady = %v, want %v", c.name, got, c.want)
		}
	}
}

// A codex menu is up when codex's cursor marks a numbered row, and codex is the
// one drawing: Claude's ❯ anywhere on the pane says the pane is Claude's.
func TestCodexMenuOpen(t *testing.T) {
	read := func(name string) string {
		t.Helper()
		b, err := os.ReadFile("testdata/" + name)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	for _, c := range []struct {
		name string
		pane string
		want bool
	}{
		{"the background-server dialog", read("codex-dialog-daemon.txt"), true},
		{"a menu inside a border", "│ › 1. Yes, continue │\n│   2. No, quit     │\n", true},
		{"an idle codex", read("status-codex-idle.txt"), false},
		{"a Claude pane with a numbered line after ›", "\n› 3. say pong\n\n❯ \n", false},
		{"a numbered line codex did not mark", "  1. Run without daemon this time\n› Ask Codex\n", false},
		{"Claude's prompt", "\n❯ \n", false},
	} {
		if got := CodexMenuOpen(c.pane); got != c.want {
			t.Errorf("%s: CodexMenuOpen = %v, want %v", c.name, got, c.want)
		}
	}
}

// A codex stuck on a menu never reads as ready, so the first prompt waits
// rather than answering the menu.
func TestAwaitCodexReadyWaitsOutAMenu(t *testing.T) {
	in, osUser, _ := paneSession(t, `sh -c 'printf "\n› 2. Cancel\n"; sleep 60'`)
	if err := in.AwaitReady(context.Background(), osUser, "demo", HarnessCodex, 1500*time.Millisecond, 100*time.Millisecond); err == nil {
		t.Fatal("a codex showing a menu read as ready for a prompt")
	}
}

func TestAwaitCodexReadyTakesTheInputLine(t *testing.T) {
	in, osUser, _ := paneSession(t, `sh -c 'sleep 0.8; printf "\n› Ask Codex to do anything\n"; sleep 60'`)
	if err := in.AwaitReady(context.Background(), osUser, "demo", HarnessCodex, 10*time.Second, 100*time.Millisecond); err != nil {
		t.Fatalf("AwaitReady(codex): %v", err)
	}
}
