package main

// Suspending a session nobody has driven for days.
//
// Every lobby session holds a Claude, and a Claude is not cheap. Measured on
// this box 2026-09-19: 38 live claude processes held 16.5 GiB, and 17 of them
// had been idle over 72 hours holding 4.6 GiB. The real cost is the process
// TREE (781-856 MB), not the claude process alone (305-377 MB) — about 476 MB
// of stdio MCP children die with it — so reclaiming one session is worth
// nearly a gigabyte.
//
// So a session nobody has driven for 72 hours is SUSPENDED: its claude is
// killed, its tmux session stays in the sidebar marked suspended, and clicking
// it brings the conversation back with `claude --resume <uuid>`. The transcript
// JSONL on disk is what makes that safe — the conversation was never in the
// process, it was always in the file, and a cold resume reaches a loaded prompt
// in 1.7 s (empty) to 3.1 s (a 24 MB transcript) for $0.00.
//
// Four facts were measured while building this, and each one breaks the feature
// silently when it is got wrong.
//
//  1. KILLING CLAUDE DESTROYS THE TMUX SESSION unless it is prevented.
//     `remain-on-exit` is off globally and per-window here, every lobby session
//     has exactly one window and one pane, and the pane command is
//     `/bin/zsh -lic "claude …"`. When claude exits the shell's -c list ends,
//     the pane exits, and a one-pane session dies with it. So remain-on-exit is
//     set ON THAT SESSION ONLY, immediately before the signal. Never globally —
//     an ordinary `exit` would then stop closing sessions for everyone.
//
//  2. A TRANSCRIPT'S MTIME IS NOT AN ACTIVITY SIGNAL. A transcript whose last
//     record was 2026-08-19 had an mtime 28 minutes old; keying idleness on it
//     reported 36 of 38 sessions as active within the hour. The idle signal is
//     @last_drive (lastdrive.go), which is derived from the CLIENT list and so
//     says when a human last had hands on the session. Nothing here reads an
//     mtime.
//
//  3. THE CONVERSATION UUID IS NOT IN ARGV. For 15 of 38 live processes the
//     pane's --session-id had no matching <uuid>.jsonl, while @claude_transcript
//     pointed at a different file entirely — a /clear leaves argv naming a
//     conversation claude has abandoned. The uuid comes from the stamp's base
//     name (sessionio.ClaudeIDFromTranscript), never from argv.
//
//  4. `#{pane_start_command}` DOES NOT ROUND-TRIP. tmux renders it through
//     args_escape, whose output is not shell syntax and is not re-parsed by
//     respawn-pane: measured on tmux 3.4, an argv of ["a|b"] comes back as the
//     bare `a|b` and ["has$dollar"] as `"has\\$dollar"`, and handing the whole
//     string back to `respawn-pane` produced a pane whose start command was
//     that string quoted AGAIN as one word, with nothing running in it. The
//     argv is read from /proc/<pane_pid>/cmdline instead, which is exact, and
//     handed back to respawn-pane as SEPARATE arguments, which tmux execvp's
//     without parsing anything.

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"terminal-lobby/sessionio"
	"terminal-lobby/telemetry"
)

const (
	// suspendIdleAfter is how long a person's session may sit undriven. Three
	// days is past any working week's worth of "I'll come back to that" and
	// well past the 4h6m median gap measured between drives on this box.
	suspendIdleAfter = 72 * time.Hour

	// suspendSystemIdleAfter is the same fuse for a session tooling made
	// (isSystemSession, origin.go). Nobody is coming back to a harness run, and
	// a QA session that outlived its harness is pure cost.
	suspendSystemIdleAfter = 4 * time.Hour

	// suspendSweepInterval is how often the sweep runs. The thresholds are in
	// hours, so five minutes is the granularity of "a bit over 72 hours" and
	// costs one session list per user per tick — the same call the sessions
	// poll already makes.
	suspendSweepInterval = 5 * time.Minute

	// suspendGrace is how long claude gets to flush its transcript and go after
	// SIGTERM. Past it the session is LEFT ALONE rather than SIGKILLed: an
	// unflushed transcript is the one thing that would make a resume come back
	// wrong, and the next sweep will try again in five minutes.
	//
	// 30s, raised from 10s after the first sweep on the devvm (2026-09-19
	// 20:10). Of six candidates, four outlived a 10s grace and every one of
	// them exited shortly after, so the grace was measuring the wrong thing:
	// the kill had worked and the code declined to record it. Transcript size
	// did not predict it — `ny-reibursment` has a 441 KB transcript and still
	// took longer than 10s. Nothing waits on this: the sweep is a background
	// timer, so a longer grace costs a slower sweep and nothing else, and the
	// repair pass below is the backstop for whatever still slips past.
	suspendGrace = 30 * time.Second

	// The three tmux session options this file owns. Only tmux-api writes them.
	//
	// suspendedOption is the unix second the session was suspended, and its
	// PRESENCE is what makes a session read as suspended — parseSessions forces
	// State from it. That is why it is stamped LAST of the three.
	//
	// Named through sessionio, the way sessionStateOption is (resume.go): this
	// service writes it, and agent-api and session-events both refuse to write
	// a session wearing it, so one spelling has to serve all three.
	suspendedOption = sessionio.OptionSuspended
	// resumeCmdOption is the argv respawn-pane will run, shell-quoted by
	// shellQuoteArgv and read back by shellSplitArgv. Quoted rather than stored
	// as a list because an option is one string and an operator reads this one.
	resumeCmdOption = "@tl_resume_cmd"
	// suspendStateOption is the @claude_state the session had when it was
	// suspended, put back on resume. Without it a resumed session would come
	// back stateless until its next hook fired, which for a conversation
	// waiting on an answer could be never.
	suspendStateOption = "@tl_suspend_state"

	// agentOwnerOption is agent-api's stamp, and the one option here this
	// service only ever READS. It names the credential that opened a
	// conversation over HTTP (agent-api/sessions.go), and a session wearing it
	// is never suspended — see declineNow.
	//
	// Spelled as a literal for the reason originOption is (origin.go): the
	// writer is a different Go module, so a shared constant would mean one of
	// them importing the other for one string. TestAgentOwnerOptionMatchesAgentAPI
	// is what keeps the two spellings together.
	agentOwnerOption = "@agent_owner"
)

