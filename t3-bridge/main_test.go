package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"terminal-lobby/sessionio"
)

// The argv T3 v0.0.34-nightly.20260815.1098 actually spawns the bridge with,
// captured live. Every test that says "a real spawn" starts from this.
var protoRealArgv = []string{
	"--output-format", "stream-json",
	"--input-format", "stream-json",
	"--verbose",
	"--model", "claude-opus-5",
	"--effort", "high",
	"--permission-prompt-tool", "stdio",
	"--mcp-config", `{"mcpServers":{"t3":{"type":"http","url":"http://127.0.0.1:3773/mcp"}}}`,
	"--setting-sources=user,project,local",
	"--permission-mode", "bypassPermissions",
	"--allow-dangerously-skip-permissions",
	"--include-partial-messages",
	"--add-dir", "/home/wizard/code/infra",
	"--add-dir", "/home/wizard/code/pages",
	"--resume", "6c420342-1111-2222-3333-444444444444",
}

func TestParseArgs(t *testing.T) {
	tests := []struct {
		name   string
		argv   []string
		want   Config
		errStr string
	}{
		{
			name: "a real T3 spawn",
			argv: protoRealArgv,
			want: Config{
				Resume:                 "6c420342-1111-2222-3333-444444444444",
				Model:                  "claude-opus-5",
				Effort:                 "high",
				PermissionMode:         "bypassPermissions",
				MCPConfig:              `{"mcpServers":{"t3":{"type":"http","url":"http://127.0.0.1:3773/mcp"}}}`,
				SettingSources:         "user,project,local",
				AddDirs:                []string{"/home/wizard/code/infra", "/home/wizard/code/pages"},
				IncludePartialMessages: true,
				SkipPermissions:        true,
			},
		},
		{
			name: "a new thread carries --session-id",
			argv: []string{"--output-format", "stream-json", "--session-id", "eb1a92c6-0000-0000-0000-000000000000"},
			want: Config{SessionID: "eb1a92c6-0000-0000-0000-000000000000"},
		},
		{
			// T3 uses both spellings in one command line.
			name: "joined and separated forms are the same flag",
			argv: []string{"--model=claude-opus-5", "--resume=abc", "--add-dir=/tmp/a", "--add-dir", "/tmp/b"},
			want: Config{Resume: "abc", Model: "claude-opus-5", AddDirs: []string{"/tmp/a", "/tmp/b"}},
		},
		{
			name: "an empty joined value is still a value",
			argv: []string{"--resume=abc", "--effort="},
			want: Config{Resume: "abc"},
		},
		{
			// T3 upgrades nightly; a flag we have never seen must not stop a
			// thread from opening.
			name: "unknown flags are kept, not rejected",
			argv: []string{"--resume", "abc", "--some-new-flag", "--another=1"},
			want: Config{Resume: "abc", Rest: []string{"--some-new-flag", "--another=1"}},
		},
		{
			name: "understood-but-ignored flags do not pollute Rest",
			argv: []string{"--resume", "abc", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--permission-prompt-tool", "stdio"},
			want: Config{Resume: "abc"},
		},
		{
			name: "an explicit false boolean is false",
			argv: []string{"--resume", "abc", "--include-partial-messages=false"},
			want: Config{Resume: "abc"},
		},
		{
			name:   "a value flag with nothing after it",
			argv:   []string{"--resume"},
			errStr: "--resume",
		},
		{
			// Without one of the two, nothing identifies a conversation — which
			// is exactly what T3's own capability probe looks like. Erroring
			// here used to exit the process, and T3 answers a provider that
			// exits mid-handshake by writing to its closed stdin and dying on
			// the unhandled EPIPE: it crash-looped wizard's instance every six
			// seconds for eight days (2026-08-20 -> 2026-08-28).
			name: "neither --session-id nor --resume is a probe, not an error",
			argv: []string{"--output-format", "stream-json", "--verbose"},
			want: Config{Probe: true},
		},
		{
			name: "a probe stays a probe even with model flags along for the ride",
			argv: []string{"--model", "opus", "--effort", "high"},
			want: Config{Probe: true, Model: "opus", Effort: "high"},
		},
		{
			// The safety property the probe mode was built for still holds: a
			// probe must never bind a tmux session to a conversation nobody
			// asked about.
			name: "a session id means it is not a probe",
			argv: []string{"--session-id", "abc"},
			want: Config{SessionID: "abc"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseArgs(tc.argv)
			if tc.errStr != "" {
				if err == nil {
					t.Fatalf("ParseArgs(%q) = %+v, want an error", tc.argv, got)
				}
				if !strings.Contains(err.Error(), tc.errStr) {
					t.Fatalf("error %q does not mention %q", err, tc.errStr)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseArgs(%q): %v", tc.argv, err)
			}
			// Argv and CWD are filled from the environment, not from the flags.
			got.Argv = nil
			got.CWD = ""
			if !configEqual(got, tc.want) {
				t.Fatalf("ParseArgs(%q) =\n%+v\nwant\n%+v", tc.argv, got, tc.want)
			}
		})
	}
}

func TestParseArgsKeepsTheOriginalArgvAndCWD(t *testing.T) {
	cfg, err := ParseArgs(protoRealArgv)
	if err != nil {
		t.Fatalf("ParseArgs: %v", err)
	}
	if !equalStrings(cfg.Argv, protoRealArgv) {
		t.Fatalf("Argv = %q, want the original", cfg.Argv)
	}
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd: %v", err)
	}
	if cfg.CWD != wd {
		t.Fatalf("CWD = %q, want %q — T3 sets cwd to the thread's workspace root", cfg.CWD, wd)
	}
}

func TestConfigIdentity(t *testing.T) {
	tests := []struct {
		name      string
		cfg       Config
		wantID    string
		wantFresh bool
	}{
		{"a resumed thread", Config{Resume: "r"}, "r", false},
		{"a new thread", Config{SessionID: "s"}, "s", true},
		{"both, resume wins", Config{Resume: "r", SessionID: "s"}, "r", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.cfg.ClaudeID(); got != tc.wantID {
				t.Fatalf("ClaudeID() = %q, want %q", got, tc.wantID)
			}
			if got := tc.cfg.NewThread(); got != tc.wantFresh {
				t.Fatalf("NewThread() = %v, want %v", got, tc.wantFresh)
			}
		})
	}
}

