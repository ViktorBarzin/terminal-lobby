package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"terminal-lobby/telemetry"
)

// A session old enough to qualify under either threshold, so a row only has to
// say what makes it DIFFERENT.
const (
	testNow      int64 = 1_800_000_000
	longAgo            = testNow - int64(100*time.Hour/time.Second)
	fiveHoursAgo       = testNow - int64(5*time.Hour/time.Second)
	oneHourAgo         = testNow - int64(1*time.Hour/time.Second)
)

// suspendable is the session every row below starts from: a person's claude
// session, nobody attached, idle for 100 hours. Each row changes one field, so
// what the row is testing is the only thing on the line.
func suspendable(name string) Session {
	return Session{
		Name:      name,
		Origin:    originUser,
		Tool:      toolClaude,
		State:     stateDone,
		LastDrive: longAgo,
	}
}

func TestSessionsToSuspend(t *testing.T) {
	cases := []struct {
		why  string
		s    Session
		want bool
	}{
		{"a person's claude session idle for 100h", suspendable("plain"), true},
		{"idle exactly at the 72h threshold", func() Session {
			s := suspendable("at-threshold")
			s.LastDrive = testNow - int64(suspendIdleAfter/time.Second)
			return s
		}(), true},
		{"idle one second under the threshold", func() Session {
			s := suspendable("under")
			s.LastDrive = testNow - int64(suspendIdleAfter/time.Second) + 1
			return s
		}(), false},
		{"driven an hour ago", func() Session {
			s := suspendable("recent")
			s.LastDrive = oneHourAgo
			return s
		}(), false},
		{"running, whatever its age", func() Session {
			s := suspendable("running")
			s.State = stateRunning
			return s
		}(), false},
		{"awaiting an answer — exempt forever", func() Session {
			s := suspendable("awaiting")
			s.State = stateAwaiting
			return s
		}(), false},
		{"already suspended", func() Session {
			s := suspendable("already")
			s.State = stateSuspended
			s.SuspendedAt = oneHourAgo
			return s
		}(), false},
		{"a client is attached", func() Session {
			s := suspendable("attached")
			s.Attached = 1
			return s
		}(), false},
		{"a client is driving it", func() Session {
			s := suspendable("driven")
			s.Attached, s.Driven = 1, true
			return s
		}(), false},
		{"running codex, not claude", func() Session {
			s := suspendable("codex")
			s.Tool = toolCodex
			return s
		}(), false},
		{"a plain shell", func() Session {
			s := suspendable("shell")
			s.Tool = toolShell
			return s
		}(), false},
		{"the /proc scan failed, so the tool is unknown", func() Session {
			s := suspendable("unknown-tool")
			s.Tool = ""
			return s
		}(), false},
		{"never stamped with a drive time", func() Session {
			s := suspendable("unstamped")
			s.LastDrive = 0
			return s
		}(), false},
		{"stamped in the future by a clock skew", func() Session {
			s := suspendable("future")
			s.LastDrive = testNow + 600
			return s
		}(), false},
		{"a pre-warmed pool slot", func() Session {
			s := suspendable(poolSlotPrefix + "home_wizard_code")
			s.Origin = ""
			return s
		}(), false},
		{"a QA harness session", func() Session {
			s := suspendable("qa-probe")
			return s
		}(), false},
		{"the lobby's own playwright session", func() Session {
			s := suspendable("tlp-t-run")
			return s
		}(), false},
		// A system session — unstamped origin — has the SHORTER fuse.
		{"a system session idle 5h", func() Session {
			s := suspendable("system-5h")
			s.Origin = ""
			s.LastDrive = fiveHoursAgo
			return s
		}(), true},
		{"a system session idle 1h", func() Session {
			s := suspendable("system-1h")
			s.Origin = ""
			s.LastDrive = oneHourAgo
			return s
		}(), false},
		{"a user session idle 5h — the long fuse applies", func() Session {
			s := suspendable("user-5h")
			s.LastDrive = fiveHoursAgo
			return s
		}(), false},
		{"a test-origin session idle 5h is still system", func() Session {
			s := suspendable("test-5h")
			s.Origin = originTest
			s.LastDrive = fiveHoursAgo
			return s
		}(), true},
	}

	for _, c := range cases {
		t.Run(c.why, func(t *testing.T) {
			got := sessionsToSuspend([]Session{c.s}, testNow)
			if c.want && !reflect.DeepEqual(got, []string{c.s.Name}) {
				t.Fatalf("sessionsToSuspend = %v, want [%s] — %s", got, c.s.Name, c.why)
			}
			if !c.want && len(got) != 0 {
				t.Fatalf("sessionsToSuspend = %v, want none — %s", got, c.why)
			}
		})
	}
}

// The list arrives whole, and the answer has to be every qualifying name in it
// — a rule that returned only the first would suspend one session per sweep.
func TestSessionsToSuspendReturnsEveryQualifyingName(t *testing.T) {
	list := []Session{
		suspendable("a"),
		func() Session { s := suspendable("busy"); s.State = stateRunning; return s }(),
		suspendable("b"),
	}
	got := sessionsToSuspend(list, testNow)
	if want := []string{"a", "b"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("sessionsToSuspend = %v, want %v", got, want)
	}
}

// ---------------------------------------------------------------------------
// The resume command.

const testUUID = "1f04270e-2598-415b-93d4-8138fab681bf"