// sessionsToSuspend picks the names to suspend out of the list tmux-api has
// already built. Pure: every tmux call lives in suspendSession.
//
// The exclusions are the whole of the policy, and each one has a reason worth
// more than the memory it costs:
//
//   - RUNNING is work in flight. AWAITING is a person's answer still owed, and
//     it is exempt FOREVER, whatever its age — a dialog that has stood for a
//     week is still a question somebody has to answer, and killing it throws
//     the question away.
//   - ATTACHED covers both driving and watching. Somebody has it on screen.
//   - A TOOL THAT IS NOT CLAUDE cannot be resumed by `claude --resume`. An
//     EMPTY tool means the /proc scan failed, and an unknown pane is not
//     evidence of anything — both decline.
//   - A RESERVED NAME is a pool slot or a harness run (migrate_ids.go). A slot
//     holds no conversation to come back to, and prewarm.go's own reaper owns
//     its lifetime.
//   - LASTDRIVE == 0 is a session nothing has stamped. lastdrive.go seeds the
//     stamp from Created on the first poll that sees a session, so by the time
//     a list is built it should be non-zero; treating zero as "do not suspend"
//     fails safe rather than reading an unstamped session as infinitely idle.
//
// A stamp in the FUTURE (a clock that moved) reads as not yet idle for the same
// reason: the arithmetic says "driven recently", which is the harmless answer.
func sessionsToSuspend(sessions []Session, now int64) []string {
	var out []string
	for _, s := range sessions {
		if s.SuspendedAt > 0 || s.State == stateSuspended {
			continue
		}
		if s.State == stateRunning || s.State == stateAwaiting {
			continue
		}
		if s.Attached > 0 || s.Driven {
			continue
		}
		if s.Tool != toolClaude {
			continue
		}
		if reservedName(s.Name) {
			continue
		}
		if s.LastDrive <= 0 {
			continue
		}
		after := suspendIdleAfter
		if isSystemSession(s) {
			after = suspendSystemIdleAfter
		}
		if now-s.LastDrive < int64(after/time.Second) {
			continue
		}
		out = append(out, s.Name)
	}
	return out
}

// ---------------------------------------------------------------------------
// Building the resume command.

// resumeUUIDRe is what may reach a command line as the conversation id.
//
// The uuid comes from @claude_transcript's base name, and that option is
// written by the session's own OS user, so it is untrusted input. Rather than
// escape whatever arrives, only a plain id is accepted: no spaces, no quotes,
// no shell metacharacters, and no leading dash that could read as a flag. A
// name this refuses simply means the session is not suspended.
var resumeUUIDRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

// resumeArgv returns argv with `--resume <uuid>` added to its claude
// invocation, and ok=false when there is no claude in it to resume.
//
// Two shapes, and which one it is decides where the flag goes. When claude is
// an argv element in its OWN RIGHT — `claude …`, or `/bin/sh /path/claude …`
// once an interpreter has been named — the flag becomes two new elements after
// it. When it is a word inside a longer element, that element is a shell
// command string (`/bin/zsh -lic "claude …"`, the lobby's own shape) and the
// flag is spliced into the text, leaving every other byte where it was. Getting
// that backwards would produce an argv element reading `claude --resume <uuid>`
// as ONE word, which execvp would look for as a program of that name.
//
// A command already carrying --resume has its uuid replaced rather than a
// second one appended, so running this twice lands in the same place.
func resumeArgv(argv []string, uuid string) ([]string, bool) {
	if len(argv) == 0 || !resumeUUIDRe.MatchString(uuid) {
		return nil, false
	}
	out := append([]string(nil), argv...)
	// Forwards, because the earliest whole-element claude is the program being
	// run and anything later is an argument to it.
	for i, a := range out {
		if isClaudeWord(a) {
			return insertResumeArgs(out, i, uuid), true
		}
	}
	// Otherwise the invocation is inside a shell command string, which is the
	// LAST element for both `-c` and `-lic`. Searched from the end so an
	// interpreter path that happened to mention claude loses to the command.
	for i := len(out) - 1; i >= 1; i-- {
		if spliced, ok := spliceResumeIntoCommand(out[i], uuid); ok {
			out[i] = spliced
			return out, true
		}
	}
	return nil, false
}

// isClaudeWord reports whether a shell word invokes claude: the bare name or
// any path ending in /claude. A directory that merely contains the word (say
// /home/wizard/claude-notes) is not one.
func isClaudeWord(w string) bool {
	return w == "claude" || strings.HasSuffix(w, "/claude")
}

// insertResumeArgs handles the shape where argv[at] IS claude, so the flag is
// two argv elements of its own rather than text inside one.
func insertResumeArgs(argv []string, at int, uuid string) []string {
	for i := at + 1; i+1 < len(argv); i++ {
		if argv[i] == "--resume" {
			argv[i+1] = uuid
			return argv
		}
	}
	out := make([]string, 0, len(argv)+2)
	out = append(out, argv[:at+1]...)
	out = append(out, "--resume", uuid)
	out = append(out, argv[at+1:]...)
	return out
}

// shWord is one whitespace-delimited word of a shell command string, with the
// byte offsets it occupies. Offsets rather than the words alone because the
// edit is a SPLICE: re-joining tokens would collapse the runs of whitespace
// inside the command and rewrite text nobody asked to change.
type shWord struct {
	text       string
	start, end int
}

// shWords splits on whitespace. Crude on purpose — it is used only to LOCATE a
// bare word, never to interpret one, and a quoted run containing spaces simply
// becomes several words none of which match what is being looked for.
func shWords(s string) []shWord {
	var out []shWord
	i := 0
	for i < len(s) {
		for i < len(s) && isSpaceByte(s[i]) {
			i++
		}
		start := i
		for i < len(s) && !isSpaceByte(s[i]) {
			i++
		}
		if i > start {
			out = append(out, shWord{text: s[start:i], start: start, end: i})
		}
	}
	return out
}

func isSpaceByte(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r'
}

