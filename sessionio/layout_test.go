package sessionio

import (
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"testing"

	"terminal-lobby/sessionio/siotest"
)

// The fake is the shared one, so a change to it is felt by every module that
// leans on it. This assertion is what keeps it honest against the real
// interface — siotest cannot import sessionio without a cycle, so the check
// belongs on this side.
var _ Options = (*siotest.FakeOptions)(nil)

func TestTranscriptPathSlug(t *testing.T) {
	got := TranscriptPath("/home/wizard/.claude/projects", "/home/wizard/code/terminal-lobby", "abc-123")
	want := "/home/wizard/.claude/projects/-home-wizard-code-terminal-lobby/abc-123.jsonl"
	if got != want {
		t.Fatalf("transcriptPath =\n %s\nwant %s", got, want)
	}
}

// The slug has to be Claude Code's own, character for character, or the bridge
// tails a file nothing ever writes. The wants below are REAL directory names
// read off ~/.claude/projects on this box, which is why the dotted ones matter:
// a worktree under .worktrees/ is the standing workflow here, and every one of
// them was previously stamped with a path that does not exist.
func TestTranscriptSlugMatchesClaudeCode(t *testing.T) {
	for _, tc := range []struct{ name, cwd, want string }{
		{"plain", "/home/wizard/code/terminal-lobby", "-home-wizard-code-terminal-lobby"},
		{"leading-dot component", "/home/wizard/code/infra/.worktrees/ingress-factory-nullguard",
			"-home-wizard-code-infra--worktrees-ingress-factory-nullguard"},
		{"dot inside a component", "/tmp/tl-t3-e2e.9eW/ws", "-tmp-tl-t3-e2e-9eW-ws"},
		{"underscore", "/home/wizard/my_dir", "-home-wizard-my-dir"},
		{"space", "/home/wizard/two words", "-home-wizard-two-words"},
		{"case is kept", "/home/wizard/CamelCase", "-home-wizard-CamelCase"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := TranscriptSlug(tc.cwd); got != tc.want {
				t.Fatalf("TranscriptSlug(%q) = %q, want %q", tc.cwd, got, tc.want)
			}
		})
	}
}

// Over 200 characters Claude Code truncates and appends a hash of the ORIGINAL
// path, so two long siblings do not collide. The hash is a 32-bit
// h = h*31 + charCode accumulator, absolute value, base 36.
func TestTranscriptSlugTruncatesLongPathsLikeClaudeCode(t *testing.T) {
	// Both wants come from running claude 2.1.233's own WE() over the same
	// input; they are here so the hash is pinned to the reference rather than to
	// this port of it.
	long := "/home/wizard/" + strings.Repeat("abcdefghij/", 25) // 288 characters
	head := strings.ReplaceAll(long, "/", "-")[:200]
	for _, tc := range []struct{ cwd, want string }{
		{long, head + "-10l5cp"},
		{long + "x", head + "-vi7lu7"},
	} {
		if got := TranscriptSlug(tc.cwd); got != tc.want {
			t.Fatalf("TranscriptSlug(%d chars) =\n %s\nwant %s", len(tc.cwd), got, tc.want)
		}
	}
}

func TestSessionMapStampsAndReadsBackTheTranscript(t *testing.T) {
	opts := siotest.NewFakeOptions("wizard/demo")
	sm := NewSessionMap("wizard", "/home/wizard/.claude/projects", opts)

	if err := sm.Put(SessionInfo{TmuxSession: "demo", CWD: "/home/wizard/x", ClaudeID: "s1"}); err != nil {
		t.Fatalf("put: %v", err)
	}
	info, ok := sm.Get("demo")
	if !ok {
		t.Fatal("session 'demo' does not resolve after put")
	}
	if info.Transcript != "/home/wizard/.claude/projects/-home-wizard-x/s1.jsonl" {
		t.Fatalf("info = %+v", info)
	}
}

// The mapping has to outlive the PROCESS that recorded it: session-events is
// restarted by every deploy, and an in-memory map turns each restart into
// "404 session not registered" for every Claude session already running.
func TestSessionMapOutlivesTheProcessThatRecordedIt(t *testing.T) {
	opts := siotest.NewFakeOptions("wizard/demo")
	before := NewSessionMap("wizard", "/home/wizard/.claude/projects", opts)
	if err := before.Put(SessionInfo{TmuxSession: "demo", CWD: "/home/wizard/x", ClaudeID: "s1"}); err != nil {
		t.Fatalf("put: %v", err)
	}

	// A restart: brand-new process state, the same tmux server underneath.
	after := NewSessionMap("wizard", "/home/wizard/.claude/projects", opts)
	info, ok := after.Get("demo")
	if !ok {
		t.Fatal("the mapping did not survive the restart — every live session 404s")
	}
	if info.Transcript != "/home/wizard/.claude/projects/-home-wizard-x/s1.jsonl" {
		t.Fatalf("info after restart = %+v", info)
	}
}

