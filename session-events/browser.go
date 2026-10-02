package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"

	"terminal-lobby/telemetry"
)

// The relay between the lobby and a session browser
// (docs/plans/2026-10-01-session-browser-design.md, ADR-0035).
//
// A session's browser host (tl-browser/host) records itself on the tmux
// session as @tl_browser (live or frozen) and @tl_browser_sock, and serves the
// viewer protocol on that unix socket, mode 0600 in its owner's runtime
// directory. Two routes reach it:
//
//	GET /browser/<session>         state, tabs and control, read from the
//	                               host's own hello and closed again
//	GET /browser/<session>/stream  a WebSocket carrying the viewer protocol,
//	                               one message per line, both ways
//
// The relay is where Attach mode is enforced. The host trusts the first line
// it reads, the viewer hello, because only its owner (or this service acting
// as its owner) can open the socket. So this file writes that line itself,
// with the authenticated caller and what they may do, and for a watch-only
// viewer drops every message other than watching BEFORE it reaches the host.
// The frontend hides the controls too, but that is presentation; this is the
// check.

const (
	// optBrowser and optBrowserSock are the two session options the host sets
	// on launch and unsets on exit (tl-browser/host/lib/tmux.mjs).
	optBrowser     = "@tl_browser"
	optBrowserSock = "@tl_browser_sock"
	// optSessionID is tmux's own id for the session ($N), which the host's
	// socket name carries (protocol.mjs socketName). A format, not an option,
	// so nothing in the session can set it.
	optSessionID = "session_id"

	browserLive   = "live"
	browserFrozen = "frozen"
	browserNone   = "none"

	// browserHelloTimeout bounds the state route's wait for the host's hello.
	// The host is Node and stays responsive while Chrome is frozen, so a hello
	// that takes this long means a host that is not really there.
	browserHelloTimeout = 3 * time.Second

	// maxViewerMessage bounds one message from the lobby. The largest real one
	// is a paste (insertText); 1 MiB of text is far past any form field.
	maxViewerMessage = 1 << 20

	// maxHostLine bounds one line from the host. A frame is a base64 JPEG of
	// at most 1280x800 at quality 60, about 60 to 200 KB; this is headroom,
	// and a line past it ends the stream rather than growing without limit.
	maxHostLine = 16 << 20

	// browserPingEvery keeps an idle stream alive through the ingress. With no
	// tab subscribed nothing else crosses it, and Traefik closes a quiet
	// connection.
	browserPingEvery = 25 * time.Second
	browserWriteWait = 30 * time.Second
	// browserReadWait is how long a stream waits to hear anything from the
	// lobby, a pong included, before it counts the client gone. A phone that
	// vanished without a FIN leaves the socket looking open; the host refuses
	// a resume while the old connection is open, so a stream left hanging
	// would keep the person's control from their reconnected tab. It is more
	// than two pings, so one late pong does not end a live stream.
	browserReadWait = 60 * time.Second

	// browserRecheckEvery is how often an open stream re-reads the share that
	// let it in, and browserRecheckMin the least gap between the re-reads a
	// control message triggers. Together they bound how long a revoked or
	// downgraded guest keeps driving: at most recheckMin while sending, and
	// at most recheckEvery while holding control without sending.
	browserRecheckEvery = 5 * time.Second
	browserRecheckMin   = time.Second

	// browserGrantLinger is how long after a guest's last stream closes the
	// relay keeps checking their share, to free control they may still hold
	// (controlGrants). The host keeps control across a closed connection until
	// it lapses, 10 minutes after the last input by default
	// (TL_BROWSER_CONTROL_LAPSE_MS); past that there is nothing left to free.
	// A host configured with a longer lapse outlives this, and then a revoked
	// guest's control ends at the host's own lapse, as it did before.
	browserGrantLinger = 11 * time.Minute
)

// watchOnlyMessages are the viewer messages a watch-only connection may send:
// choosing what to look at, and nothing that touches the page or control. That
// includes the answers to popups the host shows the person in control (choose
// for a select's list, dialog for alert, confirm and prompt): they change the
// page, so only a connection that may control passes them, as does resume,
// which moves control to a reconnected tab.
// An allowlist, so a message type the host learns later is refused to a
// watcher until someone decides otherwise here.
var watchOnlyMessages = map[string]bool{
	"subscribe":   true,
	"unsubscribe": true,
	"selectTab":   true,
}

// browserSharesPath is tmux-api's share store. This service runs as the same
// OS user and only reads it. A var only as a test seam.
var browserSharesPath = "/var/lib/tmux-api/shares.json"

// browserShare is one row of that store, the fields this file reads.
type browserShare struct {
	Owner string `json:"owner"`
	Name  string `json:"name"`
	Guest string `json:"guest"`
	Mode  string `json:"mode"`
}