// spliceResumeIntoCommand adds or replaces `--resume <uuid>` in a shell command
// string, leaving every other byte where it was.
//
// The FIRST claude word wins, and the search for an existing --resume stops at
// the first shell separator after it. Both matter on a real command: a session
// restored by tmux-persist runs a preamble, then claude, then
// `echo "  claude exited — shell preserved"` — so a rule that took the last
// claude word would edit the echo, and one that scanned the whole string for
// --resume could pick up a flag belonging to a different command.
func spliceResumeIntoCommand(s, uuid string) (string, bool) {
	words := shWords(s)
	ci := -1
	for i, w := range words {
		if isClaudeWord(w.text) {
			ci = i
			break
		}
	}
	if ci < 0 {
		return "", false
	}
	for i := ci + 1; i < len(words); i++ {
		if words[i].text == "--resume" && i+1 < len(words) {
			// The value may carry the separator that ends the command, glued
			// on: a restored session's command reads `--resume <uuid>; echo …`.
			// Only the part before it is the uuid.
			v := words[i+1]
			if cut := valueEnd(v.text); cut > 0 {
				return s[:v.start] + uuid + s[v.start+cut:], true
			}
			break
		}
		// Past the end of claude's own command, any --resume belongs to
		// something else.
		if endsCommand(words[i].text) {
			break
		}
	}
	e := words[ci].end
	return s[:e] + " --resume " + uuid + s[e:], true
}

// valueEnd is how much of a word is the value, stopping at the first shell
// separator glued to its tail. 0 means the word is a separator and carries no
// value at all.
func valueEnd(w string) int {
	if i := strings.IndexAny(w, ";&|"); i >= 0 {
		return i
	}
	return len(w)
}

// endsCommand reports whether a word carries a separator that ends the command
// claude is part of. Checked by containment rather than equality because the
// separator is usually stuck to the word before it (`--name "x";`).
func endsCommand(w string) bool {
	return strings.ContainsAny(w, ";&|")
}

// ---------------------------------------------------------------------------
// Getting an argv through a tmux option and back.

// shQuoteSafe is the set of bytes a word may hold and still be written bare.
var shQuoteSafe = regexp.MustCompile(`^[A-Za-z0-9_@%+=:,./-]+$`)

// shellQuoteArgv renders an argv as one POSIX shell command line.
//
// The pair with shellSplitArgv is a closed loop: this service writes the
// option and this service reads it, so the only property that matters is that
// the round trip is exact — which TestShellQuoteArgvRoundTrips pins over every
// argv shape on this box plus a run of hostile ones. Ordinary words are left
// bare so `tmux show-options @tl_resume_cmd` reads as a command rather than a
// wall of quotes.
func shellQuoteArgv(argv []string) string {
	parts := make([]string, 0, len(argv))
	for _, a := range argv {
		if shQuoteSafe.MatchString(a) {
			parts = append(parts, a)
			continue
		}
		parts = append(parts, "'"+strings.ReplaceAll(a, "'", `'\''`)+"'")
	}
	return strings.Join(parts, " ")
}

