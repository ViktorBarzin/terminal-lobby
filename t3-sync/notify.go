package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// The one thing the syncer cannot work out for itself: whether a session's
// disappearance was DELIBERATE.
//
// Decision 3 splits the two, and the split is not observable from tmux. A
// session killed from the lobby and a session killed by earlyoom leave exactly
// the same absence behind, and getting it wrong in the destructive direction
// would archive a thread whose conversation is about to be resurrected. So the
// lobby tells us: tmux-api posts a notice here when a kill goes through its own
// handler, and a session that simply stopped existing changes nothing in T3.
//
// The seam, settled with the producer in CONTRACT.md §8.2 and implemented in
// tmux-api/killnotify.go:
//
//	POST <listen>/notify/kill
//	{"osUser":"wizard","session":"feat-header","killedAt":"2026-08-16T00:00:00Z","source":"tmux-api"}
//	→ 204 No Content
//
// osUser, killedAt and source are optional; session is required. The last two
// are accepted and ignored — they cost nothing to send and make the notice
// legible in a journal or a packet capture. Unknown fields are ignored too, so
// the producer can grow the shape without a lockstep release.
// TestKillNoticeWireMatchesTmuxAPI pins the path and the keys against the
// producer's own source.
//
// Deployed, the listener is loopback TCP: the unit passes
// -notify-addr 127.0.0.1:${TL_T3_SYNC_NOTIFY_PORT} from the same env file
// tmux-api reads the port out of, one per user from the 7695–7699 block. Run by
// hand with no address it is a UNIX SOCKET under the user's own runtime dir
// instead ($XDG_RUNTIME_DIR/terminal-lobby/t3-sync.sock, mode 0600), which
// needs no port allocated to it. The payload is identical either way.
const NotifyKilledPath = "/notify/kill"

// KillNotices collects deliberate-kill notices between reconcile passes.
//
// It is a SET, not a queue: two notices for one session are one fact, and the
// plan they feed is a set of intentions. Safe for concurrent use — the listener
// writes from its own goroutines and the loop drains from the ticker's.
type KillNotices struct {
	osUser string

	mu      sync.Mutex
	pending map[string]bool
}

// NewKillNotices makes a collector for one OS user's sessions.
func NewKillNotices(osUser string) *KillNotices {
	return &KillNotices{osUser: osUser, pending: map[string]bool{}}
}

// Drain returns the pending session names and clears them, sorted so a log
// line and a test both read the same way twice.
func (k *KillNotices) Drain() []string {
	k.mu.Lock()
	defer k.mu.Unlock()
	if len(k.pending) == 0 {
		return nil
	}
	out := make([]string, 0, len(k.pending))
	for name := range k.pending {
		out = append(out, name)
	}
	sort.Strings(out)
	k.pending = map[string]bool{}
	return out
}

// Requeue puts drained notices back after a pass could not act on them.
//
// Without it, a kill that arrived while t3-serve was unreachable would be lost
// and its thread would stay in the inbox forever, which is the failure the user
// would actually notice.
func (k *KillNotices) Requeue(sessions []string) {
	k.mu.Lock()
	defer k.mu.Unlock()
	for _, name := range sessions {
		k.pending[name] = true
	}
}

// add records one notice.
func (k *KillNotices) add(session string) {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.pending[session] = true
}

// killNotice is the request body. Every field but Session is optional, and the
// keys are the producer's (CONTRACT.md §8.2 / tmux-api's killNotice).
type killNotice struct {
	OSUser   string `json:"osUser"`
	Session  string `json:"session"`
	KilledAt string `json:"killedAt"`
	Source   string `json:"source"`
}

