package sessionio

import (
	"errors"
	"fmt"
	"log"
	"os/exec"
	"strings"
)

// Claude turn states, as stamped into @claude_state by the org-wide hooks
// (docs/adr/0001-claude-state-via-hooks.md). An UNSTAMPED session — the empty
// string — means no Claude ever ran in it, which is a different answer from
// "done" and is why callers must not treat "" as a state.
const (
	StateRunning  = "running"
	StateAwaiting = "awaiting"
	StateDone     = "done"
)

// tmux session options this package reads and writes. They live on the tmux
// session rather than in any process because their lifetime is exactly the
// session's: they survive every restart of every service, and they die with the
// session so a reused name never serves the dead conversation's data.
const (
	// OptionTranscript holds the absolute path of the transcript the session's
	// Claude is writing. Stamped by the SessionStart hook (see SessionMap).
	OptionTranscript = "@claude_transcript"
	// OptionState holds running/awaiting/done (ADR-0001).
	OptionState = "@claude_state"
	// OptionThread holds the T3 thread id a session is mirrored into. Written
	// by the syncer at adoption; dies with the session, which is deliberate —
	// a resurrected session re-derives it from the durable Index instead.
	OptionThread = "@t3_thread"
)

// Options is the tmux session-option store: read and written as the session's
// own OS user. It is an interface so callers can be tested without a tmux
// server (see sessionio/siotest.FakeOptions); Injector is the real one.
type Options interface {
	// Option reads a session option; "" when unset, ok=false when the session
	// could not be read at all.
	Option(osUser, session, name string) (string, bool)
	// SetOption stamps a session option. It fails when the session is gone.
	SetOption(osUser, session, name, value string) error
}

// Injector drives a tmux session's pty: it sends prompts (bracketed paste + a
// separate Enter to submit — a CR inside a bracketed paste is only a soft
// newline), interrupts, and manages the sessions themselves. It runs tmux AS
// the mapped OS user (sudo -u), skipping sudo when the target IS this process's
// own user.
//
// Every caller in the T3 bridge runs as the session's owner already
// (t3-serve@%i runs User=%i), so the sudo branch is only exercised by
// session-events, which runs privileged and serves several users.
type Injector struct {
	selfUser string
	socket   string
}

// NewInjector binds to the user's DEFAULT tmux socket — the one every real
// session on the box lives on.
func NewInjector(selfUser string) *Injector {
	return &Injector{selfUser: selfUser}
}

// NewInjectorOnSocket binds to an explicit `tmux -L <socket>` server. Tests use
// it to get an isolated tmux server that cannot reach a real session, which is
// the only safe way to exercise the destructive verbs below.
func NewInjectorOnSocket(selfUser, socket string) *Injector {
	return &Injector{selfUser: selfUser, socket: socket}
}

// Command builds a tmux invocation for a verb this package does not wrap. It is
// exported so callers do not re-derive the two rules that matter — which socket
// to talk to, and whether to go through `sudo -u` — each in their own way.
// Prefer the named methods; reach for this only for a genuinely new verb.
func (in *Injector) Command(osUser string, args ...string) *exec.Cmd {
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

// exactPane targets the named session and NOTHING ELSE, for the verbs whose
// -t takes a pane or window: send-keys, paste-buffer, set-option,
// display-message.
//
// tmux resolves an absent session name by unambiguous PREFIX match, and exits 0
// doing it (measured on 3.4: with only `agent-2` alive, `send-keys -t agent`
// types into `agent-2`). That is not a hypothetical state here — a resurrection
// that finds `agent` taken creates `agent-2` (resurrect.go), and `agent` then
// dying is the normal case on this box. Without the `=` the next prompt for the
// dead session is bracketed-pasted and Enter-submitted into a stranger's live
// conversation.
//
// The trailing colon makes it a window target; `=name` alone is rejected by
// set-option even for a session that exists, because its -t is a pane.
func exactPane(session string) string { return "=" + session + ":" }

// exactSession is the same rule for the verbs whose -t takes a session —
// kill-session, where `=name:` is not accepted and `=name` is.
func exactSession(session string) string { return "=" + session }

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
	if err := in.Command(osUser, "send-keys", "-t", exactPane(session), "C-e", "C-u").Run(); err != nil {
		return err
	}
	if err := in.Command(osUser, "set-buffer", "--", text).Run(); err != nil {
		return err
	}
	// -p = bracketed paste, -d = delete the buffer afterwards.
	if err := in.Command(osUser, "paste-buffer", "-p", "-d", "-t", exactPane(session)).Run(); err != nil {
		return err
	}
	return in.Command(osUser, "send-keys", "-t", exactPane(session), "Enter").Run()
}

