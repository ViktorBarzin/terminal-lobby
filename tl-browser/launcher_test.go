package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// harness runs one Launcher against the fake host, playing Claude on the other
// end of its stdio.
type harness struct {
	t       *testing.T
	in      *io.PipeWriter
	lines   chan string
	done    chan error
	logPath string
	cache   *HandshakeCache
	spawner *recordingSpawner
	gone    chan int // pids the launcher reported gone, in order
}

// recordingSpawner spawns directly and remembers each argv it was handed.
type recordingSpawner struct {
	argvs [][]string
}

func (r *recordingSpawner) Command(argv []string, n int) (cmdSpec, error) {
	r.argvs = append(r.argvs, argv)
	return DirectSpawner{}.Command(argv, n)
}

type harnessOpt func(*Launcher, *harness)

func withEnv(kv ...string) harnessOpt {
	return func(l *Launcher, _ *harness) { l.Env = append(l.Env, kv...) }
}

func withKillGrace(d time.Duration) harnessOpt {
	return func(l *Launcher, _ *harness) { l.KillGrace = d }
}

// withCacheDir shares a cache directory between launchers, as two sessions do.
func withCacheDir(dir string) harnessOpt {
	return func(l *Launcher, h *harness) { l.Handshake.Dir = dir }
}

func newHarness(t *testing.T, opts ...harnessOpt) *harness {
	t.Helper()
	dir := t.TempDir()
	h := &harness{
		t:       t,
		lines:   make(chan string, 64),
		done:    make(chan error, 1),
		logPath: filepath.Join(dir, "fake.log"),
		spawner: &recordingSpawner{},
		gone:    make(chan int, 16),
	}
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	h.in = inW

	env := []string{"TLB_FAKE_HOST=1", "TLB_FAKE_LOG=" + h.logPath, "PATH=" + os.Getenv("PATH")}
	l := &Launcher{
		In:       inR,
		Out:      outW,
		Log:      log.New(io.Discard, "", 0),
		HostArgv: []string{os.Args[0]},
		Env:      env,
		Spawner:  h.spawner,
		Handshake: &HandshakeCache{
			Dir:      filepath.Join(dir, "cache"),
			Version:  "testversion00000",
			Describe: []string{os.Args[0], "--describe"},
			Env:      env,
		},
		InitTimeout: 10 * time.Second,
		KillGrace:   2 * time.Second,
		HostGone:    func(pid int) { h.gone <- pid },
	}
	for _, o := range opts {
		o(l, h)
	}
	h.cache = l.Handshake

	go func() {
		sc := bufio.NewScanner(outR)
		sc.Buffer(make([]byte, 1<<20), 1<<24)
		for sc.Scan() {
			h.lines <- sc.Text()
		}
		close(h.lines)
	}()
	go func() {
		err := l.Run(context.Background())
		outW.Close()
		h.done <- err
	}()
	t.Cleanup(func() {
		inW.Close()
		select {
		case <-h.done:
		case <-time.After(10 * time.Second):
			t.Errorf("launcher did not exit after stdin closed")
		}
	})
	return h
}

func (h *harness) send(line string) {
	h.t.Helper()
	if _, err := io.WriteString(h.in, line+"\n"); err != nil {
		h.t.Fatalf("write to launcher: %v", err)
	}
}

// recv returns the next line Claude would read, decoded.
func (h *harness) recv() map[string]json.RawMessage {
	h.t.Helper()
	select {
	case line, ok := <-h.lines:
		if !ok {
			h.t.Fatalf("launcher closed its stdout")
		}
		var m map[string]json.RawMessage
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			h.t.Fatalf("launcher wrote a line that is not JSON: %q", line)
		}
		return m
	case <-time.After(10 * time.Second):
		h.t.Fatalf("no reply from the launcher within 10s")
	}
	return nil
}

// noMore asserts nothing else arrives for a moment.
func (h *harness) noMore() {
	h.t.Helper()
	select {
	case line := <-h.lines:
		h.t.Fatalf("unexpected line from the launcher: %s", line)
	case <-time.After(300 * time.Millisecond):
	}
}

