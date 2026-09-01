package main

import (
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Reading the box. The parsers here are separated from the calls that produce
// their input so each format has a test that does not need a devvm.

// procSample is one process inside a pane, ranked the way the kernel ranks at
// the cap: by resident size.
type procSample struct {
	Pid      int
	RSSBytes uint64
	IsClaude bool
}

// A test seam, matching the pattern tmux-api uses for the same reason.
var (
	tmuxBinary    = "/usr/bin/tmux"
	sudoBinary    = "/usr/bin/sudo"
	setprivBinary = "/usr/bin/setpriv"
	cgroupRoot    = "/sys/fs/cgroup"
	procRoot      = "/proc"
	userMap       = "/etc/ttyd-user-map"
	// The TOMBSTONE file, not the manifest. tmux-persist-forget appends here on a
	// deliberate kill and leaves the manifest row alone until the next 5-minute
	// save, so an orphaned manifest row cannot tell a kill from a death in the
	// window that matters.
	tombstonesFn = func(user string) string { return "/var/lib/tmux-persist/" + user + ".forgotten.tsv" }
)

// parseUserMap takes the OS users out of /etc/ttyd-user-map, whose rows are
// <authentik_user>=<os_user>. Two identities may map to one account, so the
// result is deduplicated while keeping file order.
func parseUserMap(in string) []string {
	var out []string
	seen := map[string]bool{}
	for _, line := range strings.Split(in, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		i := strings.Index(line, "=")
		if i < 1 {
			continue
		}
		user := strings.TrimSpace(line[i+1:])
		if user == "" || seen[user] {
			continue
		}
		seen[user] = true
		out = append(out, user)
	}
	return out
}

// parseSessionList reads `name<TAB>@claude_state` rows. tmux rejects newlines in
// session names but not tabs, so the field comes off the last separator.
func parseSessionList(in string) map[string]Session {
	out := map[string]Session{}
	for _, line := range strings.Split(in, "\n") {
		if line == "" {
			continue
		}
		i := strings.LastIndex(line, "\t")
		if i < 0 {
			continue
		}
		name := line[:i]
		out[name] = Session{Name: name, ClaudeState: line[i+1:]}
	}
	return out
}

// parsePaneList reads `name<TAB>pane_pid` rows into session -> pane pids.
func parsePaneList(in string) map[string][]int {
	out := map[string][]int{}
	for _, line := range strings.Split(in, "\n") {
		if line == "" {
			continue
		}
		i := strings.LastIndex(line, "\t")
		if i < 0 {
			continue
		}
		pid, err := strconv.Atoi(line[i+1:])
		if err != nil {
			continue
		}
		name := line[:i]
		out[name] = append(out[name], pid)
	}
	return out
}

// parseTombstones reads /var/lib/tmux-persist/<user>.forgotten.tsv, whose rows
// are `<session>\t<epoch>`, into name -> most recent kill epoch. The file is
// append-only, so a name can appear several times and the newest row wins.
func parseTombstones(in string) map[string]int64 {
	out := map[string]int64{}
	for _, line := range strings.Split(in, "\n") {
		i := strings.LastIndex(line, "\t")
		if i < 1 {
			continue
		}
		ts, err := strconv.ParseInt(strings.TrimSpace(line[i+1:]), 10, 64)
		if err != nil {
			continue
		}
		if name := line[:i]; ts > out[name] {
			out[name] = ts
		}
	}
	return out
}

// cgroupPath pulls the unified hierarchy path out of /proc/<pid>/cgroup. A v1
// hierarchy has no unified entry, and guessing at one would attach a pane to
// the wrong scope, so it returns empty instead.
func cgroupPath(in string) string {
	for _, line := range strings.Split(in, "\n") {
		if strings.HasPrefix(line, "0::") {
			return strings.TrimSpace(strings.TrimPrefix(line, "0::"))
		}
	}
	return ""
}

// isClaude identifies a Claude Code process. The exe link is the reliable half:
// comm has been observed carrying the binary's version string instead of a
// name, and a re-exec'd child carrying something else again, so a scheme that
// trusted comm alone would mis-rank exactly the process that matters. comm is
// still consulted, because exe is unreadable without privilege over the target.
func isClaude(exe, comm string) bool {
	if exe != "" {
		if strings.Contains(exe, "/share/claude/versions/") || filepath.Base(exe) == "claude" {
			return true
		}
	}
	return comm == "claude"
}

// pickTop returns the largest sample, or a zero sample for a pane holding
// nothing. Stale scopes with no processes exist on the box.
func pickTop(in []procSample) procSample {
	var top procSample
	for _, s := range in {
		if s.RSSBytes > top.RSSBytes {
			top = s
		}
	}
	return top
}

// --- reading the live box -------------------------------------------------

// Collect builds one snapshot per user. A user whose tmux server is not running
// yields a snapshot with no sessions rather than an error: that is a real state,
// not a failure, and treating it as one would alert on every empty account.
func Collect(users []string, bootID string) []Snapshot {
	out := make([]Snapshot, 0, len(users))
	for _, u := range users {
		out = append(out, collectUser(u, bootID))
	}
	return out
}

func collectUser(user, bootID string) Snapshot {
	snap := Snapshot{
		User:       user,
		BootID:     bootID,
		Taken:      time.Now(),
		Sessions:   map[string]Session{},
		Tombstones: map[string]int64{},
	}

	sessOut, err := asUser(user, tmuxBinary, "list-sessions", "-F", "#{session_name}\t#{@claude_state}")
	if err != nil {
		// No server, or no sessions. Either way there is nothing to compare.
		return snap
	}
	snap.Sessions = parseSessionList(sessOut)

	paneOut, err := asUser(user, tmuxBinary, "list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}")
	if err == nil {
		panes := parsePaneList(paneOut)
		for name, sess := range snap.Sessions {
			for _, panePid := range panes[name] {
				sess = paneFacts(sess, sampleTree(panePid), cgroupMemOf)
			}
			snap.Sessions[name] = sess
		}
	}

	if raw, err := readTombstones(user); err == nil {
		snap.Tombstones = parseTombstones(raw)
	}
	return snap
}

// parseChildren reads /proc/<pid>/task/<pid>/children, a space-separated list.
func parseChildren(in string) []int {
	var out []int
	for _, f := range strings.Fields(in) {
		if pid, err := strconv.Atoi(f); err == nil {
			out = append(out, pid)
		}
	}
	return out
}

// procTree collects root and every descendant. childrenOf is injected so the
// walk is testable without a live /proc, and visited guards the case where a pid
// appears as its own ancestor: /proc is read without a lock, so the tree can
// change underneath the walk.
func procTree(root int, childrenOf func(int) []int) []int {
	visited := map[int]bool{}
	var out []int
	var walk func(int)
	walk = func(pid int) {
		if pid <= 0 || visited[pid] {
			return
		}
		visited[pid] = true
		out = append(out, pid)
		for _, kid := range childrenOf(pid) {
			walk(kid)
		}
	}
	walk(root)
	return out
}

// realChildren reads a pid's direct children from /proc.
func realChildren(pid int) []int {
	raw, err := os.ReadFile(fmt.Sprintf("%s/%d/task/%d/children", procRoot, pid, pid))
	if err != nil {
		return nil
	}
	return parseChildren(string(raw))
}

// paneFacts fills in what one pane says about its session.
//
// Liveness comes from the process tree, never from cgroup membership. Measured
// 2026-09-01: emo's claude sits in a run-r*.scope at 2.09 GB while the
// tmux-spawn scope for the same pane holds only the shell and reports
// memory.current 0. Asking the pane's own scope "is a claude in here" called
// four of emo's live conversations dead.
//
// Memory comes from the cgroup around the LARGEST process, which is the cap that
// will fire and the process it will take. Reading the shell's scope instead
// reported 0 for every one of emo's sessions.
//
// A session with several panes keeps the largest, since that is the one whose
// cap bites first.
func paneFacts(s Session, samples []procSample, memOf func(pid int) (cur, unreclaimable, max uint64)) Session {
	for _, sm := range samples {
		if sm.IsClaude {
			s.ClaudeAlive = true
			break
		}
	}
	top := pickTop(samples)
	if top.Pid == 0 {
		return s
	}
	cur, unreclaimable, max := memOf(top.Pid)
	if cur < s.PaneBytes {
		return s
	}
	s.PaneBytes, s.PaneUnreclaimable, s.PaneLimit, s.TopIsClaude = cur, unreclaimable, max, top.IsClaude
	return s
}

// parseMemStatUnreclaimable sums the fields of memory.stat that the cap cannot
// reclaim: anon and shmem. With memory.swap.max=0 inherited from the user slice,
// neither can be paged out, so this is what a cap has to kill for.
//
// anon_thp is deliberately not added — it is already counted inside anon, and
// adding it would double-count transparent huge pages.
func parseMemStatUnreclaimable(in string) uint64 {
	var total uint64
	for _, line := range strings.Split(in, "\n") {
		f := strings.Fields(line)
		if len(f) != 2 {
			continue
		}
		if f[0] != "anon" && f[0] != "shmem" {
			continue
		}
		if v, err := strconv.ParseUint(f[1], 10, 64); err == nil {
			total += v
		}
	}
	return total
}

// sampleTree reads every process under a pane pid with its resident size.
func sampleTree(panePid int) []procSample {
	pids := procTree(panePid, realChildren)
	out := make([]procSample, 0, len(pids))
	for _, pid := range pids {
		comm, _ := os.ReadFile(fmt.Sprintf("%s/%d/comm", procRoot, pid))
		exe, _ := os.Readlink(fmt.Sprintf("%s/%d/exe", procRoot, pid))
		out = append(out, procSample{
			Pid:      pid,
			RSSBytes: readRSS(pid),
			IsClaude: isClaude(exe, strings.TrimSpace(string(comm))),
		})
	}
	return out
}

// cgroupMemOf reads memory.current, the unreclaimable part of memory.stat, and
// memory.max from the cgroup a pid is in.
func cgroupMemOf(pid int) (uint64, uint64, uint64) {
	raw, err := os.ReadFile(fmt.Sprintf("%s/%d/cgroup", procRoot, pid))
	if err != nil {
		return 0, 0, 0
	}
	scope := cgroupPath(string(raw))
	if scope == "" {
		return 0, 0, 0
	}
	dir := filepath.Join(cgroupRoot, scope)
	stat, _ := os.ReadFile(filepath.Join(dir, "memory.stat"))
	return readUint(filepath.Join(dir, "memory.current")),
		parseMemStatUnreclaimable(string(stat)),
		// memory.max reads "max" when uncapped, which parses to 0.
		readUint(filepath.Join(dir, "memory.max"))
}

// readRSS reads VmRSS out of /proc/<pid>/status, in bytes.
func readRSS(pid int) uint64 {
	raw, err := os.ReadFile(fmt.Sprintf("%s/%d/status", procRoot, pid))
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if !strings.HasPrefix(line, "VmRSS:") {
			continue
		}
		f := strings.Fields(line)
		if len(f) < 2 {
			return 0
		}
		kb, err := strconv.ParseUint(f[1], 10, 64)
		if err != nil {
			return 0
		}
		return kb * 1024
	}
	return 0
}

