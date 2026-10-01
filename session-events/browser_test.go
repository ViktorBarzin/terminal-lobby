package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// --- attach mode ----------------------------------------------------------------

func TestResolveBrowserAccessFollowsAttachMode(t *testing.T) {
	shares := func(rows map[[3]string]string) func(owner, name, guest string) (string, error) {
		return func(owner, name, guest string) (string, error) {
			return rows[[3]string{owner, name, guest}], nil
		}
	}
	both := shares(map[[3]string]string{
		{"bob", "k7m2q9x4tpz3", "alice"}: "rw",
		{"bob", "r0r0r0r0r0r0", "alice"}: "ro",
		{"bob", "odd000000000", "alice"}: "admin",
	})
	cases := []struct {
		name            string
		eff, real, own  string
		session         string
		wantOwner       string
		wantViewer      string
		wantCanControl  bool
		wantErrNotShare bool
	}{
		{name: "own session", eff: "alice", real: "alice", session: "k7m2q9x4tpz3",
			wantOwner: "alice", wantViewer: "alice", wantCanControl: true},
		{name: "owner named explicitly as yourself", eff: "alice", real: "alice", own: "alice", session: "x",
			wantOwner: "alice", wantViewer: "alice", wantCanControl: true},
		{name: "rw share drives", eff: "alice", real: "alice", own: "bob", session: "k7m2q9x4tpz3",
			wantOwner: "bob", wantViewer: "alice", wantCanControl: true},
		{name: "ro share watches", eff: "alice", real: "alice", own: "bob", session: "r0r0r0r0r0r0",
			wantOwner: "bob", wantViewer: "alice", wantCanControl: false},
		{name: "no share is refused", eff: "alice", real: "alice", own: "bob", session: "nope00000000",
			wantErrNotShare: true},
		{name: "a mode that is neither is refused", eff: "alice", real: "alice", own: "bob", session: "odd000000000",
			wantErrNotShare: true},
		{name: "lens on the target's own session watches", eff: "bob", real: "admin", session: "k7m2q9x4tpz3",
			wantOwner: "bob", wantViewer: "admin", wantCanControl: false},
		{name: "lens on an rw share still watches", eff: "alice", real: "admin", own: "bob", session: "k7m2q9x4tpz3",
			wantOwner: "bob", wantViewer: "admin", wantCanControl: false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			acc, err := resolveBrowserAccess(c.eff, c.real, c.own, c.session, both)
			if c.wantErrNotShare {
				if !errors.Is(err, errNotShared) {
					t.Fatalf("err = %v, want errNotShared", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("err = %v", err)
			}
			if acc.owner != c.wantOwner || acc.viewer != c.wantViewer || acc.canControl != c.wantCanControl {
				t.Fatalf("got %+v, want owner %s viewer %s canControl %v", acc, c.wantOwner, c.wantViewer, c.wantCanControl)
			}
		})
	}
}

// A store that cannot be read is a refusal, never a guess at the ceiling.
func TestResolveBrowserAccessPassesAShareStoreFailureOn(t *testing.T) {
	boom := errors.New("disk")
	_, err := resolveBrowserAccess("alice", "alice", "bob", "x", func(string, string, string) (string, error) {
		return "", boom
	})
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want the store's error", err)
	}
}

func TestShareModeForReadsTmuxAPIsStore(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "shares.json")
	if mode, err := shareModeFor(path, "bob", "x", "alice"); err != nil || mode != "" {
		t.Fatalf("missing store: mode %q err %v, want no share and no error", mode, err)
	}
	doc := `{"version":1,"shares":[{"owner":"bob","name":"x","guest":"alice","mode":"ro","clientTty":"/dev/pts/3"}]}`
	if err := os.WriteFile(path, []byte(doc), 0o600); err != nil {
		t.Fatal(err)
	}
	if mode, err := shareModeFor(path, "bob", "x", "alice"); err != nil || mode != "ro" {
		t.Fatalf("mode %q err %v, want ro", mode, err)
	}
	if mode, _ := shareModeFor(path, "bob", "x", "carol"); mode != "" {
		t.Fatalf("another guest got %q", mode)
	}
	os.WriteFile(path, []byte("{"), 0o600)
	if _, err := shareModeFor(path, "bob", "x", "alice"); err == nil {
		t.Fatal("a corrupt store must be an error")
	}
}

// --- the filter ---------------------------------------------------------------