func TestDelegatesToClaude(t *testing.T) {
	tests := []struct {
		name string
		argv []string
		want bool
	}{
		{"the health probe", []string{"--version"}, true},
		{"short version", []string{"-v"}, true},
		{"auth is a leading subcommand", []string{"auth", "login"}, true},
		{"auth status", []string{"auth", "status"}, true},
		{"a real spawn", protoRealArgv, false},
		{"nothing at all", nil, false},
		// --model auth is absurd but it is not an auth invocation, and
		// delegating it would hand the whole stream-json spawn to claude.
		{"auth as a flag value", []string{"--model", "auth", "--resume", "x"}, false},
		{"auth deep in the argv", []string{"--resume", "x", "auth"}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := delegatesToClaude(tc.argv); got != tc.want {
				t.Fatalf("delegatesToClaude(%q) = %v, want %v", tc.argv, got, tc.want)
			}
		})
	}
}

func TestRealClaudePathPrefersTheEnvironment(t *testing.T) {
	stub := protoStubBinary(t, "#!/bin/sh\nexit 0\n")
	t.Setenv("TL_REAL_CLAUDE", stub)
	got, err := RealClaudePath()
	if err != nil {
		t.Fatalf("RealClaudePath: %v", err)
	}
	if got != stub {
		t.Fatalf("RealClaudePath() = %q, want %q", got, stub)
	}

	// The contract's spelling is honoured too, and the deployment's wins.
	t.Setenv("TL_REAL_CLAUDE", "")
	t.Setenv("TL_T3_BRIDGE_CLAUDE", stub)
	got, err = RealClaudePath()
	if err != nil {
		t.Fatalf("RealClaudePath: %v", err)
	}
	if got != stub {
		t.Fatalf("RealClaudePath() = %q, want %q", got, stub)
	}
}

// The environment is not trusted either: TL_REAL_CLAUDE=/path/to/the/bridge is
// a plausible typo in a unit file, and honouring it would fork-bomb the box.
func TestRealClaudePathRefusesAnEnvironmentPointingAtItself(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Skipf("cannot determine this test binary's path: %v", err)
	}
	shim := filepath.Join(t.TempDir(), "claude")
	if err := os.Symlink(self, shim); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	for _, env := range []string{self, shim} {
		t.Setenv("TL_T3_BRIDGE_CLAUDE", "")
		t.Setenv("TL_REAL_CLAUDE", env)
		// Whatever the fallbacks find, it must not be us. An error is a fine
		// outcome; returning ourselves is not.
		got, err := RealClaudePath()
		if err == nil && protoSameBinary(got, self) {
			t.Fatalf("RealClaudePath() = %q with TL_REAL_CLAUDE=%q, which is this binary", got, env)
		}
	}
}

