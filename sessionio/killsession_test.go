package sessionio

import (
	"io"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

// attachFocusedClient attaches a real terminal client to session through
// script(1), which gives tmux a pty to read. Writing to the returned pipe is
// typing into that terminal. focus-events is turned on first, as it is on the
// lobby users' servers, so tmux reads "\x1b[I" as a focus-in event rather than
// as plain input.
func attachFocusedClient(t *testing.T, sock, session string) io.WriteCloser {
	t.Helper()
	if _, err := exec.LookPath("script"); err != nil {
		t.Skip("script(1) not available")
	}
	if out, err := exec.Command("tmux", "-L", sock, "set", "-s", "focus-events", "on").CombinedOutput(); err != nil {
		t.Fatalf("set focus-events: %v: %s", err, out)
	}
	cmd := exec.Command("script", "-qfec",
		"tmux -L "+sock+" attach -t ="+session, "/dev/null")
	// script runs its command through $SHELL, and zsh would expand the
	// `=name` target as a path lookup.
	cmd.Env = append(cmd.Environ(), "SHELL=/bin/sh", "TERM=xterm-256color")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("start client: %v", err)
	}
	t.Cleanup(func() {
		stdin.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		out, _ := exec.Command("tmux", "-L", sock, "list-clients", "-t", "="+session).Output()
		if strings.TrimSpace(string(out)) != "" {
			return stdin
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("client never attached to %s", session)
	return nil
}

// Killing a session that a browser terminal is looking at must not take down
// the user's whole tmux server.
//
// tmux 3.4 (and master as of 2026-11-02) handles a focus event with
// `window_update_focus(c->session->curw->window)` and no NULL check
// (tty-keys.c). kill-session leaves every client that was attached to the
// session with c->session == NULL until that client process exits, so a focus
// event arriving in that gap segfaults the server. On 2026-11-01 16:15:17 that
// took all 13 of emo's sessions with it, one second after the lobby killed one
// he still had open on his phone.
//
// The terminal here sends focus-in continuously, so every moment of the kill is
// covered. The sibling session is the witness: it outlives the kill only if the
// server does.
func TestKillSessionSurvivesFocusEventsFromAttachedClient(t *testing.T) {
	in, osUser, sock := scratchServer(t)
	for _, name := range []string{"siotest-victim", "siotest-witness"} {
		if err := in.NewSession(NewSessionSpec{OSUser: osUser, Name: name, Command: []string{"sh"}}); err != nil {
			t.Fatalf("NewSession %s: %v", name, err)
		}
	}
	term := attachFocusedClient(t, sock, "siotest-victim")

	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			if _, err := term.Write([]byte("\x1b[I")); err != nil {
				return
			}
			time.Sleep(500 * time.Microsecond)
		}
	}()

	err := in.KillSession(osUser, "siotest-victim")
	time.Sleep(300 * time.Millisecond) // let any focus event already in flight land
	close(stop)
	wg.Wait()

	if err != nil {
		t.Fatalf("KillSession: %v", err)
	}
	if in.HasSession(osUser, "siotest-victim") {
		t.Fatal("the killed session still resolves")
	}
	if !in.HasSession(osUser, "siotest-witness") {
		t.Fatal("killing one attached session crashed the tmux server and took the other session with it")
	}
}