func TestFilterViewerMessage(t *testing.T) {
	cases := []struct {
		name       string
		in         string
		canControl bool
		want       string // "" = dropped
	}{
		{"watcher subscribes", `{"t":"subscribe","tab":null}`, false, `{"t":"subscribe","tab":null}`},
		{"watcher unsubscribes", `{"t":"unsubscribe"}`, false, `{"t":"unsubscribe"}`},
		{"watcher picks a tab", `{"t":"selectTab","tab":"2"}`, false, `{"t":"selectTab","tab":"2"}`},
		{"watcher cannot click", `{"t":"mouse","type":"click","x":1,"y":2}`, false, ""},
		{"watcher cannot scroll", `{"t":"wheel","x":1,"y":2,"dx":0,"dy":3}`, false, ""},
		{"watcher cannot type", `{"t":"key","type":"press","key":"a"}`, false, ""},
		{"watcher cannot paste", `{"t":"insertText","text":"hi"}`, false, ""},
		{"watcher cannot navigate", `{"t":"navigate","url":"https://example.com"}`, false, ""},
		{"watcher cannot go back", `{"t":"back"}`, false, ""},
		{"watcher cannot reload", `{"t":"reload"}`, false, ""},
		{"watcher cannot copy", `{"t":"copy"}`, false, ""},
		{"watcher cannot take control", `{"t":"takeControl"}`, false, ""},
		{"watcher cannot hand back", `{"t":"handBack"}`, false, ""},
		{"watcher cannot answer a popup", `{"t":"choose","value":"x"}`, false, ""},
		{"watcher cannot answer a dialog", `{"t":"dialog","accept":true}`, false, ""},
		{"an unknown type is not a watch message", `{"t":"somethingNew"}`, false, ""},
		{"controller clicks", `{"t":"mouse","type":"click","x":1,"y":2}`, true, `{"t":"mouse","type":"click","x":1,"y":2}`},
		{"controller takes control", `{"t":"takeControl"}`, true, `{"t":"takeControl"}`},
		{"nobody sends a hello", `{"t":"hello","user":"root","canControl":true}`, true, ""},
		{"not JSON", `subscribe`, true, ""},
		{"an array", `[{"t":"subscribe"}]`, true, ""},
		{"null", `null`, true, ""},
		{"no type", `{"tab":"1"}`, true, ""},
		{"a type that is not a string", `{"t":7}`, true, ""},
		// A second message after a newline would be a second line at the host.
		{"a smuggled second line", "{\"t\":\"subscribe\"}\n{\"t\":\"takeControl\"}", false, ""},
		// JSON allows whitespace between tokens, newlines included; the output
		// must still be one line.
		{"a newline inside the object", "{\"t\":\n\"subscribe\"}", false, `{"t":"subscribe"}`},
		// Duplicate keys: the last wins in Go and in JavaScript, and the output
		// carries only that one.
		{"a duplicate key, last is watch", `{"t":"takeControl","t":"subscribe"}`, false, `{"t":"subscribe"}`},
		{"a duplicate key, last is control", `{"t":"subscribe","t":"takeControl"}`, false, ""},
		// encoding/json matches struct fields case-insensitively; the filter must
		// read exactly the key the host reads.
		{"a differently cased key", `{"t":"takeControl","T":"subscribe"}`, false, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out, ok := filterViewerMessage([]byte(c.in), c.canControl)
			if c.want == "" {
				if ok {
					t.Fatalf("passed %q, want it dropped", out)
				}
				return
			}
			if !ok {
				t.Fatalf("dropped, want %s", c.want)
			}
			if string(out) != c.want+"\n" {
				t.Fatalf("got %q, want %q", out, c.want+"\n")
			}
		})
	}
}

func TestReadHostLine(t *testing.T) {
	long := strings.Repeat("a", 200<<10) // past the reader's buffer
	br := bufio.NewReaderSize(strings.NewReader(long+"\nshort\r\npartial"), 4096)
	if got, err := readHostLine(br, 1<<20); err != nil || string(got) != long {
		t.Fatalf("long line: len %d err %v", len(got), err)
	}
	if got, err := readHostLine(br, 1<<20); err != nil || string(got) != "short" {
		t.Fatalf("got %q err %v", got, err)
	}
	if _, err := readHostLine(br, 1<<20); !errors.Is(err, io.EOF) {
		t.Fatalf("a partial line at EOF: err %v, want EOF", err)
	}
	br = bufio.NewReaderSize(strings.NewReader(strings.Repeat("b", 10000)+"\n"), 4096)
	if _, err := readHostLine(br, 5000); err == nil {
		t.Fatal("a line past the cap must be refused")
	}
}

// --- where the socket may be ----------------------------------------------------

// browserTestBases points both socket directories at a short temp dir (a unix
// socket path is limited to 108 bytes, so t.TempDir's long names do not fit)
// and returns the runtime-dir socket directory for this uid, created 0700.
func browserTestBases(t *testing.T) (base, sockDir string) {
	t.Helper()
	base, err := os.MkdirTemp("", "tlb")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(base) })
	oldRun, oldTmp := browserRuntimeBase, browserTmpBase
	browserRuntimeBase, browserTmpBase = filepath.Join(base, "run"), filepath.Join(base, "tmp")
	t.Cleanup(func() { browserRuntimeBase, browserTmpBase = oldRun, oldTmp })
	sockDir = filepath.Join(browserRuntimeBase, strconv.Itoa(os.Getuid()), "tl-browser")
	if err := os.MkdirAll(sockDir, 0o700); err != nil {
		t.Fatal(err)
	}
	return base, sockDir
}

