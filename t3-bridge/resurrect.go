package main

import (
	"fmt"
	"strings"
	"time"

	"terminal-lobby/sessionio"
)

// Recreating a session that is gone, and creating the one a T3-born thread
// needs. Both end the same way: a detached tmux session with exactly one claude
// process in it, writing the transcript the bridge is about to tail.
//
// "Dead and back" is the normal case on this box — earlyoom fired 34 times in
// one day — so resurrection is silent (decision 10). It is also what lets the
// 386 threads that already exist need no migration: resuming one makes it
// tmux-backed.

// Resurrector creates tmux sessions for threads whose session is missing.
type Resurrector struct {
	// OSUser owns the session; the bridge runs as them already.
	OSUser string
	// Tmux is the session driver. It is TmuxDriver rather than the concrete
	// *sessionio.Injector (which satisfies it) for the reason attach.go gives:
	// the interface has no KillSession, so nothing on this path can destroy a
	// session even by accident.
	Tmux TmuxDriver
	// ClaudeBin is the real claude, from RealClaudePath.
	ClaudeBin string
	// Bindings records the new tmux name against the uuid, so the NEXT death
	// can be recovered from too.
	Bindings *Bindings

	// wait bounds how long the stamp is waited for, and poll how often it is
	// re-read. Both are unexported with sane zero-value defaults: production has
	// no reason to tune them and tests need them short.
	wait time.Duration
	poll time.Duration
}

// ResurrectSpec is one recreation.
type ResurrectSpec struct {
	// ClaudeID is the conversation to bring back. It becomes `claude --resume
	// <id>` for an existing conversation, or `claude --session-id <id>` for a
	// thread T3 has just created (verified fact: T3 assigns the id itself, so
	// the two sides agree from the first message).
	ClaudeID string
	// Resume distinguishes the two: true resumes an existing transcript.
	Resume bool
	// TmuxName is the session name to create. For a resurrection it comes from
	// the binding index — the one fact that does not survive in tmux. For a
	// T3-born thread it is Slug(thread title).
	TmuxName string
	// CWD is the session's working directory.
	CWD string
	// MCPConfig is T3's --mcp-config, passed straight through so a session the
	// bridge launches keeps T3's own tools. A session adopted mid-flight cannot
	// have them (--mcp-config is launch-only), which the design accepts.
	MCPConfig string
	// ExtraArgs are further claude flags to carry over from T3's argv
	// (--model, --permission-mode, --add-dir, …).
	ExtraArgs []string
}

// resurrectWait is how long claude gets to come up and have its transcript
// stamped. It is generous because the stamp travels the long way round — the
// SessionStart hook POSTs to session-events, which sets the tmux option — and
// because the alternative to waiting is a thread bound to no transcript at all.
const resurrectWait = 45 * time.Second

// resurrectPoll is how often the stamp is re-read while waiting. Fast enough
// that a normal start costs no visible delay, slow enough to be nothing on a
// loaded box: this is one `tmux show-options` per tick.
const resurrectPoll = 250 * time.Millisecond

// Resurrect creates the tmux session and starts claude inside it, returning the
// target the attacher should bind to.
//
// Two things it gets right on purpose:
//
//   - The name must be free. NewSession fails on a duplicate, and rather than
//     surface that as an error the resurrection moves to the first free variant:
//     the alternative — attaching to whatever else holds the name — would paste
//     this thread's prompts into somebody else's conversation.
//   - The transcript does not exist the moment claude starts. The stamp is
//     waited for rather than derived, so the binding comes from the same source
//     every other reader in the lobby uses (sessionio.SessionMap), and a stamp
//     naming a different conversation is not accepted at all.
func (r *Resurrector) Resurrect(spec ResurrectSpec) (Target, error) {
	if spec.ClaudeID == "" {
		return Target{}, fmt.Errorf("resurrect: no claude session id")
	}
	if spec.TmuxName == "" {
		return Target{}, fmt.Errorf("resurrect %s: no tmux session name", spec.ClaudeID)
	}
	if spec.CWD == "" {
		return Target{}, fmt.Errorf("resurrect %s: no working directory", spec.ClaudeID)
	}
	if r.ClaudeBin == "" {
		return Target{}, fmt.Errorf("resurrect %s: no claude binary to run", spec.ClaudeID)
	}

	live, err := r.Tmux.ListSessions(r.OSUser)
	if err != nil {
		return Target{}, fmt.Errorf("resurrect %s: %w", spec.ClaudeID, err)
	}
	taken := make(map[string]bool, len(live))
	for _, s := range live {
		taken[s.Name] = true
	}
	name := resurrectFreeName(spec.TmuxName, taken)

	if err := r.Tmux.NewSession(sessionio.NewSessionSpec{
		OSUser:  r.OSUser,
		Name:    name,
		Dir:     spec.CWD,
		Command: []string{resurrectCommandLine(r.ClaudeBin, spec)},
	}); err != nil {
		return Target{}, fmt.Errorf("resurrect %s: %w", spec.ClaudeID, err)
	}

	transcript, err := r.awaitStamp(name, spec.ClaudeID)
	if err != nil {
		// The session is left exactly as it is. It may still be coming up, and
		// the bridge is a detached client that never destroys a session
		// (decision 3) — the operator can see it in the lobby either way.
		return Target{}, err
	}

	target := Target{
		ClaudeID:   spec.ClaudeID,
		TmuxName:   name,
		CWD:        spec.CWD,
		Transcript: transcript,
	}
	if r.Bindings != nil {
		if err := r.Bindings.Record(target); err != nil {
			return Target{}, fmt.Errorf("resurrect %s: %w", spec.ClaudeID, err)
		}
	}
	return target, nil
}

