package sessionio

// Bringing a suspended session back: the one sequence every caller shares.
//
// tmux-api suspends a session nobody has used for a while (tmux-api/suspend.go)
// and serves the click that brings it back. agent-api brings back a Caller's
// conversation when the Caller sends it a message. Both have to do exactly the
// same thing, in exactly the same order, because the step at the heart of it,
// `respawn-pane -k`, replaces whatever is in the pane and cannot be taken back.
// So the checks and their order live here, once, and each service supplies
// only the tmux and /proc primitives (ResumeOps), which is also what lets each
// one's tests drive the sequence without a tmux server.
//
// The measurements behind every check are tmux-api's, from the first suspends
// on the devvm (2026-09-19), and the comments below carry the ones a reader of
// this file needs.

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// The three options a suspend writes beside OptionSuspended, plus the attach
// clock a resume moves. tmux-api is the only writer of the first two; they are
// named here because the resume that reads them now lives here.
const (
	// OptionResumeCmd is the argv respawn-pane will run, quoted so SplitArgv
	// reads it back exactly.
	OptionResumeCmd = "@tl_resume_cmd"
	// OptionSuspendState is the @claude_state the session had when it was
	// suspended, put back on resume.
	OptionSuspendState = "@tl_suspend_state"
	// OptionLastDrive is tmux-api's attach clock (tmux-api/lastdrive.go).
	OptionLastDrive = "@last_drive"
)

// The ways a resume can decline. Each one leaves the session as it was found,
// except ErrNotSuspended after a stale mark, which ResumeResult says.
var (
	// ErrSessionGone: there is no such session, or it vanished under the
	// respawn.
	ErrSessionGone = errors.New("session not found")
	// ErrNotSuspended: the session is live. Either it carries no mark, or it
	// carries one over a pane with a claude running in it, which makes the
	// mark stale; ResumeResult.StaleMarkCleared says which.
	ErrNotSuspended = errors.New("not suspended")
	// ErrPaneUnknown: the pane is alive and /proc would not say whether a
	// claude is under it. Nothing is respawned on a guess.
	ErrPaneUnknown = errors.New("cannot tell whether the pane is busy")
	// ErrResumeCmdUnreadable: the stored command does not parse, so it was
	// edited by hand or truncated. Running half of it would run something
	// nobody wrote.
	ErrResumeCmdUnreadable = errors.New("resume command unreadable")
	// ErrNothingToResume: the transcript the session points at is gone or
	// empty. Respawning `claude --resume` against it would end with claude
	// exiting, the pane exiting and the session destroyed.
	ErrNothingToResume = errors.New("no transcript to resume")
	// ErrRespawnFailed: tmux refused the respawn. Every mark is left in place
	// so the resume can be tried again.
	ErrRespawnFailed = errors.New("respawn-pane failed")
)

// SuspendedFacts is everything the resume needs, read in one tmux call: a
// second round trip could see a session that moved between them.
type SuspendedFacts struct {
	PaneID string
	// PanePID is #{pane_pid}: read only to answer whether a claude is running
	// under a pane that is still ALIVE, and never consulted for a dead one —
	// tmux goes on printing a dead pane's old pid and the kernel reuses pids.
	PanePID     int
	SuspendedAt int64
	ResumeCmd   string
	SavedState  string
	// Transcript is @claude_transcript, re-read rather than trusted from
	// suspend time: a transcript can be deleted while a session sits
	// suspended.
	Transcript string
	// PaneDead is #{pane_dead}. NOT on its own the test for a stale mark: a
	// session restored by tmux-persist runs `…; claude …; exec bash -l`, so
	// killing its claude leaves the pane alive holding a bash and the mark is
	// perfectly good. What makes a mark stale is a CLAUDE under a live pane.
	PaneDead bool
}