// shareModeFor answers the share row for (owner, name, guest): "ro", "rw", or
// "" when there is none. A missing store is no shares at all, which is every
// single-user install.
func shareModeFor(path, owner, name, guest string) (string, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	var set struct {
		Shares []browserShare `json:"shares"`
	}
	if err := json.Unmarshal(raw, &set); err != nil {
		return "", fmt.Errorf("corrupt share store: %w", err)
	}
	for _, sh := range set.Shares {
		if sh.Owner == owner && sh.Name == name && sh.Guest == guest {
			return sh.Mode, nil
		}
	}
	return "", nil
}

// browserAccess is what one request may do with one session's browser.
type browserAccess struct {
	// owner is the OS user the session and its host belong to.
	owner string
	// viewer is the caller's own OS user, never an act-as target. Telemetry
	// records the stream under it.
	viewer string
	// name is the name the host shows as the controller: the identity
	// header's (displayNameOf), which reads "vbarzin" where viewer reads
	// "wizard". It decides nothing here; canControl comes from the OS users
	// alone. Empty means viewer.
	name string
	// canControl is the Attach mode ceiling: true for the owner and an rw
	// share, false for an ro share and for a Lens.
	canControl bool
}

// errNotShared is a session of someone else's that the caller holds no share
// for.
var errNotShared = errors.New("not shared")

// resolveBrowserAccess decides the ceiling the way the terminal's attach does
// (tmux-api handleInternalAttach), from the caller and the session's owner.
//
//   - Your own session: rw.
//   - Someone else's: the share row's mode, and no row is a refusal. Project
//     membership is not consulted, because the terminal's attach does not
//     consult it either, and watching the browser must not reach further than
//     watching the terminal.
//   - A Lens (?as=, so eff differs from real) only watches, whatever the
//     ceiling. The Lens watches every terminal it attaches, and its browser
//     view follows the same rule.
//
// ownerParam is the ?owner= the client sent for a shared session; empty means
// the effective user's own.
func resolveBrowserAccess(eff, real, ownerParam, session string,
	shares func(owner, name, guest string) (string, error)) (browserAccess, error) {
	owner := ownerParam
	if owner == "" {
		owner = eff
	}
	ceiling := shareModeRW
	if owner != eff {
		mode, err := shares(owner, session, eff)
		if err != nil {
			return browserAccess{}, err
		}
		if mode != shareModeRO && mode != shareModeRW {
			return browserAccess{}, errNotShared
		}
		ceiling = mode
	}
	return browserAccess{
		owner:      owner,
		viewer:     real,
		canControl: ceiling == shareModeRW && eff == real,
	}, nil
}

const (
	shareModeRO = "ro"
	shareModeRW = "rw"
)

// hostName is the name the viewer hello gives the host for this connection.
func (acc browserAccess) hostName() string {
	if acc.name != "" {
		return acc.name
	}
	return acc.viewer
}

// viewerHello is the first line the host reads on every connection. User is
// the name the host shows as control's holder; the host keys control on its
// own per-connection id, which it sends the viewer in its hello as "you".
type viewerHello struct {
	T          string `json:"t"`
	User       string `json:"user"`
	CanControl bool   `json:"canControl"`
}

func encodeViewerHello(acc browserAccess) []byte {
	b, _ := json.Marshal(viewerHello{T: "hello", User: acc.hostName(), CanControl: acc.canControl})
	return append(b, '\n')
}

// filterViewerMessage decides whether one message from the lobby reaches the
// host, and re-encodes it when it does.
//
// The re-encoding is part of the check. The host splits its input on newlines,
// so a message carrying one could smuggle a second message past this filter;
// and Go and JavaScript read a duplicate or differently-cased key differently,
// so `{"t":"subscribe","T":...}` could mean one thing here and another there.
// Decoding into a map with exact keys and marshalling it again leaves one key
// per name and no raw newline, which makes what was checked and what the host
// parses the same message.
//
// A "hello" or a "release" is always dropped: only this file writes either,
// and only as a connection's first line, which the host alone honours, but
// nothing a viewer sends should look like one either.
func filterViewerMessage(raw []byte, canControl bool) ([]byte, bool) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil || m == nil {
		return nil, false
	}
	var t string
	if err := json.Unmarshal(m["t"], &t); err != nil || t == "" || t == "hello" || t == "release" {
		return nil, false
	}
	if !canControl && !watchOnlyMessages[t] {
		return nil, false
	}
	out, err := json.Marshal(m)
	if err != nil {
		return nil, false
	}
	return append(out, '\n'), true
}