func TestResumeArgv(t *testing.T) {
	cases := []struct {
		why  string
		argv []string
		want []string
		ok   bool
	}{
		{
			why:  "the lobby's own shape, with model and effort flags",
			argv: []string{"/bin/zsh", "-lic", "claude --dangerously-skip-permissions --effort max --model 'claude-opus-5' --effort 'max'"},
			want: []string{"/bin/zsh", "-lic", "claude --resume " + testUUID + " --dangerously-skip-permissions --effort max --model 'claude-opus-5' --effort 'max'"},
			ok:   true,
		},
		{
			why:  "no model flags",
			argv: []string{"/bin/zsh", "-lic", "claude --dangerously-skip-permissions --effort max"},
			want: []string{"/bin/zsh", "-lic", "claude --resume " + testUUID + " --dangerously-skip-permissions --effort max"},
			ok:   true,
		},
		{
			why:  "already carrying --resume: the uuid is replaced, not doubled",
			argv: []string{"/bin/sh", "-c", "claude --dangerously-skip-permissions --resume 6c8ea2b7-21f4-47f5-a3e1-c6d1beb3d211 --name \"h9r7m1r2s6zt\""},
			want: []string{"/bin/sh", "-c", "claude --dangerously-skip-permissions --resume " + testUUID + " --name \"h9r7m1r2s6zt\""},
			ok:   true,
		},
		{
			why: "a restored session's preamble, with the word claude in a later echo",
			argv: []string{"/bin/sh", "-c",
				"i=0; while [ $i -lt 40 ]; do sleep 0.05; done; claude --dangerously-skip-permissions --resume 6c8ea2b7-21f4-47f5-a3e1-c6d1beb3d211; echo \"  claude exited — shell preserved\"; exec bash -l"},
			want: []string{"/bin/sh", "-c",
				"i=0; while [ $i -lt 40 ]; do sleep 0.05; done; claude --dangerously-skip-permissions --resume " + testUUID + "; echo \"  claude exited — shell preserved\"; exec bash -l"},
			ok: true,
		},
		{
			why:  "claude is the pane's own program",
			argv: []string{"claude", "--dangerously-skip-permissions"},
			want: []string{"claude", "--resume", testUUID, "--dangerously-skip-permissions"},
			ok:   true,
		},
		{
			why:  "claude by absolute path as the pane's own program",
			argv: []string{"/usr/local/bin/claude", "--effort", "max"},
			want: []string{"/usr/local/bin/claude", "--resume", testUUID, "--effort", "max"},
			ok:   true,
		},
		{
			why:  "claude as the pane's own program, already resumed",
			argv: []string{"claude", "--resume", "6c8ea2b7-21f4-47f5-a3e1-c6d1beb3d211", "--effort", "max"},
			want: []string{"claude", "--resume", testUUID, "--effort", "max"},
			ok:   true,
		},
		{
			why:  "an interpreter named ahead of claude — the flag is its own argv element",
			argv: []string{"/bin/sh", "/usr/local/bin/claude", "--effort", "max"},
			want: []string{"/bin/sh", "/usr/local/bin/claude", "--resume", testUUID, "--effort", "max"},
			ok:   true,
		},
		{
			why:  "the same, already resumed",
			argv: []string{"/bin/sh", "/usr/local/bin/claude", "--resume", "6c8ea2b7-21f4-47f5-a3e1-c6d1beb3d211", "--effort", "max"},
			want: []string{"/bin/sh", "/usr/local/bin/claude", "--resume", testUUID, "--effort", "max"},
			ok:   true,
		},
		{
			why:  "a plain shell — nothing to resume",
			argv: []string{"/bin/zsh", "-l"},
			ok:   false,
		},
		{
			why:  "a path that merely contains the word claude",
			argv: []string{"/bin/sh", "-c", "cd /home/wizard/claude-notes && exec bash -l"},
			ok:   false,
		},
		{
			why:  "codex, not claude",
			argv: []string{"/bin/zsh", "-lic", "codex --full-auto"},
			ok:   false,
		},
		{
			why:  "no argv at all",
			argv: nil,
			ok:   false,
		},
	}

	for _, c := range cases {
		t.Run(c.why, func(t *testing.T) {
			got, ok := resumeArgv(c.argv, testUUID)
			if ok != c.ok {
				t.Fatalf("resumeArgv ok = %v, want %v (got %q)", ok, c.ok, got)
			}
			if ok && !reflect.DeepEqual(got, c.want) {
				t.Fatalf("resumeArgv =\n  %q\nwant\n  %q", got, c.want)
			}
		})
	}
}

// Running it twice must land in the same place. A sweep that suspended a
// session, failed to clear the mark and came back must not stack flags.
func TestResumeArgvIsIdempotent(t *testing.T) {
	argv := []string{"/bin/zsh", "-lic", "claude --dangerously-skip-permissions --effort max"}
	once, ok := resumeArgv(argv, testUUID)
	if !ok {
		t.Fatal("first pass refused a claude command")
	}
	twice, ok := resumeArgv(once, testUUID)
	if !ok {
		t.Fatal("second pass refused its own output")
	}
	if !reflect.DeepEqual(once, twice) {
		t.Fatalf("second pass changed the command:\n  %q\n  %q", once, twice)
	}
}

// The uuid reaches a command line, so anything that is not a plain id is
// refused rather than escaped. A transcript stamp is written by the session's
// own user and is untrusted input.
func TestResumeArgvRefusesAHostileUUID(t *testing.T) {
	argv := []string{"/bin/zsh", "-lic", "claude --effort max"}
	for _, bad := range []string{
		"", " ", "a b", "x; rm -rf /", "$(whoami)", "`id`", "'quoted'", "\"dq\"",
		"a\nb", "a\tb", "--flag", strings.Repeat("a", 200),
	} {
		if got, ok := resumeArgv(argv, bad); ok {
			t.Errorf("resumeArgv accepted uuid %q -> %q", bad, got)
		}
	}
}

