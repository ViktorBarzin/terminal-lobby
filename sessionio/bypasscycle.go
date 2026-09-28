package sessionio

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Whether bypassPermissions is a stop on a session's Shift+Tab cycle.
//
// The pane cannot say: the status line shows the mode the session is in, not
// the stops it offers. The flags Claude Code was started with can. Bypass is
// on the cycle only when a flag allows it (setmode.go's table, measured on CLI
// 2.1.281): --dangerously-skip-permissions, --allow-dangerously-skip-permissions,
// or a start in the mode itself. Found in the round 7 check (2026-09-28): a
// session started as plain `claude` refused Plan to Auto while Claude worked,
// "passes through Bypass", over a cycle that has no Bypass in it.
//
// What is read is every process in the pane, the pane's own and its
// descendants, from /proc. The lobby starts Claude under a login shell
// (`zsh -lic claude --dangerously-skip-permissions`, measured 2026-09-28), so
// Claude is a child of the pane's process, not the process itself.
//
// Unknown counts as on the cycle. Nothing read, or no Claude among what was
// read, leaves the walk as careful as it was before this existed. A session
// whose settings file starts it in bypass carries no flag; if one shows
// mid-walk while Claude works, SetMode stops there and says so.

// bypassOnCycle reports whether the session's Claude can reach bypass with
// Shift+Tab, erring towards yes.
func (in *Injector) bypassOnCycle(osUser, session string) bool {
	out, err := in.Command(osUser, "display-message", "-p", "-t", exactPane(session), "#{pane_pid}").Output()
	if err != nil {
		return true
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil || pid <= 0 {
		return true
	}
	return bypassFromArgvs(procTreeArgvs("/proc", pid))
}

// bypassFromArgvs reads the command lines of a pane's processes. A process is
// Claude when its program, or the script node runs, is named `claude`. Any
// Claude holding a bypass flag puts bypass on the cycle; Claude found and none
// holding one takes it off; no Claude found leaves it on.
func bypassFromArgvs(argvs [][]string) bool {
	sawClaude := false
	for _, argv := range argvs {
		at := claudeArg(argv)
		if at < 0 {
			continue
		}
		sawClaude = true
		flags := argv[at+1:]
		for i, a := range flags {
			switch {
			case a == "--dangerously-skip-permissions", a == "--allow-dangerously-skip-permissions",
				a == "--permission-mode="+ModeBypass:
				return true
			case a == "--permission-mode" && i+1 < len(flags) && flags[i+1] == ModeBypass:
				return true
			}
		}
	}
	return !sawClaude
}

// claudeArg is the index of the argument naming Claude's program in argv: the
// program itself, or the script an interpreter was handed. -1 when argv is not
// Claude.
func claudeArg(argv []string) int {
	for i := 0; i < len(argv) && i < 2; i++ {
		if filepath.Base(argv[i]) == "claude" {
			return i
		}
	}
	return -1
}

// procTreeArgvs is the command line of `root` and of every process descended
// from it, read from a proc filesystem mounted at `proc`. A process that
// cannot be read, or that went away mid-scan, is skipped.
func procTreeArgvs(proc string, root int) [][]string {
	entries, err := os.ReadDir(proc)
	if err != nil {
		return nil
	}
	children := map[int][]int{}
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		stat, err := os.ReadFile(filepath.Join(proc, e.Name(), "stat"))
		if err != nil {
			continue
		}
		// "pid (comm) state ppid ...": comm may hold spaces and parentheses,
		// so the fields are read after the last ')'.
		s := string(stat)
		end := strings.LastIndexByte(s, ')')
		if end < 0 {
			continue
		}
		fields := strings.Fields(s[end+1:])
		if len(fields) < 2 {
			continue
		}
		ppid, err := strconv.Atoi(fields[1])
		if err != nil {
			continue
		}
		children[ppid] = append(children[ppid], pid)
	}
	var argvs [][]string
	queue := []int{root}
	seen := map[int]bool{}
	for len(queue) > 0 {
		pid := queue[0]
		queue = queue[1:]
		if seen[pid] {
			continue
		}
		seen[pid] = true
		if raw, err := os.ReadFile(filepath.Join(proc, strconv.Itoa(pid), "cmdline")); err == nil && len(raw) > 0 {
			argvs = append(argvs, strings.Split(strings.TrimRight(string(raw), "\x00"), "\x00"))
		}
		queue = append(queue, children[pid]...)
	}
	return argvs
}