func (h *harness) fakeLog() []string {
	b, err := os.ReadFile(h.logPath)
	if err != nil {
		return nil
	}
	return strings.Split(strings.TrimSpace(string(b)), "\n")
}

func (h *harness) count(prefix string) int {
	n := 0
	for _, l := range h.fakeLog() {
		if strings.HasPrefix(l, prefix) {
			n++
		}
	}
	return n
}

// waitFor polls the fake host's log until cond holds.
func (h *harness) waitFor(what string, cond func() bool) {
	h.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			h.t.Fatalf("timed out waiting for %s; fake log: %q", what, h.fakeLog())
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func writeCache(t *testing.T, c *HandshakeCache) {
	t.Helper()
	if err := os.MkdirAll(c.Dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(c.Path(), []byte(fakeDescribe), 0o600); err != nil {
		t.Fatal(err)
	}
}

const initLine = `{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{"roots":{}},"clientInfo":{"name":"claude-code","version":"2.1"}}}`

func str(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatalf("not a string: %s", raw)
	}
	return s
}

func resultText(t *testing.T, m map[string]json.RawMessage) (string, bool) {
	t.Helper()
	var r struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
		IsError bool `json:"isError"`
	}
	if err := json.Unmarshal(m["result"], &r); err != nil || len(r.Content) == 0 {
		t.Fatalf("not a tool result: %v", m)
	}
	return r.Content[0].Text, r.IsError
}

