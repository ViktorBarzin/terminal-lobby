package main

import (
	"os/exec"
	"os/user"
	"strings"
	"testing"
	"time"
)

// scratchSession starts an isolated tmux server holding one shell session named
// "demo" and returns an Injector bound to it, the current OS user, and the
// socket name. Skips where tmux (or the current user) is unavailable; the
// server dies with the test.
func scratchSession(t *testing.T) (*Injector, string, string) {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available")
	}
	u, err := user.Current()
	if err != nil {
		t.Skip("no current user")
	}
	sock := "se-test-" + strings.NewReplacer("/", "-", " ", "-").Replace(t.Name())
	exec.Command("tmux", "-L", sock, "kill-server").Run() // clean any leftover
	if err := exec.Command("tmux", "-L", sock, "new-session", "-d", "-s", "demo", "sh").Run(); err != nil {
		t.Fatalf("new-session: %v", err)
	}
	t.Cleanup(func() { exec.Command("tmux", "-L", sock, "kill-server").Run() })
	time.Sleep(150 * time.Millisecond)
	return &Injector{selfUser: u.Username, socket: sock}, u.Username, sock
}

// Exercises real tmux: start a scratch server + a shell session, inject a prompt,
// and confirm it reached the pty. Skips where tmux is unavailable.
func TestInjectPromptAndCancelIntegration(t *testing.T) {
	in, osUser, sock := scratchSession(t)

	if err := in.Prompt(osUser, "demo", "echo hello123marker"); err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	time.Sleep(400 * time.Millisecond)

	out, err := exec.Command("tmux", "-L", sock, "capture-pane", "-p", "-t", "demo").Output()
	if err != nil {
		t.Fatalf("capture-pane: %v", err)
	}
	if !strings.Contains(string(out), "hello123marker") {
		t.Fatalf("injected prompt not visible in pane:\n%s", out)
	}

	if err := in.Cancel(osUser, "demo"); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
}

// An interrupt ends the turn but never fires Claude's Stop hook, which is the
// only writer of "done" (/etc/claude-code/managed-settings.json). So Cancel
// owns the transition: whatever state the stamp was left in, the turn is over
// once the interrupt lands. Without this, @claude_state latches at "running"
// and main.go's /prompt gate answers 409 for the life of the session — proven
// on a live Claude session: 30 s of polling after `send-keys C-c`, pane idle at
// its prompt, stamp still "running".
//
// An UNSTAMPED session is left alone: no Claude ever ran in it, and stamping
// would grow a state dot for a plain shell in the sidebar.
func TestCancelReDerivesStateAfterInterrupt(t *testing.T) {
	for _, tc := range []struct{ name, seed, want string }{
		{"latched running becomes done", stateRunning, stateDone},
		{"stale awaiting becomes done", "awaiting", stateDone},
		{"unstamped stays unstamped", "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in, osUser, sock := scratchSession(t)
			if tc.seed != "" {
				if err := exec.Command("tmux", "-L", sock, "set-option", "-t", "demo",
					"@claude_state", tc.seed).Run(); err != nil {
					t.Fatalf("seed @claude_state=%s: %v", tc.seed, err)
				}
			}

			if err := in.Cancel(osUser, "demo"); err != nil {
				t.Fatalf("Cancel: %v", err)
			}

			if got := in.State(osUser, "demo"); got != tc.want {
				t.Fatalf("@claude_state after Cancel = %q, want %q (seeded %q)",
					got, tc.want, tc.seed)
			}
		})
	}
}
