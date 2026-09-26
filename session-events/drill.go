package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode"

	"terminal-lobby/sessionio"
)

// The drill-in: one agent's own transcript, agent-<id>.jsonl, served as an
// event stream of its own (design step 6,
// docs/plans/2026-09-12-agent-workflow-visualisation-design.md). The agent
// panel names the agent; this streams everything it said and did.
//
// It rides the session's own routes, under /events/{session}/agents/{agent},
// because the ingress routes by path prefix and /events/ is already one of
// its rules (DEPLOY.md), with buffering off for event streams. A new top-level
// prefix would fall through to ttyd in production until the ingress learned
// it.
//
// An agent is resolved only through the files the session directory holds:
// the id a request carries is compared against the directory's listing and
// never joined into a path. Reads go through the session owner's reader, so
// another user's agents are read by their privileged child like their
// transcript is.

var (
	errNoSession = errors.New("session not registered")
	errBadAgent  = errors.New("bad agent id")
	errNoAgent   = errors.New("no such agent in this session")
)

// maxAgentID bounds an agent id. The longest of the agent files on this box
// is 43 characters.
const maxAgentID = 128

// validAgentID reports whether id could name an agent at all: one printable
// file-name segment. What it names is then settled by the listing.
func validAgentID(id string) bool {
	if id == "" || len(id) > maxAgentID || id == "." || id == ".." {
		return false
	}
	if strings.ContainsAny(id, `/\`) {
		return false
	}
	for _, r := range id {
		if !unicode.IsPrint(r) || unicode.IsSpace(r) {
			return false
		}
	}
	return true
}

// drillSource is one agent transcript somebody opened to read: a FileSource
// over agent-<id>.jsonl, tailed under its session's context so retiring the
// session stops it too.
type drillSource struct {
	fs *sessionio.FileSource
	// ready is closed once the first read is done. That read is the expensive
	// one (a 34 MB agent file measured 5 s cold), so it runs off the request
	// and every reader waits on this instead.
	ready <-chan struct{}
	done  <-chan struct{} // closed once the tail has returned
	stop  context.CancelFunc

	idleSince time.Time // guarded by the liveSource's drillMu
}

// retire stops the tail and ends every stream reading it.
func (d *drillSource) retire() {
	d.stop()
	d.fs.Close()
}

// await holds a stream until the first read is done. The response has already
// started, so a comment goes out now and on every heartbeat, and nothing
// between here and the browser takes the wait for a dead connection. False
// when the client left first.
func (d *drillSource) await(ctx context.Context, sink *sseSink, hb time.Duration) bool {
	select {
	case <-d.ready:
		return true
	default:
	}
	sink.print(": reading\n\n")
	sink.flush()
	t := time.NewTicker(hb)
	defer t.Stop()
	for {
		select {
		case <-d.ready:
			return true
		case <-ctx.Done():
			return false
		case <-t.C:
			sink.print(": hb\n\n")
			sink.flush()
		}
	}
}

// drills is the agent sources of one session, by agent id.
type drills struct {
	mu sync.Mutex
	// by is nil once the session has been retired, so a drill-in racing the
	// retirement builds nothing that nobody would ever stop.
	by map[string]*drillSource
}

func newDrills() *drills { return &drills{by: map[string]*drillSource{}} }

// source returns the agent's source, building it on first use. ok is false
// when the session has been retired meanwhile.
func (ds *drills) source(ctx context.Context, session, id, path string, r sessionio.Reader, poll time.Duration) (*drillSource, bool) {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	if ds.by == nil {
		return nil, false
	}
	if d, ok := ds.by[id]; ok {
		if d.fs.Path() == path {
			d.idleSince = time.Time{}
			return d, true
		}
		d.retire() // the id names a different file now
	}
	ctx, stop := context.WithCancel(ctx)
	fs := sessionio.NewAgentFileSource(session, path, poll, r)
	ready, done := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(done)
		fs.TailOnce()
		close(ready)
		fs.Run(ctx)
	}()
	d := &drillSource{fs: fs, ready: ready, done: done, stop: stop}
	ds.by[id] = d
	return d, true
}

// readers is how many streams are reading any of the session's agents.
func (ds *drills) readers() int {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	n := 0
	for _, d := range ds.by {
		n += d.fs.Subscribers()
	}
	return n
}

// sweep lets go of every agent source nobody has read for idleGrace, the same
// grace a session's own source gets.
func (ds *drills) sweep(now time.Time) {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	for id, d := range ds.by {
		if d.fs.Subscribers() > 0 {
			d.idleSince = time.Time{}
			continue
		}
		if d.idleSince.IsZero() {
			d.idleSince = now
			continue
		}
		if now.Sub(d.idleSince) >= idleGrace {
			d.retire()
			delete(ds.by, id)
		}
	}
}

// close retires every agent source, for good: the session is going.
func (ds *drills) close() {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	for _, d := range ds.by {
		d.retire()
	}
	ds.by = nil
}

// agentTranscript resolves a drill-in request to the agent's transcript and
// the reader for it: the session must be registered, and the id must name an
// agent file its directory holds.
func (rg *registry) agentTranscript(osUser, session, agent string) (*liveSource, string, sessionio.Reader, error) {
	if !validAgentID(agent) {
		return nil, "", nil, errBadAgent
	}
	ls, ok := rg.live(osUser, session)
	if !ok {
		return nil, "", nil, errNoSession
	}
	path, ok := ls.agents.Resolve(agent)
	if !ok {
		return nil, "", nil, errNoAgent
	}
	us := rg.user(osUser)
	us.mu.Lock()
	reader := us.reader
	us.mu.Unlock()
	return ls, path, reader, nil
}

// drill is the source a drill-in reads. Tried twice: a session retired between
// resolving and building (its transcript moved) is rebuilt by the next live().
func (rg *registry) drill(osUser, session, agent string) (*drillSource, error) {
	for range 2 {
		ls, path, reader, err := rg.agentTranscript(osUser, session, agent)
		if err != nil {
			return nil, err
		}
		if d, ok := ls.drills.source(ls.ctx, session, agent, path, reader, rg.poll); ok {
			return d, nil
		}
	}
	return nil, errNoSession
}

func drillError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errBadAgent):
		http.Error(w, err.Error(), http.StatusBadRequest)
	default:
		http.Error(w, err.Error(), http.StatusNotFound)
	}
}

// handleDrillEvents serves one agent's transcript with the SSE framing of
// /events: the state frame, history newest first, the ready frame, then live.
// The agent panel's set is not sent here, since the view reading this stream
// holds the session's own stream for that.
//
// The response starts before the first read of the agent file is done, so a
// big agent opens the way a big session does: the stream is there at once and
// the history follows it.
func (rg *registry) handleDrillEvents(hb time.Duration) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		d, err := rg.drill(osUserFrom(r.Context()), r.PathValue("session"), r.PathValue("agent"))
		if err != nil {
			drillError(w, err)
			return
		}
		sink, ok := openSSE(w, r)
		if !ok {
			return
		}
		defer sink.close()
		if !d.await(r.Context(), sink, hb) {
			return
		}
		streamSSE(sink, r, d.fs, nil, hb)
	}
}

// handleDrillEarlier is /earlier for an agent's transcript: one step further
// back, in the shape a byte-bounded /earlier answers with.
func (rg *registry) handleDrillEarlier() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		d, err := rg.drill(osUserFrom(r.Context()), r.PathValue("session"), r.PathValue("agent"))
		if err != nil {
			drillError(w, err)
			return
		}
		select {
		case <-d.ready:
		case <-r.Context().Done():
			return
		}
		writeEarlier(w, r, d.fs)
	}
}

// handleDrillResult is /result for an agent's transcript: one tool result in
// full, scanned out of the agent's own file where it is readable.
func (rg *registry) handleDrillResult() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		_, path, reader, err := rg.agentTranscript(osUserFrom(r.Context()), r.PathValue("session"), r.PathValue("agent"))
		if err != nil {
			drillError(w, err)
			return
		}
		body, result, err := reader.FullResult(path, r.PathValue("toolId"))
		if err != nil {
			http.Error(w, "no such result", http.StatusNotFound)
			return
		}
		writeJSON(w, struct {
			Body   string          `json:"body"`
			Result json.RawMessage `json:"result,omitempty"`
		}{body, result})
	}
}
