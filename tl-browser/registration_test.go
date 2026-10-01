package main

import (
	"bufio"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeTmux plays tmux for one session's options and records every call.
type fakeTmux struct {
	sessionID string
	opts      map[string]string
	calls     []string
}

func (f *fakeTmux) run(args ...string) (string, error) {
	f.calls = append(f.calls, strings.Join(args, " "))
	switch {
	case len(args) >= 1 && args[0] == "display-message":
		return f.sessionID + "\n", nil
	case len(args) == 5 && args[0] == "show-options" && args[1] == "-v":
		v, ok := f.opts[args[4]]
		if !ok {
			return "", errors.New("invalid option")
		}
		return v + "\n", nil
	case len(args) == 5 && args[0] == "set-option" && args[1] == "-u":
		delete(f.opts, args[4])
		return "", nil
	case len(args) == 5 && args[0] == "set-option" && args[1] == "-t":
		f.opts[args[3]] = args[4]
		return "", nil
	}
	return "", errors.New("unexpected tmux call: " + strings.Join(args, " "))
}

// staleSocket leaves a socket file behind with nothing listening, as a host
// killed with SIGKILL does.
func staleSocket(t *testing.T, path string) {
	t.Helper()
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	ln.(*net.UnixListener).SetUnlinkOnClose(false)
	ln.Close()
}

func liveSocket(t *testing.T, path string) {
	t.Helper()
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func newRegistration(t *testing.T, tm *fakeTmux) (Registration, string) {
	t.Helper()
	rt := t.TempDir()
	dir := filepath.Join(rt, "tl-browser")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	return Registration{
		Env:  []string{"TMUX=/tmp/tmux-1000/default,1,0", "TMUX_PANE=%7", "XDG_RUNTIME_DIR=" + rt},
		UID:  1000,
		Tmux: tm.run,
	}, dir
}

func TestClearAfterADeadHostRemovesItsOptionsAndSocket(t *testing.T) {
	tm := &fakeTmux{sessionID: "$12", opts: map[string]string{}}
	r, dir := newRegistration(t, tm)
	sock := filepath.Join(dir, "s12.sock")
	staleSocket(t, sock)
	tm.opts["@tl_browser"] = "frozen"
	tm.opts["@tl_browser_sock"] = sock

	r.Clear(4242)

	if exists(sock) {
		t.Errorf("stale socket %s is still there", sock)
	}
	if len(tm.opts) != 0 {
		t.Errorf("options left on the session: %v", tm.opts)
	}
	for _, c := range tm.calls {
		if strings.HasPrefix(c, "set-option") && !strings.Contains(c, "-t %7") {
			t.Errorf("tmux call not aimed at the launcher's pane: %q", c)
		}
	}
}

func TestClearRemovesTheSecondHostsOwnSocketName(t *testing.T) {
	// A host that found another live host on s12.sock listens on s12-<pid>.sock.
	tm := &fakeTmux{sessionID: "$12", opts: map[string]string{}}
	r, dir := newRegistration(t, tm)
	other := filepath.Join(dir, "s12.sock")
	liveSocket(t, other)
	mine := filepath.Join(dir, "s12-4242.sock")
	staleSocket(t, mine)
	tm.opts["@tl_browser"] = "live"
	tm.opts["@tl_browser_sock"] = mine

	r.Clear(4242)

	if exists(mine) {
		t.Errorf("stale socket %s is still there", mine)
	}
	if !exists(other) {
		t.Errorf("the other host's live socket was removed")
	}
	if len(tm.opts) != 0 {
		t.Errorf("options left on the session: %v", tm.opts)
	}
}

func TestClearLeavesAnotherLiveHostsRegistrationAlone(t *testing.T) {
	// Two Claudes in one tmux session: the other host registered last and is
	// still serving, so the options are its, not ours.
	tm := &fakeTmux{sessionID: "$12", opts: map[string]string{}}
	r, dir := newRegistration(t, tm)
	mine := filepath.Join(dir, "s12.sock")
	staleSocket(t, mine)
	other := filepath.Join(dir, "s12-5151.sock")
	liveSocket(t, other)
	tm.opts["@tl_browser"] = "live"
	tm.opts["@tl_browser_sock"] = other

	r.Clear(4242)

	if exists(mine) {
		t.Errorf("stale socket %s is still there", mine)
	}
	if !exists(other) {
		t.Errorf("the other host's live socket was removed")
	}
	if tm.opts["@tl_browser"] != "live" || tm.opts["@tl_browser_sock"] != other {
		t.Errorf("the other host's options were touched: %v", tm.opts)
	}
}

func TestClearNeverRemovesALiveSocket(t *testing.T) {
	tm := &fakeTmux{sessionID: "$12", opts: map[string]string{}}
	r, dir := newRegistration(t, tm)
	sock := filepath.Join(dir, "s12.sock")
	liveSocket(t, sock)
	tm.opts["@tl_browser"] = "live"
	tm.opts["@tl_browser_sock"] = sock

	r.Clear(4242)

	if !exists(sock) {
		t.Errorf("a live socket was removed")
	}
	if len(tm.opts) != 2 {
		t.Errorf("a live host's options were cleared: %v", tm.opts)
	}
}

func TestClearLeavesAFileThatIsNotASocket(t *testing.T) {
	tm := &fakeTmux{sessionID: "$12", opts: map[string]string{}}
	r, dir := newRegistration(t, tm)
	path := filepath.Join(dir, "s12.sock")
	if err := os.WriteFile(path, []byte("not a socket"), 0o600); err != nil {
		t.Fatal(err)
	}

	r.Clear(4242)

	if !exists(path) {
		t.Errorf("a regular file was removed")
	}
}

func TestClearAfterACleanExitIsHarmless(t *testing.T) {
	// The host already unregistered itself; clearing again changes nothing.
	tm := &fakeTmux{sessionID: "$12", opts: map[string]string{}}
	r, _ := newRegistration(t, tm)

	r.Clear(4242)

	if len(tm.opts) != 0 {
		t.Errorf("options appeared: %v", tm.opts)
	}
}

func TestClearOutsideTmuxRemovesThePidSocketOnly(t *testing.T) {
	tm := &fakeTmux{opts: map[string]string{}}
	r, dir := newRegistration(t, tm)
	r.Env = []string{"XDG_RUNTIME_DIR=" + filepath.Dir(dir)}
	sock := filepath.Join(dir, "pid-4242.sock")
	staleSocket(t, sock)

	r.Clear(4242)

	if exists(sock) {
		t.Errorf("stale socket %s is still there", sock)
	}
	if len(tm.calls) != 0 {
		t.Errorf("tmux was called outside tmux: %q", tm.calls)
	}
}

func TestSocketDirFallsBackToTmp(t *testing.T) {
	if got := socketDir(nil, 1000); got != "/tmp/tl-browser-1000" {
		t.Errorf("socketDir without XDG_RUNTIME_DIR = %q", got)
	}
	if got := socketDir([]string{"XDG_RUNTIME_DIR=/run/user/1000"}, 1000); got != "/run/user/1000/tl-browser" {
		t.Errorf("socketDir = %q", got)
	}
}

func TestSocketNameMatchesTheHost(t *testing.T) {
	cases := []struct {
		session string
		want    string
	}{
		{"$12", "s12"},
		{"$0", "s0"},
		{"", "pid-77"},
		{"12", "pid-77"},
		{"$1x", "pid-77"},
	}
	for _, c := range cases {
		if got := socketName(c.session, 77); got != c.want {
			t.Errorf("socketName(%q) = %q, want %q", c.session, got, c.want)
		}
	}
}

// helloHost is a live host's viewer socket: it answers a connection's first
// line with a host hello in the given state, and records the hello it got.
func helloHost(t *testing.T, path, state string) chan string {
	t.Helper()
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	got := make(chan string, 8)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				line, err := bufio.NewReader(c).ReadString('\n')
				if err != nil {
					return
				}
				got <- strings.TrimSpace(line)
				c.Write([]byte(`{"t":"hello","state":"` + state + `","tabs":[],"agentTab":null}` + "\n"))
			}()
		}
	}()
	return got
}

