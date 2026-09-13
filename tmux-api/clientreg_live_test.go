package main

import (
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
)

// The claim chain against a REAL tmux, with no seam stubbed.
//
// Everything else that covers decisions 6, 7 and 8 feeds the handler a client
// list written by hand, which proves the branching and not that tmux agrees.
// Three claims about tmux carry the whole feature, and they are checked here
// against the tmux this box runs:
//
//   - `#{client_pid}` exists and is the attaching process's pid, which is what
//     makes the registry work for a user the ttyd account is not (a sudo'd
//     attach runs on a pty the script cannot see).
//   - `switch-client -c <client>` moves an UNPINNED window to that client's
//     size, and leaves `window-size` alone, so the session keeps following its
//     clients afterwards.
//   - It is repeatable, which is the whole of last-active-wins.
//
// Skipped when tmux is missing, so this stays runnable anywhere.
func TestLiveClaimTakesTheWindowToTheRecordedClient(t *testing.T) {
	tmux := withRealTmux(t)
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	if out, err := tmux("new-session", "-d", "-s", "demo", "-x", "80", "-y", "24"); err != nil {
		t.Fatalf("new-session: %v: %s", err, out)
	}
	if out, err := tmux("set-option", "-g", "status", "off"); err != nil {
		t.Fatalf("status off: %v: %s", err, out)
	}

	// Two real read-write clients on one session, which is the two-device case
	// the whole feature is about. Which of them the window starts on is NOT
	// asserted: `window-size latest` follows client_activity, whose resolution
	// is one second, so two attaches inside the same second are a tie tmux
	// breaks however it likes (measured both ways on this box 2026-09-13).
	// Every assertion below is a MOVE from wherever it was.
	big := liveAttach(t, 200, 50)
	small := liveAttach(t, 100, 30)

	live := func() []client {
		t.Helper()
		out, err := tmux("list-clients", "-t", exactSession("demo"), "-F", clientsListFmt)
		if err != nil {
			t.Fatalf("list-clients: %v: %s", err, out)
		}
		return parseClients([]byte(out + "\n"))
	}
	cs := waitFor(t, "both clients to attach", func() ([]client, bool) {
		cs := live()
		return cs, len(cs) == 2
	})

	byPID := map[int]client{}
	for _, c := range cs {
		if c.PID == 0 {
			t.Fatalf("tmux reported no client_pid for %+v; the registry's sudo "+
				"fallback has nothing to match on", c)
		}
		byPID[c.PID] = c
	}
	if _, ok := byPID[big]; !ok {
		t.Fatalf("the 200x50 client (pid %d) is not in %+v", big, cs)
	}
	if _, ok := byPID[small]; !ok {
		t.Fatalf("the 100x30 client (pid %d) is not in %+v", small, cs)
	}
	t.Logf("window before any claim: %s", liveWindow(t, tmux))

	// What devvm/tmux-attach.sh writes, for both shapes: the no-sudo case
	// records the pty its tmux client runs on, and the sudo case records a pty
	// that names nothing tmux knows, with the pid as the only usable half.
	const byTTYID = "0123456789abcdef0123456789abcdef"
	const byPIDID = "fedcba9876543210fedcba9876543210"
	writeLiveRecord(t, byTTYID, byPID[big].Name, byPID[big].PID)
	writeLiveRecord(t, byPIDID, "/dev/pts/99999", byPID[big].PID)

	for _, id := range []string{byTTYID, byPIDID} {
		if got := claimingClient(id, "demo", live()); got != byPID[big].Name {
			t.Fatalf("claimingClient(%s) = %q, want the 200x50 client %q",
				id, got, byPID[big].Name)
		}
	}

	// The claim itself, on an unpinned session, which is what the handler runs
	// when sessionio.SizeGrid answers (false, nil). Small first, so that
	// whichever client tmux happened to start on, at least two of the three
	// claims below are a real move.
	if err := switchClient(selfUser, byPID[small].Name, "demo"); err != nil {
		t.Fatalf("switchClient to the 100x30 client: %v", err)
	}
	if got := liveWindowSettling(t, tmux, "100x30"); got != "100x30" {
		t.Errorf("after the 100x30 client claimed: window = %s", got)
	}
	if err := switchClient(selfUser, byPID[big].Name, "demo"); err != nil {
		t.Fatalf("switchClient: %v", err)
	}
	if got := liveWindowSettling(t, tmux, "200x50"); got != "200x50" {
		t.Errorf("after the 200x50 client claimed: window = %s", got)
	}
	if got := liveWindowSize(t, tmux); got == "manual" {
		t.Error("the claim pinned the session; switch-client is supposed to leave " +
			"window-size alone, which is what keeps last-active-wins working")
	}

	// Last active wins, so the other device takes it straight back.
	if err := switchClient(selfUser, byPID[small].Name, "demo"); err != nil {
		t.Fatalf("switchClient back: %v", err)
	}
	if got := liveWindowSettling(t, tmux, "100x30"); got != "100x30" {
		t.Errorf("after the 100x30 client claimed it back: window = %s", got)
	}
}