// ---------------------------------------------------------------------------
// The option round trip.

// argvCorpus is every argv shape the round trip has to survive, including the
// two live on this box on 2026-09-19 and a run of hostile ones.
func argvCorpus() [][]string {
	return [][]string{
		{"/bin/zsh", "-lic", "claude --dangerously-skip-permissions --effort max --model 'claude-opus-5' --effort 'max'"},
		{"/bin/zsh", "-lic", "claude --dangerously-skip-permissions --effort max"},
		{"/bin/sh", "-c", "i=0; while [ $i -lt 40 ]; do read -r _cg < /proc/self/cgroup 2>/dev/null; case ${_cg:-} in *tmux-spawn-*) break ;; esac; i=$((i+1)); sleep 0.05; done; claude --resume " + testUUID + " --name \"m79sj3xg106n\"; echo; echo \"  claude exited\"; exec bash -l"},
		{"claude"},
		{"claude", "--resume", testUUID},
		{"a b", `has"dq`, "has'sq", "has$dollar", `has\bslash`, "has`tick", "plain", "a;b", "a#b", "a~b", "a*b", "a|b"},
		{""},
		{"", "x", ""},
		{"trailing "},
		{" leading"},
		{"new\nline"},
		{"tab\there"},
	}
}

func TestShellQuoteArgvRoundTrips(t *testing.T) {
	for _, argv := range argvCorpus() {
		line := shellQuoteArgv(argv)
		back, ok := shellSplitArgv(line)
		if !ok {
			t.Errorf("shellSplitArgv refused our own output for %q:\n  %s", argv, line)
			continue
		}
		if !reflect.DeepEqual(back, argv) {
			t.Errorf("round trip changed the argv:\n  in:   %q\n  line: %s\n  out:  %q", argv, line, back)
		}
	}
}

// A word with nothing special in it stays bare, so an operator reading
// `tmux show-options @tl_resume_cmd` sees a command rather than a wall of
// quotes.
func TestShellQuoteArgvLeavesOrdinaryWordsBare(t *testing.T) {
	got := shellQuoteArgv([]string{"/bin/zsh", "-lic", "claude --effort max"})
	want := `/bin/zsh -lic 'claude --effort max'`
	if got != want {
		t.Fatalf("shellQuoteArgv = %s, want %s", got, want)
	}
}