func TestHandshakeServedFromCacheWithoutSpawning(t *testing.T) {
	h := newHarness(t)
	writeCache(t, h.cache)

	h.send(initLine)
	r := h.recv()
	if string(r["id"]) != "0" {
		t.Fatalf("initialize reply id = %s", r["id"])
	}
	var init map[string]json.RawMessage
	json.Unmarshal(r["result"], &init)
	if str(t, init["instructions"]) != "close the browser when done" {
		t.Fatalf("initialize result is not the cached one: %s", r["result"])
	}

	h.send(`{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	h.send(`{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}`)
	r = h.recv()
	if string(r["id"]) != "1" || !strings.Contains(string(r["result"]), "browser_close") {
		t.Fatalf("tools/list reply = %v", r)
	}
	h.send(`{"jsonrpc":"2.0","id":"p","method":"ping"}`)
	r = h.recv()
	if string(r["id"]) != `"p"` || string(r["result"]) != "{}" {
		t.Fatalf("ping reply = %v", r)
	}
	h.noMore()

	if log := h.fakeLog(); log != nil {
		t.Fatalf("the host ran during a cached handshake: %q", log)
	}
}

func TestInitializeEchoesTheClientsProtocolVersion(t *testing.T) {
	h := newHarness(t)
	writeCache(t, h.cache)

	h.send(`{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"c","version":"1"}}}`)
	var init map[string]json.RawMessage
	json.Unmarshal(h.recv()["result"], &init)
	if got := str(t, init["protocolVersion"]); got != "2025-03-26" {
		t.Fatalf("protocolVersion = %q, want the client's 2025-03-26", got)
	}
	if str(t, init["instructions"]) != "close the browser when done" {
		t.Fatalf("the rest of the cached result was lost: %s", init)
	}
}

func TestCacheMissDescribesOnceAndWritesTheCache(t *testing.T) {
	shared := t.TempDir()
	h := newHarness(t, withCacheDir(shared))

	h.send(initLine)
	h.recv()
	h.send(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	h.recv()
	if n := h.count("describe"); n != 1 {
		t.Fatalf("describe ran %d times, want 1", n)
	}
	if h.count("spawn") != 0 {
		t.Fatalf("describing started a full host: %q", h.fakeLog())
	}
	b, err := os.ReadFile(h.cache.Path())
	if err != nil {
		t.Fatalf("cache not written: %v", err)
	}
	var hs Handshake
	if err := json.Unmarshal(b, &hs); err != nil || len(hs.Initialize) == 0 || len(hs.Tools) == 0 {
		t.Fatalf("cache content = %s", b)
	}

	// A second session reads the cache the first one wrote.
	h2 := newHarness(t, withCacheDir(shared))
	h2.send(initLine)
	h2.recv()
	if h2.fakeLog() != nil {
		t.Fatalf("second launcher described again: %q", h2.fakeLog())
	}
}

func TestFirstCallSpawnsReplaysInitializeAndForwardsInOrder(t *testing.T) {
	h := newHarness(t)
	writeCache(t, h.cache)

	h.send(initLine)
	h.recv()
	h.send(`{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	// Sent back to back, so the second and third arrive while the host starts.
	h.send(`{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"browser_navigate"}}`)
	h.send(`{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"browser_snapshot"}}`)
	h.send(`{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"browser_click"}}`)

	for _, want := range []string{"10", "11", "12"} {
		r := h.recv()
		if string(r["id"]) != want {
			t.Fatalf("reply id = %s, want %s (the host's initialize reply must be swallowed)", r["id"], want)
		}
	}
	h.noMore()

	var recv []string
	for _, l := range h.fakeLog() {
		if s, ok := strings.CutPrefix(l, "recv "); ok {
			recv = append(recv, s)
		}
	}
	if len(recv) != 5 {
		t.Fatalf("host received %d lines, want 5: %q", len(recv), recv)
	}
	var first struct {
		ID     string          `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	json.Unmarshal([]byte(recv[0]), &first)
	if first.Method != "initialize" || first.ID != "tl-init-1" {
		t.Fatalf("first line to the host = %s, want initialize with id tl-init-1", recv[0])
	}
	var orig struct {
		Params json.RawMessage `json:"params"`
	}
	json.Unmarshal([]byte(initLine), &orig)
	if string(first.Params) != string(orig.Params) {
		t.Fatalf("replayed params = %s, want the client's original %s", first.Params, orig.Params)
	}
	if !strings.Contains(recv[1], `"notifications/initialized"`) {
		t.Fatalf("second line to the host = %s, want notifications/initialized", recv[1])
	}
	for i, id := range []string{`"id":10`, `"id":11`, `"id":12`} {
		if !strings.Contains(recv[2+i], id) {
			t.Fatalf("line %d to the host = %s, want %s", 2+i, recv[2+i], id)
		}
	}
	if h.count("spawn") != 1 {
		t.Fatalf("spawned %d hosts, want 1", h.count("spawn"))
	}
	if len(h.spawner.argvs) != 1 || h.spawner.argvs[0][0] != os.Args[0] {
		t.Fatalf("spawner argv = %q", h.spawner.argvs)
	}
}

func TestHostExitReturnsToLazyAndTheNextCallRespawns(t *testing.T) {
	h := newHarness(t)
	writeCache(t, h.cache)

	h.send(initLine)
	h.recv()
	h.send(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"browser_close"}}`)
	text, isErr := resultText(t, h.recv())
	if text != "closed" || isErr {
		t.Fatalf("browser_close reply = %q (isError %v)", text, isErr)
	}
	h.waitFor("the host to exit", func() bool { return h.count("exit") == 1 })

	// Handshake traffic does not wake it.
	h.send(`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	h.recv()
	time.Sleep(200 * time.Millisecond)
	if h.count("spawn") != 1 {
		t.Fatalf("tools/list respawned the host: %q", h.fakeLog())
	}

	h.send(`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"browser_navigate"}}`)
	text, _ = resultText(t, h.recv())
	if text != "ok browser_navigate" {
		t.Fatalf("call after respawn = %q", text)
	}
	if h.count("spawn") != 2 {
		t.Fatalf("spawned %d hosts, want 2", h.count("spawn"))
	}
	if !strings.Contains(strings.Join(h.fakeLog(), "\n"), `"id":"tl-init-2"`) {
		t.Fatalf("the respawn did not replay initialize as tl-init-2: %q", h.fakeLog())
	}
}

func TestCallStraightAfterCloseGoesToAFreshHost(t *testing.T) {
	h := newHarness(t)
	writeCache(t, h.cache)

	h.send(initLine)
	h.recv()
	h.send(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"browser_navigate"}}`)
	h.recv()
	// No pause: the second call lands before the launcher has seen the exit.
	h.send(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"browser_close"}}`)
	h.send(`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"browser_navigate"}}`)
	if text, _ := resultText(t, h.recv()); text != "closed" {
		t.Fatalf("browser_close reply = %q", text)
	}
	r := h.recv()
	if text, isErr := resultText(t, r); string(r["id"]) != "3" || text != "ok browser_navigate" || isErr {
		t.Fatalf("call after close = %s %q (isError %v), want it served by a new host", r["id"], text, isErr)
	}
	if h.count("spawn") != 2 {
		t.Fatalf("spawned %d hosts, want 2", h.count("spawn"))
	}
}

func TestRefusedCloseKeepsTheHost(t *testing.T) {
	h := newHarness(t, withEnv("TLB_FAKE_REFUSE_CLOSE=1"), withKillGrace(100*time.Millisecond))
	writeCache(t, h.cache)

	h.send(initLine)
	h.recv()
	h.send(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"browser_close"}}`)
	h.send(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"browser_navigate"}}`)
	if _, isErr := resultText(t, h.recv()); !isErr {
		t.Fatal("the refused close did not come back as an error")
	}
	r := h.recv()
	if text, _ := resultText(t, r); string(r["id"]) != "2" || text != "ok browser_navigate" {
		t.Fatalf("call after a refused close = %s %q", r["id"], text)
	}
	// Well past the close deadline: a refused close must not get the host killed.
	time.Sleep(500 * time.Millisecond)
	h.send(`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"browser_snapshot"}}`)
	if text, _ := resultText(t, h.recv()); text != "ok browser_snapshot" {
		t.Fatalf("host gone after a refused close: %q", text)
	}
	if h.count("spawn") != 1 {
		t.Fatalf("spawned %d hosts, want 1", h.count("spawn"))
	}
}

func TestInFlightRequestIsToldTheBrowserClosed(t *testing.T) {
	h := newHarness(t)
	writeCache(t, h.cache)

	h.send(initLine)
	h.recv()
	h.send(`{"jsonrpc":"2.0","id":"a","method":"tools/call","params":{"name":"die"}}`)
	r := h.recv()
	if string(r["id"]) != `"a"` {
		t.Fatalf("reply id = %s", r["id"])
	}
	text, isErr := resultText(t, r)
	if !isErr || text != "The browser closed. Call the tool again to open a fresh one." {
		t.Fatalf("reply = %q (isError %v)", text, isErr)
	}

	// And it recovers.
	h.send(`{"jsonrpc":"2.0","id":"b","method":"tools/call","params":{"name":"browser_navigate"}}`)
	if text, _ := resultText(t, h.recv()); text != "ok browser_navigate" {
		t.Fatalf("call after the crash = %q", text)
	}
}

func TestStdinEOFTerminatesTheHost(t *testing.T) {
	h := newHarness(t)
	writeCache(t, h.cache)

	h.send(initLine)
	h.recv()
	h.send(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"browser_navigate"}}`)
	h.recv()
	pid := h.hostPid()

	h.in.Close()
	select {
	case <-h.done:
	case <-time.After(10 * time.Second):
		t.Fatal("launcher did not exit after stdin closed")
	}
	h.done <- nil // for the cleanup
	if alive(pid) {
		t.Fatalf("host %d still running after the launcher exited", pid)
	}
}

