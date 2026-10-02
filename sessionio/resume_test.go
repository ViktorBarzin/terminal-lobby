package sessionio

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// resumeRecorder stands in for tmux and /proc and records what Resume asked
// of them, in order.
type resumeRecorder struct {
	facts          SuspendedFacts
	readOK         bool
	claudeThere    bool
	procUnreadable bool
	hasConvo       bool
	respawnOut     string
	respawnErr     error

	log       []string
	respawned []string
	stampedAt int64
}

func (r *resumeRecorder) ops() ResumeOps {
	return ResumeOps{
		Read: func(_, _ string) (SuspendedFacts, bool) {
			r.log = append(r.log, "read")
			return r.facts, r.readOK
		},
		ClaudeUnderPane: func(int) (bool, bool) {
			r.log = append(r.log, "proc")
			return r.claudeThere, !r.procUnreadable
		},
		HasConversation: func(_, _ string) bool {
			r.log = append(r.log, "probe")
			return r.hasConvo
		},
		Respawn: func(_, pane string, argv []string) (string, error) {
			r.log = append(r.log, "respawn "+pane)
			r.respawned = argv
			return r.respawnOut, r.respawnErr
		},
		ClearMarks: func(_, name, saved string) {
			r.log = append(r.log, "clear "+name+":"+saved)
		},
		StampDriven: func(_, _ string, at int64) {
			r.log = append(r.log, "stamp")
			r.stampedAt = at
		},
		Now: func() time.Time { return time.Unix(1_800_000_000, 0) },
	}
}

func suspendedRecorder() *resumeRecorder {
	return &resumeRecorder{
		readOK:   true,
		hasConvo: true,
		facts: SuspendedFacts{
			PaneID:      "%42",
			SuspendedAt: 1_799_990_000,
			SavedState:  StateDone,
			PaneDead:    true,
			Transcript:  "/home/u/.claude/projects/p/abc.jsonl",
			ResumeCmd:   `/bin/zsh -lic 'claude --resume abc --effort max'`,
		},
	}
}

func TestResumeRespawnsTheStoredCommandThenClearsAndStamps(t *testing.T) {
	r := suspendedRecorder()
	res, err := Resume(r.ops(), "u", "s")
	if err != nil {
		t.Fatalf("Resume: %v", err)
	}
	want := []string{"/bin/zsh", "-lic", "claude --resume abc --effort max"}
	if !reflect.DeepEqual(r.respawned, want) {
		t.Fatalf("respawned %q, want %q", r.respawned, want)
	}
	// The marks only after the respawn, and the clock after that: a failed
	// respawn must leave a session that still reads as suspended.
	wantLog := []string{"read", "probe", "respawn %42", "clear s:done", "stamp"}
	if !reflect.DeepEqual(r.log, wantLog) {
		t.Fatalf("order = %v, want %v", r.log, wantLog)
	}
	if r.stampedAt != 1_800_000_000 || res.SuspendedAt != 1_799_990_000 {
		t.Fatalf("stamped %d, result %+v", r.stampedAt, res)
	}
}

func TestResumeDeclines(t *testing.T) {
	for _, c := range []struct {
		why   string
		setup func(*resumeRecorder)
		want  error
	}{
		{"the session cannot be read", func(r *resumeRecorder) { r.readOK = false }, ErrSessionGone},
		{"it carries no mark", func(r *resumeRecorder) { r.facts.SuspendedAt = 0 }, ErrNotSuspended},
		{"a live pane and /proc will not say what is in it", func(r *resumeRecorder) {
			r.facts.PaneDead, r.procUnreadable = false, true
		}, ErrPaneUnknown},
		{"the stored command does not parse", func(r *resumeRecorder) { r.facts.ResumeCmd = `claude 'unterminated` }, ErrResumeCmdUnreadable},
		{"the stored command is empty", func(r *resumeRecorder) { r.facts.ResumeCmd = "" }, ErrResumeCmdUnreadable},
		{"no pane id", func(r *resumeRecorder) { r.facts.PaneID = "" }, ErrSessionGone},
		{"the transcript is gone", func(r *resumeRecorder) { r.hasConvo = false }, ErrNothingToResume},
	} {
		r := suspendedRecorder()
		c.setup(r)
		_, err := Resume(r.ops(), "u", "s")
		if !errors.Is(err, c.want) {
			t.Errorf("%s: err = %v, want %v", c.why, err, c.want)
		}
		if r.respawned != nil {
			t.Errorf("%s: it respawned the pane anyway", c.why)
		}
		for _, l := range r.log {
			if strings.HasPrefix(l, "clear") || l == "stamp" {
				t.Errorf("%s: it touched the marks (%v), which would leave the session unresumable", c.why, r.log)
			}
		}
	}
}

// A restored session's shell outlives its claude, so a live pane with no
// claude under it is a good mark and is what respawn-pane -k replaces.
func TestResumeRespawnsALivePaneThatLostItsClaude(t *testing.T) {
	r := suspendedRecorder()
	r.facts.PaneDead = false
	if _, err := Resume(r.ops(), "u", "s"); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if r.respawned == nil {
		t.Fatal("a live pane holding only a shell was not respawned")
	}
}