func TestClearHandsTheOptionsToTheSessionsOtherLiveHost(t *testing.T) {
	// Two Claudes in one tmux session. The host that registered last exited,
	// cleanly (it unset the options itself) or killed (its socket is stale).
	// The first host is still serving, so the options go back to it, in its
	// own state, rather than leaving a running browser the lobby cannot see.
	for _, c := range []struct {
		name   string
		killed bool
	}{{"clean exit", false}, {"killed", true}} {
		t.Run(c.name, func(t *testing.T) {
			tm := &fakeTmux{sessionID: "$12", opts: map[string]string{}}
			r, dir := newRegistration(t, tm)
			first := filepath.Join(dir, "s12.sock")
			hellos := helloHost(t, first, "frozen")
			if c.killed {
				mine := filepath.Join(dir, "s12-4242.sock")
				staleSocket(t, mine)
				tm.opts["@tl_browser"] = "live"
				tm.opts["@tl_browser_sock"] = mine
			}

			r.Clear(4242)

			if tm.opts["@tl_browser_sock"] != first || tm.opts["@tl_browser"] != "frozen" {
				t.Fatalf("options %v, want the first host's socket in its state", tm.opts)
			}
			// Asking its state must not let the launcher drive it.
			select {
			case h := <-hellos:
				if !strings.Contains(h, `"canControl":false`) {
					t.Errorf("hello %s, want a watch-only one", h)
				}
			default:
				t.Error("the other host was never asked its state")
			}
		})
	}
}

func TestClearHandsOverToASecondHostsSocketName(t *testing.T) {
	// The first host was the one that registered last and exited; the one
	// still serving took s12-<pid>.sock.
	tm := &fakeTmux{sessionID: "$12", opts: map[string]string{}}
	r, dir := newRegistration(t, tm)
	mine := filepath.Join(dir, "s12.sock")
	staleSocket(t, mine)
	tm.opts["@tl_browser"] = "live"
	tm.opts["@tl_browser_sock"] = mine
	other := filepath.Join(dir, "s12-5151.sock")
	helloHost(t, other, "live")

	r.Clear(4242)

	if tm.opts["@tl_browser_sock"] != other || tm.opts["@tl_browser"] != "live" {
		t.Fatalf("options %v, want %s live", tm.opts, other)
	}
}

func TestClearHandsOverOnlyToThisSessionsHosts(t *testing.T) {
	tm := &fakeTmux{sessionID: "$12", opts: map[string]string{}}
	r, dir := newRegistration(t, tm)
	helloHost(t, filepath.Join(dir, "s120.sock"), "live")
	helloHost(t, filepath.Join(dir, "s1.sock"), "live")
	helloHost(t, filepath.Join(dir, "s12-x.sock"), "live")
	// A socket that accepts but is not a host answering a hello.
	liveSocket(t, filepath.Join(dir, "s12-6161.sock"))

	r.Clear(4242)

	if len(tm.opts) != 0 {
		t.Fatalf("options %v, want none: no other host of this session answers", tm.opts)
	}
}