// The guard that matters most in this file. T3's provider instance points at
// the bridge, so a deployment that installs the bridge under the name `claude`
// would have it find itself: every --version probe would fork a bridge, which
// would fork a bridge, until the box fell over.
func TestRealClaudeOnPathSkipsThisBinary(t *testing.T) {
	self := protoStubBinary(t, "#!/bin/sh\nexit 0\n")

	// A directory whose `claude` IS this binary, reached by a symlink — the
	// shape a PATH shim actually takes.
	shim := t.TempDir()
	if err := os.Symlink(self, filepath.Join(shim, "claude")); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	// A directory holding a hard link to it, which no path comparison catches.
	hard := t.TempDir()
	if err := os.Link(self, filepath.Join(hard, "claude")); err != nil {
		t.Fatalf("link: %v", err)
	}
	// And the genuine article, later in PATH.
	real := t.TempDir()
	realClaude := filepath.Join(real, "claude")
	if err := os.WriteFile(realClaude, []byte("#!/bin/sh\necho 2.1.233\n"), 0o755); err != nil {
		t.Fatalf("write: %v", err)
	}

	empty := t.TempDir()
	home := t.TempDir()

	tests := []struct {
		name    string
		dirs    []string
		want    string
		wantErr string
	}{
		{"the plain case", []string{real}, realClaude, ""},
		{"a symlinked shim is skipped", []string{shim, real}, realClaude, ""},
		{"a hard link is skipped", []string{hard, real}, realClaude, ""},
		{"both shims are skipped", []string{shim, hard, real}, realClaude, ""},
		{"directories without a claude are stepped over", []string{empty, real}, realClaude, ""},
		{"only ourselves on PATH", []string{shim, hard}, "", "would recurse"},
		{"no claude anywhere", []string{empty}, "", "no claude"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := protoClaudeOnPath(strings.Join(tc.dirs, string(os.PathListSeparator)), self, home)
			if tc.wantErr != "" {
				if err == nil {
					t.Fatalf("protoClaudeOnPath = %q, want an error", got)
				}
				if !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("error %q does not mention %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("protoClaudeOnPath: %v", err)
			}
			if got != tc.want {
				t.Fatalf("protoClaudeOnPath = %q, want %q", got, tc.want)
			}
		})
	}
}

// ~/.local/bin/claude is where claude installs itself on this box, and it is
// the last thing tried — a login shell's PATH is not a systemd unit's PATH.
func TestRealClaudeOnPathFallsBackToTheHomeInstall(t *testing.T) {
	self := protoStubBinary(t, "#!/bin/sh\nexit 0\n")
	home := t.TempDir()
	local := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(local, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	installed := filepath.Join(local, "claude")
	if err := os.WriteFile(installed, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatalf("write: %v", err)
	}

	got, err := protoClaudeOnPath(t.TempDir(), self, home)
	if err != nil {
		t.Fatalf("protoClaudeOnPath: %v", err)
	}
	if got != installed {
		t.Fatalf("protoClaudeOnPath = %q, want %q", got, installed)
	}

	// Even the home install is refused when it is us.
	shimHome := t.TempDir()
	shimLocal := filepath.Join(shimHome, ".local", "bin")
	if err := os.MkdirAll(shimLocal, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.Symlink(self, filepath.Join(shimLocal, "claude")); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	if _, err := protoClaudeOnPath(t.TempDir(), self, shimHome); err == nil {
		t.Fatal("protoClaudeOnPath accepted a home install that is this binary")
	}
}

// A non-executable file called claude is not a claude.
func TestRealClaudeOnPathIgnoresNonExecutables(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "claude"), []byte("notes"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := protoClaudeOnPath(dir, protoStubBinary(t, "#!/bin/sh\n"), t.TempDir()); err == nil {
		t.Fatal("protoClaudeOnPath accepted a non-executable file")
	}
}

func TestExecClaudePassesTheExitCodeThrough(t *testing.T) {
	tests := []struct {
		name   string
		script string
		want   int
	}{
		{"success", "#!/bin/sh\necho '2.1.233 (Claude Code)'\n", 0},
		{"failure", "#!/bin/sh\nexit 7\n", 7},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("TL_REAL_CLAUDE", protoStubBinary(t, tc.script))
			if got := execClaude([]string{"--version"}); got != tc.want {
				t.Fatalf("execClaude = %d, want %d", got, tc.want)
			}
		})
	}
}