// readHostLine reads one newline-terminated line, without its terminator, and
// refuses one longer than max rather than buffering it whole. A partial line at
// EOF is dropped: the host always ends a message with a newline.
func readHostLine(br *bufio.Reader, max int) ([]byte, error) {
	var line []byte
	for {
		chunk, err := br.ReadSlice('\n')
		line = append(line, chunk...)
		if len(line) > max {
			return nil, fmt.Errorf("browser: host line over %d bytes", max)
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if err != nil {
			return nil, err
		}
		return bytes.TrimRight(line, "\r\n"), nil
	}
}

// --- where the socket may be ------------------------------------------------

// browserRuntimeBase and browserTmpBase are where the host puts its socket:
// $XDG_RUNTIME_DIR/tl-browser, which systemd makes /run/user/<uid>, or
// /tmp/tl-browser-<uid> without one (tl-browser/host/lib/protocol.mjs
// socketDir). Vars only as test seams.
var (
	browserRuntimeBase = "/run/user"
	browserTmpBase     = "/tmp"
)

// browserSockNameRe is the host's socket name: s<N> for tmux session $N, or
// pid-<pid> outside tmux (protocol.mjs socketName), with -<pid> after it when
// another live host already serves that name, a second Claude in the same
// session (viewers.mjs listen).
var browserSockNameRe = regexp.MustCompile(`^(s[0-9]{1,10}|pid-[0-9]{1,10})(-[0-9]{1,10})?\.sock$`)

// browserSocketWithin is the first bound on a socket path read from a tmux
// option, which anything running in the session can set. It must be a host
// socket name in one of the two directories the host uses for uid, written
// exactly (no "..", no trailing slash), so the option cannot point this
// service, or the bridge running as the owner, at a socket that is not one of
// that owner's browser hosts. It does not say WHICH session's host: every
// session of one owner shares the directory, so locate also holds the name to
// the session's own id (browserSocketOfSession).
func browserSocketWithin(sock string, uid int) error {
	if !filepath.IsAbs(sock) || filepath.Clean(sock) != sock {
		return fmt.Errorf("browser: %q is not a clean absolute path", sock)
	}
	if !browserSockNameRe.MatchString(filepath.Base(sock)) {
		return fmt.Errorf("browser: %q is not a browser socket name", sock)
	}
	dir := filepath.Dir(sock)
	u := strconv.Itoa(uid)
	if dir != filepath.Join(browserRuntimeBase, u, "tl-browser") &&
		dir != filepath.Join(browserTmpBase, "tl-browser-"+u) {
		return fmt.Errorf("browser: %q is outside uid %d's browser directories", sock, uid)
	}
	return nil
}

// browserSessionIDRe is tmux's #{session_id}: a dollar sign and a number.
var browserSessionIDRe = regexp.MustCompile(`^\$([0-9]{1,10})$`)

// browserSocketOfSession holds a socket path to the session it was read from:
// its name must be s<N>.sock or s<N>-<pid>.sock where $N is that session's own
// #{session_id}. Without it, an option set in session A could name session B's
// socket, which passes every directory and ownership check, and a guest let
// into A would watch, or drive, B's browser. A pid-<pid> name never passes: a
// host outside tmux records no option, so no session's option names one.
func browserSocketOfSession(sock, sessionID string) error {
	id := browserSessionIDRe.FindStringSubmatch(sessionID)
	if id == nil {
		return fmt.Errorf("browser: %q is not a tmux session id", sessionID)
	}
	m := browserSockNameRe.FindStringSubmatch(filepath.Base(sock))
	if m == nil || m[1] != "s"+id[1] {
		return fmt.Errorf("browser: %q is not session %s's socket", sock, sessionID)
	}
	return nil
}

// browserSocketOwned checks what is actually on disk: a real directory and a
// socket, both owned by uid. /tmp is shared, so without this anyone could
// create /tmp/tl-browser-<uid> before the host does and plant a socket that
// receives the viewer's hello and feeds it frames of their choosing.
func browserSocketOwned(sock string, uid int) error {
	for _, p := range []struct {
		path string
		mode os.FileMode
	}{{filepath.Dir(sock), os.ModeDir}, {sock, os.ModeSocket}} {
		fi, err := os.Lstat(p.path)
		if err != nil {
			return fmt.Errorf("browser: %w", err)
		}
		if fi.Mode().Type() != p.mode {
			return fmt.Errorf("browser: %q is not a %v", p.path, p.mode)
		}
		st, ok := fi.Sys().(*syscall.Stat_t)
		if !ok || int(st.Uid) != uid {
			return fmt.Errorf("browser: %q is not owned by uid %d", p.path, uid)
		}
	}
	return nil
}

// dialOwnSocket opens a socket belonging to this process's own user, after
// both checks.
func dialOwnSocket(sock string) (net.Conn, error) {
	uid := os.Getuid()
	if err := browserSocketWithin(sock, uid); err != nil {
		return nil, err
	}
	if err := browserSocketOwned(sock, uid); err != nil {
		return nil, err
	}
	return net.Dial("unix", sock)
}

// --- the privileged bridge ----------------------------------------------------

// browserBridgeOp is the privop that relays one viewer connection for a user
// this service is not: `session-events -privop browser-bridge <socket>`, run
// through the same sudo grant as the read child (privop.go). It is a
// per-connection child rather than an op on the long-lived read child,
// because a stream is long-lived and bidirectional and the read child's pipe
// carries one request at a time.
const browserBridgeOp = "browser-bridge"

// runBrowserBridge is the child's whole life: check the socket against its own
// uid, dial it, and copy bytes both ways until either side ends. It re-checks
// the path itself rather than trusting the parent, the same as every other
// privop.
func runBrowserBridge(sock string, in io.Reader, out io.Writer) error {
	conn, err := dialOwnSocket(sock)
	if err != nil {
		return err
	}
	defer conn.Close()
	go func() {
		io.Copy(conn, in)
		// The lobby went away: say so to the host, which closes its end, and
		// that ends the copy below.
		if uc, ok := conn.(*net.UnixConn); ok {
			uc.CloseWrite()
		} else {
			conn.Close()
		}
	}()
	_, err = io.Copy(out, conn)
	return err
}

// browserBridgeCommand is the exact command line for the bridge: the read
// child's command (privopCommand, the shape the sudoers grant is written
// against) plus the op and the socket.
func browserBridgeCommand(osUser, exe, sock string) []string {
	return append(privopCommand(osUser, exe), browserBridgeOp, sock)
}

// bridgeConn is the parent's end of a bridge child: its stdout to read, its
// stdin to write, and the process to stop.
type bridgeConn struct {
	io.Reader
	stdin io.WriteCloser
	cmd   *exec.Cmd
	once  sync.Once
}

func (c *bridgeConn) Write(p []byte) (int, error) { return c.stdin.Write(p) }

func (c *bridgeConn) Close() error {
	c.once.Do(func() {
		c.stdin.Close()
		if c.cmd.Process != nil {
			c.cmd.Process.Kill()
		}
		c.cmd.Wait()
	})
	return nil
}

// dialBridge starts a bridge child as osUser. The parent checks the path
// against that user's uid first, so an option pointing elsewhere is refused
// without a sudo call; the child checks it again, with what is on disk.
func dialBridge(osUser, sock string) (io.ReadWriteCloser, error) {
	u, err := user.Lookup(osUser)
	if err != nil {
		return nil, fmt.Errorf("browser: %w", err)
	}
	uid, err := strconv.Atoi(u.Uid)
	if err != nil {
		return nil, fmt.Errorf("browser: uid %q: %w", u.Uid, err)
	}
	if err := browserSocketWithin(sock, uid); err != nil {
		return nil, err
	}
	exe, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("browser: locating this binary: %w", err)
	}
	exe = strings.TrimSuffix(exe, " (deleted)") // see sudoChild
	argv := browserBridgeCommand(osUser, exe, sock)
	cmd := exec.Command(argv[0], argv[1:]...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("browser: starting a bridge for %s: %w", osUser, err)
	}
	return &bridgeConn{Reader: stdout, stdin: stdin, cmd: cmd}, nil
}

