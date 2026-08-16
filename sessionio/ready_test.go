package sessionio

import (
	"context"
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
	sock := "se-ready-" + strings.NewReplacer("/", "-", " ", "-").Replace(t.Name())
	exec.Command("tmux", "-L", sock, "kill-server").Run()
	if err := exec.Command("tmux", "-L", sock, "new-session", "-d", "-s", "demo", cmd).Run(); err != nil {
		t.Fatalf("new-session: %v", err)
	}
	t.Cleanup(func() { exec.Command("tmux", "-L", sock, "kill-server").Run() })
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