// liveAttach puts a real tmux client of the given size on `demo` and returns
// its pid. A pty, because tmux will not attach without one.
func liveAttach(t *testing.T, cols, rows uint16) int {
	t.Helper()
	pid, fd, err := forkPtyTmux(cols, rows, tmuxBinary,
		[]string{"attach-session", "-t", exactSession("demo")})
	if err != nil {
		t.Fatalf("attach %dx%d through a pty: %v", cols, rows, err)
	}
	t.Cleanup(func() {
		syscall.Close(fd)
		syscall.Kill(pid, syscall.SIGKILL)
		var ws syscall.WaitStatus
		syscall.Wait4(pid, &ws, 0, nil)
	})
	return pid
}

// writeLiveRecord writes a record exactly as devvm/tmux-attach.sh does.
func writeLiveRecord(t *testing.T, id, tty string, pid int) {
	t.Helper()
	if err := os.MkdirAll(clientRegistryDir(), 0o700); err != nil {
		t.Fatalf("mkdir registry: %v", err)
	}
	body := tty + "\t" + strconv.Itoa(pid) + "\n"
	if err := os.WriteFile(filepath.Join(clientRegistryDir(), id), []byte(body), 0o600); err != nil {
		t.Fatalf("write record: %v", err)
	}
}

func liveWindow(t *testing.T, tmux func(...string) (string, error)) string {
	t.Helper()
	out, err := tmux("display", "-p", "-t", exactPane("demo"), "#{window_width}x#{window_height}")
	if err != nil {
		t.Fatalf("display: %v: %s", err, out)
	}
	return out
}

func liveWindowSize(t *testing.T, tmux func(...string) (string, error)) string {
	t.Helper()
	out, err := tmux("show-options", "-qv", "-t", exactPane("demo"), "window-size")
	if err != nil {
		t.Fatalf("show-options: %v: %s", err, out)
	}
	return out
}

// liveWindowSettling waits for the window to reach a size rather than sleeping
// a guessed interval: tmux applies a resize on its own event loop, so reading
// it in the same breath as the command that asked for it reads the old size.
func liveWindowSettling(t *testing.T, tmux func(...string) (string, error), want string) string {
	t.Helper()
	got := ""
	waitFor(t, "the window to reach "+want, func() ([]client, bool) {
		got = liveWindow(t, tmux)
		return nil, got == want
	})
	return got
}

// The sudo hop, end to end, with nothing simulated: a real sudo, a real tmux
// client on the pty sudo gave it, and the real /proc walk.
//
// This is the half of the registry that decides whether per-client resolution
// works for anybody but the ttyd account. `Defaults use_pty` puts the client
// on a pty the attach script never sees, so the tty it recorded matches
// nothing and the pid is all that is left. Measured by hand on this box
// 2026-09-13 (recorded 934083, client 934092, walk 934092 -> 934091 -> 934083)
// and pinned here so a sudo or tmux that stops behaving that way says so.
//
// Runs as the CURRENT user rather than another account: sudo still allocates
// its own pty and still forks its monitor, which is the whole of what this
// checks, and nothing of anybody else's is touched.
func TestTheRecordedPidSurvivesARealSudoHop(t *testing.T) {
	tmux := withRealTmux(t)
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	if err := exec.Command("sudo", "-n", "true").Run(); err != nil {
		t.Skip("no passwordless sudo on this host")
	}
	if out, err := tmux("new-session", "-d", "-s", "demo", "-x", "80", "-y", "24"); err != nil {
		t.Fatalf("new-session: %v: %s", err, out)
	}

	me, err := user.Current()
	if err != nil {
		t.Fatalf("current user: %v", err)
	}
	// What devvm/tmux-attach.sh does for a user the ttyd account is not, down
	// to the `exec`, which is what keeps the shell's pid as sudo's own.
	pid, fd, err := forkPtyTmux(200, 50, "/bin/sh", []string{"-c",
		"exec sudo -n -H -u " + me.Username + " " + tmuxBinary +
			" attach-session -t " + exactSession("demo")})
	if err != nil {
		t.Fatalf("sudo attach through a pty: %v", err)
	}
	t.Cleanup(func() {
		syscall.Close(fd)
		syscall.Kill(pid, syscall.SIGKILL)
		var ws syscall.WaitStatus
		syscall.Wait4(pid, &ws, 0, nil)
	})

	cs := waitFor(t, "the sudo'd client to attach", func() ([]client, bool) {
		out, err := tmux("list-clients", "-t", exactSession("demo"), "-F", clientsListFmt)
		if err != nil || out == "" {
			return nil, false
		}
		return parseClients([]byte(out + "\n")), true
	})
	if len(cs) != 1 {
		t.Fatalf("want one client, got %+v", cs)
	}
	if cs[0].PID == pid {
		t.Skipf("sudo did not fork here (client pid %d is the shell's own), so "+
			"there is no hop to walk", pid)
	}

	// The record the script would have written: its own pty, which is NOT the
	// one the client ended up on, and its own pid, which still is an ancestor.
	const id = "0123456789abcdef0123456789abcdef"
	writeLiveRecord(t, id, "/dev/pts/99999", pid)

	if got := claimingClient(id, "demo", cs); got != cs[0].Name {
		t.Errorf("claimingClient = %q, want the sudo'd client %q (recorded pid %d, "+
			"client pid %d): the pid walk is what makes this work for every user "+
			"the service account is not", got, cs[0].Name, pid, cs[0].PID)
	}
}