func TestBrowserSocketWithin(t *testing.T) {
	browserTestBases(t)
	uid := 1234
	run := filepath.Join(browserRuntimeBase, "1234", "tl-browser")
	tmp := filepath.Join(browserTmpBase, "tl-browser-1234")
	cases := []struct {
		path string
		ok   bool
	}{
		{filepath.Join(run, "s12.sock"), true},
		{filepath.Join(run, "pid-4242.sock"), true},
		{filepath.Join(tmp, "s0.sock"), true},
		// A second host in the same session listens on <name>-<pid>.sock
		// (tl-browser/host/lib/viewers.mjs).
		{filepath.Join(run, "s12-959431.sock"), true},
		{filepath.Join(run, "pid-4242-4242.sock"), true},
		{filepath.Join(run, "s12-.sock"), false},
		{filepath.Join(run, "s12-x.sock"), false},
		{filepath.Join(run, "s12-1-2.sock"), false},
		{"s12.sock", false},
		{filepath.Join(run, "x.sock"), false},
		{filepath.Join(run, "s12.sock.bak"), false},
		{filepath.Join(run, "s.sock"), false},
		{run + "/../tl-browser/s12.sock", false},
		{run + "//s12.sock", false},
		{filepath.Join(browserRuntimeBase, "999", "tl-browser", "s12.sock"), false},
		{filepath.Join(browserTmpBase, "tl-browser-999", "s12.sock"), false},
		{filepath.Join(run, "sub", "s12.sock"), false},
		{"/run/docker.sock", false},
	}
	for _, c := range cases {
		err := browserSocketWithin(c.path, uid)
		if (err == nil) != c.ok {
			t.Errorf("%s: err %v, want ok=%v", c.path, err, c.ok)
		}
	}
}

func TestBrowserSocketOwnedChecksWhatIsOnDisk(t *testing.T) {
	base, sockDir := browserTestBases(t)
	uid := os.Getuid()
	sock := filepath.Join(sockDir, "s1.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if err := browserSocketOwned(sock, uid); err != nil {
		t.Fatalf("a real socket in a real directory: %v", err)
	}
	if err := browserSocketOwned(sock, uid+1); err == nil {
		t.Fatal("a socket owned by someone else must be refused")
	}
	plain := filepath.Join(sockDir, "s2.sock")
	os.WriteFile(plain, nil, 0o600)
	if err := browserSocketOwned(plain, uid); err == nil {
		t.Fatal("a regular file is not a socket")
	}
	// A symlinked directory in /tmp is how someone else would redirect it.
	tmpDir := filepath.Join(browserTmpBase, "tl-browser-"+strconv.Itoa(uid))
	os.MkdirAll(browserTmpBase, 0o700)
	if err := os.Symlink(sockDir, tmpDir); err != nil {
		t.Fatal(err)
	}
	via := filepath.Join(tmpDir, "s1.sock")
	if err := browserSocketWithin(via, uid); err != nil {
		t.Fatalf("the path itself is in bounds: %v", err)
	}
	if err := browserSocketOwned(via, uid); err == nil {
		t.Fatal("a socket reached through a symlinked directory must be refused")
	}
	// And the dial itself goes through that check, not only the path rule.
	if c, err := dialOwnSocket(via); err == nil {
		c.Close()
		t.Fatal("dialOwnSocket connected through a symlinked directory")
	}
	// A socket that is yours but is not a browser's (an ssh-agent, say) passes
	// the ownership check, so the path rule is what refuses it.
	os.MkdirAll(filepath.Join(base, "agent"), 0o700)
	agent := filepath.Join(base, "agent", "s1.sock")
	aln, err := net.Listen("unix", agent)
	if err != nil {
		t.Fatal(err)
	}
	defer aln.Close()
	if c, err := dialOwnSocket(agent); err == nil {
		c.Close()
		t.Fatal("dialOwnSocket connected to a socket outside the browser directories")
	}
	if c, err := dialOwnSocket(sock); err != nil {
		t.Fatalf("dialOwnSocket refused a real socket: %v", err)
	} else {
		c.Close()
	}
	_ = base
}

// --- a fake host ---------------------------------------------------------------------

// fakeHost listens where a host would and records every line it is sent. It
// answers a connection's first line (the viewer hello) with its own hello.
type fakeHost struct {
	ln    net.Listener
	lines chan string
	conns chan net.Conn
}

func startFakeHost(t *testing.T, sock, hello string) *fakeHost {
	t.Helper()
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	h := &fakeHost{ln: ln, lines: make(chan string, 64), conns: make(chan net.Conn, 8)}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			h.conns <- c
			go func() {
				br := bufio.NewReader(c)
				first := true
				for {
					line, err := br.ReadString('\n')
					if err != nil {
						return
					}
					h.lines <- strings.TrimSuffix(line, "\n")
					if first {
						first = false
						c.Write([]byte(hello + "\n"))
					}
				}
			}()
		}
	}()
	return h
}