// ResumeOps is every side effect Resume performs. Grouped as function values
// so a caller's tests can stand in for tmux and /proc, and so tmux-api can
// keep the seams its own tests already swap.
type ResumeOps struct {
	// Read returns the session's facts; ok=false means it could not be read
	// at all, which is ErrSessionGone.
	Read func(osUser, name string) (SuspendedFacts, bool)
	// ClaudeUnderPane answers whether a claude runs under pid; ok=false means
	// the /proc scan did not happen, which is neither answer.
	ClaudeUnderPane func(pid int) (there, ok bool)
	// HasConversation answers whether a transcript path names a non-empty
	// regular file, asked as the session's own user.
	HasConversation func(osUser, transcript string) bool
	// Respawn runs `respawn-pane -k` with argv as SEPARATE arguments, and
	// returns tmux's combined output for the error path.
	Respawn func(osUser, paneID string, argv []string) (string, error)
	// ClearMarks puts the session back the way it was before the suspend.
	// Best-effort: the respawn has already happened when it runs.
	ClearMarks func(osUser, name, savedState string)
	// StampDriven moves the session's last-used clocks to at.
	StampDriven func(osUser, name string, at int64)
	Now         func() time.Time
	// FileExists answers whether a path names a file, for the agent rules
	// move (MigrateResumeArgv). nil asks os.Stat.
	FileExists func(path string) bool
}

// The agent rules file agent-api passes to a Caller's Claude with
// --append-system-prompt-file. It lived in /tmp/agent-api until 2026-10-02,
// a directory any account on the box could create first after a reboot and
// then redirect or replace the file in. It now lives in agent-api's
// StateDirectory=, which only that account can write. A suspend copies
// Claude's argv into @tl_resume_cmd, so a conversation started before the
// move still names the old path, and a resume moves it.
const (
	LegacyAgentRulesPath = "/tmp/agent-api/agent-rules.md"
	AgentRulesPath       = "/var/lib/agent-api/agent-rules.md"
)

// MigrateResumeArgv points a resume command that names LegacyAgentRulesPath
// at AgentRulesPath, in a bare argv word or inside a shell line alike. It
// leaves the command alone while nothing is at the new path: Claude exits on
// a rules file it cannot read, and the session would go with it.
func MigrateResumeArgv(argv []string, exists func(path string) bool) []string {
	var out []string
	for i, a := range argv {
		if !strings.Contains(a, LegacyAgentRulesPath) {
			continue
		}
		if out == nil {
			if !exists(AgentRulesPath) {
				return argv
			}
			out = append([]string(nil), argv...)
		}
		out[i] = strings.ReplaceAll(a, LegacyAgentRulesPath, AgentRulesPath)
	}
	if out == nil {
		return argv
	}
	return out
}

func (ops ResumeOps) fileExists(path string) bool {
	if ops.FileExists != nil {
		return ops.FileExists(path)
	}
	fi, err := os.Stat(path)
	return err == nil && fi.Mode().IsRegular()
}

// ResumeResult is what a caller reports about a resume, whether or not it
// respawned anything.
type ResumeResult struct {
	// SuspendedAt is the mark's unix second, for the telemetry a caller emits.
	SuspendedAt int64
	// RespawnMs is how long the respawn call itself took. Claude's own boot
	// happens after the pane exists and is not in it.
	RespawnMs int64
	// StaleMarkCleared is set with ErrNotSuspended when the session wore a
	// mark over a running claude and the mark was cleared instead of acted on.
	StaleMarkCleared bool
}

func (ops ResumeOps) now() time.Time {
	if ops.Now != nil {
		return ops.Now()
	}
	return time.Now()
}