// A claude under the pane means the mark is stale: respawning would kill a
// running conversation, so the mark goes instead.
func TestResumeClearsAStaleMarkInsteadOfRespawning(t *testing.T) {
	r := suspendedRecorder()
	r.facts.PaneDead, r.claudeThere = false, true
	res, err := Resume(r.ops(), "u", "s")
	if !errors.Is(err, ErrNotSuspended) || !res.StaleMarkCleared {
		t.Fatalf("err = %v, result %+v; want ErrNotSuspended with the stale mark cleared", err, res)
	}
	if r.respawned != nil {
		t.Fatal("it respawned over a running claude")
	}
	if !reflect.DeepEqual(r.log, []string{"read", "proc", "clear s:done"}) {
		t.Fatalf("log = %v", r.log)
	}
}

func TestResumeKeepsTheMarksWhenTheRespawnFails(t *testing.T) {
	r := suspendedRecorder()
	r.respawnErr, r.respawnOut = errors.New("exit status 1"), "something broke"
	_, err := Resume(r.ops(), "u", "s")
	if !errors.Is(err, ErrRespawnFailed) {
		t.Fatalf("err = %v, want ErrRespawnFailed", err)
	}
	for _, l := range r.log {
		if strings.HasPrefix(l, "clear") {
			t.Fatalf("marks cleared after a failed respawn: %v", r.log)
		}
	}
}

func TestResumeMapsAMissingTargetToGone(t *testing.T) {
	r := suspendedRecorder()
	r.respawnErr, r.respawnOut = errors.New("exit status 1"), "can't find pane: %42"
	if _, err := Resume(r.ops(), "u", "s"); err == nil {
		t.Fatal("a failed respawn reported success")
	}
	r = suspendedRecorder()
	r.respawnErr, r.respawnOut = errors.New("exit status 1"), "no server running on /tmp/tmux-1000/default"
	if _, err := Resume(r.ops(), "u", "s"); !errors.Is(err, ErrSessionGone) {
		t.Fatalf("err = %v, want ErrSessionGone", err)
	}
}