func (h *fakeHost) next(t *testing.T) string {
	t.Helper()
	select {
	case l := <-h.lines:
		return l
	case <-time.After(3 * time.Second):
		t.Fatal("the host received nothing")
		return ""
	}
}

func (h *fakeHost) conn(t *testing.T) net.Conn {
	t.Helper()
	select {
	case c := <-h.conns:
		return c
	case <-time.After(3 * time.Second):
		t.Fatal("nobody connected to the host")
		return nil
	}
}

// fakeOptions is a stampReader over a fixed table: owner/session -> options.
// A session missing from it is one tmux does not have.
type fakeOptions map[string]map[string]string

func (f fakeOptions) Option(osUser, session, name string) (string, bool) {
	opts, ok := f[osUser+"/"+session]
	if !ok {
		return "", false
	}
	return opts[name], true
}

const fakeHostHello = `{"t":"hello","state":"frozen","tabs":[{"id":"1","url":"https://example.com/","title":"Example"}],` +
	`"agentTab":"1","control":{"holder":"bob","since":10,"lapseAt":20},"viewport":{"w":1280,"h":800}}`

// testRelay is a relay for user "alice" whose own sockets are dialled for real,
// with shares from the table.
func testRelay(opts fakeOptions, rows map[[3]string]string) *browserRelay {
	b := newBrowserRelay(opts, "alice")
	b.shares = func(owner, name, guest string) (string, error) { return rows[[3]string{owner, name, guest}], nil }
	b.dial = func(owner, sock string) (io.ReadWriteCloser, error) { return dialOwnSocket(sock) }
	b.helloTimeout = time.Second
	return b
}

func browserMux(b *browserRelay, eff, real string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /browser/{session}", b.handleState())
	mux.HandleFunc("GET /browser/{session}/stream", b.handleStream())
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := context.WithValue(r.Context(), osUserKey, eff)
		ctx = context.WithValue(ctx, realOSUserKey, real)
		mux.ServeHTTP(w, r.WithContext(ctx))
	})
}

func getState(t *testing.T, h http.Handler, path string) (int, browserStateBody) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	var body browserStateBody
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("body %q: %v", rec.Body.String(), err)
		}
	}
	return rec.Code, body
}

// --- the state route ---------------------------------------------------------------

func TestBrowserStateReadsTheHostsHello(t *testing.T) {
	_, dir := browserTestBases(t)
	sock := filepath.Join(dir, "s3.sock")
	host := startFakeHost(t, sock, fakeHostHello)
	opts := fakeOptions{"alice/k7m2q9x4tpz3": {optBrowser: "live", optBrowserSock: sock}}
	code, body := getState(t, browserMux(testRelay(opts, nil), "alice", "alice"), "/browser/k7m2q9x4tpz3")
	if code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	// The host's own state wins over the option, which can lag a freeze.
	if body.State != "frozen" {
		t.Fatalf("state %q, want the host's frozen", body.State)
	}
	if !strings.Contains(string(body.Tabs), "example.com") || string(body.AgentTab) != `"1"` ||
		!strings.Contains(string(body.Control), `"holder":"bob"`) {
		t.Fatalf("body %+v", body)
	}
	// Peeking is watching: the host must be told this connection cannot drive.
	var hello viewerHello
	if err := json.Unmarshal([]byte(host.next(t)), &hello); err != nil {
		t.Fatal(err)
	}
	if hello != (viewerHello{T: "hello", User: "alice", CanControl: false}) {
		t.Fatalf("hello %+v", hello)
	}
}

func TestBrowserStateWithoutABrowser(t *testing.T) {
	_, dir := browserTestBases(t)
	opts := fakeOptions{
		"alice/none00000000": {},
		"alice/junk00000000": {optBrowser: "maybe", optBrowserSock: filepath.Join(dir, "s1.sock")},
		// The options outlived the host (killed outright): nothing listens.
		"alice/stale0000000": {optBrowser: "live", optBrowserSock: filepath.Join(dir, "s2.sock")},
		// An option pointing anywhere else is never dialled.
		"alice/elsewhere000": {optBrowser: "live", optBrowserSock: "/run/docker.sock"},
	}
	h := browserMux(testRelay(opts, nil), "alice", "alice")
	for _, s := range []string{"none00000000", "junk00000000", "stale0000000", "elsewhere000"} {
		code, body := getState(t, h, "/browser/"+s)
		if code != http.StatusOK || body.State != "none" || string(body.Tabs) != "[]" {
			t.Errorf("%s: status %d body %+v, want state none", s, code, body)
		}
	}
	if code, _ := getState(t, h, "/browser/gone00000000"); code != http.StatusNotFound {
		t.Errorf("a session tmux does not have: status %d, want 404", code)
	}
}

