package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"runtime"
	"syscall"
	"time"
)

// The launcher's state machine.
//
// LAZY: no host. initialize, tools/list and ping are answered from the
// handshake cache; notifications and stray responses are dropped. The first
// other request starts a host.
//
// STARTING: the host is running but has not answered the initialize the
// launcher replayed to it. Everything from Claude queues, in order.
//
// RUNNING: lines are piped both ways. The handshake methods are still answered
// from the cache, so a session sees one consistent tool list whether or not its
// browser is up.
//
// When the host exits, on browser_close, its frozen-close timer, or a crash,
// the launcher answers whatever was still waiting with "the browser closed"
// and goes back to LAZY. Between a browser_close and the host's exit, new
// requests wait for that exit and go to a fresh host, so an agent that closes
// and immediately browses again is not told to retry.
//
// Every state change happens on Run's goroutine; the readers and the writer
// only move lines.

const browserClosedText = "The browser closed. Call the tool again to open a fresh one."

// Launcher is one session's playwright MCP server.
type Launcher struct {
	In  io.Reader // from Claude
	Out io.Writer // to Claude
	Log *log.Logger

	Handshake *HandshakeCache
	HostArgv  []string // node host.mjs
	Env       []string // the host's whole environment

	// Spawner, when nil, is chosen by ChooseSpawner the first time a browser
	// is wanted, so a session that never browses never probes systemd.
	Spawner       Spawner
	ChooseSpawner func() Spawner
	StopUnit      func(unit string)
	// HostGone runs after every host exit, clean or not, with the host's pid,
	// before any new host starts. A host that was SIGKILLed never cleared its
	// tmux options or socket, so this does (Registration.Clear).
	HostGone func(pid int)

	InitTimeout time.Duration // how long a new host has to answer initialize
	KillGrace   time.Duration // SIGTERM to SIGKILL
}

type rpcMsg struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

// closesBrowser reports whether m is the call that makes the host exit.
func (m *rpcMsg) closesBrowser() bool {
	if m.Method != "tools/call" {
		return false
	}
	var p struct {
		Name string `json:"name"`
	}
	return json.Unmarshal(m.Params, &p) == nil && p.Name == "browser_close"
}

func (m *rpcMsg) hasID() bool {
	return len(m.ID) > 0 && string(m.ID) != "null"
}

// idKey is a request id in a form that compares equal however it was spaced.
func idKey(raw json.RawMessage) string {
	var b bytes.Buffer
	if json.Compact(&b, raw) != nil {
		return string(raw)
	}
	return b.String()
}

type hostEvent struct {
	gen    int
	line   []byte
	exited bool
	err    error
}

type pending struct {
	key    string
	id     json.RawMessage
	closes bool // a browser_close: once answered, the host is on its way out
}

type host struct {
	gen     int
	cmd     *exec.Cmd
	unit    string
	stdin   chan []byte
	initID  string
	ready   bool
	closing bool // was sent a browser_close and is about to exit
}

type state struct {
	l  *Launcher
	hs *Handshake

	initParams json.RawMessage
	spawns     int

	host      *host
	events    chan hostEvent
	deadline  *time.Timer // a starting host must answer, a closing one exit, by then
	queue     [][]byte    // lines held while STARTING
	queued    []pending   // the requests among them
	inflight  []pending   // forwarded, not yet answered
	afterExit [][]byte    // requests that arrived while the host was closing

	outErr error
}

// Run serves Claude until its stdin closes or ctx ends, then stops the host.
func (l *Launcher) Run(ctx context.Context) error {
	// PR_SET_PDEATHSIG fires when the THREAD that forked the host exits, not
	// the process. Pinning the loop to its thread keeps that thread alive for
	// as long as the launcher is.
	runtime.LockOSThread()

	if l.Log == nil {
		l.Log = log.New(io.Discard, "", 0)
	}
	if l.InitTimeout == 0 {
		l.InitTimeout = time.Minute
	}
	if l.KillGrace == 0 {
		l.KillGrace = 5 * time.Second
	}

	client := make(chan []byte)
	go func() {
		defer close(client)
		r := bufio.NewReader(l.In)
		for {
			line, err := r.ReadBytes('\n')
			if line = bytes.TrimSpace(line); len(line) > 0 {
				client <- line
			}
			if err != nil {
				return
			}
		}
	}()

	s := &state{l: l, events: make(chan hostEvent, 64)}
	defer s.shutdown()
	for {
		var deadline <-chan time.Time
		if s.deadline != nil {
			deadline = s.deadline.C
		}
		select {
		case line, ok := <-client:
			if !ok {
				return nil
			}
			s.fromClient(line)
		case ev := <-s.events:
			s.fromHost(ev)
		case <-deadline:
			s.deadline = nil
			if h := s.host; h != nil && !h.ready {
				l.Log.Printf("browser host did not answer initialize within %s, stopping it", l.InitTimeout)
				s.signal(syscall.SIGKILL)
			} else if h != nil && h.closing {
				l.Log.Printf("browser host did not exit after browser_close, stopping it")
				s.signal(syscall.SIGKILL)
			}
		case <-ctx.Done():
			return nil
		}
		if s.outErr != nil {
			return s.outErr
		}
	}
}

