package sessionio

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

// The invariant this whole file exists to prove: a READ-WRITE client owns the
// window size; a READ-ONLY client consumes it and never moves it.
//
// tmux gets most of the way there on its own — `attach -r` implies the
// ignore-size client flag, so a read-only client is skipped while sizing. But
// that skip is conditional on at least one read-write client being attached
// (resize.c: ignore_client_size). The moment the last read-write client
// detaches, the read-only client's size takes over and the window reflows under
// a watcher who never asked to change anything. PinGrid closes exactly that
// gap, so these tests care most about the no-read-write-client case.
//
// They drive REAL ptys rather than control-mode clients, because the size a
// client reports is a property of its terminal, and a fake would be asserting
// our own assumption back at us.

// client is a live `tmux attach` on a pty of a size we control.
type client struct {
	pid int
	fd  int
}

// attach forks a real pty of the given size and runs `tmux attach` in it.
func attach(t *testing.T, sock, session string, cols, rows uint16, extra ...string) *client {
	t.Helper()
	args := append([]string{"-L", sock, "attach-session"}, extra...)
	args = append(args, "-t", session)

	pid, fd, err := forkPty(cols, rows, "tmux", args)
	if err != nil {
		t.Fatalf("forkPty: %v", err)
	}
	c := &client{pid: pid, fd: fd}
	t.Cleanup(func() { c.close() })
	time.Sleep(600 * time.Millisecond) // let the attach settle
	return c
}

// resize changes the client's terminal size, as dragging a window would.
func (c *client) resize(t *testing.T, cols, rows uint16) {
	t.Helper()
	setWinsize(c.fd, cols, rows)
	time.Sleep(600 * time.Millisecond)
}

// close kills the client the way a dropped WebSocket does — abruptly, with no
// chance to detach cleanly. That is the production path: term.html drops its
// socket after the tab has been hidden 60s, and ttyd reaps the pty.
func (c *client) close() {
	if c.fd >= 0 {
		syscall.Close(c.fd)
		c.fd = -1
	}
	if c.pid > 0 {
		syscall.Kill(c.pid, syscall.SIGKILL)
		var ws syscall.WaitStatus
		syscall.Wait4(c.pid, &ws, 0, nil)
		c.pid = 0
	}
	time.Sleep(600 * time.Millisecond)
}

func setWinsize(fd int, cols, rows uint16) {
	ws := struct{ Row, Col, X, Y uint16 }{rows, cols, 0, 0}
	syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), syscall.TIOCSWINSZ,
		uintptr(unsafe.Pointer(&ws)))
}

// forkPty is a minimal pty.Fork: open a pty pair, size it, and exec the child
// on the slave side. Kept local so sessionio stays dependency-free.
func forkPty(cols, rows uint16, name string, args []string) (int, int, error) {
	master, err := syscall.Open("/dev/ptmx", syscall.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		return 0, 0, err
	}
	var n uint32
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, uintptr(master),
		syscall.TIOCGPTN, uintptr(unsafe.Pointer(&n))); e != 0 {
		syscall.Close(master)
		return 0, 0, e
	}
	var unlock int32
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, uintptr(master),
		syscall.TIOCSPTLCK, uintptr(unsafe.Pointer(&unlock))); e != 0 {
		syscall.Close(master)
		return 0, 0, e
	}
	slaveName := fmt.Sprintf("/dev/pts/%d", n)
	setWinsize(master, cols, rows)

	bin, err := exec.LookPath(name)
	if err != nil {
		syscall.Close(master)
		return 0, 0, err
	}
	slave, err := syscall.Open(slaveName, syscall.O_RDWR, 0)
	if err != nil {
		syscall.Close(master)
		return 0, 0, err
	}
	pid, err := syscall.ForkExec(bin, append([]string{name}, args...), &syscall.ProcAttr{
		Env:   append(os.Environ(), "TERM=xterm-256color"),
		Files: []uintptr{uintptr(slave), uintptr(slave), uintptr(slave)},
		Sys:   &syscall.SysProcAttr{Setsid: true, Setctty: true},
	})
	syscall.Close(slave)
	if err != nil {
		syscall.Close(master)
		return 0, 0, err
	}
	return pid, master, nil
}

// gridSession starts an isolated tmux server with one session sized 200x50 and
// no status line (so window height is the full grid, which keeps the assertions
// readable).
func gridSession(t *testing.T) (*Injector, string, string) {
	t.Helper()
	in, osUser, sock := scratchSession(t)
	run(t, sock, "set-option", "-g", "status", "off")
	run(t, sock, "resize-window", "-t", "demo", "-x", "200", "-y", "50")
	// resize-window flips the WINDOW to manual; put it back so each test starts
	// from the box's real default and PinGrid is what changes it.
	run(t, sock, "set-option", "-t", "demo", "window-size", "latest")
	run(t, sock, "set-option", "-w", "-t", "demo", "window-size", "latest")
	return in, osUser, sock
}