func TestBrowserStateRefusesASessionThatIsNotShared(t *testing.T) {
	opts := fakeOptions{"bob/k7m2q9x4tpz3": {optBrowser: "live"}}
	h := browserMux(testRelay(opts, nil), "alice", "alice")
	if code, _ := getState(t, h, "/browser/k7m2q9x4tpz3?owner=bob"); code != http.StatusForbidden {
		t.Fatalf("status %d, want 403", code)
	}
}

// --- the stream ---------------------------------------------------------------------

func dialStream(t *testing.T, srv *httptest.Server, path string) *websocket.Conn {
	t.Helper()
	hdr := http.Header{"Origin": {srv.URL}}
	c, resp, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+path, hdr)
	if err != nil {
		code := 0
		if resp != nil {
			code = resp.StatusCode
		}
		t.Fatalf("dial %s: %v (status %d)", path, err, code)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func readWS(t *testing.T, c *websocket.Conn) string {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, msg, err := c.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	return string(msg)
}

// streamFixture is alice's session k7m2q9x4tpz3 with a host, reachable as
// alice herself, and bob's session shared with alice under two modes. All
// three sessions point at the same fake host, which is enough: what differs is
// what the relay lets through.
func streamFixture(t *testing.T, eff, real string) (*httptest.Server, *fakeHost) {
	t.Helper()
	_, dir := browserTestBases(t)
	sock := filepath.Join(dir, "s5.sock")
	host := startFakeHost(t, sock, fakeHostHello)
	opts := fakeOptions{
		"alice/k7m2q9x4tpz3": {optBrowser: "live", optBrowserSock: sock},
		"bob/rw0000000000":   {optBrowser: "live", optBrowserSock: sock},
		"bob/ro0000000000":   {optBrowser: "live", optBrowserSock: sock},
	}
	rows := map[[3]string]string{
		{"bob", "rw0000000000", "alice"}: "rw",
		{"bob", "ro0000000000", "alice"}: "ro",
	}
	b := testRelay(opts, rows)
	// bob's sockets are reached the same way here; production bridges them.
	srv := httptest.NewServer(browserMux(b, eff, real))
	t.Cleanup(srv.Close)
	return srv, host
}

func TestBrowserStreamLetsTheOwnerDrive(t *testing.T) {
	srv, host := streamFixture(t, "alice", "alice")
	c := dialStream(t, srv, "/browser/k7m2q9x4tpz3/stream")
	if got := host.next(t); got != `{"t":"hello","user":"alice","canControl":true}` {
		t.Fatalf("hello %s", got)
	}
	if got := readWS(t, c); got != fakeHostHello {
		t.Fatalf("the host's hello did not reach the lobby: %s", got)
	}
	c.WriteMessage(websocket.TextMessage, []byte(`{"t":"hello","user":"root","canControl":true}`))
	c.WriteMessage(websocket.TextMessage, []byte(`{"t":"takeControl"}`))
	c.WriteMessage(websocket.TextMessage, []byte(`{"t":"mouse","type":"click","x":5,"y":6,"button":"left","clickCount":1}`))
	if got := host.next(t); got != `{"t":"takeControl"}` {
		t.Fatalf("got %s, want takeControl with the forged hello dropped", got)
	}
	if got := host.next(t); got != `{"button":"left","clickCount":1,"t":"mouse","type":"click","x":5,"y":6}` {
		t.Fatalf("got %s", got)
	}
}

func TestBrowserStreamRWShareDrives(t *testing.T) {
	srv, host := streamFixture(t, "alice", "alice")
	dialStream(t, srv, "/browser/rw0000000000/stream?owner=bob")
	if got := host.next(t); got != `{"t":"hello","user":"alice","canControl":true}` {
		t.Fatalf("hello %s", got)
	}
}

// ?owner= is how the lobby names whose session it means (frontend-v2
// browserStreamUrl, sent only when the owner is not the effective user). A
// guest with a session of the same name as the one shared with them reaches
// the owner's browser with it, through the owner's dial, and their own without.
func TestBrowserStreamOwnerParamPicksWhoseSession(t *testing.T) {
	_, dir := browserTestBases(t)
	aliceSock, bobSock := filepath.Join(dir, "s1.sock"), filepath.Join(dir, "s2.sock")
	aliceHost := startFakeHost(t, aliceSock, fakeHostHello)
	bobHost := startFakeHost(t, bobSock, fakeHostHello)
	opts := fakeOptions{
		"alice/same00000000": {optBrowser: "live", optBrowserSock: aliceSock},
		"bob/same00000000":   {optBrowser: "live", optBrowserSock: bobSock},
	}
	b := testRelay(opts, map[[3]string]string{{"bob", "same00000000", "alice"}: "ro"})
	dialled := make(chan string, 4)
	b.dial = func(owner, sock string) (io.ReadWriteCloser, error) {
		dialled <- owner
		return dialOwnSocket(sock)
	}
	srv := httptest.NewServer(browserMux(b, "alice", "alice"))
	t.Cleanup(srv.Close)

	dialStream(t, srv, "/browser/same00000000/stream?owner=bob")
	if got := <-dialled; got != "bob" {
		t.Fatalf("dialled as %q, want bob", got)
	}
	if got := bobHost.next(t); got != `{"t":"hello","user":"alice","canControl":false}` {
		t.Fatalf("bob's host got %s", got)
	}

	dialStream(t, srv, "/browser/same00000000/stream")
	if got := <-dialled; got != "alice" {
		t.Fatalf("dialled as %q, want alice", got)
	}
	if got := aliceHost.next(t); got != `{"t":"hello","user":"alice","canControl":true}` {
		t.Fatalf("alice's host got %s", got)
	}
}

// The two watch-only cases: an ro share, and a Lens on the target's own
// session. Input and control must never reach the host; watching must.
func TestBrowserStreamWatchersCannotDrive(t *testing.T) {
	for _, c := range []struct {
		name, eff, real, path, user string
	}{
		{"ro share", "alice", "alice", "/browser/ro0000000000/stream?owner=bob", "alice"},
		{"lens", "alice", "admin", "/browser/k7m2q9x4tpz3/stream", "admin"},
	} {
		t.Run(c.name, func(t *testing.T) {
			srv, host := streamFixture(t, c.eff, c.real)
			ws := dialStream(t, srv, c.path)
			want := `{"t":"hello","user":"` + c.user + `","canControl":false}`
			if got := host.next(t); got != want {
				t.Fatalf("hello %s, want %s", got, want)
			}
			readWS(t, ws) // the host's hello reaches a watcher too
			for _, m := range []string{
				`{"t":"takeControl"}`,
				`{"t":"mouse","type":"click","x":5,"y":6}`,
				`{"t":"key","type":"press","key":"Enter"}`,
				`{"t":"insertText","text":"secret"}`,
				`{"t":"navigate","url":"https://example.com"}`,
				`{"t":"copy"}`,
				"{\"t\":\"subscribe\"}\n{\"t\":\"takeControl\"}",
				`{"t":"subscribe","tab":null}`,
			} {
				ws.WriteMessage(websocket.TextMessage, []byte(m))
			}
			// Messages arrive in order, so the first thing after the hello
			// being the subscribe means every message before it was dropped.
			if got := host.next(t); got != `{"t":"subscribe","tab":null}` {
				t.Fatalf("the host received %s, want only the subscribe", got)
			}
		})
	}
}

func TestBrowserStreamRelaysHostLinesAsMessages(t *testing.T) {
	srv, host := streamFixture(t, "alice", "alice")
	ws := dialStream(t, srv, "/browser/k7m2q9x4tpz3/stream")
	host.next(t)
	conn := host.conn(t)
	readWS(t, ws)
	frame := `{"t":"frame","tab":"1","jpeg":"` + strings.Repeat("A", 150<<10) + `","w":1280,"h":800}`
	conn.Write([]byte(frame + "\n" + `{"t":"state","state":"closed"}` + "\n"))
	if got := readWS(t, ws); got != frame {
		t.Fatalf("frame arrived as %d bytes, want %d", len(got), len(frame))
	}
	if got := readWS(t, ws); got != `{"t":"state","state":"closed"}` {
		t.Fatalf("got %s", got)
	}
	// The host going away ends the stream with a normal close, so the lobby can
	// tell a closed browser from a dropped network, which closes abnormally.
	conn.Close()
	ws.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, _, err := ws.ReadMessage()
	var ce *websocket.CloseError
	if !errors.As(err, &ce) || ce.Code != websocket.CloseNormalClosure {
		t.Fatalf("the stream ended with %v, want a normal close", err)
	}
}

func TestBrowserStreamRefusals(t *testing.T) {
	srv, _ := streamFixture(t, "alice", "alice")
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	cases := []struct {
		name, path string
		hdr        http.Header
		want       int
	}{
		{"another site's page", "/browser/k7m2q9x4tpz3/stream", http.Header{"Origin": {"https://evil.example"}}, http.StatusForbidden},
		{"no origin", "/browser/k7m2q9x4tpz3/stream", http.Header{}, http.StatusForbidden},
		{"not shared", "/browser/k7m2q9x4tpz3/stream?owner=carol", http.Header{"Origin": {srv.URL}}, http.StatusForbidden},
		{"no such session", "/browser/gone00000000/stream", http.Header{"Origin": {srv.URL}}, http.StatusNotFound},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			conn, resp, err := websocket.DefaultDialer.Dial(wsURL+c.path, c.hdr)
			if err == nil {
				conn.Close()
				t.Fatal("the stream opened")
			}
			if resp == nil || resp.StatusCode != c.want {
				t.Fatalf("resp %v, want status %d", resp, c.want)
			}
		})
	}
}