// --- the routes -----------------------------------------------------------------

// browserRelay serves both routes. Its fields are the seams the tests replace.
type browserRelay struct {
	// opts reads the session's options, as the session's owner.
	opts stampReader
	// shares answers a share row's mode (shareModeFor over the store).
	shares func(owner, name, guest string) (string, error)
	// dial opens a connection to a host socket belonging to owner.
	dial func(owner, sock string) (io.ReadWriteCloser, error)
	// helloTimeout bounds the state route's wait for the host's hello.
	helloTimeout time.Duration
	// recheckEvery and recheckMin pace an open stream's re-reading of the
	// share that let it in (streamGuard). recheckEvery also paces the sweep
	// of closed guests' grants.
	recheckEvery time.Duration
	recheckMin   time.Duration
	// grantLinger is browserGrantLinger, a field only as a test seam.
	grantLinger time.Duration
	// pingEvery and readWait are browserPingEvery and browserReadWait, fields
	// only as test seams.
	pingEvery time.Duration
	readWait  time.Duration

	grantMu  sync.Mutex
	grants   map[controlGrant]*grantState
	sweeping bool
}

func newBrowserRelay(opts stampReader, self string) *browserRelay {
	return &browserRelay{
		opts: opts,
		shares: func(owner, name, guest string) (string, error) {
			return shareModeFor(browserSharesPath, owner, name, guest)
		},
		// Your own user's socket is dialled directly; anyone else's only
		// through a bridge running as them, because the socket is 0600.
		dial: func(owner, sock string) (io.ReadWriteCloser, error) {
			if owner == self {
				return dialOwnSocket(sock)
			}
			return dialBridge(owner, sock)
		},
		helloTimeout: browserHelloTimeout,
		recheckEvery: browserRecheckEvery,
		recheckMin:   browserRecheckMin,
		grantLinger:  browserGrantLinger,
		pingEvery:    browserPingEvery,
		readWait:     browserReadWait,
	}
}