// Resume brings one suspended session back.
//
// The order is the safety property. Everything that can refuse refuses before
// the respawn, because the respawn replaces the pane and there is no way back
// from it; and the marks are cleared only after the respawn landed, so a
// failed resume leaves a session that still reads as suspended and can be
// tried again.
func Resume(ops ResumeOps, osUser, name string) (ResumeResult, error) {
	facts, ok := ops.Read(osUser, name)
	if !ok {
		return ResumeResult{}, ErrSessionGone
	}
	res := ResumeResult{SuspendedAt: facts.SuspendedAt}
	if facts.SuspendedAt <= 0 {
		return res, ErrNotSuspended
	}
	if !facts.PaneDead {
		// A live pane under a mark is one of two different things, and
		// respawning the wrong one destroys a conversation: a restored
		// session's surviving bash, which holds nothing and is what
		// respawn-pane -k should replace, or a CLAUDE, which makes the mark
		// stale. So the claude is what is asked about, not the pane.
		busy, ok := ops.ClaudeUnderPane(facts.PanePID)
		if !ok {
			// Nothing is cleared: clearing would take the resume command with
			// it and leave the session unresumable.
			return res, ErrPaneUnknown
		}
		if busy {
			ops.ClearMarks(osUser, name, facts.SavedState)
			res.StaleMarkCleared = true
			return res, ErrNotSuspended
		}
	}
	argv, ok := SplitArgv(facts.ResumeCmd)
	if !ok || len(argv) == 0 {
		return res, ErrResumeCmdUnreadable
	}
	argv = MigrateResumeArgv(argv, ops.fileExists)
	if facts.PaneID == "" {
		return res, ErrSessionGone
	}
	// The conversation still has to be on disk: a claude that finds nothing
	// to resume exits, the shell's -c list ends, the pane exits, and the
	// session goes with it, because remain-on-exit is cleared with the marks
	// as soon as the respawn is issued.
	if !ops.HasConversation(osUser, facts.Transcript) {
		return res, ErrNothingToResume
	}

	started := ops.now()
	if out, err := ops.Respawn(osUser, facts.PaneID, argv); err != nil {
		msg := strings.TrimSpace(out)
		if TargetMissing(msg) {
			return res, ErrSessionGone
		}
		return res, fmt.Errorf("%w: %v: %s", ErrRespawnFailed, err, msg)
	}
	finished := ops.now()
	res.RespawnMs = finished.Sub(started).Milliseconds()

	ops.ClearMarks(osUser, name, facts.SavedState)
	// A resume IS a use of the session. Without the stamp the sweep that
	// suspended it takes it again on its next pass, because the clock still
	// holds the value that made it a candidate.
	ops.StampDriven(osUser, name, finished.Unix())
	return res, nil
}

// TargetMissing recognises "the session you named is not there" across the
// verbs a resume or a kill runs. The spelling differs by verb and by how the
// server is missing — measured on tmux 3.4: kill/rename say "can't find
// session", set-option says "no such session", a stopped server says "no
// server running", and a socket whose directory is gone says "error connecting
// to".
func TargetMissing(msg string) bool {
	for _, s := range []string{
		"can't find session", "no such session",
		"no server running", "error connecting to",
	} {
		if strings.Contains(msg, s) {
			return true
		}
	}
	return false
}

// SplitArgv reads a POSIX shell command line back into an argv: the inverse of
// the quoting tmux-api writes @tl_resume_cmd with. ok=false on anything it
// cannot read — an unterminated quote, a trailing backslash — because a
// half-parsed command is worse than no resume at all: it would respawn the
// pane running something nobody wrote.
func SplitArgv(s string) ([]string, bool) {
	out := []string{}
	var cur strings.Builder
	inWord := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			if inWord {
				out = append(out, cur.String())
				cur.Reset()
				inWord = false
			}
		case c == '\'':
			inWord = true
			j := strings.IndexByte(s[i+1:], '\'')
			if j < 0 {
				return nil, false
			}
			cur.WriteString(s[i+1 : i+1+j])
			i += j + 1
		case c == '"':
			inWord = true
			i++
			closed := false
			for ; i < len(s); i++ {
				if s[i] == '\\' && i+1 < len(s) {
					i++
					cur.WriteByte(s[i])
					continue
				}
				if s[i] == '"' {
					closed = true
					break
				}
				cur.WriteByte(s[i])
			}
			if !closed {
				return nil, false
			}
		case c == '\\':
			if i+1 >= len(s) {
				return nil, false
			}
			i++
			inWord = true
			cur.WriteByte(s[i])
		default:
			inWord = true
			cur.WriteByte(c)
		}
	}
	if inWord {
		out = append(out, cur.String())
	}
	return out, true
}