func TestExecClaudeWithNoClaude(t *testing.T) {
	t.Setenv("TL_REAL_CLAUDE", filepath.Join(t.TempDir(), "absent"))
	if got := execClaude([]string{"--version"}); got != 127 {
		t.Fatalf("execClaude = %d, want 127", got)
	}
}

func configEqual(a, b Config) bool {
	return a.SessionID == b.SessionID &&
		a.Resume == b.Resume &&
		a.Model == b.Model &&
		a.Effort == b.Effort &&
		a.PermissionMode == b.PermissionMode &&
		a.MCPConfig == b.MCPConfig &&
		a.SettingSources == b.SettingSources &&
		a.IncludePartialMessages == b.IncludePartialMessages &&
		a.SkipPermissions == b.SkipPermissions &&
		equalStrings(a.AddDirs, b.AddDirs) &&
		equalStrings(a.Rest, b.Rest) &&
		equalStrings(a.Argv, b.Argv) &&
		a.CWD == b.CWD
}

// ---------------------------------------------------------------------------
// Wiring: resolve → (resurrect) → attach
// ---------------------------------------------------------------------------

// protoSideRig assembles the same collaborators protoTmuxSide builds from the
// real environment, with tmux faked and the state directories in a temp dir.
type protoSideRig struct {
	t    *testing.T
	tmux *attachFakeTmux
	out  *attachSyncBuf
	deps protoSideDeps
}

func newProtoSideRig(t *testing.T) *protoSideRig {
	t.Helper()
	tmux := newAttachFakeTmux()
	out := &attachSyncBuf{}
	return &protoSideRig{
		t:    t,
		tmux: tmux,
		out:  out,
		deps: protoSideDeps{
			OSUser:   "wizard",
			Tmux:     tmux,
			Bindings: OpenBindingsAt(filepath.Join(t.TempDir(), "index.json")),
			Cursors:  NewCursorStore(t.TempDir()),
			Claude:   "/home/wizard/.local/bin/claude",
			// Nothing here runs a real claude, so the stamp is faked; the wait
			// only has to outlast one poll.
			Wait: 2 * time.Second,
			Poll: time.Millisecond,
		},
	}
}

func (rig *protoSideRig) open(cfg Config) (protoSide, error) {
	rig.t.Helper()
	return rig.openAdopting(cfg, "")
}

func (rig *protoSideRig) openAdopting(cfg Config, adopting string) (protoSide, error) {
	rig.t.Helper()
	att, err := protoOpenSide(cfg, NewEncoder(rig.out), rig.deps, adopting)
	if att == nil {
		return nil, err
	}
	return att, err
}

// A session that is already running is attached to, not restarted: one Claude,
// two windows (decision 1).
func TestOpenSideAttachesToTheLiveSession(t *testing.T) {
	rig := newProtoSideRig(t)
	dir := t.TempDir()
	transcript := filepath.Join(dir, attachTestID+".jsonl")
	rig.tmux.start("feat-header", "/home/wizard/code/terminal-lobby", map[string]string{
		sessionio.OptionTranscript: transcript,
	})

	side, err := rig.open(Config{Resume: attachTestID, CWD: "/home/wizard/code/terminal-lobby"})
	if err != nil {
		t.Fatalf("protoOpenSide: %v", err)
	}
	attacher, ok := side.(*Attacher)
	if !ok {
		t.Fatalf("protoOpenSide returned %T, want *Attacher", side)
	}
	if got := attacher.Target(); got.TmuxName != "feat-header" || got.Transcript != transcript {
		t.Errorf("target = %+v, want the live session and its stamped transcript", got)
	}
	if len(rig.tmux.created) != 0 {
		t.Errorf("a live session was started again: %+v", rig.tmux.created)
	}
}

