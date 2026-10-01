package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// How the host is started.
//
// On the devvm each browser runs in its own transient systemd scope inside the
// user's tl-browser.slice, so one runaway page is reclaimed and, at worst,
// OOM-killed inside its own scope rather than taking the box (ADR-0035). Where
// there is no user systemd, in the container for one, the host runs as a plain
// child.

// cmdSpec is the command that runs the host, and the scope it lands in, if any.
type cmdSpec struct {
	Argv []string
	Unit string // systemd scope name without ".scope"; empty for a plain child
}

// A Spawner turns the host's argv into the command that runs it. n counts the
// hosts this launcher has started, from 1.
type Spawner interface {
	Command(argv []string, n int) (cmdSpec, error)
}

// DirectSpawner runs the host as a plain child.
type DirectSpawner struct{}

func (DirectSpawner) Command(argv []string, _ int) (cmdSpec, error) {
	return cmdSpec{Argv: argv}, nil
}

// SystemdSpawner runs the host in a transient scope named after Base.
type SystemdSpawner struct {
	Base string
}

func (s SystemdSpawner) Command(argv []string, n int) (cmdSpec, error) {
	unit := s.Base
	if n > 1 {
		// A respawn straight after an exit can race systemd collecting the
		// previous scope, and a name still in use fails the start.
		unit += "-" + strconv.Itoa(n)
	}
	return cmdSpec{Argv: systemdRunArgs(unit, argv), Unit: unit}, nil
}

// systemdRunArgs is the full argv. The limits are first values, not measured
// working sets; the design doc's open questions say how they get checked.
func systemdRunArgs(unit string, argv []string) []string {
	return append([]string{
		"systemd-run", "--user", "--scope", "--quiet", "--collect",
		"--slice=tl-browser.slice",
		"--unit=" + unit,
		"-p", "MemoryHigh=1G",
		"-p", "MemoryMax=1536M",
		"-p", "CPUQuota=300%",
		"-p", "CPUWeight=50",
		"--",
	}, argv...)
}

// unitBase names this launcher's scopes: the tmux session it serves, or the
// pid of the process that started it (Claude) outside tmux, then its own pid.
func unitBase(tmuxSessionID string, ppid, pid int) string {
	who := strconv.Itoa(ppid)
	if id := sanitiseSessionID(tmuxSessionID); id != "" {
		who = "s" + id
	}
	return "tl-browser-" + who + "-" + strconv.Itoa(pid)
}

// sanitiseSessionID keeps what a unit name can carry from a tmux session id
// such as "$12".
func sanitiseSessionID(id string) string {
	var b strings.Builder
	for _, r := range id {
		if r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r == '_' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// tmuxSessionID asks tmux which session the pane this launcher inherited
// belongs to. Empty outside tmux or when tmux cannot say.
func tmuxSessionID(env []string) string {
	pane := lookupEnv(env, "TMUX_PANE")
	if pane == "" || lookupEnv(env, "TMUX") == "" {
		return ""
	}
	cmd := exec.Command("tmux", "display-message", "-p", "-t", pane, "#{session_id}")
	cmd.Env = env
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// userSystemdWorks reports whether `systemd-run --user --scope` can start a
// scope here. It runs one, which costs about 20 ms, once per launcher and
// only when a browser is first wanted.
func userSystemdWorks(env []string) bool {
	if _, err := exec.LookPath("systemd-run"); err != nil {
		return false
	}
	rt := lookupEnv(env, "XDG_RUNTIME_DIR")
	if rt == "" {
		return false
	}
	if _, err := os.Stat(filepath.Join(rt, "systemd", "private")); err != nil {
		return false
	}
	cmd := exec.Command("systemd-run", "--user", "--scope", "--quiet", "--collect", "--", "true")
	cmd.Env = env
	return cmd.Run() == nil
}

// stopUnit stops a scope, best-effort: by the time it runs the scope is
// usually already gone with its last process.
func stopUnit(unit string, env []string) {
	if unit == "" {
		return
	}
	cmd := exec.Command("systemctl", "--user", "stop", unit+".scope")
	cmd.Env = env
	_ = cmd.Run()
}

// passthroughEnv keeps the variables the host needs and nothing else, so
// Claude's own environment (API keys among it) never reaches a browser.
func passthroughEnv(environ []string) []string {
	keep := map[string]bool{
		"TMUX": true, "TMUX_PANE": true, "XDG_RUNTIME_DIR": true, "HOME": true, "PATH": true,
	}
	var out []string
	for _, kv := range environ {
		k, _, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		if keep[k] || strings.HasPrefix(k, "TL_BROWSER_") {
			out = append(out, kv)
		}
	}
	return out
}

func lookupEnv(env []string, key string) string {
	for i := len(env) - 1; i >= 0; i-- {
		if v, ok := strings.CutPrefix(env[i], key+"="); ok {
			return v
		}
	}
	return ""
}