func TestShellSplitArgvRefusesWhatItCannotRead(t *testing.T) {
	for _, bad := range []string{`'unterminated`, `"unterminated`, `trailing\`} {
		if got, ok := shellSplitArgv(bad); ok {
			t.Errorf("shellSplitArgv(%q) = %q, want a refusal", bad, got)
		}
	}
}

// ---------------------------------------------------------------------------
// Reading the process tree.

type suspendProcEntry struct {
	comm string
	ppid int
	argv []string
	rss  int64 // pages
}

func writeFakeProcFull(t *testing.T, procs map[int]suspendProcEntry) string {
	t.Helper()
	dir := t.TempDir()
	for pid, p := range procs {
		pdir := filepath.Join(dir, strconv.Itoa(pid))
		if err := os.MkdirAll(pdir, 0o755); err != nil {
			t.Fatal(err)
		}
		stat := strconv.Itoa(pid) + " (" + p.comm + ") S " + strconv.Itoa(p.ppid) + " 1 1 0 -1 0 0\n"
		if err := os.WriteFile(filepath.Join(pdir, "stat"), []byte(stat), 0o644); err != nil {
			t.Fatal(err)
		}
		statm := fmt.Sprintf("%d %d 0 0 0 0 0\n", p.rss*2, p.rss)
		if err := os.WriteFile(filepath.Join(pdir, "statm"), []byte(statm), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(pdir, "cmdline"),
			[]byte(strings.Join(p.argv, "\x00")+"\x00"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestProcArgvReadsACommandLine(t *testing.T) {
	dir := writeFakeProcFull(t, map[int]suspendProcEntry{
		100: {comm: "zsh", ppid: 1, argv: []string{"/bin/zsh", "-lic", "claude --effort max"}},
		101: {comm: "zsh", ppid: 1, argv: nil},
	})
	got, ok := procArgv(dir, 100)
	if !ok {
		t.Fatal("procArgv refused a readable cmdline")
	}
	if want := []string{"/bin/zsh", "-lic", "claude --effort max"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("procArgv = %q, want %q", got, want)
	}
	// A kernel thread has an EMPTY cmdline, which is not an argv.
	if got, ok := procArgv(dir, 101); ok {
		t.Fatalf("procArgv on an empty cmdline = %q, want a refusal", got)
	}
	if got, ok := procArgv(dir, 999); ok {
		t.Fatalf("procArgv on a missing pid = %q, want a refusal", got)
	}
}

// The RSS the suspend reclaims is the TREE's, not the claude process's: ~476MB
// of stdio MCP children die with it, and a number that left them out would
// under-report the saving by more than half.
func TestTreeRSSBytesSumsTheWholeTree(t *testing.T) {
	dir := writeFakeProcFull(t, map[int]suspendProcEntry{
		100: {comm: "zsh", ppid: 1, rss: 10},
		101: {comm: "claude", ppid: 100, rss: 100},
		102: {comm: "node", ppid: 101, rss: 50},
		103: {comm: "python3", ppid: 101, rss: 25},
		200: {comm: "zsh", ppid: 1, rss: 999}, // another session entirely
	})
	tree, err := procTreeFrom(dir)
	if err != nil {
		t.Fatalf("procTreeFrom: %v", err)
	}
	page := int64(os.Getpagesize())
	if got, want := treeRSSBytes(dir, tree, 100), 185*page; got != want {
		t.Fatalf("treeRSSBytes = %d, want %d", got, want)
	}
}

func TestClaudeUnderFindsTheShallowestClaude(t *testing.T) {
	dir := writeFakeProcFull(t, map[int]suspendProcEntry{
		100: {comm: "zsh", ppid: 1},
		101: {comm: "claude", ppid: 100},
		102: {comm: "claude", ppid: 101}, // a claude the session spawned
		200: {comm: "zsh", ppid: 1},
	})
	tree, err := procTreeFrom(dir)
	if err != nil {
		t.Fatalf("procTreeFrom: %v", err)
	}
	if got, ok := tree.claudeUnder(100); !ok || got != 101 {
		t.Fatalf("claudeUnder(100) = %d,%v — want the shallowest claude, 101", got, ok)
	}
	if got, ok := tree.claudeUnder(200); ok {
		t.Fatalf("claudeUnder(200) = %d, want nothing under a bare shell", got)
	}
}

// A stamp is not a conversation. claude writes @claude_transcript within
// seconds of starting and creates the .jsonl only when the conversation gets
// its first record, so a session nobody typed into carries a stamp naming a
// file that is not there — and that is the likeliest thing on the box to sit
// idle for 72 hours.
//
// The probe runs through the session's own tmux server, so what is checked
// here is the shell test it hands over. Running it for real against /bin/sh
// rather than asserting on the string, because the thing that would break it
// is a quoting rule, and a string comparison cannot see one.
func TestTranscriptProbeCommand(t *testing.T) {
	dir := t.TempDir()
	full := filepath.Join(dir, "full.jsonl")
	if err := os.WriteFile(full, []byte("{\"type\":\"summary\"}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	empty := filepath.Join(dir, "empty.jsonl")
	if err := os.WriteFile(empty, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	// A directory whose name carries the two characters that would end the
	// quoting if it were wrong.
	odd := filepath.Join(dir, "it's \"odd\"")
	if err := os.MkdirAll(odd, 0o755); err != nil {
		t.Fatal(err)
	}
	oddFile := filepath.Join(odd, "full.jsonl")
	if err := os.WriteFile(oddFile, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		why  string
		path string
		want bool
	}{
		{"a transcript with records in it", full, true},
		{"a stamp naming a file that was never created", filepath.Join(dir, "missing.jsonl"), false},
		{"a transcript with nothing in it yet", empty, false},
		{"a directory where a transcript should be", dir, false},
		{"a path carrying a quote and a double quote", oddFile, true},
	} {
		err := exec.Command("/bin/sh", "-c", transcriptProbeCommand(c.path)).Run()
		if got := err == nil; got != c.want {
			t.Errorf("%s: %s said %v, want %v", c.why, transcriptProbeCommand(c.path), got, c.want)
		}
	}
}

// An empty stamp never reaches a shell at all.
func TestTranscriptHasAConversationRefusesAnEmptyStamp(t *testing.T) {
	if transcriptHasAConversation("wizard", "") {
		t.Fatal("an unstamped session was treated as having a conversation")
	}
}

// ---------------------------------------------------------------------------
// The suspend act.

// recordingOps is a suspendOps whose every call lands in one ordered log, so a
// test can assert on the SEQUENCE. The order is the safety property: the
// timestamp is what makes a session read as suspended, so nothing may observe
// it before the resume command and the saved state are on the session.
type recordingOps struct {
	log          []string
	noTranscript bool
	setFail      string // option name whose write fails
	remainFail   bool
	signalFail   bool
	neverExits   bool
	// facts is what tmux says about the session at the moment of the kill:
	// the pid, plus the four fields declineNow re-checks there.
	facts paneFacts
	// paneAlive makes #{pane_dead} read 0 after the kill — the tmux-persist
	// shape, whose wrapper shell carries on into bash when its claude goes.
	paneAlive bool
	// paneUnreadable makes the #{pane_dead} read fail outright.
	paneUnreadable bool
	// claudeRespawned makes the second /proc look (the one that runs when the
	// pane outlived the kill) find a claude still under the pane.
	claudeRespawned bool
	inspects        int
	signalledUsers  []string
	ops             suspendOps
}

func newRecordingOps() *recordingOps {
	r := &recordingOps{}
	r.ops = suspendOps{
		transcript: func(osUser, name string) (string, bool) {
			r.log = append(r.log, "transcript")
			if r.noTranscript {
				return "", false
			}
			return "/home/wizard/.claude/projects/-home-wizard/" + testUUID + ".jsonl", true
		},
		pane: func(osUser, name string) (paneFacts, bool) {
			r.log = append(r.log, "pane")
			f := r.facts
			f.pid = 100
			return f, true
		},
		paneDead: func(osUser, name string) (bool, bool) {
			r.log = append(r.log, "pane-dead")
			if r.paneUnreadable {
				return false, false
			}
			return !r.paneAlive, true
		},
		inspect: func(panePID int) (procFacts, bool) {
			r.log = append(r.log, "inspect")
			r.inspects++
			// The second look happens only when the pane outlived the kill,
			// and it is asking whether a claude is still under it.
			if r.inspects > 1 && !r.claudeRespawned {
				return procFacts{}, false
			}
			return procFacts{
				argv:      []string{"/bin/zsh", "-lic", "claude --effort max"},
				claudePID: 101,
				rssBytes:  800 << 20,
			}, true
		},
		setOption: func(osUser, name, option, value string) error {
			r.log = append(r.log, "set "+option)
			if r.setFail == option {
				return fmt.Errorf("set %s refused", option)
			}
			return nil
		},
		remainOn: func(osUser, name string) error {
			r.log = append(r.log, "remain-on-exit")
			if r.remainFail {
				return fmt.Errorf("refused")
			}
			return nil
		},
		signal: func(osUser string, pid int) error {
			r.log = append(r.log, "sigterm")
			r.signalledUsers = append(r.signalledUsers, osUser)
			if r.signalFail {
				return fmt.Errorf("refused")
			}
			return nil
		},
		exited: func(pid int, grace time.Duration) bool {
			r.log = append(r.log, "wait")
			return !r.neverExits
		},
		emit: func(event, osUser string, attrs telemetry.Attrs) {
			r.log = append(r.log, "emit "+event+" "+fmt.Sprint(attrs["tl.rssBytes"]))
		},
	}
	return r
}

// The mark goes on AFTER the kill is confirmed, and everything the resume
// needs goes on before it. The resume acts on the mark with `respawn-pane -k`,
// so a mark over a live claude is a click away from destroying a conversation.
func TestSuspendSessionStampsTheTimestampAfterTheKill(t *testing.T) {
	r := newRecordingOps()
	s := suspendable("k7m2q9x4tpz3")
	s.State = stateDone
	if !suspendSession(r.ops, "wizard", s, time.Unix(testNow, 0)) {
		t.Fatalf("suspendSession refused a suspendable session: %v", r.log)
	}
	want := []string{
		"transcript", "pane", "inspect",
		"set " + resumeCmdOption,
		"set " + suspendStateOption,
		"remain-on-exit",
		"sigterm", "wait", "pane-dead",
		"set " + suspendedOption,
		"emit session.suspended 838860800",
	}
	if !reflect.DeepEqual(r.log, want) {
		t.Fatalf("the act ran in the wrong order:\n  got  %v\n  want %v", r.log, want)
	}
}

// The sweep runs over every mapped user and tmux-api runs as one of them, so
// the kill has to know whose process it is aiming at. Measured on this box
// 2026-09-19: an unprivileged kill from wizard against emo's claude is EPERM.
func TestSuspendSessionSignalsAsTheSessionsOwnUser(t *testing.T) {
	r := newRecordingOps()
	if !suspendSession(r.ops, "emo", suspendable("x"), time.Unix(testNow, 0)) {
		t.Fatalf("suspendSession refused: %v", r.log)
	}
	if !reflect.DeepEqual(r.signalledUsers, []string{"emo"}) {
		t.Fatalf("signalled as %v, want the session's own user [emo]", r.signalledUsers)
	}
}

// "Never suspend what cannot be resumed": no transcript, no suspend, and
// nothing written to the session at all.
func TestSuspendSessionSkipsASessionWithNoTranscript(t *testing.T) {
	r := newRecordingOps()
	r.noTranscript = true
	if suspendSession(r.ops, "wizard", suspendable("x"), time.Unix(testNow, 0)) {
		t.Fatal("suspendSession suspended a session whose transcript does not resolve")
	}
	if !reflect.DeepEqual(r.log, []string{"transcript"}) {
		t.Fatalf("it did more than look: %v", r.log)
	}
}

// Every failure leaves the session LIVE rather than half dead, so the stamps
// stop at the one that failed and no signal is ever sent.
func TestSuspendSessionStopsAtTheFirstFailure(t *testing.T) {
	for _, c := range []struct {
		why   string
		setup func(*recordingOps)
		last  string
	}{
		{"the resume command will not stamp", func(r *recordingOps) { r.setFail = resumeCmdOption }, "set " + resumeCmdOption},
		{"the saved state will not stamp", func(r *recordingOps) { r.setFail = suspendStateOption }, "set " + suspendStateOption},
		{"remain-on-exit will not set", func(r *recordingOps) { r.remainFail = true }, "remain-on-exit"},
	} {
		t.Run(c.why, func(t *testing.T) {
			r := newRecordingOps()
			c.setup(r)
			if suspendSession(r.ops, "wizard", suspendable("x"), time.Unix(testNow, 0)) {
				t.Fatal("suspendSession reported success after a failure")
			}
			if got := r.log[len(r.log)-1]; got != c.last {
				t.Fatalf("carried on past the failure: last step %q, want %q (%v)", got, c.last, r.log)
			}
			for _, step := range r.log {
				if step == "sigterm" {
					t.Fatalf("it signalled claude anyway: %v", r.log)
				}
				if step == "set "+suspendedOption {
					t.Fatalf("it marked the session suspended anyway: %v", r.log)
				}
			}
		})
	}
}

// An unflushed transcript is the one thing that makes a resume come back
// wrong, so a claude that will not go is left alone rather than SIGKILLed.
//
// And remain-on-exit STAYS ON. Putting it back while the SIGTERM is still in
// flight destroys the session the moment claude does exit: the shell's -c list
// ends, the one pane exits, and the session goes with it. Reproduced on this
// box, tmux 3.4, 2026-09-19 — remain-on-exit on, unwind, the process exits a
// moment later, `list-sessions` answers "no server running". So the step after
// the wait is nothing at all.
func TestSuspendSessionDoesNotEscalatePastSIGTERM(t *testing.T) {
	r := newRecordingOps()
	r.neverExits = true
	if suspendSession(r.ops, "wizard", suspendable("x"), time.Unix(testNow, 0)) {
		t.Fatal("suspendSession claimed success for a claude that never exited")
	}
	want := []string{
		"transcript", "pane", "inspect",
		"set " + resumeCmdOption,
		"set " + suspendStateOption,
		"remain-on-exit",
		"sigterm", "wait",
	}
	if !reflect.DeepEqual(r.log, want) {
		t.Fatalf("a kill that did not land should end at the wait:\n  got  %v\n  want %v", r.log, want)
	}
}

// A kill that cannot even be delivered — the EPERM case, which is every
// session that is not tmux-api's own user if the signal does not go through
// their tmux server — leaves the session unmarked and reading live.
//
// remain-on-exit stays on here too, for the same reason: `tmux run-shell kill`
// can report an error after the kill was delivered, and a session that is
// destroyed cannot be retried.
func TestSuspendSessionLeavesRemainOnExitOnWhenTheKillIsRefused(t *testing.T) {
	r := newRecordingOps()
	r.signalFail = true
	if suspendSession(r.ops, "emo", suspendable("x"), time.Unix(testNow, 0)) {
		t.Fatal("suspendSession claimed success after a refused kill")
	}
	want := []string{
		"transcript", "pane", "inspect",
		"set " + resumeCmdOption,
		"set " + suspendStateOption,
		"remain-on-exit",
		"sigterm",
	}
	if !reflect.DeepEqual(r.log, want) {
		t.Fatalf("a refused kill should end at the signal:\n  got  %v\n  want %v", r.log, want)
	}
}

// ---------------------------------------------------------------------------
// What the pane says AFTER the kill.

// The tmux-persist shape: `…; claude …; echo …; exec bash -l`. Killing the
// claude leaves the pane ALIVE with a bash in it (measured on tmux 3.4,
// 2026-09-19, and two of this box's sessions have that shape today). That bash
// holds no conversation and `respawn-pane -k` replaces it, so the session is
// genuinely suspended and the mark goes on.
//
// Refusing here instead would mean the sweep kills the claude of every
// restored session and then leaves it unmarked and unresumable — which is what
// a reboot makes of the whole box.
func TestSuspendSessionMarksARestoredSessionWhoseShellSurvived(t *testing.T) {
	r := newRecordingOps()
	r.paneAlive = true
	if !suspendSession(r.ops, "wizard", suspendable("x"), time.Unix(testNow, 0)) {
		t.Fatalf("suspendSession refused a session whose wrapper shell outlived its claude: %v", r.log)
	}
	if !slices.Contains(r.log, "set "+suspendedOption) {
		t.Fatalf("no mark was written, so nothing could resume it: %v", r.log)
	}
}

// A claude still under the pane after the kill is the one case the mark must
// not be written for: the resume respawns over whatever is in the pane, and
// that would be a live conversation.
func TestSuspendSessionWillNotMarkAPaneThatKeptItsClaude(t *testing.T) {
	r := newRecordingOps()
	r.paneAlive, r.claudeRespawned = true, true
	if suspendSession(r.ops, "wizard", suspendable("x"), time.Unix(testNow, 0)) {
		t.Fatal("suspendSession claimed success over a pane that still has a claude in it")
	}
	if slices.Contains(r.log, "set "+suspendedOption) {
		t.Fatalf("a pane with a live claude was marked suspended: %v", r.log)
	}
}

// A #{pane_dead} that cannot be read is not evidence the pane died, so the
// /proc look happens anyway.
func TestSuspendSessionChecksProcWhenThePaneCannotBeRead(t *testing.T) {
	r := newRecordingOps()
	r.paneUnreadable, r.claudeRespawned = true, true
	if suspendSession(r.ops, "wizard", suspendable("x"), time.Unix(testNow, 0)) {
		t.Fatal("an unreadable pane was treated as a dead one")
	}
	if r.inspects != 2 {
		t.Fatalf("/proc was looked at %d times, want 2 — the second is what catches a surviving claude", r.inspects)
	}
}

// ---------------------------------------------------------------------------
// The policy, re-applied at the moment of the kill.

// A sweep pass is not instant — each candidate costs a /proc walk, three
// set-options and a kill that waits up to 10s — so the list a candidate came
// from can be minutes old by the time its turn arrives. Everything that can
// change in those minutes is re-read in the pane call and checked again here.
func TestSuspendSessionDeclinesWhatTheSessionSaysNow(t *testing.T) {
	for _, c := range []struct {
		why   string
		facts paneFacts
	}{
		{"somebody opened it while the pass was running", paneFacts{attached: 1}},
		{"a turn started in it", paneFacts{state: stateRunning}},
		{"it is waiting on an answer", paneFacts{state: stateAwaiting}},
		{"an overlapping pass already marked it", paneFacts{suspendedAt: testNow - 60}},
		{"it is an agent-api conversation, which has no resume verb", paneFacts{agentOwner: "muse"}},
	} {
		r := newRecordingOps()
		r.facts = c.facts
		if suspendSession(r.ops, "wizard", suspendable("x"), time.Unix(testNow, 0)) {
			t.Fatalf("%s: suspendSession went ahead anyway", c.why)
		}
		if slices.Contains(r.log, "sigterm") {
			t.Fatalf("%s: it killed the claude: %v", c.why, r.log)
		}
		if slices.Contains(r.log, "remain-on-exit") {
			t.Fatalf("%s: it left remain-on-exit on a session it did not suspend: %v", c.why, r.log)
		}
	}
}

// @agent_owner is agent-api's option and this service only reads it, so the
// two spellings are pinned to each other rather than to a shared constant —
// they are separate Go modules.
func TestAgentOwnerOptionMatchesAgentAPI(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("..", "agent-api", "sessions.go"))
	if err != nil {
		t.Skipf("agent-api is not beside this module: %v", err)
	}
	want := `OptionOwner = "` + agentOwnerOption + `"`
	if !strings.Contains(string(src), want) {
		t.Fatalf("agent-api/sessions.go does not declare %s; this sweep reads an option nobody writes", want)
	}
}

// ---------------------------------------------------------------------------
// Repairing a suspend that stopped half way.

func TestHalfSuspendedNamesFindsADeadPaneWithNoMark(t *testing.T) {
	rows := []halfSuspendedRow{
		{name: "orphan", paneDead: true, resumeCmd: "/bin/zsh -lic 'claude --resume u'"},
		{name: "marked", paneDead: true, suspended: testNow, resumeCmd: "/bin/zsh -lic 'claude --resume u'"},
		{name: "live", paneDead: false, resumeCmd: "/bin/zsh -lic 'claude --resume u'"},
		{name: "ordinary", paneDead: true},
	}
	got := halfSuspendedNames(rows)
	if !reflect.DeepEqual(got, []string{"orphan"}) {
		t.Fatalf("halfSuspendedNames = %v, want [orphan]", got)
	}
}

// A live pane wearing a resume command is a suspend that failed BEFORE the
// kill, or a resume whose mark-clearing did not finish. Marking it would
// report a running conversation as suspended and invite a respawn over it.
func TestHalfSuspendedNamesLeavesALivePaneAlone(t *testing.T) {
	if got := halfSuspendedNames([]halfSuspendedRow{
		{name: "live", paneDead: false, resumeCmd: "claude --resume u"},
	}); len(got) != 0 {
		t.Fatalf("halfSuspendedNames = %v, want none", got)
	}
}

func TestParseHalfSuspendedKeepsTheResumeCommandWhole(t *testing.T) {
	// The command is last and holds every leftover separator: a quoted
	// argument can contain one and must not shift the fields ahead of it.
	line := "one" + listSep + "1" + listSep + "" + listSep + "/bin/sh -c 'claude --resume u\t--name x'"
	rows := parseHalfSuspended([]byte(line + "\n"))
	if len(rows) != 1 {
		t.Fatalf("parsed %d rows, want 1", len(rows))
	}
	if rows[0].resumeCmd != "/bin/sh -c 'claude --resume u\t--name x'" {
		t.Fatalf("resumeCmd = %q, the tab shifted the row", rows[0].resumeCmd)
	}
	if !rows[0].paneDead || rows[0].suspended != 0 {
		t.Fatalf("row = %+v, want a dead pane with no stamp", rows[0])
	}
}

func TestParseHalfSuspendedSkipsAShortRow(t *testing.T) {
	if rows := parseHalfSuspended([]byte("one" + listSep + "1\n")); len(rows) != 0 {
		t.Fatalf("parsed %v from a short row, want none", rows)
	}
}

// The event carries the idle time, so a query can say whether the threshold is
// set anywhere near right.
func TestSuspendSessionReportsIdleSeconds(t *testing.T) {
	var got telemetry.Attrs
	r := newRecordingOps()
	r.ops.emit = func(event, osUser string, attrs telemetry.Attrs) { got = attrs }
	s := suspendable("x")
	if !suspendSession(r.ops, "wizard", s, time.Unix(testNow, 0)) {
		t.Fatal("suspendSession refused")
	}
	if got["tl.idleSeconds"] != testNow-longAgo {
		t.Fatalf("tl.idleSeconds = %v, want %d", got["tl.idleSeconds"], testNow-longAgo)
	}
	if got["tl.session"] != "x" {
		t.Fatalf("tl.session = %v, want x", got["tl.session"])
	}
}

// ---------------------------------------------------------------------------
// The list wiring.

func TestTmuxListFmtHasOneColumnPerListField(t *testing.T) {
	if n := strings.Count(tmuxListFmt, listSep) + 1; n != listFields {
		t.Fatalf("tmuxListFmt has %d columns, listFields says %d", n, listFields)
	}
}

// pane_title has to stay last: SplitN hands the final field every separator
// the row had left over, which is the only thing protecting the columns ahead
// of it from a pane that prints one.
func TestSuspendedColumnSitsBeforePaneTitle(t *testing.T) {
	cols := strings.Split(tmuxListFmt, listSep)
	if cols[len(cols)-1] != "#{pane_title}" {
		t.Fatalf("the last column is %q, want #{pane_title}", cols[len(cols)-1])
	}
	if cols[suspendedColumn] != "#{"+suspendedOption+"}" {
		t.Fatalf("column %d is %q, want #{%s}", suspendedColumn, cols[suspendedColumn], suspendedOption)
	}
}

func TestParseSessionsReadsTheSuspendedStamp(t *testing.T) {
	row := suspendRow(map[int]string{suspendedColumn: strconv.FormatInt(oneHourAgo, 10)})
	got := parseSessions([]byte(row + "\n"))
	if len(got) != 1 {
		t.Fatalf("parsed %d sessions, want 1", len(got))
	}
	if got[0].SuspendedAt != oneHourAgo {
		t.Fatalf("SuspendedAt = %d, want %d", got[0].SuspendedAt, oneHourAgo)
	}
	if got[0].State != stateSuspended {
		t.Fatalf("State = %q, want %q — the stamp is what decides it", got[0].State, stateSuspended)
	}
}

// An unset option renders empty, which is every session that predates this
// feature. Those rows have to parse, or the sidebar empties on deploy.
func TestParseSessionsHandlesAnUnsetSuspendedStamp(t *testing.T) {
	got := parseSessions([]byte(suspendRow(nil) + "\n"))
	if len(got) != 1 {
		t.Fatalf("parsed %d sessions, want 1", len(got))
	}
	if got[0].SuspendedAt != 0 {
		t.Fatalf("SuspendedAt = %d, want 0", got[0].SuspendedAt)
	}
	if got[0].State != stateRunning {
		t.Fatalf("State = %q, want the hook's own value", got[0].State)
	}
}

// suspendRow builds a full tmuxListFmt row with sane defaults, overridden per
// column. Addressed by the column constants so it follows the format rather
// than pinning a copy of it.
func suspendRow(over map[int]string) string {
	cols := make([]string, listFields)
	for i := range cols {
		cols[i] = ""
	}
	cols[0] = "$1"
	cols[1] = "k7m2q9x4tpz3"
	cols[2] = "0"
	cols[3] = "1800000000"
	cols[4] = "1800000000"
	cols[5] = strconv.FormatInt(longAgo, 10)
	cols[6] = stateRunning
	cols[8] = "100"
	cols[9] = "zsh"
	cols[gridColsColumn] = "80"
	cols[gridRowsColumn] = "24"
	cols[listFields-1] = "a pane title"
	for i, v := range over {
		cols[i] = v
	}
	return strings.Join(cols, listSep)
}

// clearDeadStates blanks the state of a session with no claude under its pane.
// That is exactly what a suspended session looks like, and blanking it would
// drop it out of the suspended group in the sidebar the moment it landed there.
func TestClearDeadStatesLeavesASuspendedSessionAlone(t *testing.T) {
	dir := writeFakeProcFull(t, map[int]suspendProcEntry{
		100: {comm: "zsh", ppid: 1}, // suspended: the pane is dead, no claude
		200: {comm: "zsh", ppid: 1}, // an ordinary session whose claude died
	})
	tree, err := procTreeFrom(dir)
	if err != nil {
		t.Fatalf("procTreeFrom: %v", err)
	}
	sessions := []Session{
		{Name: "suspended", PanePID: 100, State: stateSuspended, SuspendedAt: oneHourAgo},
		{Name: "dead", PanePID: 200, State: stateRunning, Background: &Background{Agents: 1}},
	}
	clearDeadStates(sessions, tree)
	if sessions[0].State != stateSuspended {
		t.Fatalf("the suspended session's state = %q, want %q", sessions[0].State, stateSuspended)
	}
	if sessions[1].State != "" || sessions[1].Background != nil {
		t.Fatalf("a session whose claude really died kept %q / %+v", sessions[1].State, sessions[1].Background)
	}
}

func TestSuspendedIsAKnownState(t *testing.T) {
	if !knownStates[stateSuspended] {
		t.Fatalf("%q is not in knownStates, so parseSessions would drop it", stateSuspended)
	}
}

// The two events have to be in the catalog or telemetry.Emit drops them and
// the whole record of this feature is empty.
func TestSuspendEventsAreInTheCatalog(t *testing.T) {
	for _, name := range []string{"session.suspended", "session.resumed"} {
		if !telemetry.IsKnown(name) {
			t.Errorf("%q is not in the telemetry catalog — every one would be dropped", name)
		}
	}
}

// The whole suspend act rests on remain-on-exit being OFF everywhere except
// the one session being suspended. Turned on globally it would do two things
// at once: stop an ordinary `exit` from closing anybody's session, and make
// every dead pane look like a suspended one to a reader checking pane_dead.
// The box-wide config is the one place that could flip it for everyone.
func TestSystemTmuxConfigLeavesRemainOnExitAlone(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "devvm", "tmux.conf.system"))
	if err != nil {
		t.Skipf("tmux.conf.system not readable: %v", err)
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		if strings.Contains(line, "remain-on-exit") {
			t.Errorf("the box-wide tmux config touches remain-on-exit:\n  %s\n"+
				"Suspend sets it per session and expects the global to be off "+
				"(suspend.go, fact 1). A global `on` would stop an ordinary exit "+
				"closing a session for every user on the box.", strings.TrimSpace(line))
		}
	}
}

// claude's parent is the shell running the pane's -c list, and that shell only
// reaps its child on the way to exiting itself — so there is a window where
// claude has finished and /proc/<pid> still exists as a zombie. Reading the
// directory's presence alone would call that "still running", and the suspend
// would report failure for a session that had in fact gone.
func TestProcGoneCountsAZombieAsFinished(t *testing.T) {
	dir := t.TempDir()
	write := func(pid int, stat string) {
		d := filepath.Join(dir, strconv.Itoa(pid))
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(d, "stat"), []byte(stat), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(100, "100 (claude) S 1 1 1 0 -1 0 0\n")
	write(101, "101 (claude) Z 1 1 1 0 -1 0 0\n")
	write(102, "102 (weird) (comm) Z 1 1 1 0 -1 0 0\n")
	if procGone(dir, 100) {
		t.Error("a running process reads as gone")
	}
	if !procGone(dir, 101) {
		t.Error("a zombie reads as still running")
	}
	if !procGone(dir, 102) {
		t.Error("a zombie whose comm holds parens reads as still running")
	}
	if !procGone(dir, 999) {
		t.Error("a pid with no /proc entry reads as still running")
	}
}
