package main

import (
	"fmt"
	"os"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

// The driven mark against a REAL tmux client.
//
// Everything else that tests markDriven feeds it flag lists written by hand,
// which proves the predicate does what it means to and not that tmux agrees.
// The fix for the reconnect case rests entirely on a claim about tmux — that
// client_activity sits exactly on client_created until somebody presses a key,
// and moves past it when they do — so that claim is checked here against the
// tmux this box actually runs, with the same `list-clients` format string the
// session list uses.
//
// Measured on tmux 3.4, 2026-09-11, on a client attached with `-f ignore-size`:
// attach and three idle seconds both read created/activity = 1789166777, a pty
// RESIZE left them there too, and one keypress moved activity to 1789166785.
// The resize line is the one that makes this usable: a hidden preload's xterm
// reports its size the moment it attaches.
//
// Skipped when tmux is missing, so this stays runnable anywhere.
func TestLivePreloadClientDrivesOnceSomebodyTypes(t *testing.T) {
	tmux := withRealTmux(t)
	if out, err := tmux("new-session", "-d", "-s", "demo", "-x", "80", "-y", "40"); err != nil {
		t.Fatalf("new-session: %v: %s", err, out)
	}

	// What a hover does: ttyd runs tmux-attach.sh, which for arg5=`pre` is this
	// attach (ADR-0026). A real pty, because tmux will not attach without one.
	pid, fd, err := forkPtyTmux(200, 50, tmuxBinary,
		[]string{"attach-session", "-f", "ignore-size", "-t", exactSession("demo")})
	if err != nil {
		t.Fatalf("attach through a pty: %v", err)
	}
	t.Cleanup(func() {
		syscall.Close(fd)
		syscall.Kill(pid, syscall.SIGKILL)
		var ws syscall.WaitStatus
		syscall.Wait4(pid, &ws, 0, nil)
	})

	live := func() []client {
		t.Helper()
		out, err := tmux("list-clients", "-t", exactSession("demo"), "-F", clientsListFmt)
		if err != nil {
			t.Fatalf("list-clients: %v: %s", err, out)
		}
		return parseClients([]byte(out + "\n"))
	}

	cs := waitFor(t, "the preload client to attach", func() ([]client, bool) {
		cs := live()
		return cs, len(cs) == 1
	})
	c := cs[0]
	if !hasClientFlag(c.Flags, "ignore-size") || isReadOnly(c.Flags) {
		t.Fatalf("attached with flags %q, want a read-write client carrying ignore-size", c.Flags)
	}
	if c.Activity != c.Created {
		t.Fatalf("a client that only attached reads activity %d / created %d; "+
			"tmux no longer initialises the two together and the preload rule needs rewriting",
			c.Activity, c.Created)
	}
	if !isPreloadClient(c) {
		t.Errorf("a freshly attached ignore-size client %+v did not read as a preload", c)
	}
	sessions := []Session{{Name: "demo"}}
	markDriven(sessions, cs)
	if sessions[0].Driven {
		t.Errorf("a hover lit the driven mark")
	}

	// tmux stamps whole seconds, so a key pressed inside the attach's own second
	// leaves the two equal. The session list is rebuilt every 5s, so that blind
	// spot closes long before anything reads it — but a test that types
	// immediately would be judging tmux's clock granularity, not its behaviour.
	time.Sleep(1100 * time.Millisecond)
	if _, err := syscall.Write(fd, []byte("x")); err != nil {
		t.Fatalf("typing into the client: %v", err)
	}

	cs = waitFor(t, "the keystroke to move client_activity", func() ([]client, bool) {
		cs := live()
		return cs, len(cs) == 1 && cs[0].Activity > cs[0].Created
	})
	if isPreloadClient(cs[0]) {
		t.Errorf("a client somebody typed into %+v still read as a hover", cs[0])
	}
	sessions = []Session{{Name: "demo"}}
	markDriven(sessions, cs)
	if !sessions[0].Driven {
		t.Errorf("a client somebody typed into did not light the driven mark: %+v", cs[0])
	}
	// And the promotion half still reaches it: the flags are what tmux gates the
	// window on, so this client's window is not following it until it is
	// promoted (grid_size.go).
	if got := preloadClientName(cs); got == "" {
		t.Errorf("a driver still carrying ignore-size was not offered for promotion: %+v", cs[0])
	}
}

// waitFor polls until cond holds, so nothing here waits on a fixed sleep for a
// thing tmux does on its own schedule.
func waitFor(t *testing.T, what string, cond func() ([]client, bool)) []client {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		cs, ok := cond()
		if ok {
			return cs
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out after 5s waiting for %s; clients = %+v", what, cs)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// forkPtyTmux opens a pty pair, sizes it, and execs the child on the slave side.
// Kept local and dependency-free, the way sessionio/grid_test.go's forkPty is,
// because a tmux client without a terminal is not a tmux client.
func forkPtyTmux(cols, rows uint16, name string, args []string) (int, int, error) {
	master, err := syscall.Open("/dev/ptmx", syscall.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		return 0, 0, err
	}
	fail := func(e error) (int, int, error) {
		syscall.Close(master)
		return 0, 0, e
	}
	var n uint32
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, uintptr(master),
		syscall.TIOCGPTN, uintptr(unsafe.Pointer(&n))); e != 0 {
		return fail(e)
	}
	var unlock int32
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, uintptr(master),
		syscall.TIOCSPTLCK, uintptr(unsafe.Pointer(&unlock))); e != 0 {
		return fail(e)
	}
	ws := struct{ Row, Col, X, Y uint16 }{rows, cols, 0, 0}
	syscall.Syscall(syscall.SYS_IOCTL, uintptr(master), syscall.TIOCSWINSZ,
		uintptr(unsafe.Pointer(&ws)))

	slave, err := syscall.Open(fmt.Sprintf("/dev/pts/%d", n), syscall.O_RDWR, 0)
	if err != nil {
		return fail(err)
	}
	defer syscall.Close(slave)
	pid, err := syscall.ForkExec(name, append([]string{name}, args...), &syscall.ProcAttr{
		Env:   append(os.Environ(), "TERM=xterm-256color"),
		Files: []uintptr{uintptr(slave), uintptr(slave), uintptr(slave)},
		Sys:   &syscall.SysProcAttr{Setsid: true, Setctty: true},
	})
	if err != nil {
		return fail(err)
	}
	return pid, master, nil
}