// ...and it must NOT outlive the tmux session it describes. Kill a Claude
// session and start a plain shell under the same name and the old transcript
// must stop resolving, or the pane serves a dead conversation.
func TestSessionMapDiesWithItsTmuxSession(t *testing.T) {
	opts := siotest.NewFakeOptions("wizard/qa-reuse")
	sm := NewSessionMap("wizard", "/home/wizard/.claude/projects", opts)
	if err := sm.Put(SessionInfo{TmuxSession: "qa-reuse", CWD: "/home/wizard/x", ClaudeID: "s1"}); err != nil {
		t.Fatalf("put: %v", err)
	}

	opts.Kill("wizard", "qa-reuse")
	if _, ok := sm.Get("qa-reuse"); ok {
		t.Fatal("a killed tmux session still resolves")
	}

	opts.Start("wizard", "qa-reuse") // same name, a plain shell this time
	if _, ok := sm.Get("qa-reuse"); ok {
		t.Fatal("a reused tmux name still serves the dead session's transcript")
	}
}

// The stamp is read back from a store the session's own OS user can write, so
// it is treated as untrusted input: a path outside that user's projects root is
// refused rather than opened.
func TestSessionMapRefusesTranscriptOutsideTheUsersProjects(t *testing.T) {
	const root = "/home/bob/.claude/projects"
	opts := siotest.NewFakeOptions("bob/demo")
	sm := NewSessionMap("bob", root, opts)

	for _, bad := range []string{
		"/home/wizard/.claude/projects/-x/s1.jsonl",            // another user's transcript
		root + "/../../../wizard/.claude/projects/-x/s1.jsonl", // traversal
		root + "/-x/s1.txt", // not a transcript
	} {
		opts.SetOption("bob", "demo", OptionTranscript, bad)
		if info, ok := sm.Get("demo"); ok {
			t.Fatalf("stamp %q was accepted: %+v", bad, info)
		}
	}

	// A traversing cwd/session id cannot be stamped in the first place.
	if err := sm.Put(SessionInfo{TmuxSession: "demo", CWD: "/x", ClaudeID: "../../../../etc/passwd"}); err == nil {
		t.Fatal("put accepted a session id that escapes the projects root")
	}
}

func TestSessionMapUnstampedSessionDoesNotResolve(t *testing.T) {
	opts := siotest.NewFakeOptions("wizard/plain-shell")
	sm := NewSessionMap("wizard", "/home/wizard/.claude/projects", opts)
	if _, ok := sm.Get("plain-shell"); ok {
		t.Fatal("a tmux session nobody registered must not resolve")
	}
}

// The fake above is only honest if real tmux agrees: an option written by one
// process reads back in another, and an unset option reads empty.
//
// A missing session is where tmux does NOT help — `display-message -t
// no-such-session` exits 0 with everything empty (measured, tmux 3.4), so the
// ok=false below comes from Option checking the session name it got back, not
// from tmux reporting the mistake.
func TestInjectorOptionRoundTripAgainstRealTmux(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available")
	}
	u, err := user.Current()
	if err != nil {
		t.Skip("no current user")
	}
	sock := "se-test-" + strings.NewReplacer("/", "-", " ", "-").Replace(t.Name())
	exec.Command("tmux", "-L", sock, "kill-server").Run()
	if err := exec.Command("tmux", "-L", sock, "new-session", "-d", "-s", "demo", "sh").Run(); err != nil {
		t.Fatalf("new-session: %v", err)
	}
	t.Cleanup(func() { exec.Command("tmux", "-L", sock, "kill-server").Run() })
	in := NewInjectorOnSocket(u.Username, sock)

	if v, ok := in.Option(u.Username, "demo", OptionTranscript); !ok || v != "" {
		t.Fatalf("unset option = (%q, %v), want (\"\", true)", v, ok)
	}
	if err := in.SetOption(u.Username, "demo", OptionTranscript, "/tmp/x/s1.jsonl"); err != nil {
		t.Fatalf("SetOption: %v", err)
	}
	if v, ok := in.Option(u.Username, "demo", OptionTranscript); !ok || v != "/tmp/x/s1.jsonl" {
		t.Fatalf("stamped option = (%q, %v)", v, ok)
	}
	if v, ok := in.Option(u.Username, "no-such-session", OptionTranscript); ok {
		t.Fatalf("missing session = (%q, %v), want ok=false", v, ok)
	}
}

