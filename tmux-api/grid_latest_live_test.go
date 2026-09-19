package main

import (
	"strings"
	"syscall"
	"testing"
	"time"
)

// An UNPINNED window following the client being read, against a real tmux.
//
// This is the claim the whole unpinned arm of POST /sessions/{name}/grid rests
// on, and it is a claim about tmux rather than about our code: that
// `switch-client` onto the session a client is ALREADY on moves the window to
// that client, and leaves `window-size` alone. Everything else that tests this
// path feeds the handler a client list written by hand, which proves the
// choice and not that tmux agrees with it.
//
// Why it matters that the option is untouched: `resize-window`, the verb the
// pinned path uses, sets `window-size manual` as a side effect, so reaching
// for it here would pin every session the lobby is ever pointed at. Measured
// on tmux 3.4 on this box, 2026-09-19, with two clients attached at 200x50 and
// 100x30: `resize-window -x 200 -y 50` moved the window and left the option on
// `manual`, and putting the option back with `set-option -w -u` snapped the
// window straight to 100x30, because unsetting hands the size back to `latest`
// and latest was still the other client.
//
// Skipped where tmux is missing, so this stays runnable anywhere.
func TestLiveUnpinnedWindowFollowsTheClientBeingRead(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	tmux := withRealTmux(t)

	if out, err := tmux("new-session", "-d", "-s", "demo", "-x", "80", "-y", "40"); err != nil {
		t.Fatalf("new-session: %v: %s", err, out)
	}
	// No status bar, so the window height is the client's height and the
	// numbers below read as the sizes they are.
	if out, err := tmux("set-option", "-g", "status", "off"); err != nil {
		t.Fatalf("status off: %v: %s", err, out)
	}

	// A desktop, then a phone. Both read-write, both real ptys, because tmux
	// will not attach without one. The phone attaches LAST, which is what
	// hands it the window: tmux's `latest` moves on an attach.
	attachPty(t, tmux, 200, 50)
	attachPty(t, tmux, 100, 30)

	grid := func() string {
		t.Helper()
		out, err := tmux("display", "-p", "-t", exactPane("demo"),
			"#{window_width}x#{window_height}")
		if err != nil {
			t.Fatalf("display: %v: %s", err, out)
		}
		return strings.TrimSpace(out)
	}
	windowSize := func() string {
		t.Helper()
		out, err := tmux("display", "-p", "-t", exactPane("demo"), "#{window-size}")
		if err != nil {
			t.Fatalf("display window-size: %v: %s", err, out)
		}
		return strings.TrimSpace(out)
	}

	if got := grid(); got != "100x30" {
		t.Fatalf("the phone attached last: grid = %s, want 100x30", got)
	}
	if got := windowSize(); got != "latest" {
		t.Fatalf("window-size = %s, want latest — this test is about the unpinned case", got)
	}

	// What the desktop's claim looks like from inside the handler: one fork
	// for the client list, and the size in the request picks the client.
	out, err := tmux("list-clients", "-t", exactSession("demo"), "-F", clientsListFmt)
	if err != nil {
		t.Fatalf("list-clients: %v: %s", err, out)
	}
	clients := parseClients([]byte(out + "\n"))
	if len(clients) != 2 {
		t.Fatalf("clients = %+v, want the desktop and the phone", clients)
	}
	name := readingClientName(clients, 200, 50)
	if name == "" {
		t.Fatalf("no client read as the 200x50 desktop: %+v", clients)
	}

	if err := makeLatest(osSelf, "demo", name); err != nil {
		t.Fatalf("makeLatest(%s): %v", name, err)
	}
	if got := waitForGrid(t, grid, "200x50"); got != "200x50" {
		t.Fatalf("after the desktop claimed: grid = %s, want 200x50", got)
	}
	// The whole point of using switch-client rather than resize-window.
	if got := windowSize(); got != "latest" {
		t.Errorf("window-size = %s after the claim, want latest — the session got pinned", got)
	}

	// And it holds: the phone is still attached, and nothing hands the window
	// back to it on its own.
	time.Sleep(700 * time.Millisecond)
	if got := grid(); got != "200x50" {
		t.Errorf("a moment later: grid = %s, want it still 200x50", got)
	}
}

// attachPty attaches a read-write client of exactly this size and tears it down
// with the test, the way a dropped WebSocket does.
func attachPty(t *testing.T, tmux func(...string) (string, error), cols, rows uint16) {
	t.Helper()
	pid, fd, err := forkPtyTmux(cols, rows, tmuxBinary,
		[]string{"attach-session", "-t", exactSession("demo")})
	if err != nil {
		t.Fatalf("attach a %dx%d client: %v", cols, rows, err)
	}
	t.Cleanup(func() {
		syscall.Close(fd)
		syscall.Kill(pid, syscall.SIGKILL)
		var ws syscall.WaitStatus
		syscall.Wait4(pid, &ws, 0, nil)
	})
	// The attach itself is what moves the window, and it is not instant.
	waitForClients(t, tmux, cols, rows)
}

// waitForClients polls until a client of this size is listed, so nothing here
// waits on a fixed sleep for a thing tmux does on its own schedule.
func waitForClients(t *testing.T, tmux func(...string) (string, error), cols, rows uint16) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		out, err := tmux("list-clients", "-t", exactSession("demo"), "-F", clientsListFmt)
		if err == nil {
			for _, c := range parseClients([]byte(out + "\n")) {
				if c.Width == int(cols) && c.Height == int(rows) {
					return
				}
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for a %dx%d client to attach", cols, rows)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// waitForGrid polls the window size until it is what we asked for, or until it
// is clear that it will not be.
func waitForGrid(t *testing.T, grid func() string, want string) string {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		got := grid()
		if got == want || time.Now().After(deadline) {
			return got
		}
		time.Sleep(50 * time.Millisecond)
	}
}
