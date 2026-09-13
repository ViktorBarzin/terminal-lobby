package main

// WHICH TMUX CLIENT A BROWSER CONNECTION IS.
//
// tmux sizes a window from its clients, and an HTTP request names no client:
// two devices of one person arrive with one identity header, so POST
// /sessions/{name}/grid could only ever guess which of them was asking. That
// guess is what kept last-active-wins out of reach — the handler could promote
// the single client a hover left behind (grid_size.go preloadClientName) and
// nothing more.
//
// The browser closes the gap by minting a per-connection id, 16 random bytes as
// lowercase hex, and sending it as ttyd arg 8. devvm/tmux-attach.sh records its
// own pty against that id before it execs, and this file reads the record back.
//
// THREE PROPERTIES HOLD IT TOGETHER.
//
// The directory belongs to the SERVICE account, not to the session owner. ttyd
// and tmux-api run as the same user (devvm/ttyd.service and
// devvm/tmux-api.service both say User=wizard; the container runs every service
// as `dev`), so one directory is writable by the writer and readable by the
// reader with no sudo and no shared group. Another user's /run/user/<uid> is
// 0700 and owned by them, so a per-owner directory would need a privilege this
// service should not need.
//
// A record is never deleted by its writer. The attach script execs, so no trap
// of its can run afterwards. Everything therefore rests on the reader
// disbelieving the file: the tty is validated against the live client list on
// every read, and a start-up sweep drops the records nobody holds.
//
// The tty alone is not enough for every user. `Defaults use_pty` (/etc/sudoers
// on this box) gives a sudo'd command its own pty, so for every user the ttyd
// account is not, the pty the script can read is not the one the tmux client
// runs on. Measured 2026-09-13: outer /dev/pts/62, sudo'd /dev/pts/66. The pid
// is recorded beside the tty for exactly that case — `exec sudo` keeps the
// script's pid, and the client is two hops below it.

import (
	"bytes"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// clientIDRe is the whole charset a connection id may use: 16 bytes of
// randomness as lowercase hex. It is deliberately the same class
// devvm/tmux-attach.sh gates arg 8 on, and the same one the browser mints
// (frontend-v2/src/lib/client-id.ts).
//
// The class does two jobs. It is the input discipline every other arg in that
// script gets — a value that does not match is no request at all, and the claim
// falls back to today's behaviour — and it is what makes the id safe as a FILE
// NAME here: no '/', no '.', no space, so nothing presented to this service can
// build a path out of it.
var clientIDRe = regexp.MustCompile(`^[0-9a-f]{32}$`)

// sudoPtyHops bounds the walk from a tmux client's pid up to the pid the attach
// script recorded. Measured on this box 2026-09-13: zero hops without sudo
// (`exec tmux` keeps the pid), two with (sudo forks a pty monitor, 333064 ->
// 333070 -> 333071). Four is that plus slack, and it is what keeps a pid lookup
// from walking to init on every miss.
const sudoPtyHops = 4

// clientRecord is one line of the registry: the pty the attach runs on, and the
// pid of the script that wrote it.
type clientRecord struct {
	TTY string
	PID int
}

// clientRegistryDir is where the records live, resolved against THIS process's
// runtime dir. $XDG_RUNTIME_DIR first, for the container image, which has no
// logind and so no /run/user/<uid> at all.
func clientRegistryDir() string {
	base := os.Getenv("XDG_RUNTIME_DIR")
	if base == "" {
		base = filepath.Join("/run/user", strconv.Itoa(os.Getuid()))
	}
	return filepath.Join(base, "terminal-lobby", "clients")
}

// readClientRecord reads one record, or reports false for anything it cannot
// use. A package var so the handler's tests stay pure units.
var readClientRecord = func(id string) (clientRecord, bool) {
	if !clientIDRe.MatchString(id) {
		return clientRecord{}, false
	}
	raw, err := os.ReadFile(filepath.Join(clientRegistryDir(), id))
	if err != nil {
		return clientRecord{}, false
	}
	tty, pid, _ := strings.Cut(strings.TrimSpace(string(raw)), "\t")
	if !ttyRe.MatchString(tty) {
		tty = ""
	}
	rec := clientRecord{TTY: tty}
	if n, err := strconv.Atoi(strings.TrimSpace(pid)); err == nil && n > 1 {
		rec.PID = n
	}
	return rec, rec.TTY != "" || rec.PID > 0
}

// parentPID is the ppid of a process, or 0 when it cannot be read. A package
// var so the ancestry walk can be driven from a test without a process tree.
//
// The comm field can contain spaces and parentheses, so the parse starts after
// the LAST ')' rather than splitting the whole line.
var parentPID = func(pid int) int {
	raw, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return 0
	}
	i := bytes.LastIndexByte(raw, ')')
	if i < 0 {
		return 0
	}
	fields := strings.Fields(string(raw[i+1:]))
	// After the comm come state and ppid.
	if len(fields) < 2 {
		return 0
	}
	ppid, err := strconv.Atoi(fields[1])
	if err != nil {
		return 0
	}
	return ppid
}