func (s *state) write(line []byte) {
	if s.outErr != nil {
		return
	}
	if _, err := s.l.Out.Write(append(line, '\n')); err != nil {
		s.outErr = err
	}
}

func (s *state) reply(id, result json.RawMessage) {
	s.write([]byte(fmt.Sprintf(`{"jsonrpc":"2.0","id":%s,"result":%s}`, id, result)))
}

func (s *state) replyError(id json.RawMessage, code int, msg string) {
	m, _ := json.Marshal(msg)
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	s.write([]byte(fmt.Sprintf(`{"jsonrpc":"2.0","id":%s,"error":{"code":%d,"message":%s}}`, id, code, m)))
}

// replyToolError answers a request with a tool result the agent reads, rather
// than a protocol error Claude shows as a broken server.
func (s *state) replyToolError(id json.RawMessage, text string) {
	t, _ := json.Marshal(text)
	s.reply(id, json.RawMessage(fmt.Sprintf(`{"content":[{"type":"text","text":%s}],"isError":true}`, t)))
}

func (s *state) handshake() (*Handshake, error) {
	if s.hs == nil {
		hs, err := s.l.Handshake.Load()
		if err != nil {
			return nil, err
		}
		s.hs = hs
	}
	return s.hs, nil
}

func (s *state) fromClient(line []byte) {
	var m rpcMsg
	if err := json.Unmarshal(line, &m); err != nil {
		if s.host != nil {
			s.toHost(line, nil)
			return
		}
		s.replyError(nil, -32700, "Parse error")
		return
	}

	switch {
	case m.Method == "initialize" && m.hasID():
		s.initParams = m.Params
		hs, err := s.handshake()
		if err != nil {
			s.l.Log.Print(err)
			s.replyError(m.ID, -32603, err.Error())
			return
		}
		s.reply(m.ID, initializeResult(hs.Initialize, m.Params))
	case m.Method == "notifications/initialized":
		// The launcher sends the host its own, after the replayed initialize.
	case m.Method == "tools/list" && m.hasID():
		hs, err := s.handshake()
		if err != nil {
			s.l.Log.Print(err)
			s.replyError(m.ID, -32603, err.Error())
			return
		}
		s.reply(m.ID, hs.Tools)
	case m.Method == "ping" && m.hasID():
		s.reply(m.ID, json.RawMessage("{}"))
	case m.Method != "" && m.hasID():
		if s.host == nil {
			if err := s.spawn(); err != nil {
				s.l.Log.Printf("start the browser host: %v", err)
				s.replyToolError(m.ID, "The browser could not start: "+err.Error())
				return
			}
		}
		if s.host.closing {
			s.afterExit = append(s.afterExit, line)
			return
		}
		closes := m.closesBrowser()
		s.toHost(line, &pending{key: idKey(m.ID), id: m.ID, closes: closes})
		// Anything after a browser_close would reach a host that is about to
		// exit, so it waits for the next one instead.
		s.host.closing = s.host.closing || closes
	default:
		// A notification, or Claude answering a request the host made. Only a
		// running host has anything to do with either.
		if s.host != nil {
			s.toHost(line, nil)
		}
	}
}

func (s *state) toHost(line []byte, req *pending) {
	h := s.host
	if !h.ready {
		s.queue = append(s.queue, line)
		if req != nil {
			s.queued = append(s.queued, *req)
		}
		return
	}
	if req != nil {
		s.inflight = append(s.inflight, *req)
	}
	h.stdin <- line
}