// Cancel sends Ctrl-C (interrupt) to the session, then re-derives
// @claude_state: an interrupt ends the turn WITHOUT firing Claude's Stop hook,
// which is the only writer of "done" (/etc/claude-code/managed-settings.json).
// Nothing else clears the stamp, so without this it latches at "running" and
// every turn gate that reads it stays shut for the life of the session, with
// the pane sitting idle at its prompt. Whoever injects the interrupt owns the
// transition (docs/adr/0001-claude-state-via-hooks.md).
//
// An unstamped session is left unstamped — no Claude ran in it, and a stamp
// would grow a state dot in the sidebar for a plain shell. The stamp write is
// best-effort: the interrupt already landed, so a failure here must not fail
// the cancel, but it silently re-creates the latch, so it is logged.
func (in *Injector) Cancel(osUser, session string) error {
	if err := in.Command(osUser, "send-keys", "-t", exactPane(session), "C-c").Run(); err != nil {
		return err
	}
	if in.State(osUser, session) == "" {
		return nil
	}
	if err := in.Command(osUser, "set-option", "-t", exactPane(session), OptionState, StateDone).Run(); err != nil {
		log.Printf("cancel %s/%s: clearing %s failed: %v", osUser, session, OptionState, err)
	}
	return nil
}

// MaxKeys bounds one answer. A permission dialog is answered with a digit and
// an Enter; a menu with a few arrows. Nothing legitimate needs more, and a cap
// keeps a mistake in the browser from typing a paragraph into somebody's shell.
const MaxKeys = 8

// answerKeys is what a web client may send into a pane. It is an ALLOWLIST, and
// it is the whole security boundary of the keys route: the text view answers
// blocking prompts by typing (ADR-0010), and a pane accepts anything a keyboard
// can produce, so the set is exactly the keys an answer is made of.
//
// C-c is deliberately absent — interrupting is Cancel's job, which also owns the
// @claude_state transition that an interrupt implies (ADR-0001). Letters are
// limited to the y/n a yes-no prompt wants; free text goes through Prompt, where
// it is bracketed-pasted rather than typed as keystrokes.
var answerKeys = map[string]bool{
	"1": true, "2": true, "3": true, "4": true, "5": true,
	"6": true, "7": true, "8": true, "9": true,
	"y": true, "n": true, "Y": true, "N": true,
	"Enter": true, "Escape": true, "Space": true, "Tab": true, "BTab": true,
	"Up": true, "Down": true, "Left": true, "Right": true,
}

// Keys types an answer into the session's pane — the downward half of ADR-0010,
// where the text view mirrors a blocking prompt and sends back what a person
// would have pressed.
//
// Every key is checked against answerKeys BEFORE anything is sent, so a batch
// carrying one bad key sends nothing at all rather than half an answer.
func (in *Injector) Keys(osUser, session string, keys []string) error {
	if len(keys) == 0 {
		return fmt.Errorf("keys: nothing to send")
	}
	if len(keys) > MaxKeys {
		return fmt.Errorf("keys: %d keys exceeds the %d allowed in one answer", len(keys), MaxKeys)
	}
	for _, k := range keys {
		if !answerKeys[k] {
			return fmt.Errorf("keys: %q is not an answer key", k)
		}
	}
	args := append([]string{"send-keys", "-t", exactPane(session)}, keys...)
	return in.Command(osUser, args...).Run()
}

// Reading the pane back — how the text view sees a permission dialog, which the
// transcript does not report while it is pending — is CapturePane in ready.go,
// which already existed for the resurrection readiness check. ADR-0001 rejected
// pane sniffing for session STATE, where it meant a fork per session per
// refresh to infer something a hook reports reliably; reading one pane on
// demand, for a session already known to be waiting on a human, is a different
// trade.