func run(t *testing.T, sock string, args ...string) {
	t.Helper()
	full := append([]string{"-L", sock}, args...)
	if out, err := exec.Command("tmux", full...).CombinedOutput(); err != nil {
		t.Fatalf("tmux %s: %v: %s", strings.Join(args, " "), err, out)
	}
}

// grid reports the window's current size, e.g. "200x50".
func grid(t *testing.T, sock string) string {
	t.Helper()
	out, err := exec.Command("tmux", "-L", sock, "display", "-p", "-t", "demo",
		"#{window_width}x#{window_height}").Output()
	if err != nil {
		t.Fatalf("display: %v", err)
	}
	return strings.TrimSpace(string(out))
}

// Baseline, and the reason this feature exists. WITHOUT PinGrid, tmux hands the
// window to the read-only viewer as soon as the read-write client goes away.
// If this test ever starts passing (i.e. the window stops moving), tmux changed
// under us and PinGrid may have become unnecessary.
func TestUnpinnedGridCollapsesOntoTheViewerWhenTheOwnerLeaves(t *testing.T) {
	_, _, sock := gridSession(t)

	owner := attach(t, sock, "demo", 200, 50)
	if got := grid(t, sock); got != "200x50" {
		t.Fatalf("owner attached: grid = %s, want 200x50", got)
	}

	attach(t, sock, "demo", 80, 24, "-r")
	if got := grid(t, sock); got != "200x50" {
		t.Fatalf("read-only viewer joined: grid = %s, want it untouched at 200x50", got)
	}

	owner.close()
	if got := grid(t, sock); got == "200x50" {
		t.Fatalf("owner left: grid stayed %s — tmux no longer collapses onto a "+
			"lone read-only client, so PinGrid may be redundant", got)
	}
}

// The invariant, with PinGrid applied: the viewer never moves the grid, in any
// of the four situations that can move it.
func TestPinnedGridIsOwnedOnlyByReadWriteClients(t *testing.T) {
	in, osUser, sock := gridSession(t)

	owner := attach(t, sock, "demo", 200, 50)
	if err := in.PinGrid(osUser, "demo"); err != nil {
		t.Fatalf("PinGrid: %v", err)
	}

	viewer := attach(t, sock, "demo", 80, 24, "-r")
	if got := grid(t, sock); got != "200x50" {
		t.Errorf("viewer attached: grid = %s, want 200x50", got)
	}

	viewer.resize(t, 60, 20)
	if got := grid(t, sock); got != "200x50" {
		t.Errorf("viewer resized: grid = %s, want 200x50", got)
	}

	// The case tmux gets wrong on its own.
	owner.close()
	if got := grid(t, sock); got != "200x50" {
		t.Errorf("owner detached, viewer alone: grid = %s, want it frozen at 200x50", got)
	}

	// A second viewer arriving while nobody is driving must not claim it either.
	attach(t, sock, "demo", 100, 30, "-r")
	if got := grid(t, sock); got != "200x50" {
		t.Errorf("second viewer joined with no owner: grid = %s, want 200x50", got)
	}
}

// Pinning must not cost the owner control: their attach and their live resize
// both still drive the grid.
func TestPinnedGridStillFollowsTheReadWriteClient(t *testing.T) {
	in, osUser, sock := gridSession(t)

	owner := attach(t, sock, "demo", 200, 50)
	if err := in.PinGrid(osUser, "demo"); err != nil {
		t.Fatalf("PinGrid: %v", err)
	}
	attach(t, sock, "demo", 80, 24, "-r")

	owner.resize(t, 150, 40)
	if got := grid(t, sock); got != "150x40" {
		t.Errorf("owner resized to 150x40: grid = %s", got)
	}

	// Owner leaves entirely, then comes back on a different-sized screen. This
	// is also how a grid left small by a forgotten toggle heals: the owner's
	// next attach re-drives it.
	owner.close()
	if got := grid(t, sock); got != "150x40" {
		t.Errorf("owner gone: grid = %s, want it held at 150x40", got)
	}

	attach(t, sock, "demo", 175, 45)
	if got := grid(t, sock); got != "175x45" {
		t.Errorf("owner returned at 175x45: grid = %s", got)
	}
}