// ---------------------------------------------------------------------------
// The live primitives, against a real tmux server and /proc.

// suspendedFormat is the one read Resume starts from. The resume command is
// LAST: it is the one field that can hold anything, so it gets whatever
// separators are left over rather than shifting the fields ahead of it.
var suspendedFormat = strings.Join([]string{
	"#{session_name}", "#{pane_id}",
	"#{" + OptionSuspended + "}", "#{" + OptionSuspendState + "}",
	"#{pane_dead}", "#{pane_pid}",
	"#{" + OptionTranscript + "}", "#{" + OptionResumeCmd + "}",
}, "\t")

// parseSuspended decodes one suspendedFormat line, checking it is the
// session that was asked for: tmux does NOT fail an unknown target, so the
// answer has to say whose it is.
func parseSuspended(out, name string) (SuspendedFacts, bool) {
	parts := strings.SplitN(strings.TrimRight(out, "\n"), "\t", 8)
	if len(parts) != 8 || parts[0] != name {
		return SuspendedFacts{}, false
	}
	at, _ := strconv.ParseInt(strings.TrimSpace(parts[2]), 10, 64)
	pid, _ := strconv.Atoi(strings.TrimSpace(parts[5]))
	return SuspendedFacts{
		PaneID:      parts[1],
		SuspendedAt: at,
		SavedState:  strings.TrimSpace(parts[3]),
		PaneDead:    strings.TrimSpace(parts[4]) == "1",
		PanePID:     pid,
		Transcript:  strings.TrimSpace(parts[6]),
		ResumeCmd:   parts[7],
	}, true
}

// ReadSuspended is ResumeOps.Read against the real server.
func (in *Injector) ReadSuspended(osUser, name string) (SuspendedFacts, bool) {
	out, err := in.Command(osUser, "display-message", "-p", "-t", exactPane(name), suspendedFormat).Output()
	if err != nil {
		return SuspendedFacts{}, false
	}
	return parseSuspended(string(out), name)
}

// Answers the transcript probe prints. Two distinct words rather than a
// truthy test, so a tmux error that produces no output cannot read as yes.
const (
	transcriptProbeYes = "tl-transcript-yes"
	transcriptProbeNo  = "tl-transcript-no"
)

// TranscriptProbeCommand is the shell test that answers whether a transcript
// stamp names a file there is something to resume from. `-f` as well as `-s`,
// because `test -s` is true for a directory, and a directory is not a
// conversation. The path is single-quoted: it comes from a stamp the
// session's own user wrote.
func TranscriptProbeCommand(path string) string {
	q := "'" + strings.ReplaceAll(path, "'", `'\''`) + "'"
	return "test -f " + q + " && test -s " + q
}

// HasConversation is ResumeOps.HasConversation against the real server.
//
// Asked of the SESSION'S OWN tmux server rather than answered with os.Stat:
// the services run as wizard and peer homes here are 0750 with per-user
// groups, so a local stat of another user's transcript returns EACCES. if-shell
// runs its command through /bin/sh on the server, which is that user.
func (in *Injector) HasConversation(osUser, path string) bool {
	if path == "" {
		return false
	}
	out, err := in.Command(osUser, "if-shell", TranscriptProbeCommand(path),
		"display-message -p "+transcriptProbeYes,
		"display-message -p "+transcriptProbeNo).Output()
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(out)) == transcriptProbeYes
}

// RespawnPane is ResumeOps.Respawn against the real server. argv reaches tmux
// as SEPARATE arguments, which tmux execvp's without parsing, so no shell and
// no tmux quoting rule stands between the stored command and the process.
func (in *Injector) RespawnPane(osUser, paneID string, argv []string) (string, error) {
	args := append([]string{"respawn-pane", "-k", "-t", paneID}, argv...)
	out, err := in.Command(osUser, args...).CombinedOutput()
	return string(out), err
}

