package main

// The sessionio boundary.
//
// Everything agent-api does to a conversation happens through Sessions. There
// is one production implementation, tmuxSessions, and it is a thin adapter over
// sessionio.Injector — no logic of its own beyond the tmux invocation for the
// one verb sessionio does not wrap.
//
// The interface exists for one reason: a unit test must never drive a real tmux
// server. Every session on this box is somebody's live conversation, and a test
// that pasted into one would be indistinguishable from a bug. So the tests use
// fakeSessions (sessions_fake_test.go) and the handlers never learn the
// difference.

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"terminal-lobby/sessionio"
)

// OptionOwner records WHICH CALLER created a conversation. agent-api stamps it
// once at creation with the credential's name and never rewrites it; a session
// started by a person from the lobby carries no stamp at all, which is how the
// read side tells the two apart.
//
// It is a tmux session option for the same reason @claude_transcript is one
// (sessionio.SessionMap): the lifetime that matters belongs to the session, not
// to any process. It survives every restart of this service, so a redeploy does
// not hand one caller write access to another's conversations, and it dies with
// the session, so a reused tmux name never inherits the dead conversation's
// owner.
//
// What it is NOT: a security boundary. The worker runs as the session's own OS
// user and can rewrite any option on it, which the design doc already records
// as an accepted risk. It stops one caller from walking into another's
// conversation by accident or by guessing an id; it does not stop a caller that
// has decided to.
const OptionOwner = "@agent_owner"

// OptionSuspended is tmux-api's mark, and the one option here this service
// only READS. Its presence means the idle sweep killed the Claude in that
// session and froze the pane, keeping everything needed to bring it back
// (tmux-api/suspend.go).
//
// It matters to this API because a suspended conversation has no Claude to
// take a message: `paste-buffer` into a dead pane answers "target pane has
// exited", and into a pane whose wrapper shell survived it types the message
// at a bash prompt. Either way the turn does not happen, so a conversation
// wearing this mark reports its own state rather than the `done` its last
// Claude left behind, and refuses writes.
//
// tmux-api does not suspend a session carrying OptionOwner, so in the ordinary
// run of things no conversation of this API's ever wears it. This is what
// answers honestly if one does — a mark set by hand, or by a tmux-api older
// than that exclusion.
const OptionSuspended = sessionio.OptionSuspended

// LiveSession is one tmux session as agent-api needs to see it: the name, and
// the four options that answer every question the conversation endpoints ask.
// Read in one `list-sessions` rather than one option read per field, because
// the read side is polled and each read is a sudo fork.
type LiveSession struct {
	Name string
	// Dir is tmux's own session_path — where a new window would start, not
	// necessarily where the Claude inside has cd'd to. A filing hint.
	Dir string
	// State is @claude_state: running, awaiting, done, or "" for a session no
	// Claude ever ran in.
	State string
	// Owner is @agent_owner: the credential that created this conversation
	// through agent-api, or "" for one a person started.
	Owner string
	// Transcript is @claude_transcript: the absolute path of the .jsonl the
	// session's Claude is writing, or "" before the SessionStart hook stamps
	// it.
	Transcript string
	// Title is @title, the display name a person chose in the lobby.
	Title string
	// Suspended is @tl_suspended: the idle sweep killed the Claude that was in
	// this session and left the pane frozen (OptionSuspended).
	Suspended bool
	// BornAs is @tl_born: the name the session was CREATED with.
	//
	// It is what makes a conversation id survive, and it is not decoration.
	// tmux-api renames a session from the content of its first turn (ADR-0022)
	// — measured on this box 2026-09-16, three sessions this service created
	// were renamed 5 to 20 seconds after their first prompt, "tl2-live"
	// becoming "pong-response". A caller holding the id it was given would
	// have got 404 on its second message, and a turn longer than that delay
	// would have been reported as a session that vanished mid-flight.
	BornAs string
}

// ID is the conversation id this session is addressed by: the name it was
// born with, which does not move, falling back to the live tmux name for a
// session nobody stamped.
func (l LiveSession) ID() string {
	if l.BornAs != "" {
		return l.BornAs
	}
	return l.Name
}

// CreateSpec is a new detached session.
type CreateSpec struct {
	OSUser  string
	Name    string
	Dir     string
	Command []string
	// Origin names whoever asked for this session, and it is the caller's
	// CREDENTIAL, not this service. The lobby files anything that is not
	// "user" under System, so this is what keeps a conversation an agent
	// opened out of the list of sessions the owner opened themselves.
	Origin string
}