// access resolves the request, answering the refusal itself when there is one.
func (b *browserRelay) access(w http.ResponseWriter, r *http.Request) (browserAccess, bool) {
	acc, err := resolveBrowserAccess(osUserFrom(r.Context()), realOSUserFrom(r.Context()),
		r.URL.Query().Get("owner"), r.PathValue("session"), b.shares)
	switch {
	case errors.Is(err, errNotShared):
		http.Error(w, "not shared", http.StatusForbidden)
		return browserAccess{}, false
	case err != nil:
		log.Printf("browser: share lookup: %v", err)
		http.Error(w, "share lookup failed", http.StatusInternalServerError)
		return browserAccess{}, false
	}
	acc.name = displayNameFrom(r.Context())
	return acc, true
}

// locate reads the two options, and the session's id to hold the socket to.
// ok=false is a session tmux does not have; an empty state is a session with
// no browser, which includes an option naming a socket that is not this
// session's own.
func (b *browserRelay) locate(owner, session string) (state, sock string, ok bool) {
	state, ok = b.opts.Option(owner, session, optBrowser)
	if !ok {
		return "", "", false
	}
	if state != browserLive && state != browserFrozen {
		return "", "", true
	}
	sock, _ = b.opts.Option(owner, session, optBrowserSock)
	if sock == "" {
		return "", "", true
	}
	id, _ := b.opts.Option(owner, session, optSessionID)
	if err := browserSocketOfSession(sock, id); err != nil {
		log.Printf("browser: %s/%s: %v", owner, session, err)
		return "", "", true
	}
	return state, sock, true
}

// hostHello is the parts of the host's hello the state route passes on.
type hostHello struct {
	T        string          `json:"t"`
	State    string          `json:"state"`
	Tabs     json.RawMessage `json:"tabs"`
	AgentTab json.RawMessage `json:"agentTab"`
	Control  json.RawMessage `json:"control"`
}

// browserStateBody is GET /browser/<session>'s answer.
type browserStateBody struct {
	State    string          `json:"state"`
	Tabs     json.RawMessage `json:"tabs"`
	AgentTab json.RawMessage `json:"agentTab"`
	Control  json.RawMessage `json:"control"`
}

func noBrowser() browserStateBody {
	return browserStateBody{
		State: browserNone, Tabs: json.RawMessage("[]"), AgentTab: json.RawMessage("null"),
		Control: json.RawMessage(`{"holder":null,"since":null,"lapseAt":null}`),
	}
}

// peek opens a watch-only connection, reads the host's hello and closes it.
// Watching wakes nothing: the host thaws a frozen browser on a subscribe, and
// this never subscribes.
func (b *browserRelay) peek(acc browserAccess, sock string) (hostHello, error) {
	conn, err := b.dial(acc.owner, sock)
	if err != nil {
		return hostHello{}, err
	}
	defer conn.Close()
	watch := acc
	watch.canControl = false
	type result struct {
		h   hostHello
		err error
	}
	done := make(chan result, 1)
	go func() {
		if _, err := conn.Write(encodeViewerHello(watch)); err != nil {
			done <- result{err: err}
			return
		}
		line, err := readHostLine(bufio.NewReader(conn), maxHostLine)
		if err != nil {
			done <- result{err: err}
			return
		}
		var h hostHello
		if err := json.Unmarshal(line, &h); err != nil || h.T != "hello" {
			done <- result{err: fmt.Errorf("browser: the host's first line is not a hello")}
			return
		}
		done <- result{h: h}
	}()
	select {
	case res := <-done:
		return res.h, res.err
	case <-time.After(b.helloTimeout):
		return hostHello{}, errors.New("browser: no hello from the host")
	}
}

// handleState serves GET /browser/{session}.
//
// "none" covers a session whose host is gone without clearing its options,
// killed outright say, as well as one that never browsed: either way there is
// no browser to show.
func (b *browserRelay) handleState() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		acc, ok := b.access(w, r)
		if !ok {
			return
		}
		state, sock, exists := b.locate(acc.owner, r.PathValue("session"))
		if !exists {
			http.Error(w, "no such session", http.StatusNotFound)
			return
		}
		if state == "" {
			writeJSON(w, noBrowser())
			return
		}
		h, err := b.peek(acc, sock)
		if err != nil {
			writeJSON(w, noBrowser())
			return
		}
		body := noBrowser()
		body.State = state
		if h.State == browserLive || h.State == browserFrozen {
			body.State = h.State
		}
		if len(h.Tabs) > 0 && string(h.Tabs) != "null" {
			body.Tabs = h.Tabs
		}
		if len(h.AgentTab) > 0 {
			body.AgentTab = h.AgentTab
		}
		if len(h.Control) > 0 && string(h.Control) != "null" {
			body.Control = h.Control
		}
		writeJSON(w, body)
	}
}