// descendantOf reports whether pid is ancestor, or is within sudoPtyHops below
// it. The bound matters: an unbounded walk on a miss reaches init every time.
func descendantOf(ancestor, pid int) bool {
	if ancestor <= 1 || pid <= 1 {
		return false
	}
	for range sudoPtyHops {
		if pid == ancestor {
			return true
		}
		pid = parentPID(pid)
		if pid <= 1 {
			return false
		}
	}
	return false
}

// claimingClient names the tmux client a connection id belongs to, as a `-t`
// target, or "" when it cannot say.
//
// "" is not an error and is the common case for a while yet: a socket opened
// before this shipped carries no id at all. The caller falls back to what it
// did before per-client resolution existed (grid_size.go, decision 7).
//
// The client must be in the list of clients attached to THE SESSION BEING
// CLAIMED, which is a safety requirement and not only staleness hygiene:
// `switch-client -c X -t =other:` MOVES client X onto that session (measured on
// tmux 3.4, 2026-09-13), so a resolved client attached somewhere else would be
// dragged across by a claim. Scanning the session's own list is what makes the
// switch a resize and nothing more.
//
// A READ-ONLY client is never named. A watcher asking to be the size is what
// PinGrid exists to refuse, and promoting one would clear the ignore-size flag
// that makes Watch mode's promise true.
func claimingClient(id, session string, clients []client) string {
	rec, ok := readClientRecord(id)
	if !ok {
		return ""
	}
	return matchClient(rec, clients, session, true)
}

// matchClient is the lookup itself.
//
// `session` is the session being claimed, and a client on any other one is
// never named. The fork the caller made was already scoped with `-t
// =<session>:`, so this is the second of two checks on the same thing — and it
// is worth having twice, because the cost of getting it wrong is a person's
// terminal being dragged onto a session they did not open. "" means any
// session, which is what the sweep asks.
//
// `skipReadOnly` is what tells a CLAIM from the sweep's liveness question: a
// watcher may never claim, but its record belongs to a live connection and must
// not be swept out from under it.
func matchClient(rec clientRecord, clients []client, session string, skipReadOnly bool) string {
	usable := func(c client) bool {
		if session != "" && c.Session != session {
			return false
		}
		return ttyRe.MatchString(c.Name) && !(skipReadOnly && isReadOnly(c.Flags))
	}
	// The pty first: it is exact, and it is what every attach that did not go
	// through sudo recorded.
	if rec.TTY != "" {
		for _, c := range clients {
			if usable(c) && c.Name == rec.TTY {
				return c.Name
			}
		}
	}
	// Then the pid, which is what survives sudo's own pty.
	if rec.PID > 1 {
		for _, c := range clients {
			if usable(c) && descendantOf(rec.PID, c.PID) {
				return c.Name
			}
		}
	}
	return ""
}

// allClients lists every client on one user's tmux server, and says whether it
// could read one at all. A package var so the sweep's tests stay pure units.
var allClients = func(osUser string) ([]client, bool) {
	out, err := tmuxCmd(osUser, "list-clients", "-F", clientsListFmt).Output()
	if err != nil {
		return nil, false
	}
	return parseClients(out), true
}

// sweepClientRegistry drops the records no live client holds, and returns how
// many it removed.
//
// Nothing deletes a record when its connection ends, because the attach script
// execs: a start where the client lists can be read is the only chance to tidy
// up. Correctness never depends on this — a stale record resolves to nothing on
// every read — so a tmux that cannot be reached means the sweep keeps
// everything rather than deleting records it cannot judge.
//
// Only names that match clientIDRe are considered, so a file this service did
// not write is left where it is.
func sweepClientRegistry(users []string) int {
	dir := clientRegistryDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	var live []client
	for _, u := range users {
		cs, ok := allClients(u)
		if !ok {
			return 0
		}
		live = append(live, cs...)
	}
	swept := 0
	for _, e := range entries {
		if e.IsDir() || !clientIDRe.MatchString(e.Name()) {
			continue
		}
		rec, ok := readClientRecord(e.Name())
		if ok && matchClient(rec, live, "", false) != "" {
			continue
		}
		if err := os.Remove(filepath.Join(dir, e.Name())); err == nil {
			swept++
		}
	}
	return swept
}