func TestSplitArgv(t *testing.T) {
	for _, c := range []struct {
		in   string
		want []string
	}{
		{`a b  c`, []string{"a", "b", "c"}},
		{`/bin/zsh -lic 'claude --resume u'`, []string{"/bin/zsh", "-lic", "claude --resume u"}},
		{`'it'\''s'`, []string{"it's"}},
		{`"a \"b\""`, []string{`a "b"`}},
		{`''`, []string{""}},
	} {
		got, ok := SplitArgv(c.in)
		if !ok || !reflect.DeepEqual(got, c.want) {
			t.Errorf("SplitArgv(%q) = %q, %v; want %q", c.in, got, ok, c.want)
		}
	}
	for _, bad := range []string{`'open`, `"open`, `trailing\`} {
		if _, ok := SplitArgv(bad); ok {
			t.Errorf("SplitArgv(%q) read a command it cannot read", bad)
		}
	}
}

func TestParseSuspendedKeepsTheCommandInTheLastField(t *testing.T) {
	cmd := "/bin/sh -c 'a\tb'"
	line := strings.Join([]string{"s", "%3", "1700", "awaiting", "1", "99", "/t.jsonl", cmd}, "\t") + "\n"
	f, ok := parseSuspended(line, "s")
	if !ok {
		t.Fatal("parseSuspended refused a well-formed line")
	}
	want := SuspendedFacts{PaneID: "%3", SuspendedAt: 1700, SavedState: "awaiting", PaneDead: true,
		PanePID: 99, Transcript: "/t.jsonl", ResumeCmd: cmd}
	if f != want {
		t.Fatalf("parsed %+v, want %+v", f, want)
	}
	if _, ok := parseSuspended(line, "other"); ok {
		t.Fatal("a line for another session was taken as this one's")
	}
}

func TestClaudeUnderPID(t *testing.T) {
	dir := t.TempDir()
	write := func(pid, comm, ppid string) {
		if err := os.MkdirAll(filepath.Join(dir, pid), 0o755); err != nil {
			t.Fatal(err)
		}
		line := pid + " (" + comm + ") S " + ppid + " 1 1 0"
		if err := os.WriteFile(filepath.Join(dir, pid, "stat"), []byte(line), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("10", "zsh", "1")
	write("11", "node (x)", "10")
	write("12", "claude", "11")
	write("20", "bash", "1")
	if there, ok := ClaudeUnderPID(dir, 10); !ok || !there {
		t.Fatalf("claude two levels under 10: there=%v ok=%v", there, ok)
	}
	if there, ok := ClaudeUnderPID(dir, 20); !ok || there {
		t.Fatalf("nothing under 20: there=%v ok=%v", there, ok)
	}
	if _, ok := ClaudeUnderPID(filepath.Join(dir, "missing"), 10); ok {
		t.Fatal("an unreadable /proc answered")
	}
}

// The live primitives against an isolated tmux server: a suspended session as
// tmux-api leaves one (a dead pane under remain-on-exit, three marks, and a
// transcript on disk) comes back running the stored command, with its marks
// gone and its state put back.
func TestLiveResumeBringsBackADeadPane(t *testing.T) {
	in, user, sock := scratchSession(t)
	run := func(args ...string) string {
		out, err := exec.Command("tmux", append([]string{"-L", sock}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("tmux %v: %v: %s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	transcript := filepath.Join(t.TempDir(), "abc.jsonl")
	if err := os.WriteFile(transcript, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("set-option", "-t", "=demo:", "remain-on-exit", "on")
	run("respawn-pane", "-k", "-t", "=demo:", "true")
	deadline := time.Now().Add(3 * time.Second)
	for run("display-message", "-p", "-t", "=demo:", "#{pane_dead}") != "1" {
		if time.Now().After(deadline) {
			t.Fatal("the pane never died")
		}
		time.Sleep(50 * time.Millisecond)
	}
	for opt, v := range map[string]string{
		OptionTranscript:   transcript,
		OptionResumeCmd:    "sh -c 'sleep 30'",
		OptionSuspendState: StateDone,
		OptionSuspended:    "1700000000",
	} {
		run("set-option", "-t", "=demo:", opt, v)
	}

	res, err := Resume(in.LiveResumeOps("/proc", t.Logf), user, "demo")
	if err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if res.SuspendedAt != 1700000000 {
		t.Fatalf("SuspendedAt = %d", res.SuspendedAt)
	}
	if got := run("display-message", "-p", "-t", "=demo:", "#{pane_dead}"); got != "0" {
		t.Fatalf("pane_dead = %q after the resume", got)
	}
	got := run("display-message", "-p", "-t", "=demo:",
		"#{"+OptionSuspended+"}|#{"+OptionResumeCmd+"}|#{"+OptionSuspendState+"}|#{"+OptionState+"}")
	if got != "|||done" {
		t.Fatalf("marks after resume = %q, want only the state put back", got)
	}
	if v, _ := in.Option(user, "demo", OptionLastDrive); v == "" {
		t.Fatal("the resume did not stamp the drive clock")
	}
}

// Until 2026-10-02 agent-api passed its rules as a file in /tmp/agent-api,
// a directory any account on the box could create first after a reboot, and
// a suspend copies Claude's argv, that path included, into @tl_resume_cmd.
// A resume points such a command at the file's new home, which only
// agent-api's account can write, once that file is there.
func TestResumeMovesTheAgentRulesOutOfTmp(t *testing.T) {
	r := suspendedRecorder()
	r.facts.ResumeCmd = "/usr/local/bin/claude --resume e99b --append-system-prompt-file " +
		LegacyAgentRulesPath + " --permission-mode bypassPermissions"
	ops := r.ops()
	ops.FileExists = func(p string) bool { return p == AgentRulesPath }
	if _, err := Resume(ops, "u", "s"); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	want := []string{"/usr/local/bin/claude", "--resume", "e99b", "--append-system-prompt-file",
		AgentRulesPath, "--permission-mode", "bypassPermissions"}
	if !reflect.DeepEqual(r.respawned, want) {
		t.Fatalf("respawned %q, want %q", r.respawned, want)
	}
}

// The same inside a shell command line, the shape a wrapped launch has.
func TestResumeMovesTheAgentRulesOutOfTmpInsideAShellLine(t *testing.T) {
	r := suspendedRecorder()
	r.facts.ResumeCmd = `/bin/sh -c 'claude --resume e99b --append-system-prompt-file ` + LegacyAgentRulesPath + `; exec bash -l'`
	ops := r.ops()
	ops.FileExists = func(p string) bool { return p == AgentRulesPath }
	if _, err := Resume(ops, "u", "s"); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if len(r.respawned) != 3 || strings.Contains(r.respawned[2], LegacyAgentRulesPath) ||
		!strings.Contains(r.respawned[2], "--append-system-prompt-file "+AgentRulesPath+";") {
		t.Fatalf("respawned %q", r.respawned)
	}
}

// With no file at the new home yet, the command is left as it was: pointing
// Claude at a missing file would end the resume with Claude exiting and the
// session gone.
func TestResumeLeavesTheRulesPathWhenTheNewFileIsMissing(t *testing.T) {
	r := suspendedRecorder()
	r.facts.ResumeCmd = "claude --append-system-prompt-file " + LegacyAgentRulesPath
	ops := r.ops()
	ops.FileExists = func(string) bool { return false }
	if _, err := Resume(ops, "u", "s"); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if want := []string{"claude", "--append-system-prompt-file", LegacyAgentRulesPath}; !reflect.DeepEqual(r.respawned, want) {
		t.Fatalf("respawned %q, want %q", r.respawned, want)
	}
}