// sameOrigin is the WebSocket origin check. A browser sends Origin on every
// WebSocket handshake and cannot be made to send another site's, so requiring
// it to name this host is what stops a page elsewhere opening a stream with
// the viewer's cookies and driving their browser. Stricter than gorilla's
// default, which lets a handshake with no Origin through. The ingress passes
// Host through; the dev proxy keeps it by leaving changeOrigin off for
// /browser (frontend-v2/vite.config.ts).
func sameOrigin(r *http.Request) bool {
	u, err := url.Parse(r.Header.Get("Origin"))
	if err != nil || u.Host == "" {
		return false
	}
	return strings.EqualFold(u.Host, r.Host)
}

var browserUpgrader = websocket.Upgrader{
	ReadBufferSize:  4 << 10,
	WriteBufferSize: 64 << 10,
	CheckOrigin:     sameOrigin,
}

// handleStream serves GET /browser/{session}/stream.
//
// The host is dialled and handed the hello BEFORE the upgrade, so a session
// with no browser is an HTTP 404 the client can read, not a socket that opens
// and closes at once.
func (b *browserRelay) handleStream() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		acc, ok := b.access(w, r)
		if !ok {
			return
		}
		session := r.PathValue("session")
		_, sock, exists := b.locate(acc.owner, session)
		if !exists || sock == "" {
			http.Error(w, "no browser", http.StatusNotFound)
			return
		}
		host, err := b.dial(acc.owner, sock)
		if err != nil {
			http.Error(w, "no browser", http.StatusNotFound)
			return
		}
		if _, err := host.Write(encodeViewerHello(acc)); err != nil {
			host.Close()
			http.Error(w, "browser not reachable", http.StatusBadGateway)
			return
		}
		conn, err := browserUpgrader.Upgrade(w, r, nil)
		if err != nil {
			host.Close() // Upgrade has answered the client already
			return
		}
		mode := "watch"
		if acc.canControl {
			mode = "control"
		}
		attrs := telemetry.Attrs{"tl.session": session, "tl.mode": mode, "tl.client": "api"}
		if acc.owner != acc.viewer {
			attrs["tl.to"] = acc.owner
		}
		events.Emit("browser.stream_opened", acc.viewer, attrs)
		start := time.Now()
		eff, real, ownerParam := osUserFrom(r.Context()), realOSUserFrom(r.Context()), r.URL.Query().Get("owner")
		resolve := func() (browserAccess, error) {
			return resolveBrowserAccess(eff, real, ownerParam, session, b.shares)
		}
		guard := &streamGuard{
			canControl: acc.canControl,
			resolve:    resolve,
			every:      b.recheckEvery,
			min:        b.recheckMin,
		}
		// A guest able to control may take it and close the tab still holding
		// it, so their grant outlives the stream (controlGrants). The owner's
		// control never ends by a share, and a watcher holds none.
		if acc.canControl && acc.owner != eff {
			key := controlGrant{owner: acc.owner, session: session, sock: sock, name: acc.hostName()}
			closed, released := b.openGrant(key, resolve)
			defer closed()
			guard.release = func() {
				released()
				if err := b.release(key.owner, key.sock, key.name); err != nil {
					log.Printf("browser: releasing %s's control of %s/%s: %v", key.name, key.owner, key.session, err)
				}
			}
		}
		relayBrowser(conn, host, guard, streamTiming{ping: b.pingEvery, readWait: b.readWait})
		events.Emit("browser.stream_closed", acc.viewer, telemetry.Attrs{
			"tl.session": session, "tl.ms": time.Since(start).Milliseconds(),
		})
	}
}

// streamGuard keeps an open stream inside the authority it was opened with.
//
// The access check runs once, before the upgrade, but a stream lasts as long
// as the tab. tmux-api revokes a share, or changes its mode, by rewriting the
// store and detaching the guest's terminal; nothing tells this service. So the
// stream re-reads the store itself: before a control message once recheckMin
// has passed since the last read, and on a ticker of recheckEvery for a guest
// who is not sending. A stream opened to drive ends the moment its caller may
// no longer drive, and a watch-only stream when its caller may no longer watch.
// A store that cannot be read counts as no share: the stream fails closed.
type streamGuard struct {
	// canControl is the authority the stream was opened with.
	canControl bool
	// resolve re-runs the access decision for the same caller and session.
	resolve func() (browserAccess, error)
	every   time.Duration
	min     time.Duration
	// release frees any control the caller holds, on whichever connection,
	// when the stream loses its authority. nil when there is none to free.
	release func()
}