func TestSameOrigin(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:7685/browser/x/stream", nil)
	r.Header.Set("Origin", "http://localhost:5173")
	if sameOrigin(r) {
		t.Fatal("an Origin naming another host must not match")
	}
	r.Header.Set("Origin", "null")
	if sameOrigin(r) {
		t.Fatal("an opaque origin must not match")
	}
	r = httptest.NewRequest(http.MethodGet, "https://terminal.example/browser/x/stream", nil)
	if sameOrigin(r) {
		t.Fatal("a handshake without an Origin must not match")
	}
	r.Header.Set("Origin", "https://Terminal.example")
	if !sameOrigin(r) {
		t.Fatal("the same host must match, whatever its case")
	}
}

// --- the bridge -----------------------------------------------------------------------

func TestBrowserBridgeCommandExtendsTheGrantedCommand(t *testing.T) {
	got := browserBridgeCommand("bob", "/usr/local/bin/session-events", "/run/user/1001/tl-browser/s3.sock")
	want := []string{sudoBinary, "-n", "-u", "bob", "/usr/local/bin/session-events", "-privop",
		"browser-bridge", "/run/user/1001/tl-browser/s3.sock"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestRunBrowserBridgeRelaysBothWays(t *testing.T) {
	_, dir := browserTestBases(t)
	sock := filepath.Join(dir, "s7.sock")
	host := startFakeHost(t, sock, fakeHostHello)
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	done := make(chan error, 1)
	go func() { done <- runBrowserBridge(sock, inR, outW); outW.Close() }()
	inW.Write([]byte(`{"t":"hello","user":"alice","canControl":false}` + "\n"))
	if got := host.next(t); got != `{"t":"hello","user":"alice","canControl":false}` {
		t.Fatalf("host got %s", got)
	}
	line, err := bufio.NewReader(outR).ReadString('\n')
	if err != nil || strings.TrimSuffix(line, "\n") != fakeHostHello {
		t.Fatalf("bridge out %q err %v", line, err)
	}
	// The lobby closing its end closes the bridge.
	conn := host.conn(t)
	inW.Close()
	conn.Close()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("the bridge outlived both ends")
	}
}

func TestRunBrowserBridgeRefusesAPathOutOfBounds(t *testing.T) {
	browserTestBases(t)
	for _, p := range []string{"/run/docker.sock", "relative.sock", filepath.Join(browserRuntimeBase, "1", "tl-browser", "s1.sock")} {
		if err := runBrowserBridge(p, strings.NewReader(""), io.Discard); err == nil {
			t.Errorf("%s: the bridge dialled it", p)
		}
	}
}

// The act-as audit covers a Lens opening a browser stream, as it covers a
// transcript stream.
func TestIsBrowserStream(t *testing.T) {
	for p, want := range map[string]bool{
		"/browser/k7m2q9x4tpz3/stream": true,
		"/browser/k7m2q9x4tpz3":        false,
		"/events/k7m2q9x4tpz3/stream":  false,
	} {
		if isBrowserStream(p) != want {
			t.Errorf("%s: want %v", p, want)
		}
	}
}

// --- a share changing under an open stream ----------------------------------------------

// shareTable is a share store a test can change while a stream is open.
type shareTable struct {
	mu   sync.Mutex
	rows map[[3]string]string
	err  error
}

func (s *shareTable) lookup(owner, name, guest string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.rows[[3]string{owner, name, guest}], s.err
}

func (s *shareTable) set(owner, name, guest, mode string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rows[[3]string{owner, name, guest}] = mode
}

// recheckFixture is bob's session shared with alice rw, on a relay that
// re-reads the share before every control message (recheckMin 0) and on a
// ticker of the given period.
func recheckFixture(t *testing.T, every time.Duration) (*httptest.Server, *fakeHost, *shareTable) {
	t.Helper()
	_, dir := browserTestBases(t)
	sock := filepath.Join(dir, "s6.sock")
	host := startFakeHost(t, sock, fakeHostHello)
	opts := fakeOptions{
		"alice/k7m2q9x4tpz3": {optBrowser: "live", optBrowserSock: sock},
		"bob/sh0000000000":   {optBrowser: "live", optBrowserSock: sock},
	}
	shares := &shareTable{rows: map[[3]string]string{{"bob", "sh0000000000", "alice"}: "rw"}}
	b := testRelay(opts, nil)
	b.shares = shares.lookup
	b.recheckEvery = every
	b.recheckMin = 0
	srv := httptest.NewServer(browserMux(b, "alice", "alice"))
	t.Cleanup(srv.Close)
	return srv, host, shares
}

// readClose reads until the stream ends and returns how it ended.
func readClose(t *testing.T, ws *websocket.Conn) *websocket.CloseError {
	t.Helper()
	ws.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		if _, _, err := ws.ReadMessage(); err != nil {
			var ce *websocket.CloseError
			if !errors.As(err, &ce) {
				t.Fatalf("the stream ended with %v, want a close frame", err)
			}
			return ce
		}
	}
}

