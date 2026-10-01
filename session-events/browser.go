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
)

// watchOnlyMessages are the viewer messages a watch-only connection may send:
// choosing what to look at, and nothing that touches the page or control.
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
	// viewer is the caller's own OS user, never an act-as target. It is the
	// name the host shows as the controller.
	viewer string
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

// viewerHello is the first line the host reads on every connection.
type viewerHello struct {
	T          string `json:"t"`
	User       string `json:"user"`
	CanControl bool   `json:"canControl"`
}

func encodeViewerHello(acc browserAccess) []byte {
	b, _ := json.Marshal(viewerHello{T: "hello", User: acc.viewer, CanControl: acc.canControl})
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
// A "hello" is always dropped: only this file writes the hello, and the host
// reads only the first one, but nothing after it should look like one either.
func filterViewerMessage(raw []byte, canControl bool) ([]byte, bool) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil || m == nil {
		return nil, false
	}
	var t string
	if err := json.Unmarshal(m["t"], &t); err != nil || t == "" || t == "hello" {
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

// browserSocketWithin is the boundary on a socket path read from a tmux
// option, which anything running in the session can set. It must be a host
// socket name in one of the two directories the host uses for uid, written
// exactly (no "..", no trailing slash), so the option cannot point this
// service, or the bridge running as the owner, at any other socket.
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
	return acc, true
}

// locate reads the two options. ok=false is a session tmux does not have; an
// empty state is a session with no browser.
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
		relayBrowser(conn, host, acc.canControl)
		events.Emit("browser.stream_closed", acc.viewer, telemetry.Attrs{
			"tl.session": session, "tl.ms": time.Since(start).Milliseconds(),
		})
	}
}

// relayBrowser pipes one viewer connection until either end goes: host lines
// out as WebSocket text messages, lobby messages in through the filter.
func relayBrowser(conn *websocket.Conn, host io.ReadWriteCloser, canControl bool) {
	conn.SetReadLimit(maxViewerMessage)
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
		t := time.NewTicker(browserPingEvery)
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

	for {
		typ, msg, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if typ != websocket.TextMessage {
			continue
		}
		out, ok := filterViewerMessage(msg, canControl)
		if !ok {
			continue
		}
		if _, err := host.Write(out); err != nil {
			return
		}
	}
}
