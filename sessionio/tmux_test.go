package sessionio

import (
	"os/exec"
	"os/user"
	"strings"
	"testing"
	"time"
)

// scratchSession starts an isolated tmux server holding one shell session named
// "demo" and returns an Injector bound to it, the current OS user, and the
// socket name. Skips where tmux (or the current user) is unavailable; the
// server dies with the test.
func scratchSession(t *testing.T) (*Injector, string, string) {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available")
	}
	u, err := user.Current()
	if err != nil {
		t.Skip("no current user")
	}
	sock := "se-test-" + strings.NewReplacer("/", "-", " ", "-").Replace(t.Name())
	exec.Command("tmux", "-L", sock, "kill-server").Run() // clean any leftover
	if err := exec.Command("tmux", "-L", sock, "new-session", "-d", "-s", "demo", "sh").Run(); err != nil {
		t.Fatalf("new-session: %v", err)
	}
	t.Cleanup(func() { exec.Command("tmux", "-L", sock, "kill-server").Run() })
	time.Sleep(150 * time.Millisecond)
	return NewInjectorOnSocket(u.Username, sock), u.Username, sock
}

// Exercises real tmux: start a scratch server + a shell session, inject a prompt,
// and confirm it reached the pty. Skips where tmux is unavailable.
func TestInjectPromptAndCancelIntegration(t *testing.T) {
	in, osUser, sock := scratchSession(t)

	if err := in.Prompt(osUser, "demo", "echo hello123marker"); err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	time.Sleep(400 * time.Millisecond)

	out, err := exec.Command("tmux", "-L", sock, "capture-pane", "-p", "-t", "demo").Output()
	if err != nil {
		t.Fatalf("capture-pane: %v", err)
	}
	if !strings.Contains(string(out), "hello123marker") {
		t.Fatalf("injected prompt not visible in pane:\n%s", out)
	}

	if err := in.Cancel(osUser, "demo"); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
}

// An interrupt ends the turn but never fires Claude's Stop hook, which is the
// only writer of "done" (/etc/claude-code/managed-settings.json). So Cancel
// owns the transition: whatever state the stamp was left in, the turn is over
// once the interrupt lands. Without this, @claude_state latches at "running"
// and main.go's /prompt gate answers 409 for the life of the session — proven
// on a live Claude session: 30 s of polling after `send-keys C-c`, pane idle at
// its prompt, stamp still "running".
//
// An UNSTAMPED session is left alone: no Claude ever ran in it, and stamping
// would grow a state dot for a plain shell in the sidebar.
func TestCancelReDerivesStateAfterInterrupt(t *testing.T) {
	for _, tc := range []struct{ name, seed, want string }{
		{"latched running becomes done", StateRunning, StateDone},
		{"stale awaiting becomes done", "awaiting", StateDone},
		{"unstamped stays unstamped", "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in, osUser, sock := scratchSession(t)
			if tc.seed != "" {
				if err := exec.Command("tmux", "-L", sock, "set-option", "-t", "demo",
					"@claude_state", tc.seed).Run(); err != nil {
					t.Fatalf("seed @claude_state=%s: %v", tc.seed, err)
				}
			}

			if err := in.Cancel(osUser, "demo"); err != nil {
				t.Fatalf("Cancel: %v", err)
			}

			if got := in.State(osUser, "demo"); got != tc.want {
				t.Fatalf("@claude_state after Cancel = %q, want %q (seeded %q)",
					got, tc.want, tc.seed)
			}
		})
	}
}

// A prompt must submit exactly what the composer sent, and nothing the pane
// happened to be holding.
//
// Stop is what makes this bite: Claude Code puts the interrupted prompt BACK on
// its input line, so the next composer prompt was submitted concatenated onto
// it — measured 2026-08-06 as the transcript recording one user line reading
// "Write out the numbers 1 to 400, one per line, nothing else.PING" when the
// operator had typed only PING. The cancelled work re-ran, so Stop was
// effectively undone. A draft a human left in the pane from the Terminal view
// did the same thing, silently.
func TestPromptSubmitsOnlyItsOwnTextWhenThePaneHoldsADraft(t *testing.T) {
	in, osUser, sock := scratchSession(t)

	// Whatever the pane was already holding — a restored prompt, a human's draft.
	if err := exec.Command("tmux", "-L", sock, "send-keys", "-t", "demo", "LEFTOVER-DRAFT").Run(); err != nil {
		t.Fatalf("seed draft: %v", err)
	}
	time.Sleep(200 * time.Millisecond)

	if err := in.Prompt(osUser, "demo", "echo PING123"); err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	time.Sleep(600 * time.Millisecond)

	out, err := exec.Command("tmux", "-L", sock, "capture-pane", "-p", "-t", "demo").Output()
	if err != nil {
		t.Fatalf("capture-pane: %v", err)
	}
	pane := string(out)
	found := false
	for _, line := range strings.Split(pane, "\n") {
		if strings.TrimSpace(line) == "PING123" {
			found = true
		}
	}
	if !found {
		t.Fatalf("the prompt did not run on its own; pane:\n%s", pane)
	}
	if strings.Contains(pane, "LEFTOVER-DRAFTecho") {
		t.Fatalf("the pane's draft was submitted together with the prompt; pane:\n%s", pane)
	}
}

