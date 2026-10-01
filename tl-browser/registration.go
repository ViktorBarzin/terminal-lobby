package main

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Clearing what a dead host left behind.
//
// The host records its browser on the tmux session (@tl_browser and
// @tl_browser_sock) and listens on a viewer socket, and it removes all three on
// its way out. A host that is SIGKILLed, by the launcher after a grace period
// or by the OOM killer inside its scope, never gets that far, and tmux-api
// would go on reporting a browser nobody can open. So after every host exit the
// launcher clears the same things again. Nothing it removes can belong to a
// live host: a socket is removed only when nothing accepts on it, and the
// options only when the socket they name is dead.
//
// The options are the session's, not one host's, and two Claudes in one tmux
// session each run a host: the second listens on s<N>-<pid>.sock and writes
// the options last. When the host that exits held them, and the other host is
// still serving, the options are handed to that host rather than cleared, so
// its browser stays visible in the lobby.

const (
	optBrowser     = "@tl_browser"
	optBrowserSock = "@tl_browser_sock"
)

// Registration clears a dead host's tmux options and viewer socket.
type Registration struct {
	Env  []string // the host's environment: TMUX, TMUX_PANE, XDG_RUNTIME_DIR
	UID  int
	Tmux func(args ...string) (string, error)
}

// Clear removes what the host with this pid registered, unless another live
// host now owns it. Safe to call after a clean exit, when there is nothing
// left to remove.
func (r Registration) Clear(hostPid int) {
	pane := lookupEnv(r.Env, "TMUX_PANE")
	inTmux := pane != "" && lookupEnv(r.Env, "TMUX") != "" && r.Tmux != nil

	sessionID := ""
	if inTmux {
		if out, err := r.Tmux("display-message", "-p", "-t", pane, "#{session_id}"); err == nil {
			sessionID = strings.TrimSpace(out)
		}
	}
	dir := socketDir(r.Env, r.UID)
	name := socketName(sessionID, hostPid)
	// The second name is the one a host takes when another live host already
	// serves the session's socket (host/lib/viewers.mjs).
	for _, f := range []string{name + ".sock", name + "-" + strconv.Itoa(hostPid) + ".sock"} {
		removeStaleSocket(filepath.Join(dir, f))
	}
	if !inTmux {
		return
	}

	// The options are the session's, so a second Claude's host in the same
	// session may have written them last. Its socket still answers; ours does
	// not.
	sock := ""
	if out, err := r.Tmux("show-options", "-v", "-t", pane, optBrowserSock); err == nil {
		sock = strings.TrimSpace(out)
	}
	if sock != "" && listening(sock) {
		return
	}
	if sock != "" && filepath.Dir(sock) == dir {
		removeStaleSocket(sock)
	}
	if sessionID != "" && r.handOver(pane, dir, name) {
		return
	}
	for _, opt := range []string{optBrowser, optBrowserSock} {
		_, _ = r.Tmux("set-option", "-u", "-t", pane, opt)
	}
}

// handOver points the session's options at another live host of the same
// session, in the state that host reports, and says whether it found one.
func (r Registration) handOver(pane, dir, name string) bool {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	for _, e := range entries {
		if e.Type()&os.ModeSocket == 0 || !sessionSocketName(e.Name(), name) {
			continue
		}
		path := filepath.Join(dir, e.Name())
		state, ok := hostState(path)
		if !ok {
			continue
		}
		_, _ = r.Tmux("set-option", "-t", pane, optBrowserSock, path)
		_, _ = r.Tmux("set-option", "-t", pane, optBrowser, state)
		return true
	}
	return false
}

// sessionSocketName reports whether file is one of the names a host of the
// session called name listens on: <name>.sock, or <name>-<pid>.sock.
func sessionSocketName(file, name string) bool {
	if file == name+".sock" {
		return true
	}
	pid, ok := strings.CutPrefix(file, name+"-")
	if !ok {
		return false
	}
	pid, ok = strings.CutSuffix(pid, ".sock")
	if !ok || pid == "" {
		return false
	}
	for _, c := range pid {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// hostState asks the host on path for its state the way the lobby's state
// route does: a watch-only viewer hello, then the host's own hello. Only a
// host that answers with live or frozen counts.
func hostState(path string) (string, bool) {
	c, err := net.DialTimeout("unix", path, time.Second)
	if err != nil {
		return "", false
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(2 * time.Second))
	// The user is only shown when a viewer takes control, which a watch-only
	// connection cannot.
	if _, err := c.Write([]byte(`{"t":"hello","user":"tl-browser","canControl":false}` + "\n")); err != nil {
		return "", false
	}
	line, err := bufio.NewReader(c).ReadBytes('\n')
	if err != nil {
		return "", false
	}
	var h struct {
		T     string `json:"t"`
		State string `json:"state"`
	}
	if json.Unmarshal(line, &h) != nil || h.T != "hello" || (h.State != "live" && h.State != "frozen") {
		return "", false
	}
	return h.State, true
}

// runTmux runs one tmux command with the host's environment, so it reaches the
// same server through TMUX.
func runTmux(env []string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "tmux", args...)
	cmd.Env = env
	out, err := cmd.Output()
	return string(out), err
}

// socketDir matches socketDir in host/lib/protocol.mjs.
func socketDir(env []string, uid int) string {
	if rt := lookupEnv(env, "XDG_RUNTIME_DIR"); rt != "" {
		return filepath.Join(rt, "tl-browser")
	}
	return "/tmp/tl-browser-" + strconv.Itoa(uid)
}

var tmuxSessionIDPattern = regexp.MustCompile(`^\$(\d+)$`)

// socketName matches socketName in host/lib/protocol.mjs.
func socketName(sessionID string, pid int) string {
	if m := tmuxSessionIDPattern.FindStringSubmatch(sessionID); m != nil {
		return "s" + m[1]
	}
	return "pid-" + strconv.Itoa(pid)
}

// listening reports whether something accepts connections on the socket.
func listening(path string) bool {
	c, err := net.DialTimeout("unix", path, time.Second)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

// removeStaleSocket removes path if it is a socket nothing listens on.
func removeStaleSocket(path string) {
	st, err := os.Lstat(path)
	if err != nil || st.Mode()&os.ModeSocket == 0 || listening(path) {
		return
	}
	_ = os.Remove(path)
}