// Sessions is everything agent-api asks of tmux and the transcripts beside it.
type Sessions interface {
	// List reports the live sessions on one OS user's tmux server. A user with
	// no tmux server at all is an empty list, not an error.
	List(osUser string) ([]LiveSession, error)
	// Create starts a detached session. It fails when the name is taken.
	Create(spec CreateSpec) error
	// Prompt submits text to the session's input line.
	Prompt(osUser, session, text string) error

	// PromptUncleared is Prompt without the line-clearing prelude, for a
	// pane that has not drawn its prompt yet and so cannot interpret it.
	PromptUncleared(osUser, session, text string) error
	// Cancel interrupts the turn in flight.
	Cancel(osUser, session string) error
	// Option reads one tmux session option; ok=false means the read did not
	// land on the session asked for.
	Option(osUser, session, name string) (string, bool)
	// SetOption stamps one. It fails when the session is gone.
	SetOption(osUser, session, name, value string) error
	// TranscriptLines returns the session's transcript as raw JSONL lines. An
	// unstamped session, or one whose stamp points outside the user's own
	// projects root, is an error rather than an empty history — the two mean
	// different things to a caller deciding whether a turn produced anything.
	TranscriptLines(osUser, session string) ([][]byte, error)
	// Pane returns the visible text of the session's active pane, which is
	// where a pending permission dialog lives. The transcript does not carry
	// one while it is still on screen.
	Pane(osUser, session string) (string, error)
	// WaitReady blocks until the session's harness is drawn, showing a
	// prompt, and has stopped changing — or gives up and says so.
	//
	// Skipping it does not lose a prompt outright, which would be easier to
	// notice. sessionio measured the real failure on 2026-08-16: the
	// bracketed paste survives and lands on the input line intact, and the
	// Enter that should submit it does not, so the turn never runs and the
	// conversation shows a message the agent never saw.
	WaitReady(osUser, session string, wait, poll time.Duration) error
}

// errNoTranscript — the session has no transcript to read yet.
var errNoTranscript = errors.New("session has no transcript")

// transcriptReadError classifies a failure to read a stamped transcript.
//
// A file that is not there is NOT a fault, and treating it as one was a real
// bug: measured on this box 2026-09-16, 7 of 25 stamped sessions pointed at a
// path with no file behind it, and the transcript route answered 500 for
// every one of them. Two ordinary situations produce it. A session created a
// moment ago is stamped by the SessionStart hook before Claude has written
// its first line. And a session whose Claude cd'd and re-registered stamps a
// path derived from the wrong directory, which sessionio.SessionMap.Put
// documents having measured at 2 of 16 sessions.
//
// Either way the answer to the caller is the same as an unstamped session:
// there is nothing to read. Anything else — a permission error, a bad disk —
// is a genuine fault and keeps its own error, because those are worth a 500
// and worth an operator looking.
func transcriptReadError(path string, err error) error {
	if errors.Is(err, fs.ErrNotExist) {
		return errNoTranscript
	}
	return fmt.Errorf("read %s: %w", filepath.Base(path), err)
}

// tmuxSessions is the production Sessions: sessionio over the real tmux server.
type tmuxSessions struct {
	in *sessionio.Injector
	// homeBase is the parent of every user's home, "/home" in production and a
	// temp dir in the tests that exercise path containment.
	homeBase string
	// options is the tmux option store SessionMap reads the transcript stamp
	// through. Nil means the injector, which is production; a test supplies
	// its own so the containment rule can be exercised against real files
	// without a tmux server anywhere.
	options sessionio.Options
}

// optionStore is the seam above, resolved.
func (t *tmuxSessions) optionStore() sessionio.Options {
	if t.options != nil {
		return t.options
	}
	return t.in
}

// listFormat is the one tmux read the list endpoint makes. Every field this
// service needs, tab-separated, in one fork rather than four per session: with
// 36 live sessions the per-option version costs 144 `sudo -u … tmux` execs on
// a route Muse polls.
var listFields = []string{
	"#{session_name}",
	"#{session_path}",
	"#{" + sessionio.OptionState + "}",
	"#{" + OptionOwner + "}",
	"#{" + sessionio.OptionTranscript + "}",
	"#{" + sessionio.OptionTitle + "}",
	"#{" + sessionio.OptionBornAs + "}",
	"#{" + OptionSuspended + "}",
}

