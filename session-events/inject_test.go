package main

import (
	"os/exec"
	"os/user"
	"strings"
	"testing"
	"time"
)

// Exercises real tmux: start a scratch server + a shell session, inject a prompt,
// and confirm it reached the pty. Skips where tmux is unavailable.
func TestInjectPromptAndCancelIntegration(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available")
	}
	u, err := user.Current()
	if err != nil {
		t.Skip("no current user")
	}
	const sock = "se-test-inject"
	exec.Command("tmux", "-L", sock, "kill-server").Run() // clean any leftover
	if err := exec.Command("tmux", "-L", sock, "new-session", "-d", "-s", "demo", "sh").Run(); err != nil {
		t.Fatalf("new-session: %v", err)
	}
	defer exec.Command("tmux", "-L", sock, "kill-server").Run()
	time.Sleep(150 * time.Millisecond)

	in := &Injector{selfUser: u.Username, socket: sock}

	if err := in.Prompt(u.Username, "demo", "echo hello123marker"); err != nil {
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

	if err := in.Cancel(u.Username, "demo"); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
}
