package sessionio

import (
	"errors"
	"fmt"
	"log"
	"os/exec"
	"regexp"
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
	// OptionBackground holds the session's OUTSTANDING WORK: space-separated
	// `<kind>:<id>` tokens for background tasks the main thread launched and
	// that have not reported back, kind being `a` (agent), `b` (background
	// command) or `w` (workflow). Written by the same hook script as
	// OptionState, which adds a token when a launch returns `async_launched`
	// and removes it when that id's task-notification arrives.
	//
	// It exists because Stop is not the end of a turn's work: it fires the
	// moment the main thread stops talking, while a background agent it
	// launched keeps going (measured 2026-09-04 — Stop 2m16s before the agent
	// finished). A session with a non-empty set stays StateRunning, which is
	// what every consumer of OptionState already reads correctly. Design:
	// docs/plans/2026-09-04-background-work-session-state-design.md.
	OptionBackground = "@claude_bg"
	// OptionOrigin says what created the session: "user" when a person asked
	// for it, absent when nothing said. terminal-lobby's tmux-api reads it to
	// decide whether a session belongs in somebody's list or in the System
	// group, and a session with no origin is treated as system — so anything
	// here that creates a session on a PERSON's behalf has to stamp it, or
	// their work is filed away as tooling's. See NewSession.
	OptionOrigin = "@tl_origin"
	// OriginUser is the only value this package writes. A harness stamps
	// "test" on its own sessions; that is not this package's job.
	OriginUser = "user"
	// OptionThread holds the T3 thread id a session is mirrored into. Written
	// by the syncer at adoption; dies with the session, which is deliberate —
	// a resurrected session re-derives it from the durable Index instead.
	OptionThread = "@t3_thread"
	// OptionTitle holds the DISPLAY TITLE a person chose for the session —
	// arbitrary text, up to 64 runes, which the lobby shows in place of the
	// tmux name. Written by tmux-api; unset for a session nobody has titled,
	// which is most of them. Like the others it dies with the session, so
	// tmux-api keeps a durable copy to re-stamp after a restore.
	OptionTitle = "@title"
	// OptionBornAs holds the name a session was FIRST created with, written
	// once by the first rename that moves it (tmux-api carryRenameAcrossStores)
	// and never again.
	//
	// It exists because a rename is invisible to a client that never saw the
	// old name. ADR-0022 renames a fresh session as soon as its first title
	// lands — seconds in — and the lobby's session list is behind a 5-second
	// cache, so a poll can easily miss the window in which the session was
	// still called the id the browser minted for it. tmux's own session_id
	// survives a rename and is what the lobby normally follows, but a client
	// that never saw the session cannot know its id either, and is left holding
	// a name nothing answers to: its terminal reconnects through `tmux
	// new-session -A` and resurrects that name as an empty session.
	//
	// One name, not a history: the tab at risk is holding the name the session
	// was CREATED with, and every later rename is one the lobby watched happen.
	OptionBornAs = "@tl_born"
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
	// Binary and Sudo let a caller that already pins its own absolute paths
	// hand them over rather than rebuild the sudo rule around them — tmux-api
	// keeps both as package vars its tests swap for stubs. Empty means this
	// package's own defaults, which is every other caller.
	Binary string
	Sudo   string
}

// binary and sudo resolve the two programs a call runs: the caller's pins when
// it set them, this package's absolute defaults otherwise.
func (in *Injector) binary() string {
	if in.Binary != "" {
		return in.Binary
	}
	return tmuxBinary
}