func (t *tmuxSessions) List(osUser string) ([]LiveSession, error) {
	out, err := t.in.Command(osUser, "list-sessions", "-F", strings.Join(listFields, "\t")).Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && noTmuxServer(string(ee.Stderr)) {
			return nil, nil
		}
		return nil, fmt.Errorf("list-sessions: %w", err)
	}
	return parseLiveSessions(out), nil
}

// parseLiveSessions decodes the listFormat rows. Separate from List so the
// column order can be tested without a tmux server: a field read from the
// wrong index is invisible until something reports the wrong answer about a
// live conversation.
//
// A row shorter than the format is PADDED rather than dropped — a tmux that
// renders an unset option as nothing at the end of a line would otherwise
// take the whole session out of the list.
func parseLiveSessions(out []byte) []LiveSession {
	var live []LiveSession
	for _, line := range strings.Split(strings.TrimSuffix(string(out), "\n"), "\n") {
		if line == "" {
			continue
		}
		f := strings.Split(line, "\t")
		for len(f) < len(listFields) {
			f = append(f, "")
		}
		live = append(live, LiveSession{
			Name:       f[0],
			Dir:        f[1],
			State:      strings.TrimSpace(f[2]),
			Owner:      strings.TrimSpace(f[3]),
			Transcript: strings.TrimSpace(f[4]),
			Title:      f[5],
			BornAs:     strings.TrimSpace(f[6]),
			// Read as PRESENCE, not as a time: the mark is a unix second, an
			// unset option renders empty, and anything else in there still
			// means a sweep put it on.
			Suspended: strings.TrimSpace(f[7]) != "",
		})
	}
	return live
}

// noTmuxServer reports whether tmux's stderr means "there is no server here",
// which is an empty list rather than a fault. The two messages are the ones
// sessionio.ListSessions documents having measured on tmux 3.4; this call uses
// its own format string, so it cannot go through that method and repeats the
// tolerance instead.
func noTmuxServer(stderr string) bool {
	return strings.Contains(stderr, "no server running") ||
		strings.Contains(stderr, "error connecting to")
}

func (t *tmuxSessions) Create(spec CreateSpec) error {
	// Origin is the CREDENTIAL's name, not a constant: the lobby files
	// anything that is not OriginUser under System, so this is what keeps a
	// conversation an agent opened out of the owner's own list, and naming the
	// caller rather than "agent-api" means two external callers stay apart.
	// Empty would silently read as a person having made it.
	origin := spec.Origin
	if origin == "" {
		origin = "agent-api"
	}
	return t.in.NewSession(sessionio.NewSessionSpec{
		OSUser:  spec.OSUser,
		Name:    spec.Name,
		Dir:     spec.Dir,
		Command: spec.Command,
		Origin:  origin,
	})
}

func (t *tmuxSessions) Prompt(osUser, session, text string) error {
	return t.in.Prompt(osUser, session, text)
}

func (t *tmuxSessions) PromptUncleared(osUser, session, text string) error {
	return t.in.PromptUncleared(osUser, session, text)
}

func (t *tmuxSessions) Cancel(osUser, session string) error {
	return t.in.Cancel(osUser, session)
}

func (t *tmuxSessions) Option(osUser, session, name string) (string, bool) {
	return t.in.Option(osUser, session, name)
}

func (t *tmuxSessions) SetOption(osUser, session, name, value string) error {
	return t.in.SetOption(osUser, session, name, value)
}

func (t *tmuxSessions) Pane(osUser, session string) (string, error) {
	return t.in.CapturePane(osUser, session)
}

func (t *tmuxSessions) WaitReady(osUser, session string, wait, poll time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), wait+poll)
	defer cancel()
	return t.in.AwaitInputReady(ctx, osUser, session, wait, poll)
}

// TranscriptLines reads the session's transcript through sessionio.SessionMap,
// which is what applies the containment rule: the stamp is written by the
// session's own OS user, so it is untrusted input, and only a .jsonl inside
// that user's own projects root is opened.
func (t *tmuxSessions) TranscriptLines(osUser, session string) ([][]byte, error) {
	root := sessionio.ProjectsRoot(t.homeBase, osUser)
	info, ok := sessionio.NewSessionMap(osUser, root, t.optionStore()).Get(session)
	if !ok {
		return nil, errNoTranscript
	}
	lines, _, err := sessionio.ReadFrom(info.Transcript, 0)
	if err != nil {
		return nil, transcriptReadError(info.Transcript, err)
	}
	out := make([][]byte, 0, len(lines))
	for _, l := range lines {
		out = append(out, []byte(l))
	}
	return out, nil
}