// holds reports whether the caller still has the authority the stream was
// opened with.
func (g *streamGuard) holds() bool {
	acc, err := g.resolve()
	if err != nil {
		if !errors.Is(err, errNotShared) {
			log.Printf("browser: share recheck: %v", err)
		}
		return false
	}
	return acc.canControl || !g.canControl
}

// streamTiming paces a stream's liveness check: a ping every ping, and the
// stream ends when nothing, a pong included, arrives within readWait.
type streamTiming struct {
	ping     time.Duration
	readWait time.Duration
}

// relayBrowser pipes one viewer connection until either end goes, the client
// stops answering pings, or the guard stops holding: host lines out as
// WebSocket text messages, lobby messages in through the filter.
func relayBrowser(conn *websocket.Conn, host io.ReadWriteCloser, guard *streamGuard, timing streamTiming) {
	conn.SetReadLimit(maxViewerMessage)
	// Every message and every pong pushes the deadline on; a client that has
	// gone without closing its socket lets it pass, the read fails, and the
	// host connection closes with the stream.
	alive := func() { conn.SetReadDeadline(time.Now().Add(timing.readWait)) }
	alive()
	conn.SetPongHandler(func(string) error {
		alive()
		return nil
	})
	done := make(chan struct{})
	var once sync.Once
	stop := func() {
		once.Do(func() {
			close(done)
			host.Close()
			conn.Close()
		})
	}
	defer stop()

	// hostMu orders writes to the host, which come from the read loop and,
	// when the guard stops holding, from the recheck ticker. Once revoked is
	// set nothing more reaches the host.
	var hostMu sync.Mutex
	revoked := false
	writeHost := func(b []byte) error {
		hostMu.Lock()
		defer hostMu.Unlock()
		if revoked {
			return errors.New("browser: the stream's access changed")
		}
		_, err := host.Write(b)
		return err
	}
	// revoke ends a stream whose authority lapsed. Control the caller may hold
	// is released first: the host keeps control across a dropped connection
	// (a reload should not lose it), so without this the agent would stay
	// locked out until the control lapse. It is a release rather than a
	// handBack on this stream, because the host holds control by connection
	// and the caller may hold it on another one, a tab already closed.
	revoke := func() {
		hostMu.Lock()
		first := !revoked
		revoked = true
		hostMu.Unlock()
		if first && guard.canControl && guard.release != nil {
			guard.release()
		}
		conn.WriteControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "access changed"),
			time.Now().Add(time.Second))
		stop()
	}

	go func() {
		defer stop()
		br := bufio.NewReaderSize(host, 64<<10)
		for {
			line, err := readHostLine(br, maxHostLine)
			if err != nil {
				// The host ended the connection: its browser closed, or the
				// host exited. A normal close says so, where a dropped network
				// reaches the lobby as an abnormal one.
				conn.WriteControl(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseNormalClosure, "browser closed"),
					time.Now().Add(time.Second))
				return
			}
			if len(line) == 0 {
				continue
			}
			conn.SetWriteDeadline(time.Now().Add(browserWriteWait))
			if err := conn.WriteMessage(websocket.TextMessage, line); err != nil {
				return
			}
		}
	}()
	go func() {
		t := time.NewTicker(timing.ping)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				if conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(browserWriteWait)) != nil {
					stop()
					return
				}
			}
		}
	}()
	go func() {
		t := time.NewTicker(guard.every)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				if !guard.holds() {
					revoke()
					return
				}
			}
		}
	}()

	var checked time.Time
	for {
		typ, msg, err := conn.ReadMessage()
		if err != nil {
			return
		}
		alive()
		if typ != websocket.TextMessage {
			continue
		}
		out, ok := filterViewerMessage(msg, guard.canControl)
		if !ok {
			continue
		}
		if guard.canControl && !isWatchMessage(out) && time.Since(checked) >= guard.min {
			if !guard.holds() {
				revoke()
				return
			}
			checked = time.Now()
		}
		if err := writeHost(out); err != nil {
			return
		}
	}
}

// isWatchMessage reports whether a message filterViewerMessage let through is
// one a watcher could send too, which needs no recheck.
func isWatchMessage(out []byte) bool {
	var m struct {
		T string `json:"t"`
	}
	return json.Unmarshal(out, &m) == nil && watchOnlyMessages[m.T]
}

// --- control a closed stream leaves behind ---------------------------------------

// controlGrants: a guest let in able to control a session's browser can take
// control and close the tab. The host keeps that control until it lapses, so a
// reload does not lose it, and with no stream left nothing re-reads the share.
// If the owner then revokes the share or turns it ro, the agent stays locked
// out until the lapse. So the relay remembers each such guest per session and
// host, and after their last stream closes keeps checking their share on the
// recheck ticker. The moment it no longer allows control, the relay frees
// that guest's control on a connection of its own (release) and forgets them.
// A grant is forgotten too once browserGrantLinger has passed since its last
// stream closed, by which time the control has lapsed at the host anyway.
//
// The sweep only runs while there is a grant, so a box nobody shares a browser
// on runs nothing.

