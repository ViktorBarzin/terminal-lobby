package main

import (
	"errors"
	"os/exec"
	"os/user"
	"strings"
	"sync"
	"testing"
)

// fakeTmuxOptions stands in for the tmux option store: a set of LIVE sessions,
// each holding its options. Killing a session drops its options with it, which
// is the property the durable registry leans on.
type fakeTmuxOptions struct {
	mu       sync.Mutex
	sessions map[string]map[string]string // "<osUser>/<session>" -> option -> value
}

func newFakeTmuxOptions(live ...string) *fakeTmuxOptions {
	f := &fakeTmuxOptions{sessions: map[string]map[string]string{}}
	for _, s := range live {
		f.sessions[s] = map[string]string{}
	}
	return f
}

func (f *fakeTmuxOptions) Option(osUser, session, name string) (string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	opts, ok := f.sessions[osUser+"/"+session]
	if !ok {
		return "", false // no such tmux session
	}
	return opts[name], true
}

func (f *fakeTmuxOptions) SetOption(osUser, session, name, value string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	opts, ok := f.sessions[osUser+"/"+session]
	if !ok {
		return errors.New("can't find session: " + session) // what tmux says
	}
	opts[name] = value
	return nil
}

// kill models `tmux kill-session`: the session and every option on it go away.
func (f *fakeTmuxOptions) kill(osUser, session string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.sessions, osUser+"/"+session)
}

// start models a fresh `tmux new-session` under a name: live, no options.
func (f *fakeTmuxOptions) start(osUser, session string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sessions[osUser+"/"+session] = map[string]string{}
}

func TestTranscriptPathSlug(t *testing.T) {
	got := transcriptPath("/home/wizard/.claude/projects", "/home/wizard/code/terminal-lobby", "abc-123")
	want := "/home/wizard/.claude/projects/-home-wizard-code-terminal-lobby/abc-123.jsonl"
	if got != want {
		t.Fatalf("transcriptPath =\n %s\nwant %s", got, want)
	}
}

func TestSessionMapStampsAndReadsBackTheTranscript(t *testing.T) {
	opts := newFakeTmuxOptions("wizard/demo")
	sm := newSessionMap("wizard", "/home/wizard/.claude/projects", opts)

	if err := sm.put(sessionInfo{TmuxSession: "demo", CWD: "/home/wizard/x", ClaudeID: "s1"}); err != nil {
		t.Fatalf("put: %v", err)
	}
	info, ok := sm.get("demo")
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
	opts := newFakeTmuxOptions("wizard/demo")
	before := newSessionMap("wizard", "/home/wizard/.claude/projects", opts)
	if err := before.put(sessionInfo{TmuxSession: "demo", CWD: "/home/wizard/x", ClaudeID: "s1"}); err != nil {
		t.Fatalf("put: %v", err)
	}

	// A restart: brand-new process state, the same tmux server underneath.
	after := newSessionMap("wizard", "/home/wizard/.claude/projects", opts)
	info, ok := after.get("demo")
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
	opts := newFakeTmuxOptions("wizard/qa-reuse")
	sm := newSessionMap("wizard", "/home/wizard/.claude/projects", opts)
	if err := sm.put(sessionInfo{TmuxSession: "qa-reuse", CWD: "/home/wizard/x", ClaudeID: "s1"}); err != nil {
		t.Fatalf("put: %v", err)
	}

	opts.kill("wizard", "qa-reuse")
	if _, ok := sm.get("qa-reuse"); ok {
		t.Fatal("a killed tmux session still resolves")
	}

	opts.start("wizard", "qa-reuse") // same name, a plain shell this time
	if _, ok := sm.get("qa-reuse"); ok {
		t.Fatal("a reused tmux name still serves the dead session's transcript")
	}
}

// The stamp is read back from a store the session's own OS user can write, so
// it is treated as untrusted input: a path outside that user's projects root is
// refused rather than opened.
func TestSessionMapRefusesTranscriptOutsideTheUsersProjects(t *testing.T) {
	const root = "/home/bob/.claude/projects"
	opts := newFakeTmuxOptions("bob/demo")
	sm := newSessionMap("bob", root, opts)

	for _, bad := range []string{
		"/home/wizard/.claude/projects/-x/s1.jsonl",            // another user's transcript
		root + "/../../../wizard/.claude/projects/-x/s1.jsonl", // traversal
		root + "/-x/s1.txt", // not a transcript
	} {
		opts.SetOption("bob", "demo", transcriptOption, bad)
		if info, ok := sm.get("demo"); ok {
			t.Fatalf("stamp %q was accepted: %+v", bad, info)
		}
	}

	// A traversing cwd/session id cannot be stamped in the first place.
	if err := sm.put(sessionInfo{TmuxSession: "demo", CWD: "/x", ClaudeID: "../../../../etc/passwd"}); err == nil {
		t.Fatal("put accepted a session id that escapes the projects root")
	}
}

func TestSessionMapUnstampedSessionDoesNotResolve(t *testing.T) {
	opts := newFakeTmuxOptions("wizard/plain-shell")
	sm := newSessionMap("wizard", "/home/wizard/.claude/projects", opts)
	if _, ok := sm.get("plain-shell"); ok {
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
	in := &Injector{selfUser: u.Username, socket: sock}

	if v, ok := in.Option(u.Username, "demo", transcriptOption); !ok || v != "" {
		t.Fatalf("unset option = (%q, %v), want (\"\", true)", v, ok)
	}
	if err := in.SetOption(u.Username, "demo", transcriptOption, "/tmp/x/s1.jsonl"); err != nil {
		t.Fatalf("SetOption: %v", err)
	}
	if v, ok := in.Option(u.Username, "demo", transcriptOption); !ok || v != "/tmp/x/s1.jsonl" {
		t.Fatalf("stamped option = (%q, %v)", v, ok)
	}
	if v, ok := in.Option(u.Username, "no-such-session", transcriptOption); ok {
		t.Fatalf("missing session = (%q, %v), want ok=false", v, ok)
	}
}