// A guest whose rw share is revoked, or turned ro, mid-stream must not drive
// the owner's browser one message further. The relay hands back any control
// the guest holds, so the agent is not left locked out until the lapse, and
// ends the stream; the lobby reconnects under whatever the share now says.
func TestBrowserStreamEndsWhenTheShareNoLongerAllowsControl(t *testing.T) {
	for _, c := range []struct{ name, mode string }{{"revoked", ""}, {"turned ro", "ro"}} {
		t.Run(c.name, func(t *testing.T) {
			srv, host, shares := recheckFixture(t, time.Hour)
			ws := dialStream(t, srv, "/browser/sh0000000000/stream?owner=bob")
			if got := host.next(t); got != `{"t":"hello","user":"alice","canControl":true}` {
				t.Fatalf("hello %s", got)
			}
			readWS(t, ws)
			ws.WriteMessage(websocket.TextMessage, []byte(`{"t":"takeControl"}`))
			if got := host.next(t); got != `{"t":"takeControl"}` {
				t.Fatalf("got %s", got)
			}

			shares.set("bob", "sh0000000000", "alice", c.mode)
			ws.WriteMessage(websocket.TextMessage, []byte(`{"t":"mouse","type":"click","x":5,"y":6}`))
			ws.WriteMessage(websocket.TextMessage, []byte(`{"t":"insertText","text":"secret"}`))

			if got := host.next(t); got != `{"t":"handBack"}` {
				t.Fatalf("the host received %s after the share changed, want only handBack", got)
			}
			if ce := readClose(t, ws); ce.Code != websocket.ClosePolicyViolation {
				t.Fatalf("closed with %d, want %d", ce.Code, websocket.ClosePolicyViolation)
			}
			select {
			case l := <-host.lines:
				t.Fatalf("the host received %s after the stream lost its share", l)
			case <-time.After(200 * time.Millisecond):
			}
		})
	}
}