// The model a session is running is knowable from its own transcript, and it is
// read from the END: a session's model can change mid-conversation, and what a
// reader wants is what it is answering with now.
func TestTranscriptModelReadsTheLastAnswer(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.jsonl")
	var b strings.Builder
	b.WriteString(`{"type":"user","message":{"role":"user","content":"hi"}}` + "\n")
	b.WriteString(`{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-4","content":[]}}` + "\n")
	// Padding past the tail window, so the seek path is the one exercised.
	for b.Len() < 80*1024 {
		b.WriteString(`{"type":"system","subtype":"noise","content":"` + strings.Repeat("x", 200) + `"}` + "\n")
	}
	b.WriteString(`{"type":"assistant","message":{"role":"assistant","model":"claude-opus-5","content":[]}}` + "\n")
	if err := os.WriteFile(path, []byte(b.String()), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if got := TranscriptModel(path); got != "claude-opus-5" {
		t.Fatalf("TranscriptModel = %q, want claude-opus-5", got)
	}
	if got := TranscriptModel(filepath.Join(t.TempDir(), "absent.jsonl")); got != "" {
		t.Fatalf("TranscriptModel on a missing file = %q, want empty", got)
	}
}

// TranscriptCWD is the shared answer to "where is this conversation actually
// happening"; both the bridge and the syncer file bindings by it.
func TestTranscriptCWDReadsTheOpeningRecords(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.jsonl")
	body := `{"type":"system","subtype":"start"}` + "\n" +
		`{"type":"user","cwd":"/home/wizard/code/tl/.worktrees/x","message":{"role":"user","content":"hi"}}` + "\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if got := TranscriptCWD(path); got != "/home/wizard/code/tl/.worktrees/x" {
		t.Fatalf("TranscriptCWD = %q", got)
	}
}

// The harness NAMES the transcript it is writing, and that name is the only
// reliable one: Claude Code files a session under the directory it STARTED in,
// while the hook reports the cwd of the moment. An agent that cds into a
// worktree — which the house workflow asks for on every task — then re-registers
// against a path that does not exist, and the Text view tails nothing. Measured
// 2026-08-28: 2 of 16 live sessions on this box were stamped with a file that
// was never written, both of them cds away from where Claude was launched.
func TestSessionMapPrefersTheTranscriptTheHarnessNamed(t *testing.T) {
	const root = "/home/wizard/.claude/projects"
	opts := siotest.NewFakeOptions("wizard/demo")
	sm := NewSessionMap("wizard", root, opts)

	// Launched in ~/code, now working in a worktree under it.
	if err := sm.Put(SessionInfo{
		TmuxSession: "demo",
		CWD:         "/home/wizard/code/tripit/.worktrees/viewer",
		ClaudeID:    "s1",
		Transcript:  root + "/-home-wizard-code-tripit/s1.jsonl",
	}); err != nil {
		t.Fatalf("put: %v", err)
	}
	info, ok := sm.Get("demo")
	if !ok {
		t.Fatal("session 'demo' does not resolve after put")
	}
	if info.Transcript != root+"/-home-wizard-code-tripit/s1.jsonl" {
		t.Fatalf("stamped the cwd-derived path instead of the harness's: %+v", info)
	}
}

// A supplied path is as untrusted as one read back: the hook runs as the
// session's own user and posts to a loopback endpoint anything on the box could
// reach.
func TestSessionMapRefusesASuppliedTranscriptOutsideTheProjectsRoot(t *testing.T) {
	const root = "/home/bob/.claude/projects"
	opts := siotest.NewFakeOptions("bob/demo")
	sm := NewSessionMap("bob", root, opts)

	for _, bad := range []string{
		"/home/wizard/.claude/projects/-x/s1.jsonl",
		root + "/../../../wizard/.claude/projects/-x/s1.jsonl",
		root + "/-x/s1.txt",
	} {
		err := sm.Put(SessionInfo{
			TmuxSession: "demo", CWD: "/home/bob/x", ClaudeID: "s1", Transcript: bad,
		})
		if err == nil {
			t.Fatalf("supplied transcript %q was accepted", bad)
		}
	}
}