// awaitStamp waits for the SessionStart hook to record which transcript this
// session's claude is writing.
//
// A stamp for another conversation is treated as no stamp: it means the name
// was reused, and mirroring that transcript would put somebody else's
// conversation into this thread.
func (r *Resurrector) awaitStamp(name, claudeID string) (string, error) {
	wait, poll := r.wait, r.poll
	if wait <= 0 {
		wait = resurrectWait
	}
	if poll <= 0 {
		poll = resurrectPoll
	}
	deadline := time.Now().Add(wait)
	for {
		stamp, ok := r.Tmux.Option(r.OSUser, name, sessionio.OptionTranscript)
		if ok && stamp != "" && sessionio.ClaudeIDFromTranscript(stamp) == claudeID {
			return stamp, nil
		}
		if !time.Now().Before(deadline) {
			return "", fmt.Errorf(
				"resurrect %s: no %s naming this conversation appeared on session %s within %s (is session-events running?)",
				claudeID, sessionio.OptionTranscript, name, wait)
		}
		time.Sleep(poll)
	}
}

// resurrectCommandLine builds the shell line tmux runs in the new session.
//
// It is ONE already-quoted string rather than an argv. tmux's new-session takes
// a shell-command, and several arguments are joined with spaces and handed to
// /bin/sh — so an unquoted --mcp-config payload (JSON: braces, quotes, commas)
// would arrive at claude as a dozen arguments and the session would die on
// startup. Quoting here and passing one element makes the two behaviours
// identical.
func resurrectCommandLine(bin string, spec ResurrectSpec) string {
	args := []string{bin}
	if spec.Resume {
		args = append(args, "--resume", spec.ClaudeID)
	} else {
		args = append(args, "--session-id", spec.ClaudeID)
	}
	if spec.MCPConfig != "" {
		args = append(args, "--mcp-config", spec.MCPConfig)
	}
	args = append(args, spec.ExtraArgs...)

	quoted := make([]string, 0, len(args))
	for _, a := range args {
		quoted = append(quoted, resurrectQuote(a))
	}
	return strings.Join(quoted, " ")
}

// resurrectQuote makes one argument safe for /bin/sh.
//
// Single quotes, because inside them the shell interprets nothing at all; the
// only escape needed is for a single quote itself, which ends the run, is
// backslash-escaped outside it, and starts a new one.
func resurrectQuote(arg string) string {
	if arg != "" && strings.IndexFunc(arg, func(r rune) bool {
		return !resurrectShellSafe(r)
	}) < 0 {
		return arg
	}
	return "'" + strings.ReplaceAll(arg, "'", `'\''`) + "'"
}

// resurrectShellSafe reports whether a rune needs no quoting. The set is
// deliberately conservative: anything not obviously inert gets quotes.
func resurrectShellSafe(r rune) bool {
	switch {
	case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		return true
	}
	return strings.ContainsRune("-_./:=@+,", r)
}

// Slug turns a T3 thread title into a tmux session name.
//
// tmux names are the constraint: 32 characters of [A-Za-z0-9_-]. That squeezes
// T3's descriptive titles hard, and it is the accepted cost of decision 7 —
// one name, tmux wins, so both lists read as the same sessions.
//
// Case is kept. The lobby's own session names are mixed-case and the two lists
// are meant to read as the same sessions, so lowercasing here would make every
// T3-born session look like it came from somewhere else.
func Slug(title string) string {
	var b strings.Builder
	dash := false // collapses a run of unusable characters into one dash
	for _, r := range strings.TrimSpace(title) {
		if resurrectNameRune(r) {
			b.WriteRune(r)
			dash = false
			continue
		}
		if !dash && b.Len() > 0 {
			b.WriteByte('-')
			dash = true
		}
	}
	name := strings.Trim(b.String(), "-")
	if len(name) > MaxTmuxNameLen {
		name = strings.TrimRight(name[:MaxTmuxNameLen], "-")
	}
	if name == "" {
		// Every caller is about to create a session, and a session cannot be
		// created under an empty name. A legible placeholder beats an error the
		// caller can only turn into the same placeholder.
		return resurrectFallbackName
	}
	return name
}

// resurrectNameRune reports whether a rune may appear in a tmux session name.
// The set matches tmux-api's own validation (^[a-zA-Z0-9_-]{1,32}$), so a name
// the bridge creates can always be renamed and killed through the lobby.
func resurrectNameRune(r rune) bool {
	switch {
	case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		return true
	}
	return r == '_' || r == '-'
}

// resurrectFallbackName is what a title with nothing usable in it becomes.
const resurrectFallbackName = "claude"

// resurrectFreeName returns base, or the first free `base-N` variant.
//
// The suffix has to fit the same 32-character budget, so a base at the limit is
// cut to make room. Ten variants is the ceiling before it gives up and returns
// the last try: at that point the collision is not a coincidence, and
// NewSession's own duplicate check is the backstop.
func resurrectFreeName(base string, taken map[string]bool) string {
	if !taken[base] {
		return base
	}
	name := base
	for n := 2; n < 12; n++ {
		suffix := fmt.Sprintf("-%d", n)
		trimmed := base
		if len(trimmed)+len(suffix) > MaxTmuxNameLen {
			trimmed = strings.TrimRight(base[:MaxTmuxNameLen-len(suffix)], "-")
		}
		name = trimmed + suffix
		if !taken[name] {
			return name
		}
	}
	return name
}

// MaxTmuxNameLen is the character budget a slugged title has to fit.
const MaxTmuxNameLen = 32