// State returns the @claude_state option value (running/awaiting/done/"") for
// the session, used to gate prompt injection. Empty on any error (fail-open to
// allow).
func (in *Injector) State(osUser, session string) string {
	v, _ := in.Option(osUser, session, OptionState)
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
	out, err := in.Command(osUser, "display-message", "-p", "-t", exactPane(session),
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
	return in.Command(osUser, "set-option", "-t", exactPane(session), name, value).Run()
}

// HasSession reports whether the named session is live on this user's tmux
// server. It leans on the same self-validating read as Option rather than
// `has-session`, because that is the check whose behaviour against a missing
// target has actually been measured here (see Option).
func (in *Injector) HasSession(osUser, session string) bool {
	_, ok := in.Option(osUser, session, "session_name")
	return ok
}

// TmuxSession is one live session as tmux reports it.
type TmuxSession struct {
	Name string
	// Dir is the session's working directory (#{session_path}) — tmux's own
	// notion, which is where a new window would start, not necessarily where a
	// long-running Claude has cd'd to. Treat it as the filing hint it is.
	Dir string
}

// ListSessions returns the live sessions on the user's tmux server.
//
// No server at all is not an error — a user with nothing open is an ordinary
// state, and the syncer must not report it as broken tmux. `list-sessions`
// exits 1 in that case with one of two messages depending on how the connect
// failed (both measured on tmux 3.4): "no server running on <socket>" when the
// socket exists but the server is gone, and "error connecting to <socket> (No
// such file or directory)" when it never existed.
func (in *Injector) ListSessions(osUser string) ([]TmuxSession, error) {
	out, err := in.Command(osUser, "list-sessions", "-F", "#{session_name}\t#{session_path}").Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && noServer(string(ee.Stderr)) {
			return nil, nil
		}
		return nil, err
	}
	var sessions []TmuxSession
	for _, line := range strings.Split(strings.TrimSuffix(string(out), "\n"), "\n") {
		if line == "" {
			continue
		}
		name, dir, _ := strings.Cut(line, "\t")
		sessions = append(sessions, TmuxSession{Name: name, Dir: dir})
	}
	return sessions, nil
}

// noServer reports whether tmux's stderr means "there is no server here",
// which is an empty list rather than a fault. See ListSessions.
func noServer(stderr string) bool {
	return strings.Contains(stderr, "no server running") ||
		strings.Contains(stderr, "error connecting to")
}

// NewSessionSpec describes a detached session to create.
type NewSessionSpec struct {
	OSUser string
	Name   string // tmux session name
	Dir    string // the session's working directory (-c)
	// Command is the argv to run in the session. Empty starts the user's login
	// shell, which is what a plain lobby session is.
	Command []string
	// Env is set on the new session's environment (-e). Claude reads several
	// of these at startup, so they cannot be exported after the fact.
	Env map[string]string
}

// NewSession creates a detached tmux session. It fails when the name is already
// taken — tmux refuses a duplicate, and so must we: silently attaching to
// somebody else's session under the same name is how a resurrection would end
// up pasting into a live conversation.
func (in *Injector) NewSession(spec NewSessionSpec) error {
	if spec.Name == "" {
		return fmt.Errorf("new-session: empty session name")
	}
	args := []string{"new-session", "-d", "-s", spec.Name}
	if spec.Dir != "" {
		args = append(args, "-c", spec.Dir)
	}
	for k, v := range spec.Env {
		args = append(args, "-e", k+"="+v)
	}
	if len(spec.Command) > 0 {
		args = append(args, spec.Command...)
	}
	out, err := in.Command(spec.OSUser, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("new-session %s: %v: %s", spec.Name, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// KillSession destroys a session and everything running in it.
//
// This is the only irreversible verb in the package. It exists because a
// deliberate destruction crosses surfaces — deleting a bridged thread in T3
// kills the tmux session (design decision 3) — and for no other reason. A
// process merely exiting is not a kill and must not reach here.
func (in *Injector) KillSession(osUser, session string) error {
	out, err := in.Command(osUser, "kill-session", "-t", exactSession(session)).CombinedOutput()
	if err != nil {
		return fmt.Errorf("kill-session %s: %v: %s", session, err, strings.TrimSpace(string(out)))
	}
	return nil
}