func readUint(path string) uint64 {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	v, err := strconv.ParseUint(strings.TrimSpace(string(raw)), 10, 64)
	if err != nil {
		return 0
	}
	return v
}

// asUserArgv builds the argv for running bin as target.
//
// setpriv rather than sudo when we are root, because sudo opens a PAM session
// and PAM logs an open/close pair plus the command for each one. Two tmux calls
// per user every 30 seconds is ~360 journal lines an hour of bookkeeping, and
// `sudo` is in promtail's identifier allowlist, so all of it would ship to Loki
// and spend retention and part of a shared stream budget saying nothing. A root
// process does not need sudo to change uid.
func asUserArgv(amRoot bool, amUser, target string, uid, gid int, bin string, args []string) []string {
	switch {
	case target == amUser:
		return append([]string{bin}, args...)
	case amRoot:
		return append([]string{
			setprivBinary,
			"--reuid=" + strconv.Itoa(uid),
			"--regid=" + strconv.Itoa(gid),
			"--init-groups",
			bin,
		}, args...)
	default:
		// A single-user install, or the unit run unprivileged: the sudoers grant
		// the rest of the lobby's services use.
		return append([]string{sudoBinary, "-n", "-u", target, bin}, args...)
	}
}

// asUser runs a command as another OS user and returns its stdout.
func asUser(target, bin string, args ...string) (string, error) {
	uid, gid := 0, 0
	if u, err := user.Lookup(target); err == nil {
		uid, _ = strconv.Atoi(u.Uid)
		gid, _ = strconv.Atoi(u.Gid)
	}
	me := "root"
	if u, err := user.Current(); err == nil {
		me = u.Username
	}
	argv := asUserArgv(os.Geteuid() == 0, me, target, uid, gid, bin, args)
	out, err := exec.Command(argv[0], argv[1:]...).Output()
	return string(out), err
}

// readTombstones reads the root-owned 0600 tombstone file, which is why this
// unit runs as root rather than as wizard like the rest of the lobby's services.
// The alternative was a new line in /etc/sudoers.d/ttyd-users, which is per-box
// identity data the package deliberately does not ship and which is maintained
// by hand; a hardened unit that needs no grant is the smaller surface of the two.
func readTombstones(user string) (string, error) {
	raw, err := os.ReadFile(tombstonesFn(user))
	return string(raw), err
}

// Users lists the OS users to watch.
func Users() []string {
	raw, err := os.ReadFile(userMap)
	if err != nil {
		// Single-user install: watch whoever we are.
		if u := os.Getenv("USER"); u != "" {
			return []string{u}
		}
		return nil
	}
	return parseUserMap(string(raw))
}

// BootID identifies this boot, so a reboot is distinguishable from a box that
// lost every session while staying up.
func BootID() string {
	raw, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}