// A guest who has stopped sending is still cut off, by the ticker, so an idle
// tab does not keep a revoked share's control alive.
func TestBrowserStreamTickerEndsARevokedStream(t *testing.T) {
	srv, host, shares := recheckFixture(t, 50*time.Millisecond)
	ws := dialStream(t, srv, "/browser/sh0000000000/stream?owner=bob")
	host.next(t)
	readWS(t, ws)
	shares.set("bob", "sh0000000000", "alice", "")
	if got := host.next(t); got != `{"t":"handBack"}` {
		t.Fatalf("got %s, want handBack", got)
	}
	if ce := readClose(t, ws); ce.Code != websocket.ClosePolicyViolation {
		t.Fatalf("closed with %d", ce.Code)
	}
}

// A share store that cannot be read is treated as no share: the stream fails
// closed rather than keeping authority nobody can confirm.
func TestBrowserStreamEndsWhenTheShareCannotBeRead(t *testing.T) {
	srv, host, shares := recheckFixture(t, 50*time.Millisecond)
	ws := dialStream(t, srv, "/browser/sh0000000000/stream?owner=bob")
	host.next(t)
	readWS(t, ws)
	shares.mu.Lock()
	shares.err = errors.New("corrupt share store")
	shares.mu.Unlock()
	if ce := readClose(t, ws); ce.Code != websocket.ClosePolicyViolation {
		t.Fatalf("closed with %d", ce.Code)
	}
}

// A watcher has no control to hand back; a revoked ro share just ends.
func TestBrowserStreamEndsARevokedWatcherWithoutAHandBack(t *testing.T) {
	srv, host, shares := recheckFixture(t, 50*time.Millisecond)
	shares.set("bob", "sh0000000000", "alice", "ro")
	ws := dialStream(t, srv, "/browser/sh0000000000/stream?owner=bob")
	host.next(t)
	readWS(t, ws)
	shares.set("bob", "sh0000000000", "alice", "")
	if ce := readClose(t, ws); ce.Code != websocket.ClosePolicyViolation {
		t.Fatalf("closed with %d", ce.Code)
	}
	select {
	case l := <-host.lines:
		t.Fatalf("the host received %s from a watcher", l)
	case <-time.After(200 * time.Millisecond):
	}
}

// Rechecks change nothing for a stream whose authority still holds: the owner,
// and a guest whose share is unchanged, keep driving.
func TestBrowserStreamKeepsAStreamWhoseShareHolds(t *testing.T) {
	srv, host, _ := recheckFixture(t, 20*time.Millisecond)
	for _, path := range []string{"/browser/k7m2q9x4tpz3/stream", "/browser/sh0000000000/stream?owner=bob"} {
		ws := dialStream(t, srv, path)
		host.next(t)
		readWS(t, ws)
		time.Sleep(100 * time.Millisecond) // several ticks
		ws.WriteMessage(websocket.TextMessage, []byte(`{"t":"key","type":"press","key":"Enter"}`))
		if got := host.next(t); got != `{"key":"Enter","t":"key","type":"press"}` {
			t.Fatalf("%s: got %s", path, got)
		}
	}
}