// A thread whose session is gone comes back under the name the index kept —
// silently, because dead-and-back is the normal case here (decision 10).
func TestOpenSideResurrectsFromTheIndex(t *testing.T) {
	rig := newProtoSideRig(t)
	root := t.TempDir()
	if err := rig.deps.Bindings.Record(Target{
		ClaudeID: attachTestID, TmuxName: "feat-header", CWD: "/home/wizard/code/terminal-lobby",
	}); err != nil {
		t.Fatalf("seed the index: %v", err)
	}
	rig.tmux.onNew = func(f *attachFakeTmux, spec sessionio.NewSessionSpec) {
		_ = f.SetOption("wizard", spec.Name, sessionio.OptionTranscript,
			sessionio.TranscriptPath(root, spec.Dir, attachTestID))
	}

	side, err := rig.open(Config{Resume: attachTestID, CWD: "/somewhere/t3/thinks"})
	if err != nil {
		t.Fatalf("protoOpenSide: %v", err)
	}
	if len(rig.tmux.created) != 1 {
		t.Fatalf("created %d sessions, want 1", len(rig.tmux.created))
	}
	spec := rig.tmux.created[0]
	if spec.Name != "feat-header" {
		t.Errorf("resurrected as %q, want the name the index remembered", spec.Name)
	}
	if spec.Dir != "/home/wizard/code/terminal-lobby" {
		t.Errorf("resurrected in %q, want the cwd the index remembered", spec.Dir)
	}
	if !strings.Contains(spec.Command[0], "--resume "+attachTestID) {
		t.Errorf("command %q does not resume the conversation", spec.Command[0])
	}
	if side.(*Attacher).Target().TmuxName != "feat-header" {
		t.Errorf("attached to %+v, want the resurrected session", side.(*Attacher).Target())
	}
}

// A thread born in T3 has no history anywhere: T3 assigned the uuid, and the
// session is named after the workspace root it opened.
func TestOpenSideStartsAT3BornThread(t *testing.T) {
	rig := newProtoSideRig(t)
	root := t.TempDir()
	ws := filepath.Join(t.TempDir(), "My Notes")
	if err := os.MkdirAll(ws, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	rig.tmux.onNew = func(f *attachFakeTmux, spec sessionio.NewSessionSpec) {
		_ = f.SetOption("wizard", spec.Name, sessionio.OptionTranscript,
			sessionio.TranscriptPath(root, spec.Dir, attachTestID))
	}

	if _, err := rig.open(Config{
		SessionID: attachTestID, CWD: ws,
		Model: "claude-opus-5", PermissionMode: "bypassPermissions",
		SkipPermissions: true, MCPConfig: `{"mcpServers":{}}`,
		AddDirs: []string{"/home/wizard/code"},
	}); err != nil {
		t.Fatalf("protoOpenSide: %v", err)
	}
	spec := rig.tmux.created[0]
	if spec.Name != "my-notes" {
		t.Errorf("session name = %q, want the slugged workspace directory", spec.Name)
	}
	cmd := spec.Command[0]
	if !strings.Contains(cmd, "--session-id "+attachTestID) {
		t.Errorf("command %q does not start the conversation under T3's uuid", cmd)
	}
	for _, want := range []string{"--model claude-opus-5", "--permission-mode bypassPermissions",
		"--dangerously-skip-permissions", "--add-dir /home/wizard/code", "--mcp-config"} {
		if !strings.Contains(cmd, want) {
			t.Errorf("command %q dropped %q", cmd, want)
		}
	}
}

// The failure has to reach the operator: T3 is holding a turn open, and a
// bridge that reports only into the journal leaves the thread spinning.
//
// It is reported on the PROMPT rather than at start-up now. Opening the tmux
// side is deferred until something needs it, so the frame that closes the turn
// is the one the turn was opened by; a bridge nobody prompts has no turn to
// close and says so in the journal instead.
func TestRunReportsAFailedTmuxSideIntoTheThread(t *testing.T) {
	tmux := newAttachFakeTmux()
	tmux.listErr = errors.New("no tmux server")
	restore := protoRealDeps
	t.Cleanup(func() { protoRealDeps = restore })
	protoRealDeps = func() (protoSideDeps, error) {
		return protoSideDeps{
			OSUser:   "wizard",
			Tmux:     tmux,
			Bindings: OpenBindingsAt(filepath.Join(t.TempDir(), "index.json")),
			Cursors:  NewCursorStore(t.TempDir()),
		}, nil
	}

	// Keep the handshake's version probe off the real claude: it is a
	// subprocess, and this test is about what reaches the thread.
	t.Setenv("TL_REAL_CLAUDE", protoStubBinary(t, "#!/bin/sh\necho '2.1.233 (Claude Code)'\n"))
	stdout := protoPipeStdio(t,
		`{"type":"control_request","request_id":"r1","request":{"subtype":"initialize"}}`,
		`{"type":"user","message":{"role":"user","content":"hello"}}`)

	if err := run(context.Background(), Config{Resume: attachTestID, CWD: t.TempDir()}); err != nil {
		t.Fatalf("run: %v", err)
	}
	frames := protoStdoutFrames(t, stdout)
	if len(frames) < 3 {
		t.Fatalf("emitted %d frames, want the control_response, system/init and a result: %v", len(frames), frames)
	}
	last := frames[len(frames)-1]
	if last["type"] != "result" || last["is_error"] != true {
		t.Errorf("last frame = %v, want an error result", last)
	}
	if !strings.Contains(fmt.Sprint(last["result"]), "no tmux server") {
		t.Errorf("result %v does not carry the reason", last["result"])
	}
}

// protoPipeStdio points the process's stdin at lines and its stdout at a temp
// file, restoring both afterwards. run() reads and writes the real descriptors
// — that is the contract with T3 — so exercising it means swapping them.
func protoPipeStdio(t *testing.T, lines ...string) *os.File {
	t.Helper()
	dir := t.TempDir()
	inPath := filepath.Join(dir, "stdin")
	if err := os.WriteFile(inPath, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatalf("write stdin: %v", err)
	}
	in, err := os.Open(inPath)
	if err != nil {
		t.Fatalf("open stdin: %v", err)
	}
	out, err := os.Create(filepath.Join(dir, "stdout"))
	if err != nil {
		t.Fatalf("create stdout: %v", err)
	}
	oldIn, oldOut := os.Stdin, os.Stdout
	os.Stdin, os.Stdout = in, out
	t.Cleanup(func() {
		os.Stdin, os.Stdout = oldIn, oldOut
		in.Close()
		out.Close()
	})
	return out
}

// protoStdoutFrames decodes what the bridge wrote to the swapped stdout.
func protoStdoutFrames(t *testing.T, out *os.File) []map[string]any {
	t.Helper()
	raw, err := os.ReadFile(out.Name())
	if err != nil {
		t.Fatalf("read stdout: %v", err)
	}
	var frames []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		if line == "" {
			continue
		}
		var frame map[string]any
		if err := json.Unmarshal([]byte(line), &frame); err != nil {
			t.Fatalf("stdout line %q is not a frame: %v", line, err)
		}
		frames = append(frames, frame)
	}
	return frames
}