func (in *Injector) sudo() string {
	if in.Sudo != "" {
		return in.Sudo
	}
	return sudoBinary
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

// tmuxBinary and sudoBinary are absolute so a privileged call cannot be pointed
// at a different program by whatever PATH the unit happens to inherit. tmux-api
// and file-api pin theirs for the same reason. Vars, not constants, only as a
// test seam; nothing in production reassigns them.
var (
	tmuxBinary = "/usr/bin/tmux"
	sudoBinary = "/usr/bin/sudo"
)

// optionNameRe is the charset a tmux option name may use. Option interpolates
// the name into a tmux FORMAT string, where #{...} is a directive rather than
// inert text: measured on tmux 3.4, a name of `}#{pane_current_command}#{`
// makes display-message print the pane's command, and a name carrying a newline
// forges the second line Option validates itself against. (`#(...)`, the job
// syntax, did NOT run under `display-message -p` on 3.4 — a format job needs a
// client context — so the charset is bounded for what was measured, not for a
// command execution this call can reach.) Every caller passes a package
// constant today; the guard is what keeps that true.
var optionNameRe = regexp.MustCompile(`^[A-Za-z0-9_@-]+$`)

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
		return exec.Command(in.binary(), full...)
	}
	return exec.Command(in.sudo(), append([]string{"-n", "-u", osUser, in.binary()}, full...)...)
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
//
// OptionBackground goes with it, for the same reason and by the same right: an
// interrupt ends the turn, and a task the interrupted turn launched will never
// report back into it. Left behind, the id holds the session at StateRunning
// with no hook able to retire it, which is the one way a set with no expiry can
// latch (docs/plans/2026-09-04-background-work-session-state-design.md).
func (in *Injector) Cancel(osUser, session string) error {
	if err := in.Command(osUser, "send-keys", "-t", exactPane(session), "C-c").Run(); err != nil {
		return err
	}
	if in.State(osUser, session) == "" {
		return nil
	}
	if err := in.Command(osUser, "set-option", "-u", "-t", exactPane(session), OptionBackground).Run(); err != nil {
		log.Printf("cancel %s/%s: clearing %s failed: %v", osUser, session, OptionBackground, err)
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

// MaxAnswerText bounds the free text of one answer. The AskUserQuestion dialog's
// "Other" option is a single-line field, so this is generous for what it is; the
// cap exists because the target is somebody's live pane.
const MaxAnswerText = 2000

// AnswerText types free text into the session's pane WITHOUT submitting it.
//
// It exists because neither of the other two routes can answer the "Other"
// option of an AskUserQuestion:
//
//   - Keys cannot, by design. answerKeys carries no letters beyond y/n, and that
//     allowlist is the whole security boundary of the keys route — widening it
//     to spell words would turn it into an arbitrary-typing channel.
//   - Prompt cannot, safely. It opens with C-e C-u to clear whatever the pane
//     was holding and closes with an unconditional Enter. Inside a dialog's
//     text field that prelude is unverified, and the forced Enter submits before
//     the caller can read the pane back to confirm the text landed — which is
//     the check the answer sequence is built on.
//
// So this does the one thing needed and stops: put the text in the buffer,
// bracketed-paste it, and leave the Enter to the caller as its own verified
// step. Bracketed paste also means the terminal treats the text as data rather
// than as keystrokes, so a control character in it cannot become an action.
//
// A newline is refused rather than stripped: it would submit the field halfway
// through the answer, and silently sending a different answer than the one asked
// for is worse than refusing.
func (in *Injector) AnswerText(osUser, session, text string) error {
	if strings.TrimSpace(text) == "" {
		return fmt.Errorf("answer text: nothing to type")
	}
	if len(text) > MaxAnswerText {
		return fmt.Errorf("answer text: %d bytes exceeds the %d allowed", len(text), MaxAnswerText)
	}
	if strings.ContainsAny(text, "\r\n") {
		return fmt.Errorf("answer text: a line break would submit the field mid-answer")
	}
	if err := in.Command(osUser, "set-buffer", "--", text).Run(); err != nil {
		return err
	}
	// -p = bracketed paste, -d = delete the buffer afterwards. No Enter.
	return in.Command(osUser, "paste-buffer", "-p", "-d", "-t", exactPane(session)).Run()
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
	if !optionNameRe.MatchString(name) {
		return "", false
	}
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
//
// The `--` is defence in depth rather than a fix for a live bug: tmux 3.4 takes
// the positional after the name as the value however it looks (measured —
// `set-option -t demo @t3_thread -g` exits 0 and stores "-g"). The marker pins
// that independently of the tmux version and of any flag a later set-option
// grows, and it is asserted on the argv, because a value round-trips either way.
func (in *Injector) SetOption(osUser, session, name, value string) error {
	if !optionNameRe.MatchString(name) {
		return fmt.Errorf("sessionio: %q is not a tmux option name", name)
	}
	return in.Command(osUser, "set-option", "-t", exactPane(session), "--", name, value).Run()
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
	// Say who this is for. The only caller is t3-bridge resurrecting a thread
	// somebody opened in T3 (resurrect.go), so the answer is always "a person" —
	// the bridge is the mechanism, not the reason. Without the stamp the session
	// reads as unattributed, which files a live conversation into the System
	// group, stops its completions reaching a phone, and keeps it out of every
	// tmux-persist snapshot so a reboot loses it.
	//
	//
	// A failure here IS returned, and the message says the session was created,
	// because the two failures need telling apart. NewSession's other error
	// means nothing exists and a retry is the right move; this one means the
	// session is up and only its label is missing, and a caller that retried
	// would hit the duplicate-name refusal this function documents above.
	// Through SetOption rather than a hand-built set-option: its target form is
	// exactPane, and set-option is the one verb that will not take the bare
	// `=name` exactSession form the rest of this package uses. Measured here on
	// tmux 3.4 — `set-option -t =name` answers "no such session: =name" for a
	// session that plainly exists.
	if oerr := in.SetOption(spec.OSUser, spec.Name, OptionOrigin, OriginUser); oerr != nil {
		return fmt.Errorf("new-session %s: session created but stamping %s failed: %w",
			spec.Name, OptionOrigin, oerr)
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
