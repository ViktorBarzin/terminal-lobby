package main

import (
	"log"
	"os/exec"
	"strings"
)

// Injector drives a tmux session's pty: it sends prompts (bracketed paste + a
// separate Enter to submit — a CR inside a bracketed paste is only a soft newline)
// and interrupts. It runs tmux AS the mapped OS user (sudo -u), skipping sudo when
// the target IS the service's own user. socket == "" uses the user's default tmux
// socket; tests set it to an isolated -L socket.
type Injector struct {
	selfUser string
	socket   string
}

func (in *Injector) cmd(osUser string, args ...string) *exec.Cmd {
	full := []string{}
	if in.socket != "" {
		full = append(full, "-L", in.socket)
	}
	full = append(full, args...)
	if osUser == in.selfUser {
		return exec.Command("tmux", full...)
	}
	return exec.Command("sudo", append([]string{"-n", "-u", osUser, "tmux"}, full...)...)
}

// Prompt injects text as a bracketed paste, then submits with Enter.
func (in *Injector) Prompt(osUser, session, text string) error {
	if err := in.cmd(osUser, "set-buffer", "--", text).Run(); err != nil {
		return err
	}
	// -p = bracketed paste, -d = delete the buffer afterwards.
	if err := in.cmd(osUser, "paste-buffer", "-p", "-d", "-t", session).Run(); err != nil {
		return err
	}
	return in.cmd(osUser, "send-keys", "-t", session, "Enter").Run()
}

// Cancel sends Ctrl-C (interrupt) to the session, then re-derives
// @claude_state: an interrupt ends the turn WITHOUT firing Claude's Stop hook,
// which is the only writer of "done" (/etc/claude-code/managed-settings.json).
// Nothing else clears the stamp, so without this it latches at "running" and
// main.go's /prompt gate answers 409 for the life of the session, with the pane
// sitting idle at its prompt. Whoever injects the interrupt owns the transition
// (docs/adr/0001-claude-state-via-hooks.md).
//
// An unstamped session is left unstamped — no Claude ran in it, and a stamp
// would grow a state dot in the sidebar for a plain shell. The stamp write is
// best-effort: the interrupt already landed, so a failure here must not fail
// the cancel, but it silently re-creates the latch, so it is logged.
func (in *Injector) Cancel(osUser, session string) error {
	if err := in.cmd(osUser, "send-keys", "-t", session, "C-c").Run(); err != nil {
		return err
	}
	if in.State(osUser, session) == "" {
		return nil
	}
	if err := in.cmd(osUser, "set-option", "-t", session, "@claude_state", stateDone).Run(); err != nil {
		log.Printf("cancel %s/%s: clearing @claude_state failed: %v", osUser, session, err)
	}
	return nil
}

// State returns the @claude_state option value (running/awaiting/done/"") for the
// session, used to gate prompt injection. Empty on any error (fail-open to allow).
func (in *Injector) State(osUser, session string) string {
	out, err := in.cmd(osUser, "display-message", "-p", "-t", session, "#{@claude_state}").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