// shellSplitArgv is shellQuoteArgv's inverse. ok=false on anything it cannot
// read — an unterminated quote, a trailing backslash — because a half-parsed
// command is worse than no resume at all: it would respawn the pane running
// something nobody wrote.
func shellSplitArgv(s string) ([]string, bool) {
	out := []string{}
	var cur strings.Builder
	inWord := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case isSpaceByte(c):
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
// Reading the process tree.

// procArgv is a process's exact argv, from /proc/<pid>/cmdline. NUL-separated
// and never quoted, which is why it is the source rather than tmux's own
// rendering of the same thing (see fact 4 in this file's header).
//
// ok=false for a pid that is gone or has an empty cmdline — a kernel thread
// has one, and it is not an argv.
func procArgv(procDir string, pid int) ([]string, bool) {
	raw, err := os.ReadFile(filepath.Join(procDir, strconv.Itoa(pid), "cmdline"))
	if err != nil || len(raw) == 0 {
		return nil, false
	}
	parts := strings.Split(strings.TrimRight(string(raw), "\x00"), "\x00")
	if len(parts) == 0 || parts[0] == "" {
		return nil, false
	}
	return parts, true
}

// treeRSSBytes sums the resident memory of pid and everything under it.
//
// The TREE, because that is what a suspend reclaims: the claude process is
// 305-377 MB of the 781-856 MB a session holds, and the rest is stdio MCP
// children that die with it. Shared pages are counted once per process that
// maps them, so this over-reports a little; it is a reclaim estimate for a
// telemetry attribute, not an accounting figure, and smaps_rollup's exact
// answer costs a kernel page walk per process.
func treeRSSBytes(procDir string, t procTree, pid int) int64 {
	page := int64(os.Getpagesize())
	var total int64
	queue := []int{pid}
	for len(queue) > 0 {
		p := queue[0]
		queue = queue[1:]
		if pages, ok := procRSSPages(procDir, p); ok {
			total += pages * page
		}
		queue = append(queue, t.children[p]...)
	}
	return total
}

// procGone reports whether a pid has finished: its /proc entry is gone, or it
// is a ZOMBIE waiting to be reaped.
//
// The zombie case is not theoretical here. claude's parent is the shell running
// the pane's -c list, and that shell only reaps its child on the way to exiting
// itself, so there is a window where claude is finished and /proc/<pid> still
// exists. Reading the directory's presence alone would call that "still
// running" and lose the suspend's telemetry for a session that had in fact gone.
func procGone(procDir string, pid int) bool {
	raw, err := os.ReadFile(filepath.Join(procDir, strconv.Itoa(pid), "stat"))
	if err != nil {
		return true
	}
	// "<pid> (comm) <state> <ppid> …", and comm may itself hold spaces and
	// parens, so the state is the first field after the LAST ')'.
	close := strings.LastIndexByte(string(raw), ')')
	if close < 0 {
		return true
	}
	fields := strings.Fields(string(raw)[close+1:])
	return len(fields) == 0 || fields[0] == "Z"
}

// procRSSPages reads the resident-pages field of /proc/<pid>/statm — the
// second, after total program size.
func procRSSPages(procDir string, pid int) (int64, bool) {
	raw, err := os.ReadFile(filepath.Join(procDir, strconv.Itoa(pid), "statm"))
	if err != nil {
		return 0, false
	}
	fields := strings.Fields(string(raw))
	if len(fields) < 2 {
		return 0, false
	}
	n, err := strconv.ParseInt(fields[1], 10, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}

// transcriptProbeCommand is the shell test if-shell runs to answer whether a
// transcript stamp names a file there is something to resume from.
//
// `-f` as well as `-s`, because `test -s` is true for a directory (measured on
// this box), and a directory is not a conversation. The path is single-quoted
// with the standard `'\”` escape: it comes from the session's own
// @claude_transcript stamp, which SessionMap.Get has already confined to that
// user's projects root, but the directory component is derived from a working
// directory and a quote in one must not become shell syntax.
func transcriptProbeCommand(path string) string {
	q := "'" + strings.ReplaceAll(path, "'", `'\''`) + "'"
	return "test -f " + q + " && test -s " + q
}

// transcriptProbeYes and transcriptProbeNo are what if-shell prints back. Two
// distinct words rather than a truthy test, so a tmux error that produces no
// output cannot read as yes.
const (
	transcriptProbeYes = "tl-transcript-yes"
	transcriptProbeNo  = "tl-transcript-no"
)

// transcriptHasAConversation answers whether a transcript stamp names a file
// there is actually something to resume.
//
// SessionMap.Get resolves a NAME: it reads @claude_transcript and checks the
// path is inside the user's own projects root. It does not open the file, and
// it has no reason to — its other callers want the identity, not the content.
//
// A session nobody ever typed into is the gap that leaves, and it is the most
// likely thing on the box to be idle for 72 hours. Measured here 2026-09-19:
// claude stamps @claude_transcript within seconds of starting and creates the
// .jsonl only when the conversation gets its first record, so a freshly
// started session carries a stamp naming a file that does not exist. Suspended
// on the strength of that stamp, its resume runs `claude --resume <uuid>`,
// claude answers "No conversation found with session ID", exits, the shell's
// -c list ends, the pane exits — and because the resume has just put
// remain-on-exit back off, THE SESSION IS DESTROYED by the click meant to
// bring it back. Watched happen on this box before this check existed.
//
// The question is asked of the SESSION'S OWN tmux server, not answered with
// os.Stat, for the reason the kill goes the same way: tmux-api runs as wizard
// and peer homes here are 0750 with per-user groups, so `stat` on emo's
// transcript returns EACCES (measured 2026-09-19). A local check would have
// declined every one of another user's sessions and read exactly like the
// guard doing its job. if-shell runs its command through /bin/sh on the
// server, which is that user, and needs no sudoers change: /usr/bin/tmux is
// already granted per target user.
//
// A var so tests can answer without a tmux server.
var transcriptHasAConversation = func(osUser, path string) bool {
	if path == "" {
		return false
	}
	out, err := tmuxCmd(osUser, "if-shell", transcriptProbeCommand(path),
		"display-message -p "+transcriptProbeYes,
		"display-message -p "+transcriptProbeNo).Output()
	if err != nil {
		log.Printf("suspend: probing the transcript for %s (%q): %v", osUser, path, err)
		return false
	}
	return strings.TrimSpace(string(out)) == transcriptProbeYes
}

// ---------------------------------------------------------------------------
// The act.

// paneFacts is what tmux says about the session RIGHT NOW, read in one call a
// few milliseconds before the kill.
//
// The pid alone would be enough to find claude. The rest is here because the
// sweep decides from a list built ONCE per pass, and a pass is not quick: every
// candidate costs a /proc walk, three set-options and a kill that waits up to
// suspendGrace for the process to go, so the last name in a list of seventeen
// is reached minutes after its row was read. In those minutes somebody can open
// the session, answer the question it was waiting on, or start a turn in it —
// three of the things the policy says must never be suspended. Re-reading them
// in the call that was already being made costs nothing and shrinks the window
// from minutes to the time it takes to walk /proc and write two options.
//
// The pane ID is deliberately NOT here: it is the resume's business and the
// resume reads its own (readSuspended), so a copy taken now would be one more
// thing that could be stale by the time it is used.
type paneFacts struct {
	pid int // #{pane_pid}
	// attached is #{session_attached} — somebody has it on screen, driving or
	// watching.
	attached int
	// state is @claude_state as it reads now rather than as the list read it.
	state string
	// suspendedAt is @tl_suspended: already marked, by an overlapping pass or
	// by hand.
	suspendedAt int64
	// agentOwner is @agent_owner: the credential that opened this conversation
	// over HTTP (agentOwnerOption).
	agentOwner string
}

// declineNow re-applies the policy to what tmux says now, and returns the
// reason to leave the session alone.
//
// Four of the five exclusions sessionsToSuspend applies can change between the
// list and the kill, and this is where that is caught. The fifth — an agent-api
// conversation — cannot change, and is checked here rather than there for a
// different reason: @agent_owner does not ride tmuxListFmt, and the sweep is
// the only reader that needs it.
//
// WHY AN AGENT-API CONVERSATION IS NEVER SUSPENDED. agent-api drives its
// conversations over HTTP and never attaches a tmux client, so stampDrives
// (lastdrive.go) never moves their @last_drive: seeded once from Created, it
// says the session has been idle since the moment it was made, however busy
// the caller has been. It also stamps the CALLER's name as the origin, so
// isSystemSession puts it on the 4h fuse. Together that suspends a conversation
// four hours after it was created however recently it was used — and agent-api
// exposes no resume verb, so its caller could not bring it back. Measured on
// this box 2026-09-19: `session-ready` (@agent_owner=muse, state done, 34h by
// @last_drive) would have gone on the first sweep. Until agent-api can resume
// one, the memory stays held.
func declineNow(f paneFacts) (string, bool) {
	switch {
	case f.agentOwner != "":
		return fmt.Sprintf("is an agent-api conversation (%s=%q), which has no way back if it is suspended",
			agentOwnerOption, f.agentOwner), true
	case f.attached > 0:
		return "has a client attached", true
	case f.state == stateRunning || f.state == stateAwaiting:
		return "reads " + f.state + " now", true
	case f.suspendedAt > 0:
		return "is already suspended", true
	}
	return "", false
}

// procFacts is what /proc knows about it.
type procFacts struct {
	argv      []string
	claudePID int
	rssBytes  int64
}

// suspendOps is every side effect suspendSession performs, as one struct of
// function values.
//
// Grouped rather than left as a run of package-level vars because the ORDER is
// the safety property here and nothing else can express it: the timestamp is
// what makes a session read as suspended, so the resume command and the saved
// state have to be on the session before anything can observe it. A recorder
// standing in for this struct is how that order is pinned.
type suspendOps struct {
	transcript func(osUser, name string) (string, bool)
	pane       func(osUser, name string) (paneFacts, bool)
	inspect    func(panePID int) (procFacts, bool)
	setOption  func(osUser, name, option, value string) error
	remainOn   func(osUser, name string) error
	// paneDead is #{pane_dead}: 1 once the pane's command has exited and
	// remain-on-exit is holding its scrollback. Read AFTER the kill, to tell
	// the two pane shapes on this box apart — see step (h).
	//
	// ok=false means tmux did not answer, which is treated as "cannot tell"
	// rather than as either answer.
	paneDead func(osUser, name string) (dead bool, ok bool)
	// signal takes the OS USER as well as the pid because tmux-api runs as
	// wizard (devvm/tmux-api.service) and the sweep covers every mapped user.
	// An unprivileged syscall.Kill against another user's claude returns
	// EPERM, so the live implementation goes through that user's own tmux
	// server instead.
	signal func(osUser string, pid int) error
	exited func(pid int, grace time.Duration) bool
	emit   func(event, osUser string, attrs telemetry.Attrs)
}

// suspendSession suspends one session and reports whether it did.
//
// Best-effort and ORDERED around one invariant: A SESSION WEARS @tl_suspended
// ONLY ONCE ITS CLAUDE IS GONE. The resume path acts on that mark with
// `respawn-pane -k`, which replaces whatever is in the pane, so a mark on a
// session whose claude is still alive is a click away from destroying a live
// conversation. That is not hypothetical — measured on this box 2026-09-19,
// tmux-api runs as wizard and cannot signal emo's claude at all, so every one
// of emo's 20 sessions would have been stamped and never killed, once every
// five minutes.
//
// So: everything needed to bring the session BACK is written before the kill
// (the resume command and the saved state, neither of which changes how the
// session reads), remain-on-exit goes on immediately before the signal, and
// the timestamp lands only after the process is confirmed gone. A failure
// anywhere leaves the session live and reading live, with remain-on-exit put
// back the way it was found.
func suspendSession(ops suspendOps, osUser string, s Session, now time.Time) bool {
	// (a) The transcript, first, because a session that cannot be resumed must
	// never be suspended and this is the only thing that says so.
	path, ok := ops.transcript(osUser, s.Name)
	if !ok || path == "" {
		log.Printf("suspend: %s/%s has no resolvable transcript — leaving it alone", osUser, s.Name)
		return false
	}
	// (b) The uuid comes from the stamp's base name, never from argv.
	uuid := sessionio.ClaudeIDFromTranscript(path)

	// (c) The pane's process, which is the root of the tree to measure and to
	// find claude under.
	//
	// Addressed by NAME, like everything else in this file, and that is safe
	// here for a reason worth writing down: tmux-api's auto-title renames a
	// session 10-25 s after it starts (ADR-0022), so anything acting on a
	// FRESH session across time has to re-resolve or use the pane id. A
	// suspend candidate is at least four hours old, which is hours past the
	// window in which a rename can happen. A rename landing anyway costs a
	// failed set-option and a miss the next sweep repeats.
	pane, ok := ops.pane(osUser, s.Name)
	if !ok || pane.pid <= 0 {
		log.Printf("suspend: %s/%s has no readable pane — leaving it alone", osUser, s.Name)
		return false
	}
	// (c2) …and the policy, re-applied to what that same call said about the
	// session NOW. The list this candidate came from can be minutes old
	// (paneFacts has the arithmetic), and nothing below this line is reversible
	// once the signal is away.
	if why, no := declineNow(pane); no {
		log.Printf("suspend: %s/%s %s — leaving it alone", osUser, s.Name, why)
		return false
	}
	facts, ok := ops.inspect(pane.pid)
	if !ok {
		log.Printf("suspend: %s/%s has no claude under pane %d — leaving it alone", osUser, s.Name, pane.pid)
		return false
	}

	// (d) The resume command, built and PROVEN to survive the option before
	// anything is written. A command that does not round-trip would come back
	// as something nobody wrote, so the session is left live instead.
	next, ok := resumeArgv(facts.argv, uuid)
	if !ok {
		log.Printf("suspend: %s/%s runs no claude command this can resume (%q)", osUser, s.Name, facts.argv)
		return false
	}
	line := shellQuoteArgv(next)
	if back, ok := shellSplitArgv(line); !ok || !sameArgv(back, next) {
		log.Printf("suspend: %s/%s resume command does not survive the option (%q)", osUser, s.Name, line)
		return false
	}

	// (e) What the resume will need, written first. Neither option changes
	// how the session reads, so a failure here costs nothing.
	if err := ops.setOption(osUser, s.Name, resumeCmdOption, line); err != nil {
		log.Printf("suspend: stamping %s on %s/%s: %v", resumeCmdOption, osUser, s.Name, err)
		return false
	}
	if err := ops.setOption(osUser, s.Name, suspendStateOption, s.State); err != nil {
		log.Printf("suspend: stamping %s on %s/%s: %v", suspendStateOption, osUser, s.Name, err)
		return false
	}

	// (f) remain-on-exit, on THIS SESSION ONLY. Globally it would stop an
	// ordinary `exit` from closing anybody's session.
	if err := ops.remainOn(osUser, s.Name); err != nil {
		log.Printf("suspend: remain-on-exit on %s/%s: %v — not signalling", osUser, s.Name, err)
		return false
	}

	// (g) SIGTERM the claude process itself, not the shell wrapping it, so
	// claude runs its own shutdown and flushes the transcript.
	if err := ops.signal(osUser, facts.claudePID); err != nil {
		log.Printf("suspend: signalling claude %d for %s/%s: %v — remain-on-exit stays on", facts.claudePID, osUser, s.Name, err)
		return false
	}
	if !ops.exited(facts.claudePID, suspendGrace) {
		// Deliberately no SIGKILL. An unflushed transcript is the one thing
		// that makes a resume come back wrong, and the next sweep retries in
		// five minutes.
		log.Printf("suspend: claude %d for %s/%s did not exit within %s — left alone, remain-on-exit stays on",
			facts.claudePID, osUser, s.Name, suspendGrace)
		return false
	}

	// (h) The pane, now that the process is gone, because the two shapes on
	// this box behave differently and only one of them is finished here.
	//
	// ops.exited watched ONE pid. Whether the PANE went with it is decided by
	// the command it was started with: an ordinary `/bin/zsh -lic "claude …"`
	// ends its -c list and the pane dies, while a session restored by
	// tmux-persist runs `…; claude …; echo …; exec bash -l` and carries on into
	// bash. Measured on tmux 3.4, 2026-09-19: after the kill the restored shape
	// reports #{pane_dead} 0 and #{pane_current_command} bash, and two of this
	// box's live sessions have exactly that shape.
	//
	// A surviving shell is FINE and is still suspended: it holds no
	// conversation, and `respawn-pane -k` replaces it. What is not fine is a
	// claude still running under the pane — a wrapper that relaunched one, or a
	// second claude that was there all along — because the mark is what the
	// resume respawns over. So the mark is declined in that case only, and the
	// session is left for the next sweep.
	if dead, ok := ops.paneDead(osUser, s.Name); !ok || !dead {
		if _, running := ops.inspect(pane.pid); running {
			log.Printf("suspend: %s/%s still has a claude under pane %d after the kill — leaving it unmarked",
				osUser, s.Name, pane.pid)
			return false
		}
	}

	// (i) The mark, now that the process it describes is gone. This is the one
	// write that changes how the session reads, and the resume acts on it with
	// `respawn-pane -k`, so it comes after the kill rather than before it.
	//
	// A failure here leaves a dead pane carrying a resume command and no mark,
	// which is a session no sweep would look at again and no click could
	// resume. repairHalfSuspended (below) is what finds it on the next pass.
	if err := ops.setOption(osUser, s.Name, suspendedOption, strconv.FormatInt(now.Unix(), 10)); err != nil {
		log.Printf("suspend: claude for %s/%s is gone but %s would not stamp: %v — the next sweep's repair pass picks it up",
			osUser, s.Name, suspendedOption, err)
		return false
	}

	// (j) …and what it cost, so the threshold can be argued from numbers.
	ops.emit("session.suspended", osUser, telemetry.Attrs{
		"tl.session":     s.Name,
		"tl.idleSeconds": now.Unix() - s.LastDrive,
		"tl.rssBytes":    facts.rssBytes,
	})
	log.Printf("suspend: %s/%s idle %s, reclaimed %d MiB",
		osUser, s.Name, time.Duration(now.Unix()-s.LastDrive)*time.Second, facts.rssBytes>>20)
	return true
}

// REMAIN-ON-EXIT IS NEVER PUT BACK ONCE THE SIGNAL IS AWAY, and the absence of
// that unwind is deliberate enough to be worth a paragraph where the function
// used to be.
//
// An earlier version turned the option back off whenever the kill did not
// finish inside suspendGrace. The SIGTERM is still in flight at that moment, so
// the moment claude does exit the shell's -c list ends, the pane exits, and a
// one-pane session is DESTROYED with its scrollback. Reproduced on this box,
// tmux 3.4, 2026-09-19: remain-on-exit on, unwind, the process exits a moment
// later, `tmux list-sessions` answers "no server running". The session does not
// come back, and no sweep can retry what is no longer there.
//
// Leaving it on costs a corpse pane instead: if that claude later exits by
// itself the pane is held rather than closed, and the session stays in the
// sidebar. repairHalfSuspended turns exactly that into a resumable suspended
// session on the next pass, so the worse outcome of the two is also the
// recoverable one.

func sameArgv(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// ---------------------------------------------------------------------------
// The live wiring.

// procRoot is /proc, a var so the tests can point the readers at a fabricated
// tree. Production never reassigns it.
var procRoot = "/proc"

// claudeProjectsRoot is where a user's transcripts live. A var for the same
// reason procRoot is: the live round-trip test has to resolve a stamp without
// writing into anybody's real home.
var claudeProjectsRoot = func(osUser string) string {
	home := homeOfUser(osUser)
	if home == "" {
		return ""
	}
	return filepath.Join(home, ".claude", "projects")
}

// apiInjector is sessionio's tmux wrapper pinned to THIS service's binaries,
// built per call for the reason tmuxCmd gives: tmuxBinary and sudoBinary are
// test seams and an injector captured at package init would ignore a stub. The
// package-level gridInjector is exactly that captured copy, which is why
// nothing here uses it.
func apiInjector() *sessionio.Injector {
	in := sessionio.NewInjector(selfUser)
	in.Binary, in.Sudo = tmuxBinary, sudoBinary
	return in
}

// liveSuspendOps is suspendOps against the real box.
var liveSuspendOps = suspendOps{
	transcript: func(osUser, name string) (string, bool) {
		root := claudeProjectsRoot(osUser)
		if root == "" {
			return "", false
		}
		// The stamp is written by the session's own user, so SessionMap.Get
		// refuses a path outside that user's own projects root rather than
		// opening whatever it names.
		info, ok := sessionio.NewSessionMap(osUser, root, apiInjector()).Get(name)
		if !ok {
			return "", false
		}
		if !transcriptHasAConversation(osUser, info.Transcript) {
			return "", false
		}
		return info.Transcript, true
	},
	pane: func(osUser, name string) (paneFacts, bool) {
		// The session name is printed back and checked, because tmux does NOT
		// fail an unknown target — `display-message -p -t no-such-session`
		// exits 0 (measured on 3.4), so the answer has to say whose it is.
		// `=name:` with the trailing colon for the reason
		// devvm/tmux-user-attach gives: the bare `=name` is rejected by some
		// verbs and a plain name resolves by unambiguous PREFIX, which can
		// address a neighbouring session.
		//
		// Five fields rather than one, in the same fork: the four after the pid
		// are the live policy check (declineNow), and asking for them here is
		// what keeps them from being minutes older than the kill.
		out, err := tmuxCmd(osUser, "display-message", "-p", "-t", exactPane(name),
			"#{session_name}"+listSep+"#{pane_pid}"+listSep+
				"#{session_attached}"+listSep+
				"#{"+suspendedOption+"}"+listSep+
				"#{@claude_state}"+listSep+
				// Last, and addressed as last: an option a caller chose the
				// value of gets whatever separators are left over rather than
				// shifting the fields ahead of it.
				"#{"+agentOwnerOption+"}").Output()
		if err != nil {
			return paneFacts{}, false
		}
		parts := strings.SplitN(strings.TrimRight(string(out), "\n"), listSep, 6)
		if len(parts) != 6 || parts[0] != name {
			return paneFacts{}, false
		}
		pid, err := strconv.Atoi(parts[1])
		if err != nil {
			return paneFacts{}, false
		}
		// Leniently, all three: an unset option renders EMPTY, and an
		// unreadable count is not evidence of anybody being attached.
		attached, _ := strconv.Atoi(strings.TrimSpace(parts[2]))
		suspendedAt, _ := strconv.ParseInt(strings.TrimSpace(parts[3]), 10, 64)
		return paneFacts{
			pid:         pid,
			attached:    attached,
			suspendedAt: suspendedAt,
			state:       strings.TrimSpace(parts[4]),
			agentOwner:  strings.TrimSpace(parts[5]),
		}, true
	},
	paneDead: func(osUser, name string) (bool, bool) {
		out, err := tmuxCmd(osUser, "display-message", "-p", "-t", exactPane(name),
			"#{session_name}"+listSep+"#{pane_dead}").Output()
		if err != nil {
			return false, false
		}
		parts := strings.Split(strings.TrimRight(string(out), "\n"), listSep)
		if len(parts) != 2 || parts[0] != name {
			return false, false
		}
		return strings.TrimSpace(parts[1]) == "1", true
	},
	inspect: func(panePID int) (procFacts, bool) {
		tree, err := procTreeFrom(procRoot)
		if err != nil {
			return procFacts{}, false
		}
		claudePID, ok := tree.claudeUnder(panePID)
		if !ok {
			return procFacts{}, false
		}
		argv, ok := procArgv(procRoot, panePID)
		if !ok {
			return procFacts{}, false
		}
		return procFacts{
			argv:      argv,
			claudePID: claudePID,
			// Read BEFORE the signal, or the number is whatever is left of a
			// process tree mid-teardown.
			rssBytes: treeRSSBytes(procRoot, tree, panePID),
		}, true
	},
	setOption: func(osUser, name, option, value string) error {
		return apiInjector().SetOption(osUser, name, option, value)
	},
	remainOn: func(osUser, name string) error {
		// -t with the pane form resolves the session's window, which is where
		// remain-on-exit lives. Measured on tmux 3.4: this leaves the global
		// and every other window untouched.
		return tmuxCmd(osUser, "set-option", "-t", exactPane(name), "remain-on-exit", "on").Run()
	},
	signal: func(osUser string, pid int) error {
		// Through the session's OWN tmux server, which runs as that user, not
		// through syscall.Kill.
		//
		// tmux-api runs as wizard (devvm/tmux-api.service, User=wizard) and
		// the sweep covers every mapped user. Measured on this box
		// 2026-09-19: `kill -0` from wizard against emo's claude returns
		// EPERM, and emo owns 20 of the sessions on it, several idle since
		// August. A direct kill would therefore have failed on every session
		// that is not wizard's, silently, once every five minutes.
		//
		// run-shell needs no sudoers change: /usr/bin/tmux is already granted
		// per target user (devvm/sudoers.d-ttyd-users.template) and tmux runs
		// the command as the server's own user. It reports nothing back —
		// measured on tmux 3.4, run-shell with no attached client exits 0 and
		// prints nothing whether the command worked or not — so the outcome is
		// read from /proc by exited(), which is the honest check anyway.
		// The pid is a decimal integer read out of /proc, so there is nothing
		// in it for the shell to interpret.
		if pid <= 0 {
			return fmt.Errorf("refusing to signal pid %d", pid)
		}
		out, err := tmuxCmd(osUser, "run-shell", "kill -TERM "+strconv.Itoa(pid)).CombinedOutput()
		if err != nil {
			return fmt.Errorf("tmux run-shell kill: %w: %s", err, strings.TrimSpace(string(out)))
		}
		return nil
	},
	exited: func(pid int, grace time.Duration) bool {
		deadline := time.Now().Add(grace)
		for {
			if procGone(procRoot, pid) {
				return true
			}
			if !time.Now().Before(deadline) {
				return false
			}
			time.Sleep(200 * time.Millisecond)
		}
	},
	emit: func(event, osUser string, attrs telemetry.Attrs) { events.Emit(event, osUser, attrs) },
}

// ---------------------------------------------------------------------------
// Repairing a suspend that stopped half way.

// halfSuspendedRow is one session as the repair read sees it.
type halfSuspendedRow struct {
	name      string
	paneDead  bool
	suspended int64
	panePID   int
	resumeCmd string
	// claudeGone is the /proc answer for a pane that is still alive: true when
	// nothing under it is a claude. A pane's own death answers this only when
	// the pane's command was claude itself. `tmux-persist` restores a session
	// as `sh -c '…; claude …; exec bash -l'`, so the shell runs on after the
	// kill and #{pane_dead} stays 0 with the conversation just as gone.
	// Filled by readHalfSuspended, left false when the pane is already dead
	// (paneDead answers it) or when /proc could not say.
	claudeGone bool
}

// halfSuspendedNames picks out the sessions a suspend killed and then failed to
// mark.
//
// The window is small and it is not closed: between the kill and the stamp the
// set-option can fail, or this service can be restarted — a package upgrade
// does exactly that, and each candidate spends up to suspendGrace in there. A
// session left that way has a dead pane, a resume command, and no timestamp,
// and every path that would look after it declines: parseSessions leaves
// SuspendedAt 0, clearDeadStates blanks the state because no claude sits under
// the pane, annotateTools leaves Tool empty, and sessionsToSuspend's Tool check
// skips it for good. Clicking it attaches to a frozen pane, and text typed
// there is swallowed (`send-keys` into a dead pane exits 0 and the bytes
// vanish, measured on tmux 3.4).
//
// All three conditions are needed. A resume command with a LIVE pane is a
// suspend that failed before the kill, or a resume whose mark-clearing did not
// finish, and marking it would report a running conversation as suspended.
func halfSuspendedNames(rows []halfSuspendedRow) []string {
	var out []string
	for _, r := range rows {
		if r.name == "" || r.suspended > 0 || r.resumeCmd == "" {
			continue
		}
		// Either answer to "is the claude gone". Measured live 2026-09-19: the
		// first sweep on this box killed `beads-2` and `health`, whose panes
		// ran on into `exec bash -l`, and asking only about paneDead left both
		// unresumable.
		if !r.paneDead && !r.claudeGone {
			continue
		}
		out = append(out, r.name)
	}
	return out
}

// parseHalfSuspended reads the repair format. Tolerant: a row it cannot read
// is skipped, because this runs in a timer and a tmux hiccup must not stop the
// pass.
func parseHalfSuspended(out []byte) []halfSuspendedRow {
	var rows []halfSuspendedRow
	for _, line := range strings.Split(strings.TrimRight(string(out), "\n"), "\n") {
		if line == "" {
			continue
		}
		// The resume command is last and gets every leftover separator: it is
		// a shell command line and the only field here that can hold one.
		parts := strings.SplitN(line, listSep, 5)
		if len(parts) != 5 {
			continue
		}
		at, _ := strconv.ParseInt(strings.TrimSpace(parts[2]), 10, 64)
		pid, _ := strconv.Atoi(strings.TrimSpace(parts[3]))
		rows = append(rows, halfSuspendedRow{
			name:      parts[0],
			paneDead:  strings.TrimSpace(parts[1]) == "1",
			suspended: at,
			panePID:   pid,
			resumeCmd: parts[4],
		})
	}
	return rows
}

// readHalfSuspended lists one user's sessions in the repair format. A var for
// the tests; one fork per user per sweep, beside the session list the sweep
// already builds.
var readHalfSuspended = func(osUser string) []halfSuspendedRow {
	out, err := tmuxCmd(osUser, "list-sessions", "-F",
		"#{session_name}"+listSep+"#{pane_dead}"+listSep+
			"#{"+suspendedOption+"}"+listSep+"#{pane_pid}"+listSep+
			"#{"+resumeCmdOption+"}").Output()
	if err != nil {
		return nil
	}
	rows := parseHalfSuspended(out)
	// The /proc walk only for rows that could still be repaired: a live pane
	// carrying a resume command and no mark. That set is normally empty and at
	// worst a handful, so this costs nothing on an ordinary sweep.
	for i := range rows {
		r := &rows[i]
		if r.paneDead || r.suspended > 0 || r.resumeCmd == "" || r.panePID <= 0 {
			continue
		}
		there, ok := claudeUnderPane(r.panePID)
		// Unreadable /proc leaves claudeGone false, so an unanswerable pane is
		// left alone rather than marked suspended on a guess.
		r.claudeGone = ok && !there
	}
	return rows
}

// repairHalfSuspended stamps the sessions halfSuspendedNames found, and reports
// whether it stamped any.
//
// No telemetry event: the memory this session gave back was reclaimed by the
// kill that already happened, and emitting session.suspended here would count
// it twice and report an rssBytes nobody measured. The log line is the record.
func repairHalfSuspended(osUser string, now time.Time) bool {
	repaired := false
	for _, name := range halfSuspendedNames(readHalfSuspended(osUser)) {
		if err := apiInjector().SetOption(osUser, name, suspendedOption, strconv.FormatInt(now.Unix(), 10)); err != nil {
			log.Printf("suspend: repairing a half-finished suspend on %s/%s: %v", osUser, name, err)
			continue
		}
		log.Printf("suspend: %s/%s had a dead pane and a resume command but no mark — marking it suspended so it can be resumed", osUser, name)
		repaired = true
	}
	return repaired
}

// sweepSuspendableSessions runs one pass over every user tmux-api can see —
// not just whoever last called, because the memory is the box's.
func sweepSuspendableSessions(now time.Time) {
	for _, osUser := range mappedOSUsers() {
		sessions := userSessions(osUser)
		by := map[string]Session{}
		for _, s := range sessions {
			by[s.Name] = s
		}
		changed := false
		for _, name := range sessionsToSuspend(sessions, now.Unix()) {
			if suspendSession(liveSuspendOps, osUser, by[name], now) {
				changed = true
			}
		}
		// After the suspends, so a mark this pass failed to write is repaired
		// on the next one rather than fought over within this one.
		if repairHalfSuspended(osUser, now) {
			changed = true
		}
		if changed {
			// So the very next poll shows the mark rather than a body built
			// before it landed.
			sessionsCacheInstance.invalidate(osUser)
		}
	}
}

// ---------------------------------------------------------------------------
// Surviving a reboot: what this cannot do from here.
//
// A suspended session does NOT come back suspended after a reboot, and the
// conversation it was holding is not resumed either. Both are `tmux-persist`
// (infra repo, scripts/tmux-persist.sh), which this repo deploys but does not
// own, so they are recorded here rather than worked around.
//
// Measured on tmux 3.4, 2026-09-19, against a pane killed under
// remain-on-exit:
//
//   - The snapshot row is three TSV columns, `session \t cwd \t uuid`
//     (capture_live). There is no fourth column a mark could ride in, so
//     carrying @tl_suspended across a reboot needs a format change.
//   - capture_live only asks uuid_of_claude when `claude_pid_under "$pane_pid"`
//     succeeds. A suspended session has no claude, so its row is saved with the
//     uuid `-` and a reboot restores it as a plain shell — the conversation is
//     still on disk, but nothing resumes it. The fix is small and belongs
//     there: uuid_of_claude's FIRST source is the @claude_transcript stamp,
//     which is still on the session and answers correctly with no live process,
//     so the call needs to happen for a dead pane too.
//   - A dead pane reports an EMPTY #{pane_current_path} (its old #{pane_pid} is
//     still printed, but that pid is gone from /proc). An empty middle column
//     collapses under `read`, because TAB is IFS whitespace — the trap
//     capture_live's own comments describe — so the row would shift by one
//     field. #{session_path} is the fallback that keeps the column full.
//
// TODO(infra, tmux-persist.sh): resolve the uuid from @claude_transcript when
// no claude is alive under the pane; fall back to #{session_path} when
// #{pane_current_path} is empty; and, if a reboot should preserve the mark
// rather than waking everything, carry @tl_suspended as a fourth column.
// Until then a reboot un-suspends every suspended session, which costs the
// memory again and loses nothing else.

// runSuspendReaper sweeps until stop is closed. Started unconditionally, like
// the prewarm reaper: with nothing old enough it is one session list per mapped
// user every five minutes.
func runSuspendReaper(stop <-chan struct{}) {
	t := time.NewTicker(suspendSweepInterval)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case now := <-t.C:
			sweepSuspendableSessions(now)
		}
	}
}