func TestStubbornHostIsKilled(t *testing.T) {
	h := newHarness(t, withEnv("TLB_FAKE_IGNORE_TERM=1"), withKillGrace(300*time.Millisecond))
	writeCache(t, h.cache)

	h.send(initLine)
	h.recv()
	h.send(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"hang"}}`)
	h.waitFor("the hang call to reach the host", func() bool {
		return strings.Contains(strings.Join(h.fakeLog(), "\n"), `"hang"`)
	})
	pid := h.hostPid()

	// This fake host ignores SIGTERM and its stdin closing, so only the
	// SIGKILL after the grace period ends it.
	h.in.Close()
	select {
	case <-h.done:
	case <-time.After(10 * time.Second):
		t.Fatal("launcher did not exit")
	}
	h.done <- nil
	if alive(pid) {
		t.Fatalf("host %d survived", pid)
	}
	if h.count("term") != 1 {
		t.Fatalf("the host was not sent SIGTERM before SIGKILL: %q", h.fakeLog())
	}
}

// goneWithin returns the next pid the launcher reported gone.
func (h *harness) goneWithin(d time.Duration) (int, bool) {
	h.t.Helper()
	select {
	case pid := <-h.gone:
		return pid, true
	case <-time.After(d):
		return 0, false
	}
}

func TestHostKilledFromOutsideIsReportedGone(t *testing.T) {
	// SIGKILL, from the OOM killer or a person, gives the host no chance to
	// unregister itself, so the launcher has to.
	h := newHarness(t)
	writeCache(t, h.cache)

	h.send(initLine)
	h.recv()
	h.send(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"browser_navigate"}}`)
	h.recv()
	pid := h.hostPid()

	if err := syscall.Kill(pid, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	got, ok := h.goneWithin(10 * time.Second)
	if !ok || got != pid {
		t.Fatalf("gone = %d (%v), want host %d", got, ok, pid)
	}
}