// controlGrant names one guest's control of one host: by the name the host
// shows as holder, which is what release matches on.
type controlGrant struct {
	owner, session, sock, name string
}

type grantState struct {
	open     int
	closedAt time.Time
	// released is set when an open stream of this grant lost its authority and
	// released the control already; the sweep then forgets it without a second
	// release.
	released bool
	resolve  func() (browserAccess, error)
}

// openGrant records one more open stream for key. closed is called when that
// stream ends, released when it has freed the guest's control itself.
func (b *browserRelay) openGrant(key controlGrant, resolve func() (browserAccess, error)) (closed, released func()) {
	b.grantMu.Lock()
	defer b.grantMu.Unlock()
	if b.grants == nil {
		b.grants = map[controlGrant]*grantState{}
	}
	g := b.grants[key]
	if g == nil {
		g = &grantState{}
		b.grants[key] = g
	}
	g.open++
	g.released = false
	g.resolve = resolve
	if !b.sweeping {
		b.sweeping = true
		go b.sweepGrants()
	}
	var once sync.Once
	closed = func() {
		once.Do(func() {
			b.grantMu.Lock()
			defer b.grantMu.Unlock()
			if b.grants[key] != g {
				return
			}
			g.open--
			g.closedAt = time.Now()
			if g.open == 0 && g.released {
				delete(b.grants, key)
			}
		})
	}
	released = func() {
		b.grantMu.Lock()
		defer b.grantMu.Unlock()
		if b.grants[key] == g {
			g.released = true
		}
	}
	return closed, released
}

// grantCount is how many grants the relay is holding, for tests.
func (b *browserRelay) grantCount() int {
	b.grantMu.Lock()
	defer b.grantMu.Unlock()
	return len(b.grants)
}

// sweepGrants runs while any grant exists, and stops when none is left.
func (b *browserRelay) sweepGrants() {
	t := time.NewTicker(b.recheckEvery)
	defer t.Stop()
	for range t.C {
		if !b.sweepOnce() {
			return
		}
	}
}

// sweepOnce checks every grant with no open stream, releasing the control of
// a guest whose share no longer allows it. It reports whether grants remain;
// when none do it clears sweeping under the lock, so the next openGrant starts
// a new sweep.
func (b *browserRelay) sweepOnce() bool {
	type due struct {
		key controlGrant
		g   *grantState
	}
	var check []due
	b.grantMu.Lock()
	for k, g := range b.grants {
		if g.open > 0 {
			continue
		}
		if g.released || time.Since(g.closedAt) > b.grantLinger {
			delete(b.grants, k)
			continue
		}
		check = append(check, due{k, g})
	}
	b.grantMu.Unlock()

	for _, d := range check {
		// A store that cannot be read counts as no share, as it does for an
		// open stream: control nobody can confirm is freed.
		if acc, err := d.g.resolve(); err == nil && acc.canControl {
			continue
		}
		if err := b.release(d.key.owner, d.key.sock, d.key.name); err != nil {
			log.Printf("browser: releasing %s's control of %s/%s: %v", d.key.name, d.key.owner, d.key.session, err)
		}
		b.grantMu.Lock()
		if b.grants[d.key] == d.g && d.g.open == 0 {
			delete(b.grants, d.key)
		}
		b.grantMu.Unlock()
	}

	b.grantMu.Lock()
	defer b.grantMu.Unlock()
	if len(b.grants) == 0 {
		b.sweeping = false
		return false
	}
	return true
}

// releaseLine is the first line of a release connection. The host honours it
// only as a connection's first line, which only this service writes, and the
// filter drops it from anything a viewer sends.
type releaseLine struct {
	T    string `json:"t"`
	User string `json:"user"`
}

// release frees whatever control name holds on the host at sock, on whichever
// connection holds it: a connection of the relay's own whose first line is
// the release, in place of a viewer hello. The host answers with one control
// line and hangs up. Waiting for that answer, rather than closing at once,
// lets a bridge child deliver the line before it is stopped. A host that is
// gone is not an error worth more than a log line: with no host there is no
// control to free.
func (b *browserRelay) release(owner, sock, name string) error {
	conn, err := b.dial(owner, sock)
	if err != nil {
		return err
	}
	defer conn.Close()
	line, _ := json.Marshal(releaseLine{T: "release", User: name})
	done := make(chan error, 1)
	go func() {
		if _, err := conn.Write(append(line, '\n')); err != nil {
			done <- err
			return
		}
		_, err := readHostLine(bufio.NewReader(conn), maxHostLine)
		done <- err
	}()
	select {
	case err := <-done:
		return err
	case <-time.After(b.helloTimeout):
		return errors.New("browser: no answer to the release")
	}
}
