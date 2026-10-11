package sessionio

import (
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"
)

// clientSession is the session the one client attached to the server is on.
func clientSession(t *testing.T, sock string) string {
	t.Helper()
	out, err := exec.Command("tmux", "-L", sock, "list-clients", "-F", "#{client_session}").Output()
	if err != nil {
		t.Fatalf("list-clients: %v", err)
	}
	return strings.TrimSpace(string(out))
}

// press types the prefix then key into a client's terminal, as a person would.
func press(t *testing.T, c *client, key string) {
	t.Helper()
	if _, err := syscall.Write(c.fd, []byte{0x02}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	if _, err := syscall.Write(c.fd, []byte(key)); err != nil {
		t.Fatal(err)
	}
	time.Sleep(400 * time.Millisecond)
}

// guardServer is a scratch server with two sessions and tmux's own default
// bindings for the three keys, whatever the test runner's ~/.tmux.conf says.
func guardServer(t *testing.T) (*Injector, string, string) {
	t.Helper()
	in, osUser, sock := scratchSession(t)
	run(t, sock, "new-session", "-d", "-s", "other", "sh")
	run(t, sock, "set-option", "-g", "prefix", "C-b")
	run(t, sock, "bind-key", "-T", "prefix", "(", "switch-client", "-p")
	run(t, sock, "bind-key", "-T", "prefix", ")", "switch-client", "-n")
	run(t, sock, "bind-key", "-T", "prefix", "L", "switch-client", "-l")
	return in, osUser, sock
}

// The gap, measured: a read-only client switches to the owner's other session.
func TestReadOnlyClientSwitchesSessionsWithoutTheGuard(t *testing.T) {
	_, _, sock := guardServer(t)
	c := attach(t, sock, "demo", 100, 30, "-r")
	press(t, c, ")")
	if got := clientSession(t, sock); got == "demo" {
		t.Skip("this tmux does not let a read-only client switch; nothing to guard")
	}
}

func TestGuardReadOnlyKeepsAWatcherWhereItIs(t *testing.T) {
	in, osUser, sock := guardServer(t)
	if err := in.GuardReadOnly(osUser); err != nil {
		t.Fatalf("GuardReadOnly: %v", err)
	}
	c := attach(t, sock, "demo", 100, 30, "-r")
	for _, key := range []string{")", "(", "L"} {
		press(t, c, key)
		if got := clientSession(t, sock); got != "demo" {
			t.Fatalf("after prefix %s the watcher is on %q, want demo", key, got)
		}
	}
}

func TestGuardReadOnlyLeavesADriverItsKeys(t *testing.T) {
	in, osUser, sock := guardServer(t)
	if err := in.GuardReadOnly(osUser); err != nil {
		t.Fatalf("GuardReadOnly: %v", err)
	}
	c := attach(t, sock, "demo", 100, 30)
	press(t, c, ")")
	if got := clientSession(t, sock); got != "other" {
		t.Fatalf("the driver is on %q after prefix ), want other", got)
	}
}

// A key the account bound to something of its own is theirs; the guard only
// wraps tmux's defaults. Run twice, it changes nothing the second time.
func TestGuardReadOnlyOnlyWrapsTheDefaults(t *testing.T) {
	in, osUser, sock := guardServer(t)
	run(t, sock, "bind-key", "-T", "prefix", "L", "display-message", "mine")
	for i := 0; i < 2; i++ {
		if err := in.GuardReadOnly(osUser); err != nil {
			t.Fatalf("GuardReadOnly: %v", err)
		}
	}
	out, err := exec.Command("tmux", "-L", sock, "list-keys", "-T", "prefix").Output()
	if err != nil {
		t.Fatal(err)
	}
	keys := string(out)
	if !strings.Contains(keys, "display-message mine") {
		t.Fatalf("the account's own L binding was replaced:\n%s", keys)
	}
	if n := strings.Count(keys, "if-shell"); n != 2 {
		t.Fatalf("%d wrapped bindings, want 2:\n%s", n, keys)
	}
}

func TestParseDefaultSwitchBinding(t *testing.T) {
	for line, want := range map[string]string{
		`bind-key    -T prefix       (                      switch-client -p`:                 "(",
		`bind-key -r -T prefix       )                      switch-client -n`:                 ")",
		`bind-key    -T prefix       L                      switch-client -l`:                 "L",
		`bind-key    -T prefix       )                      if-shell -F 1 "switch-client -n"`: "",
		`bind-key    -T prefix       d                      detach-client`:                    "",
		`bind-key    -T prefix       L                      display-message mine`:              "",
	} {
		if got := defaultSwitchKey(line); got != want {
			t.Errorf("%q: %q, want %q", line, got, want)
		}
	}
}