// Pinning must be INVISIBLE to whoever is driving. Switching a live window to
// `manual` reverts it to the size the window was created at, so a naive pin
// yanked a running session back to its birth size the instant someone started
// watching — exactly the disruption this feature exists to prevent.
//
// The session here is deliberately born SMALL and grown by its client, so birth
// size and current size differ. An earlier live check missed this bug precisely
// because those two coincided in its fixture.
func TestPinningDoesNotResizeARunningSession(t *testing.T) {
	in, osUser, sock := scratchSession(t) // born 80x24
	owner := attach(t, sock, "demo", 190, 56)
	before := grid(t, sock)
	if before == "80x24" {
		t.Fatalf("fixture is not exercising the bug: the window never grew past its birth size")
	}

	if err := in.PinGrid(osUser, "demo"); err != nil {
		t.Fatalf("PinGrid: %v", err)
	}
	if got := grid(t, sock); got != before {
		t.Errorf("pinning moved a running session from %s to %s", before, got)
	}
	_ = owner
}

// Pinning must not change the size tmux itself would have chosen for the same
// client. It did: the hook resized to the raw client height, but tmux subtracts
// the status lines, so every pinned session came out one row too tall and its
// bottom row sat behind the status bar. Ran against the status line ON — and at
// 2 and 3 rows — because that is the configuration the bug needed to show, and
// the rest of this file deliberately turns the status line off.
func TestPinnedGridMatchesTheSizeTmuxWouldHaveChosen(t *testing.T) {
	for _, status := range []string{"on", "off", "2", "3"} {
		t.Run("status="+status, func(t *testing.T) {
			in, osUser, sock := scratchSession(t)
			run(t, sock, "set-option", "-g", "status", status)

			// What tmux picks for this client, unpinned.
			owner := attach(t, sock, "demo", 190, 56)
			want := grid(t, sock)

			// The same client, pinned. The hook re-derives the size on attach,
			// so a mismatch here is the hook disagreeing with tmux.
			if err := in.PinGrid(osUser, "demo"); err != nil {
				t.Fatalf("PinGrid: %v", err)
			}
			owner.resize(t, 190, 56) // fire the hook
			if got := grid(t, sock); got != want {
				t.Errorf("status=%s: pinned grid %s, but tmux chooses %s for the "+
					"same 190x56 client", status, got, want)
			}
		})
	}
}

// Pinning twice is what actually happens in production: every read-only attach
// calls it, and a session can be watched many times over its life.
func TestPinGridIsIdempotent(t *testing.T) {
	in, osUser, sock := gridSession(t)
	owner := attach(t, sock, "demo", 200, 50)

	for i := range 3 {
		if err := in.PinGrid(osUser, "demo"); err != nil {
			t.Fatalf("PinGrid #%d: %v", i+1, err)
		}
	}
	attach(t, sock, "demo", 80, 24, "-r")
	owner.close()
	if got := grid(t, sock); got != "200x50" {
		t.Errorf("after 3 pins: grid = %s, want 200x50", got)
	}
}

// The session name reaches a shell command inside the hook, so it must be
// refused unless it is a plain tmux name. This is the injection boundary.
func TestPinGridRefusesANameItCannotSafelyEmbed(t *testing.T) {
	in, osUser, _ := gridSession(t)

	for _, bad := range []string{
		"", "demo;id", "demo\"x", "demo$(id)", "demo`id`", "demo x", "demo'x",
		"demo\nkill-server", strings.Repeat("a", 33),
	} {
		if err := in.PinGrid(osUser, bad); err == nil {
			t.Errorf("PinGrid(%q) = nil, want a refusal", bad)
		}
	}
}

// PinGrid targets one session exactly. tmux resolves an absent name by
// unambiguous PREFIX match and exits 0 doing it, so pinning "demo" on a server
// where only "demo-2" exists must fail rather than silently pin the neighbour
// (the same trap exactPane/exactSession exist for).
func TestPinGridDoesNotPrefixMatchAnotherSession(t *testing.T) {
	in, osUser, sock := gridSession(t)
	run(t, sock, "new-session", "-d", "-s", "demo-2", "sh")
	run(t, sock, "kill-session", "-t", "=demo")

	if err := in.PinGrid(osUser, "demo"); err == nil {
		t.Fatal("PinGrid on an absent session succeeded — it prefix-matched demo-2")
	}
	if got, _ := exec.Command("tmux", "-L", sock, "show-options", "-t", "=demo-2",
		"window-size").Output(); strings.Contains(string(got), "manual") {
		t.Errorf("demo-2 was pinned by a call meant for demo: %s", got)
	}
}
