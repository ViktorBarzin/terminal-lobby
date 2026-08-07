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
//
// It clears the pane's input line first, so what is submitted is exactly what
// the composer sent. The pane is rarely empty: Claude Code puts an interrupted
// prompt BACK on its input line, so after a Stop the next prompt used to be
// submitted concatenated onto the one the operator had just cancelled — the
// cancelled work re-ran and the new prompt was mangled. A draft left in the
// pane from the Terminal view did the same thing.
//
// C-e then C-u, not C-u alone: in Claude Code's input C-u kills only to the
// start of the line, so a cursor left mid-text (measured) leaves the tail
// behind. Going to the end first makes the kill total. In a plain shell the
// C-e is a literal control character in the line buffer, which the C-u then
// erases along with everything else.
func (in *Injector) Prompt(osUser, session, text string) error {
	if err := in.cmd(osUser, "send-keys", "-t", session, "C-e", "C-u").Run(); err != nil {
		return err
	}
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
	v, _ := in.Option(osUser, session, "@claude_state")
	return v
}

// Option reads a tmux session option, empty when it is unset. ok=false means
// the read did not land on the session that was asked for — a different answer
// from "set to nothing".
//
// The answer is self-validating because tmux does NOT fail an unknown target:
// `display-message -p -t no-such-session` exits 0 (measured on tmux 3.4), so
// the requested name is printed back alongside the value and has to match, or
// the value is not this session's to serve.
func (in *Injector) Option(osUser, session, name string) (string, bool) {
	out, err := in.cmd(osUser, "display-message", "-p", "-t", session,
		"#{session_name}\n#{"+name+"}").Output()
	if err != nil {
		return "", false
	}
	got, value, found := strings.Cut(strings.TrimSuffix(string(out), "\n"), "\n")
	if !found || got != session {
		return "", false
	}
	return strings.TrimSpace(value), true
}

// SetOption stamps a tmux session option. It fails if the session does not exist.
func (in *Injector) SetOption(osUser, session, name, value string) error {
	return in.cmd(osUser, "set-option", "-t", session, name, value).Run()
}