// Handler serves the notify endpoint.
func (k *KillNotices) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc(NotifyKilledPath, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var notice killNotice
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&notice); err != nil {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
		// An omitted osUser is fine: the socket is already per-user. A DIFFERENT
		// one is not — this syncer speaks for one uid and reconciling somebody
		// else's session would cross the boundary the whole design rests on.
		if notice.OSUser != "" && notice.OSUser != k.osUser {
			http.Error(w, "not this syncer's user", http.StatusForbidden)
			return
		}
		name := strings.TrimSpace(notice.Session)
		if !sessionNameRe.MatchString(name) {
			http.Error(w, "invalid session name", http.StatusBadRequest)
			return
		}
		k.add(name)
		w.WriteHeader(http.StatusNoContent)
	})
	return mux
}

// DefaultNotifyListen is where the syncer listens when nothing says otherwise:
// a unix socket in the user's own runtime directory.
func DefaultNotifyListen() string {
	dir := os.Getenv("XDG_RUNTIME_DIR")
	if dir == "" {
		dir = filepath.Join(os.TempDir(), fmt.Sprintf("terminal-lobby-%d", os.Getuid()))
	}
	return "unix:" + filepath.Join(dir, "terminal-lobby", "t3-sync.sock")
}

// ListenSpec opens the listener named by a "unix:<path>", "tcp:<addr>" or bare
// "host:port" spec.
//
// The bare form is what the systemd unit passes (-notify-addr
// 127.0.0.1:${TL_T3_SYNC_NOTIFY_PORT}), and it is checked rather than handed
// straight to net.Listen: systemd expands an unset variable to an empty string,
// so a half-filled env file arrives here as "127.0.0.1:" — which net.Listen
// would happily accept, binding a RANDOM port that tmux-api will never find.
// Failing at start is what makes that misconfiguration visible.
//
// A unix socket file outlives the process that made it, so a stale one from a
// killed syncer is removed rather than reported: refusing to start after an
// unclean shutdown would make the notice path fail exactly when it is least
// convenient. The socket is 0600 and its directory 0700 — the notice carries a
// session name, and the endpoint accepts instructions.
func ListenSpec(spec string) (net.Listener, error) {
	scheme, addr, found := strings.Cut(spec, ":")
	if !found || addr == "" {
		return nil, fmt.Errorf("listen %q: want unix:<path>, tcp:<addr> or host:port", spec)
	}
	if scheme != "unix" && scheme != "tcp" {
		// A bare host:port — the whole spec is the address.
		if err := validNotifyAddr(spec); err != nil {
			return nil, err
		}
		ln, err := net.Listen("tcp", spec)
		if err != nil {
			return nil, fmt.Errorf("listen %s: %w", spec, err)
		}
		return ln, nil
	}
	switch scheme {
	case "unix":
		if err := os.MkdirAll(filepath.Dir(addr), 0o700); err != nil {
			return nil, fmt.Errorf("listen %s: %w", spec, err)
		}
		if err := os.Remove(addr); err != nil && !os.IsNotExist(err) {
			return nil, fmt.Errorf("listen %s: removing a stale socket: %w", spec, err)
		}
		ln, err := net.Listen("unix", addr)
		if err != nil {
			return nil, fmt.Errorf("listen %s: %w", spec, err)
		}
		if err := os.Chmod(addr, 0o600); err != nil {
			ln.Close()
			return nil, fmt.Errorf("listen %s: %w", spec, err)
		}
		return ln, nil
	case "tcp":
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			return nil, fmt.Errorf("listen %s: %w", spec, err)
		}
		return ln, nil
	default:
		return nil, fmt.Errorf("listen %q: unknown scheme %q, want unix or tcp", spec, scheme)
	}
}

// validNotifyAddr rejects the shapes a half-filled environment file produces:
// no port, a port that is not a number, and port 0 (which means "pick one for
// me" — a listener nobody can find).
func validNotifyAddr(addr string) error {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("listen %q: %w", addr, err)
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return fmt.Errorf("listen %q: %q is not a port — is TL_T3_SYNC_NOTIFY_PORT set?", addr, port)
	}
	if host == "" {
		return fmt.Errorf("listen %q: no host; the notice endpoint is unauthenticated and must bind loopback", addr)
	}
	return nil
}