// ClearSuspendMarks is ResumeOps.ClearMarks against the real server, and
// returns the first failure for a caller that wants to log it. Every step is
// attempted whatever happened to the one before: the respawn has already
// happened, so a mark left behind is a stale label on a live session, which
// the next sweep's own "already suspended" check skips.
func (in *Injector) ClearSuspendMarks(osUser, name, savedState string) error {
	var first error
	note := func(err error) {
		if err != nil && first == nil {
			first = err
		}
	}
	// remain-on-exit first. It was set for one kill; left on, the pane would
	// stay as a corpse the next time claude exits normally, and the session
	// would never close again.
	note(in.Command(osUser, "set-option", "-u", "-t", exactPane(name), "remain-on-exit").Run())
	note(in.UnsetOptions(osUser, name, []string{OptionSuspended, OptionResumeCmd}))
	// The state the session had, back where it was, so the sidebar dot does
	// not blink through empty until Claude's own SessionStart hook re-stamps.
	switch savedState {
	case StateRunning, StateAwaiting, StateDone:
		note(in.SetOption(osUser, name, OptionState, savedState))
	}
	note(in.UnsetOptions(osUser, name, []string{OptionSuspendState}))
	return first
}

// StampDriven is ResumeOps.StampDriven against the real server: both clocks,
// because a session that reports its own activity is timed by
// OptionLastActivity and a resumed claude reports none until its first prompt.
func (in *Injector) StampDriven(osUser, name string, at int64) error {
	v := strconv.FormatInt(at, 10)
	var first error
	for _, opt := range []string{OptionLastDrive, OptionLastActivity} {
		if err := in.SetOption(osUser, name, opt, v); err != nil && first == nil {
			first = err
		}
	}
	return first
}

// ClaudeUnderPID answers whether pid or any descendant is a process whose
// comm is `claude`, from one scan of procDir. ok=false means the scan found
// nothing to read, which is neither answer.
//
// The same breadth-first walk tmux-api's procTree makes. Every user's
// processes are visible here (stat is world-readable), which is what lets a
// service running as wizard see another user's claude.
func ClaudeUnderPID(procDir string, pid int) (there, ok bool) {
	if pid <= 0 {
		return false, false
	}
	entries, err := os.ReadDir(procDir)
	if err != nil {
		return false, false
	}
	children := map[int][]int{}
	comm := map[int]string{}
	for _, e := range entries {
		p, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(procDir, e.Name(), "stat"))
		if err != nil {
			continue
		}
		s := string(raw)
		// comm may itself hold spaces and parens, so it ends at the LAST ')'.
		open, close := strings.IndexByte(s, '('), strings.LastIndexByte(s, ')')
		if open < 0 || close < open {
			continue
		}
		fields := strings.Fields(s[close+1:])
		if len(fields) < 2 {
			continue
		}
		ppid, err := strconv.Atoi(fields[1])
		if err != nil {
			continue
		}
		comm[p] = s[open+1 : close]
		children[ppid] = append(children[ppid], p)
	}
	if len(comm) == 0 {
		return false, false
	}
	queue := []int{pid}
	for len(queue) > 0 {
		p := queue[0]
		queue = queue[1:]
		if comm[p] == "claude" {
			return true, true
		}
		queue = append(queue, children[p]...)
	}
	return false, true
}

// LiveResumeOps is ResumeOps against the real server and procDir (normally
// /proc), with failures in the two best-effort steps passed to logf.
func (in *Injector) LiveResumeOps(procDir string, logf func(format string, args ...any)) ResumeOps {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	return ResumeOps{
		Read:            in.ReadSuspended,
		ClaudeUnderPane: func(pid int) (bool, bool) { return ClaudeUnderPID(procDir, pid) },
		HasConversation: in.HasConversation,
		Respawn:         in.RespawnPane,
		ClearMarks: func(osUser, name, savedState string) {
			if err := in.ClearSuspendMarks(osUser, name, savedState); err != nil {
				logf("resume: clearing the suspend marks on %s/%s: %v", osUser, name, err)
			}
		},
		StampDriven: func(osUser, name string, at int64) {
			if err := in.StampDriven(osUser, name, at); err != nil {
				logf("resume: stamping the drive clocks on %s/%s: %v", osUser, name, err)
			}
		},
	}
}