// scratchServer starts an EMPTY isolated tmux server and returns an Injector
// bound to it. The lifecycle verbs below are destructive, so they are only ever
// pointed at a server of their own: a `-L` socket no real session lives on.
func scratchServer(t *testing.T) (*Injector, string, string) {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available")
	}
	u, err := user.Current()
	if err != nil {
		t.Skip("no current user")
	}
	sock := "sio-test-" + strings.NewReplacer("/", "-", " ", "-").Replace(t.Name())
	exec.Command("tmux", "-L", sock, "kill-server").Run() // clean any leftover
	t.Cleanup(func() { exec.Command("tmux", "-L", sock, "kill-server").Run() })
	return NewInjectorOnSocket(u.Username, sock), u.Username, sock
}

// The resurrection path is create-then-drive: a thread whose tmux session is
// gone gets a new one, in the right directory, running the right command, and
// must then be reachable as an ordinary session.
func TestNewSessionCreatesADrivableSession(t *testing.T) {
	in, osUser, _ := scratchServer(t)
	dir := t.TempDir()

	if in.HasSession(osUser, "t3e2e-fresh") {
		t.Fatal("the scratch server is not empty")
	}
	if err := in.NewSession(NewSessionSpec{
		OSUser: osUser, Name: "t3e2e-fresh", Dir: dir,
		Command: []string{"sh"},
		Env:     map[string]string{"TL_MARKER": "resurrected"},
	}); err != nil {
		t.Fatalf("NewSession: %v", err)
	}
	if !in.HasSession(osUser, "t3e2e-fresh") {
		t.Fatal("the session was created but does not resolve")
	}

	// It is a real session: options stamp, and the directory and environment
	// asked for are the ones it got. Claude reads several env vars at startup,
	// so passing them at creation is the only chance.
	if err := in.SetOption(osUser, "t3e2e-fresh", OptionThread, "thread-1"); err != nil {
		t.Fatalf("SetOption on the new session: %v", err)
	}
	if v, ok := in.Option(osUser, "t3e2e-fresh", OptionThread); !ok || v != "thread-1" {
		t.Fatalf("@t3_thread = (%q, %v)", v, ok)
	}
	if v, ok := in.Option(osUser, "t3e2e-fresh", "session_path"); !ok || v != dir {
		t.Fatalf("session_path = (%q, %v), want %q", v, ok, dir)
	}
	out, err := in.Command(osUser, "show-environment", "-t", "t3e2e-fresh", "TL_MARKER").Output()
	if err != nil || strings.TrimSpace(string(out)) != "TL_MARKER=resurrected" {
		t.Fatalf("session environment = %q (%v), want TL_MARKER=resurrected", out, err)
	}
}

// Creating over a name that is already taken must FAIL. Resurrection asks for a
// session it believes is dead; if it is not, silently attaching to whatever
// holds the name would paste a thread's prompts into somebody else's live
// conversation.
func TestNewSessionRefusesAnExistingName(t *testing.T) {
	in, osUser, _ := scratchServer(t)
	spec := NewSessionSpec{OSUser: osUser, Name: "t3e2e-taken", Command: []string{"sh"}}
	if err := in.NewSession(spec); err != nil {
		t.Fatalf("first NewSession: %v", err)
	}
	if err := in.NewSession(spec); err == nil {
		t.Fatal("NewSession overwrote a live session with the same name")
	}
	if err := in.NewSession(NewSessionSpec{OSUser: osUser, Name: ""}); err == nil {
		t.Fatal("NewSession accepted an empty session name")
	}
}

func TestListSessionsAndKillSession(t *testing.T) {
	in, osUser, _ := scratchServer(t)

	// No server running at all is an ordinary state — a user with nothing open
	// — not a failure the syncer should report as broken tmux.
	got, err := in.ListSessions(osUser)
	if err != nil {
		t.Fatalf("ListSessions on an empty server: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("empty server listed %+v", got)
	}

	dir := t.TempDir()
	for _, name := range []string{"t3e2e-one", "t3e2e-two"} {
		if err := in.NewSession(NewSessionSpec{OSUser: osUser, Name: name, Dir: dir, Command: []string{"sh"}}); err != nil {
			t.Fatalf("NewSession %s: %v", name, err)
		}
	}

	got, err = in.ListSessions(osUser)
	if err != nil {
		t.Fatalf("ListSessions: %v", err)
	}
	names := map[string]string{}
	for _, s := range got {
		names[s.Name] = s.Dir
	}
	if len(names) != 2 || names["t3e2e-one"] != dir || names["t3e2e-two"] != dir {
		t.Fatalf("ListSessions = %+v, want both sessions with dir %s", got, dir)
	}

	if err := in.KillSession(osUser, "t3e2e-one"); err != nil {
		t.Fatalf("KillSession: %v", err)
	}
	if in.HasSession(osUser, "t3e2e-one") {
		t.Fatal("the killed session still resolves")
	}
	if !in.HasSession(osUser, "t3e2e-two") {
		t.Fatal("killing one session took the other with it")
	}
	if err := in.KillSession(osUser, "t3e2e-one"); err == nil {
		t.Fatal("KillSession reported success for a session that does not exist")
	}
}

// HasSession must not be fooled the way a naive option read is: tmux exits 0
// for an unknown target (measured, 3.4), so "no such session" and "session with
// nothing set" would otherwise look identical.
func TestHasSessionDistinguishesMissingFromUnstamped(t *testing.T) {
	in, osUser, _ := scratchSession(t)
	if !in.HasSession(osUser, "demo") {
		t.Fatal("a live, unstamped session reads as missing")
	}
	if in.HasSession(osUser, "no-such-session") {
		t.Fatal("a session that does not exist reads as live")
	}
}
