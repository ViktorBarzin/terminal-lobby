package sessionio

import (
	"os/exec"
	"os/user"
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
