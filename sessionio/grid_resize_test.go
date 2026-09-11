package sessionio

import (
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The half of the grid story that hooks cannot tell.
//
// grid_test.go proves the invariant PinGrid was built for: a read-only client
// consumes the size and never moves it. What it does not cover is which of
// SEVERAL read-write clients the window belongs to, and how a client that is
// merely being READ says so. Those are this file.
//
// The shared harness (client, attach, grid, run, gridSession, showHooks) lives
// in grid_test.go.

// typeInto puts a keystroke into a client, the way a person at that terminal
// would. tmux stamps `client_activity` on client INPUT, so this is the only way
// a test can say which client is the one being used.
//
// The sleep crosses a second boundary because `client_activity` has one-second
// resolution, and two clients used inside one second cannot be told apart. The
// byte is an Escape, which every shell discards.
func (c *client) typeInto(t *testing.T) {
	t.Helper()
	if _, err := syscall.Write(c.fd, []byte{0x1b}); err != nil {
		t.Fatalf("write to client: %v", err)
	}
	time.Sleep(1200 * time.Millisecond)
}

// Activity, not attach order, is who the grid belongs to.
//
// The hook used to take `tail -1` of the read-write clients. That is tmux's own
// client list, which is ATTACH order — measured on 3.4, a client attaching into
// a slot freed by a detach still lands at the end. So the last device to attach
// owned the grid for as long as the session lived, and the desktop being typed
// into could not take it back. An UNPINNED session does that for free:
// `window-size latest` follows `client_activity`, so typing on the desktop
// reclaims the window (measured on 3.4, two read-write clients at 200x50 and
// 100x30: the window follows whichever was typed into last).
//
// The trigger here is a read-only viewer arriving. It fires `client-attached`
// without being a candidate itself, so the only thing under test is which of
// the two read-write clients the hook picks.
func TestPinnedGridGoesToTheClientBeingTypedInto(t *testing.T) {
	in, osUser, sock := gridSession(t)

	desktop := attach(t, sock, "demo", 200, 50)
	if err := in.PinGrid(osUser, "demo"); err != nil {
		t.Fatalf("PinGrid: %v", err)
	}

	// A phone joins and drives. Attaching last, it takes the grid, which is
	// both tmux's behaviour and ours.
	attach(t, sock, "demo", 100, 30)
	if got := grid(t, sock); got != "100x30" {
		t.Fatalf("phone attached: grid = %s, want 100x30", got)
	}

	desktop.typeInto(t)
	attach(t, sock, "demo", 80, 24, "-r")

	if got := grid(t, sock); got != "200x50" {
		t.Errorf("grid = %s, want 200x50 — the desktop was typed into last, so "+
			"the grid is its; the phone only attached earlier", got)
	}
}

// SizeGrid is the half no hook can reach: nothing about the tmux client changed,
// so nothing fires.
//
// This is the lobby switching back to a session it kept mounted. The ttyd client
// never detached and its pty is the size it always was, so `client-attached`,
// `client-detached` and `client-resized` all stay silent, and a pinned window
// keeps whatever the last attach left it at until somebody reloads the page.
func TestSizeGridPointsAPinnedWindowAtTheClientBeingRead(t *testing.T) {
	in, osUser, sock := gridSession(t)

	attach(t, sock, "demo", 200, 50)
	if err := in.PinGrid(osUser, "demo"); err != nil {
		t.Fatalf("PinGrid: %v", err)
	}
	attach(t, sock, "demo", 100, 30)
	if got := grid(t, sock); got != "100x30" {
		t.Fatalf("phone attached: grid = %s, want 100x30", got)
	}

	sized, err := in.SizeGrid(osUser, "demo", 200, 50)
	if err != nil {
		t.Fatalf("SizeGrid: %v", err)
	}
	if !sized {
		t.Fatal("SizeGrid reported no change on a pinned session")
	}
	if got := grid(t, sock); got != "200x50" {
		t.Errorf("grid = %s, want 200x50", got)
	}
}

// The status line is not part of the window, so a client sends the size of its
// TERMINAL and the window is that minus the status lines. Same arithmetic as the
// hook, for the same reason: a window one row taller than the visible area hides
// its bottom row behind the status bar.
func TestSizeGridSubtractsTheStatusLines(t *testing.T) {
	in, osUser, sock := gridSession(t)
	attach(t, sock, "demo", 200, 50)
	if err := in.PinGrid(osUser, "demo"); err != nil {
		t.Fatalf("PinGrid: %v", err)
	}
	run(t, sock, "set-option", "-g", "status", "on")

	if _, err := in.SizeGrid(osUser, "demo", 120, 40); err != nil {
		t.Fatalf("SizeGrid: %v", err)
	}
	if got := grid(t, sock); got != "120x39" {
		t.Errorf("grid = %s, want 120x39 — one status line comes off the height", got)
	}
}

// An UNPINNED session is left to tmux, and that is not a nicety: `resize-window`
// sets `window-size manual` as a side effect, so sizing one here would pin every
// session the lobby was looked at. An unpinned session already follows the
// client being used, which is the behaviour this call exists to give back to a
// pinned one.
func TestSizeGridLeavesAnUnpinnedSessionToTmux(t *testing.T) {
	in, osUser, sock := gridSession(t)
	attach(t, sock, "demo", 200, 50)

	sized, err := in.SizeGrid(osUser, "demo", 100, 30)
	if err != nil {
		t.Fatalf("SizeGrid: %v", err)
	}
	if sized {
		t.Error("SizeGrid resized an unpinned session")
	}
	if got := grid(t, sock); got != "200x50" {
		t.Errorf("grid = %s, want it untouched at 200x50", got)
	}
	out, err := exec.Command("tmux", "-L", sock, "show-options", "-qv",
		"-t", "=demo:", "window-size").Output()
	if err != nil {
		t.Fatalf("show-options: %v", err)
	}
	if got := strings.TrimSpace(string(out)); got == "manual" {
		t.Error("window-size = manual: SizeGrid pinned a session that was not pinned")
	}
}

// The same charset guard the rest of the grid verbs have, for the same reason:
// the name reaches a tmux target.
func TestSizeGridRefusesANameItCannotSafelyEmbed(t *testing.T) {
	in, osUser, _ := gridSession(t)
	for _, bad := range []string{"", "a b", "a;b", "a'b", strings.Repeat("x", 33)} {
		if _, err := in.SizeGrid(osUser, bad, 100, 30); err == nil {
			t.Errorf("SizeGrid(%q): no error, want one", bad)
		}
	}
}

// A grid with no window left in it is refused rather than sent. tmux answers
// "height too small", and the browser is free to report a 0x0 terminal at any
// point during a layout.
func TestSizeGridRefusesAGridWithNoRoomInIt(t *testing.T) {
	in, osUser, sock := gridSession(t)
	attach(t, sock, "demo", 200, 50)
	if err := in.PinGrid(osUser, "demo"); err != nil {
		t.Fatalf("PinGrid: %v", err)
	}
	run(t, sock, "set-option", "-g", "status", "on")

	for _, size := range [][2]int{{0, 40}, {100, 0}, {100, 1}, {-3, 40}, {100, 20000}} {
		if _, err := in.SizeGrid(osUser, "demo", size[0], size[1]); err == nil {
			t.Errorf("SizeGrid(%dx%d): no error, want one", size[0], size[1])
		}
	}
	if got := grid(t, sock); got != "200x50" {
		t.Errorf("grid = %s, want it untouched at 200x50", got)
	}
}

// A pin laid down by an older build carries an older hook, and nothing about it
// is stale in the rename sense: it names the right session and it resizes. The
// mark is what tells the two apart, so a change to the hook deploys itself
// through the sweep that already runs on every start.
func TestGridPinStaleSpotsAHookFromAnOlderBuild(t *testing.T) {
	in, osUser, sock := gridSession(t)
	attach(t, sock, "demo", 200, 50)
	if err := in.PinGrid(osUser, "demo"); err != nil {
		t.Fatalf("PinGrid: %v", err)
	}

	// The hook as it was before the mark existed: right session, resizes, no
	// mark. Every other test here proves a fresh pin reads as fresh.
	old := `run-shell -b '{ tmux -L ` + sock + ` list-clients -t =demo: ` +
		`-F "##{client_flags} ##{client_width} ##{client_height}" ` +
		`| grep -v read-only | tail -1 ` +
		`| while read f w h; do tmux -L ` + sock + ` resize-window -t =demo: -x $w -y $h; done; ` +
		`} >/dev/null 2>&1 || true'`
	for _, name := range gridHooks {
		run(t, sock, "set-hook", "-t", "=demo:", name, old)
	}

	stale, err := in.GridPinStale(osUser, "demo")
	if err != nil {
		t.Fatalf("GridPinStale: %v", err)
	}
	if !stale {
		t.Fatal("stale=false: a hook with no mark read as current")
	}

	if err := in.RepinGrid(osUser, "demo"); err != nil {
		t.Fatalf("RepinGrid: %v", err)
	}
	if stale, err := in.GridPinStale(osUser, "demo"); err != nil || stale {
		t.Errorf("after repin: stale=%v err=%v, want false", stale, err)
	}
	if !strings.Contains(showHooks(t, sock, "=demo:"), gridHookMark) {
		t.Error("the repinned hook does not carry the mark")
	}
}