// The syncer's drift check spawns this binary with a session id T3 never
// issued. Without the probe mode the bridge would treat that as a conversation
// to bring back — creating a tmux session and starting a claude in it, once per
// syncer restart.
func TestProbeModeAnswersTheHandshakeAndTouchesNothing(t *testing.T) {
	t.Setenv("TL_REAL_CLAUDE", protoStubBinary(t, "#!/bin/sh\necho '2.1.233 (Claude Code)'\n"))
	t.Setenv(ProbeEnv, "1")

	restore := protoRealDeps
	t.Cleanup(func() { protoRealDeps = restore })
	reached := false
	protoRealDeps = func() (protoSideDeps, error) {
		reached = true
		return protoSideDeps{}, errors.New("the probe reached the tmux side")
	}

	stdout := protoPipeStdio(t, `{"type":"control_request","request_id":"probe-1","request":{"subtype":"initialize"}}`)
	if err := run(context.Background(), Config{SessionID: attachTestID, CWD: t.TempDir()}); err != nil {
		t.Fatalf("run in probe mode: %v", err)
	}
	if reached {
		t.Error("the probe built a tmux side")
	}

	frames := protoStdoutFrames(t, stdout)
	if len(frames) != 2 {
		t.Fatalf("emitted %d frames, want exactly the control_response and system/init: %v", len(frames), frames)
	}
	if frames[0]["type"] != "control_response" || frames[1]["type"] != "system" || frames[1]["subtype"] != "init" {
		t.Errorf("frames = %v, want a control_response then system/init", frames)
	}
	if frames[1]["session_id"] != attachTestID {
		t.Errorf("session_id = %v, want the id the probe asked about", frames[1]["session_id"])
	}
}