func (s *state) fromHost(ev hostEvent) {
	h := s.host
	if h == nil || ev.gen != h.gen {
		return
	}
	if ev.exited {
		s.hostExited(ev.err)
		return
	}

	var m rpcMsg
	if json.Unmarshal(ev.line, &m) == nil && m.Method == "" && m.hasID() {
		key := idKey(m.ID)
		if key == h.initID {
			s.hostInitialized(ev.line)
			return
		}
		for i, p := range s.inflight {
			if p.key == key {
				s.inflight = append(s.inflight[:i], s.inflight[i+1:]...)
				if p.closes {
					s.write(ev.line)
					s.closeAnswered(ev.line)
					return
				}
				break
			}
		}
	}
	s.write(ev.line)
}

// closeAnswered follows the host's answer to browser_close. Success means it is
// exiting, so it gets a deadline. A refusal, which is what the host says while
// a person holds control, leaves it running: the requests held back for the
// next host go to this one instead.
func (s *state) closeAnswered(line []byte) {
	var r struct {
		Result *struct {
			IsError bool `json:"isError"`
		} `json:"result"`
	}
	if json.Unmarshal(line, &r) == nil && r.Result != nil && !r.Result.IsError {
		if s.deadline == nil {
			s.deadline = time.NewTimer(2 * s.l.KillGrace)
		}
		return
	}
	s.host.closing = false
	held := s.afterExit
	s.afterExit = nil
	for _, l := range held {
		s.fromClient(l)
	}
}