func TestCrashedHostIsReportedGoneBeforeTheRespawn(t *testing.T) {
	h := newHarness(t)
	writeCache(t, h.cache)

	h.send(initLine)
	h.recv()
	h.send(`{"jsonrpc":"2.0","id":"a","method":"tools/call","params":{"name":"die"}}`)
	h.recv()
	first := h.hostPid()
	got, ok := h.goneWithin(10 * time.Second)
	if !ok || got != first {
		t.Fatalf("gone = %d (%v), want host %d", got, ok, first)
	}

	// The new host registers under the same names, so the old one must be
	// cleared first, not after.
	h.send(`{"jsonrpc":"2.0","id":"b","method":"tools/call","params":{"name":"browser_navigate"}}`)
	h.recv()
	if _, ok := h.goneWithin(300 * time.Millisecond); ok {
		t.Fatalf("the live respawned host was reported gone")
	}
}

func TestStoppedHostIsReportedGoneBeforeTheLauncherExits(t *testing.T) {
	for _, tc := range []struct {
		name string
		opts []harnessOpt
		tool string
	}{
		{"sigterm", nil, "browser_navigate"},
		{"sigkill", []harnessOpt{withEnv("TLB_FAKE_IGNORE_TERM=1"), withKillGrace(300 * time.Millisecond)}, "hang"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, tc.opts...)
			writeCache(t, h.cache)

			h.send(initLine)
			h.recv()
			h.send(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"` + tc.tool + `"}}`)
			h.waitFor("the call to reach the host", func() bool {
				return strings.Contains(strings.Join(h.fakeLog(), "\n"), `"`+tc.tool+`"`)
			})
			pid := h.hostPid()

			h.in.Close()
			select {
			case <-h.done:
			case <-time.After(10 * time.Second):
				t.Fatal("launcher did not exit")
			}
			h.done <- nil
			var got int
			select {
			case got = <-h.gone:
			default:
			}
			if got != pid {
				t.Fatalf("gone = %d when Run returned, want host %d", got, pid)
			}
		})
	}
}

func TestBrowserCloseIsReportedGone(t *testing.T) {
	h := newHarness(t)
	writeCache(t, h.cache)

	h.send(initLine)
	h.recv()
	h.send(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"browser_close"}}`)
	h.recv()
	pid := h.hostPid()
	got, ok := h.goneWithin(10 * time.Second)
	if !ok || got != pid {
		t.Fatalf("gone = %d (%v), want host %d", got, ok, pid)
	}
}

func (h *harness) hostPid() int {
	h.t.Helper()
	for _, l := range h.fakeLog() {
		if s, ok := strings.CutPrefix(l, "spawn "); ok {
			var pid int
			if _, err := fmt.Sscan(s, &pid); err == nil {
				return pid
			}
		}
	}
	h.t.Fatalf("no spawn in the fake log: %q", h.fakeLog())
	return 0
}

func alive(pid int) bool {
	// A zombie still answers kill 0, but the launcher reaps its child, so a
	// live answer here means a live process.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if syscall.Kill(pid, 0) != nil {
			return false
		}
		time.Sleep(20 * time.Millisecond)
	}
	return true
}