func (s *state) hostInitialized(line []byte) {
	var r struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(line, &r) == nil && r.Error != nil {
		s.l.Log.Printf("browser host refused initialize: %s", r.Error.Message)
		s.signal(syscall.SIGTERM)
		return
	}
	if s.deadline != nil {
		s.deadline.Stop()
		s.deadline = nil
	}
	h := s.host
	h.ready = true
	h.stdin <- []byte(`{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	queue := s.queue
	s.queue = nil
	s.inflight = append(s.inflight, s.queued...)
	s.queued = nil
	for _, line := range queue {
		h.stdin <- line
	}
}

func (s *state) hostExited(err error) {
	h := s.host
	if err != nil {
		s.l.Log.Printf("browser host exited: %v", err)
	} else {
		s.l.Log.Printf("browser host exited")
	}
	close(h.stdin)
	s.host = nil
	if s.deadline != nil {
		s.deadline.Stop()
		s.deadline = nil
	}
	s.gone(h)
	waiting := append(s.queued, s.inflight...)
	s.queue, s.queued, s.inflight = nil, nil, nil
	for _, p := range waiting {
		s.replyToolError(p.id, browserClosedText)
	}
	next := s.afterExit
	s.afterExit = nil
	for _, line := range next {
		s.fromClient(line)
	}
}

func (s *state) spawn() error {
	l := s.l
	if l.Spawner == nil {
		if l.ChooseSpawner != nil {
			l.Spawner = l.ChooseSpawner()
		} else {
			l.Spawner = DirectSpawner{}
		}
	}
	s.spawns++
	spec, err := l.Spawner.Command(l.HostArgv, s.spawns)
	if err != nil {
		return err
	}

	stdinR, stdinW, err := os.Pipe()
	if err != nil {
		return err
	}
	stdoutR, stdoutW, err := os.Pipe()
	if err != nil {
		stdinR.Close()
		stdinW.Close()
		return err
	}
	cmd := exec.Command(spec.Argv[0], spec.Argv[1:]...)
	cmd.Env = l.Env
	cmd.Stdin = stdinR
	cmd.Stdout = stdoutW
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{
		// Its own process group keeps a Ctrl-C meant for the pane away from
		// the browser, and lets one signal reach the host's helpers.
		Setpgid:   true,
		Pdeathsig: syscall.SIGTERM,
	}
	err = cmd.Start()
	stdinR.Close()
	stdoutW.Close()
	if err != nil {
		stdinW.Close()
		stdoutR.Close()
		return err
	}

	h := &host{
		gen:    s.spawns,
		cmd:    cmd,
		unit:   spec.Unit,
		stdin:  make(chan []byte, 1024),
		initID: idKey(json.RawMessage(fmt.Sprintf("%q", fmt.Sprintf("tl-init-%d", s.spawns)))),
	}
	s.host = h
	l.Log.Printf("started browser host pid %d %s", cmd.Process.Pid, spec.Unit)

	go func() {
		broken := false
		for line := range h.stdin {
			if broken {
				continue
			}
			if _, err := stdinW.Write(append(line, '\n')); err != nil {
				broken = true
			}
		}
		stdinW.Close()
	}()

	waited := make(chan error, 1)
	readDone := make(chan struct{})
	go func() {
		waited <- cmd.Wait()
		// Something the host left behind could hold its stdout open; give
		// the last lines a moment, then stop waiting for them.
		select {
		case <-readDone:
		case <-time.After(2 * time.Second):
			stdoutR.Close()
		}
	}()
	go func() {
		r := bufio.NewReader(stdoutR)
		for {
			line, err := r.ReadBytes('\n')
			if line = bytes.TrimSpace(line); len(line) > 0 {
				s.events <- hostEvent{gen: h.gen, line: line}
			}
			if err != nil {
				break
			}
		}
		close(readDone)
		err := <-waited
		stdoutR.Close()
		s.events <- hostEvent{gen: h.gen, exited: true, err: err}
	}()

	params := s.initParams
	if len(params) == 0 {
		params = s.defaultInitParams()
	}
	h.stdin <- []byte(fmt.Sprintf(`{"jsonrpc":"2.0","id":%s,"method":"initialize","params":%s}`, h.initID, params))
	s.deadline = time.NewTimer(l.InitTimeout)
	return nil
}

// defaultInitParams stands in for a client that called a tool without
// initializing first, which Claude never does.
func (s *state) defaultInitParams() json.RawMessage {
	version := json.RawMessage(`"2025-06-18"`)
	if s.hs != nil {
		var r map[string]json.RawMessage
		if json.Unmarshal(s.hs.Initialize, &r) == nil && len(r["protocolVersion"]) > 0 {
			version = r["protocolVersion"]
		}
	}
	return json.RawMessage(fmt.Sprintf(`{"protocolVersion":%s,"capabilities":{},"clientInfo":{"name":"tl-browser","version":"0"}}`, version))
}

// signal sends sig to the host's process group.
func (s *state) signal(sig syscall.Signal) {
	if s.host == nil {
		return
	}
	pid := s.host.cmd.Process.Pid
	if syscall.Kill(-pid, sig) != nil {
		_ = s.host.cmd.Process.Signal(sig)
	}
}

// shutdown stops a running host: SIGTERM so it can unregister from tmux and
// close Chrome, SIGKILL after the grace period, then the scope.
func (s *state) shutdown() {
	h := s.host
	if h == nil {
		return
	}
	s.l.Log.Printf("stopping browser host pid %d", h.cmd.Process.Pid)
	s.signal(syscall.SIGTERM)
	grace := time.NewTimer(s.l.KillGrace)
	defer grace.Stop()
	killed := false
	for {
		select {
		case ev := <-s.events:
			if ev.gen == h.gen && ev.exited {
				close(h.stdin)
				s.host = nil
				s.gone(h)
				return
			}
		case <-grace.C:
			if killed {
				// Not even SIGKILL ended it within the grace period; leave
				// the rest to the scope stop and PR_SET_PDEATHSIG.
				s.gone(h)
				return
			}
			killed = true
			s.signal(syscall.SIGKILL)
			if s.l.StopUnit != nil {
				s.l.StopUnit(h.unit)
			}
			grace.Reset(s.l.KillGrace)
		}
	}
}

// gone cleans up after a host that has exited. A host that died rather than
// closing can leave Chrome behind in its scope, which stopping the scope takes
// with it, and its registration in tmux, which HostGone clears.
func (s *state) gone(h *host) {
	if s.l.StopUnit != nil {
		s.l.StopUnit(h.unit)
	}
	if s.l.HostGone != nil {
		s.l.HostGone(h.cmd.Process.Pid)
	}
}

// initializeResult is the cached initialize result with the client's own
// protocolVersion, so a client on an older or newer revision than the one the
// cache was written with is not refused over the version string alone.
func initializeResult(cached, params json.RawMessage) json.RawMessage {
	var p struct {
		ProtocolVersion json.RawMessage `json:"protocolVersion"`
	}
	if json.Unmarshal(params, &p) != nil || len(p.ProtocolVersion) == 0 {
		return cached
	}
	var r map[string]json.RawMessage
	if json.Unmarshal(cached, &r) != nil {
		return cached
	}
	r["protocolVersion"] = p.ProtocolVersion
	b, err := json.Marshal(r)
	if err != nil {
		return cached
	}
	return b
}
