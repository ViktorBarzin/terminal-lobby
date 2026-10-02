package main

import (
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"terminal-lobby/sessionio"
)

// Source is the read side of a session's event stream. Replay returns all events
// with ID greater than `from` (0 = from the start); Subscribe returns a channel
// of live events and a cancel func to release the subscription. Kept an interface
// so the SSE layer is tested without files (sessionio.FileSource wires the real one).
type Source interface {
	Replay(from int64) []sessionio.Event
	// ReplayWindow is the pre-2026-08-28 fresh open: the most recent `turns`
	// turns, ascending. Still served to a client that does not ask for the
	// reverse open — see the `rev` flag on writeSSE.
	ReplayWindow(from int64, turns int) []sessionio.Event
	// Backfill is what a reverse open gets: the newest events below `before`,
	// bounded in bytes rather than turns.
	Backfill(before int64, budget int) sessionio.Backfill
	// State is the session-level truth a small backfill no longer carries.
	State(maxPrompts int) sessionio.SessionState
	// Head is the newest id in the log and the identity of the log itself —
	// what a client needs to tell "nothing new" from "not the log you were
	// reading" (see readyFrame).
	Head() (int64, string)
	Subscribe() (<-chan sessionio.Event, func())
}

// readyFrame closes the opening exchange. Beyond "the opening is over" it names
// the LOG: ids are per-source and start again at 1 for a new transcript, so a
// client holding id 5,000 that reconnects onto a rebuilt log asks for the gap
// above 5,000 and is answered with nothing — indistinguishable, on the wire,
// from being up to date. It then shows the previous conversation for as long as
// the tab stays open, answer card and all. Epoch names the transcript and Head
// says how far the log goes; between them a client can tell it is holding
// history that no longer belongs to this session, and resync.
//
// Cursor keeps its own meaning — the `before` for the next step back — and is
// sent only on a fresh open, where it is the client's to adopt.
type readyFrame struct {
	Cursor *int64 `json:"cursor,omitempty"`
	Head   int64  `json:"head"`
	Epoch  string `json:"epoch,omitempty"`
}

// epochFrame tells a reading client that the log's epoch moved under it: the
// source appended an event a replay of its transcript would not reproduce, so
// its ids are its own from here on (sessionio FileSource.Head). The ids the
// client holds are still this source's, so it adopts the new epoch and resyncs
// only against a source that reports a different one.
type epochFrame struct {
	Epoch string `json:"epoch"`
}

// OpenWindowTurns is how many turns a client sees when it opens a session
// WITHOUT asking for the reverse open.
//
// This is the older contract, kept for the deploy window: session-events
// restarts drop every Text-view stream, clients reconnect immediately, and the
// bundle that reconnects is whichever one that browser still holds until the
// deploy healer reloads it. A client built before 2026-08-28 has no listener
// for `event: back`, so serving it the reverse open would show it an empty
// transcript. It can go once no such bundle is in the wild.
const OpenWindowTurns = 20

// MinOpenWindowTurns is the smallest window a client may ask for. Twenty turns
// measured 766,661-2,098,703 bytes per open, 99.93% of it arriving inside 0.1s
// as one backlog dump -- 42 seconds on a 400kbps link for the view that is
// supposed to be the one that still works. A client that knows its link is slow
// asks for fewer and pages back through /earlier; one turn is the floor, because
// zero would open on nothing at all.
const MinOpenWindowTurns = 1

// parseOpenWindow reads ?turns= -- how many turns this client wants on open.
// Absent, unparseable, or out of range means the default: a client never gets
// MORE than OpenWindowTurns this way, only less.
func parseOpenWindow(r *http.Request) int {
	q := r.URL.Query().Get("turns")
	if q == "" {
		return OpenWindowTurns
	}
	n, err := strconv.Atoi(q)
	if err != nil || n < MinOpenWindowTurns || n > OpenWindowTurns {
		return OpenWindowTurns
	}
	return n
}

// OpenBackfillBytes is how much history a reverse open carries behind the
// paint. It does NOT gate first paint — the newest event is the first frame on
// the wire — so this only decides how far back the reader can scroll without a
// round trip. 100 KB is 2.0 s at the measured slow link (400 kbps), and buys
// roughly one turn on a heavy session and four on a light one.
const OpenBackfillBytes = 100 << 10

// MaxResponseBytes caps ANY single history response, whatever a caller asks
// for. A deliberate scroll-up on a heavy session used to be able to pull 2.4 MB
// in one step; this bounds every path, including a cached older bundle's.
const MaxResponseBytes = 400 << 10

// StatePrompts is how much composer history the state frame carries.
const StatePrompts = 20

// eagerFlushFrames is how many backfill frames are flushed individually before
// the writer falls back to letting net/http's buffer fill.
//
// The first frame is the whole point of a reverse open, so it must not sit in a
// 4 KB buffer waiting for company. After a handful the reader already has
// something to look at and per-frame flushing only costs syscalls.
const eagerFlushFrames = 8

// reverseOpen reports whether this client speaks the reverse-open contract.
func reverseOpen(r *http.Request) bool { return r.URL.Query().Get("rev") == "1" }

// parseLastEventID reads the resume cursor from the standard SSE `Last-Event-ID`
// header, falling back to a `?lastEventId=` query param. 0 when absent/invalid.
func parseLastEventID(r *http.Request) int64 {
	if h := r.Header.Get("Last-Event-ID"); h != "" {
		if n, err := strconv.ParseInt(h, 10, 64); err == nil {
			return n
		}
	}
	if q := r.URL.Query().Get("lastEventId"); q != "" {
		if n, err := strconv.ParseInt(q, 10, 64); err == nil {
			return n
		}
	}
	return 0
}

// writeSSE streams a source to the client as Server-Sent Events: it replays from
// the resume cursor, then tails live, emitting a heartbeat comment every hb to
// keep NAT/proxy timeouts from silently dropping the connection. Returns when the
// request context is cancelled or the live channel closes.
// sseSink writes SSE frames, optionally gzipped, and flushes both layers
// together so a compressed stream still arrives event by event.
//
// The opening window is the whole reason this exists: it measured 766,661 to
// 2,098,703 bytes per open, and gzip -6 over that same content gives 4.8-5.4x
// (1,754,321 -> 366,490). The edge does not do it -- Traefik's compress
// middleware deliberately leaves text/event-stream out of includedContentTypes,
// and it is an ENTRYPOINT middleware, so opting SSE in there would change
// streaming for every consumer in the cluster to fix one page. Doing it here
// keeps the blast radius at this service, and puts the per-event flush under the
// control of the code that knows where an event ends.
type sseSink struct {
	w  io.Writer
	gz *gzip.Writer
	fl http.Flusher
}

func (s *sseSink) printf(format string, a ...any) { fmt.Fprintf(s.w, format, a...) }
func (s *sseSink) print(v string)                 { fmt.Fprint(s.w, v) }

// flush pushes one event all the way out. gzip.Flush emits a sync marker, which
// is what makes a compressed event stream readable as it arrives rather than at
// the end; without it the browser would see nothing until the buffer filled.
func (s *sseSink) flush() {
	if s.gz != nil {
		_ = s.gz.Flush()
	}
	s.fl.Flush()
}

func (s *sseSink) close() {
	if s.gz != nil {
		_ = s.gz.Close()
	}
}

// acceptsGzip reports whether the client offered gzip. Identity is always
// acceptable, so a client that did not ask simply gets the uncompressed stream.
func acceptsGzip(r *http.Request) bool {
	for _, part := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		if strings.EqualFold(strings.TrimSpace(strings.SplitN(part, ";", 2)[0]), "gzip") {
			return true
		}
	}
	return false
}

// AgentFrameEvery is the most often one stream is sent an agents frame. The set
// moves with every tool call of every agent, and the panel ticks its own
// elapsed clock, so a second is as fresh as a glance needs.
const AgentFrameEvery = time.Second

// agentFeed is the read side of a session's agent set (agentWatch is the real
// one). An interface so the SSE layer is tested without agent files.
type agentFeed interface {
	// Current is the newest set, its version, and whether it is fresh enough
	// to send.
	Current() (sessionio.AgentSet, uint64, bool)
	// Subscribe signals after every scan of the set, whether or not it moved.
	Subscribe() (<-chan struct{}, func())
}

// agentPacer decides when a stream's next agents frame may go: the first one at
// once, a changed set at most once per AgentFrameEvery, an unchanged one never.
type agentPacer struct {
	sent bool
	ver  uint64
	at   time.Time
}

// due reports whether the set at version ver goes out now, and when it has to
// wait, for how long.
func (p *agentPacer) due(ok bool, ver uint64, now time.Time) (send bool, wait time.Duration) {
	switch {
	case !ok, p.sent && ver == p.ver:
		return false, 0
	case !p.sent:
		return true, 0
	}
	if since := now.Sub(p.at); since < AgentFrameEvery {
		return false, AgentFrameEvery - since
	}
	return true, 0
}

func (p *agentPacer) mark(ver uint64, now time.Time) { p.sent, p.ver, p.at = true, ver, now }

// agentStream is one stream's side of the agent feed: what the pacer last let
// through, and the timer holding back a change that came too soon. The zero
// value is a stream without the feed, whose channels are nil and never fire.
type agentStream struct {
	feed  agentFeed
	sig   <-chan struct{}
	pacer agentPacer
	timer *time.Timer
	due   <-chan time.Time // the timer's channel while it is armed
}

// offer writes the current set if the pacer lets it go now, and arms the timer
// when a change has to wait. It reports whether a frame was written.
func (a *agentStream) offer(sink *sseSink, now time.Time) bool {
	if a.feed == nil {
		return false
	}
	set, ver, ok := a.feed.Current()
	send, wait := a.pacer.due(ok, ver, now)
	if !send {
		if wait > 0 && a.due == nil {
			a.timer = time.NewTimer(wait)
			a.due = a.timer.C
		}
		return false
	}
	a.stop()
	// Stamped as it is written, not when the set was built: the client takes
	// its clock's skew from this, and a set built a second earlier would put
	// that second into every elapsed figure it draws.
	set.At = now.UnixMilli()
	sinkFrame(sink, "agents", set)
	a.pacer.mark(ver, now)
	return true
}

func (a *agentStream) stop() {
	if a.timer != nil {
		a.timer.Stop()
	}
	a.timer, a.due = nil, nil
}

func writeSSE(w http.ResponseWriter, r *http.Request, src Source, agents agentFeed, hb time.Duration, onOpen ...func(bytes, count int)) {
	sink, ok := openSSE(w, r)
	if !ok {
		return
	}
	defer sink.close()
	streamSSE(sink, r, src, agents, hb, onOpen...)
}

// openSSE starts an event-stream response: the headers, gzip when the client
// offered it, and the status. The caller closes the sink when it is done.
func openSSE(w http.ResponseWriter, r *http.Request) (*sseSink, bool) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return nil, false
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	sink := &sseSink{w: w, fl: fl}
	if acceptsGzip(r) {
		// Vary matters: a cache must not hand a gzipped stream to a client that
		// did not ask for one.
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Add("Vary", "Accept-Encoding")
		gz := gzip.NewWriter(w)
		sink.gz = gz
		sink.w = gz
	}
	w.WriteHeader(http.StatusOK)
	return sink, true
}

// streamSSE is writeSSE after the response has started: the opening exchange
// the request asked for, then the live tail until the client goes.
func streamSSE(sink *sseSink, r *http.Request, src Source, agents agentFeed, hb time.Duration, onOpen ...func(bytes, count int)) {
	// Subscribe BEFORE replaying so no event appended in between is lost; then
	// skip any live event whose ID was already covered by the replay (dedup).
	ch, cancel := src.Subscribe()
	defer cancel()

	// The agent panel's set rides on the reverse open only. An older bundle has
	// no state frame for it to follow and no panel to feed. Subscribed here, for
	// the same reason as the event channel above: a change landing during the
	// opening exchange must not be missed.
	var ag agentStream
	if agents != nil && reverseOpen(r) {
		sig, release := agents.Subscribe()
		defer release()
		ag.feed, ag.sig = agents, sig
	}
	defer ag.stop()

	var lastID int64
	var openBytes, openCount int
	// The epoch this client was last told, so a move mid-stream is announced
	// (epochFrame). Empty for the older contract, which was never told one.
	var announced string
	resume := parseLastEventID(r)
	switch {
	case !reverseOpen(r):
		// The older contract: ascending, windowed by turns, and honouring the
		// ?turns= a client that has measured its own link asks for.
		for _, e := range src.ReplayWindow(resume, parseOpenWindow(r)) {
			sink.printf("id: %d\ndata: %s\n\n", e.ID, e.JSON())
			lastID = e.ID
			openBytes += len(e.JSON())
			openCount++
		}
		// The opening window is complete. A client cannot tell that from the
		// events alone — they simply stop for a moment — so it either paints a
		// partial transcript and rebuilds it as the rest lands, or waits on a
		// guess. This says so once, as a NAMED event, so it reaches a listener
		// rather than the event array.
		sink.printf("event: ready\ndata: %d\n\n", lastID)

	case resume > 0:
		// A reconnecting client holds its history and is asking for the gap.
		// Backfilling it would drop exactly what it reconnected to collect, so
		// the resume stays forward — but the state frame still rides along,
		// because a disconnected client may have missed a mode change or a
		// queue operation with no row of its own. The agents ride along for
		// the same reason.
		sinkFrame(sink, "state", src.State(StatePrompts))
		ag.offer(sink, time.Now())
		sink.flush()
		for _, e := range src.Replay(resume) {
			sink.printf("id: %d\ndata: %s\n\n", e.ID, e.JSON())
			lastID = e.ID
		}
		// No cursor: the client's own is the correct one, and overwriting it
		// with a backfill cursor it never asked for would strand its history.
		// The log's own identity still rides along — that is what tells a client
		// resuming onto a REBUILT log that its history is not this session's.
		head, epoch := src.Head()
		sinkFrame(sink, "ready", readyFrame{Head: head, Epoch: epoch})
		announced = epoch

	default:
		// The reverse open. The session's own state first — it is ~8 KB and the
		// composer, the mode chip and the context meter are usable the moment it
		// lands — then history from the newest event backwards, so the first
		// row a reader sees is the last thing that happened.
		//
		// The agent set follows the state frame when the watch already has a
		// fresh one. When it does not (its first read of a large agent
		// transcript is still running, or nobody had been watching), nothing
		// here waits for it: the first set goes out from the loop below the
		// moment the watch publishes one.
		sinkFrame(sink, "state", src.State(StatePrompts))
		ag.offer(sink, time.Now())
		sink.flush()
		b := src.Backfill(0, OpenBackfillBytes)
		for i := len(b.Events) - 1; i >= 0; i-- {
			e := b.Events[i]
			// No `id:` on a backfill frame. The browser would take the OLDEST
			// of them as Last-Event-ID, and the next reconnect would resume
			// from history this client already holds. The id is in the payload,
			// which is where the client reads its cursor from.
			sink.printf("event: back\ndata: %s\n\n", e.JSON())
			if e.ID > lastID {
				lastID = e.ID
			}
			openBytes += len(e.JSON())
			// The first frame is the whole point, so it must not wait in a
			// buffer for company — gzip included, where a flush is what makes
			// the stream readable as it arrives at all.
			if len(b.Events)-i <= eagerFlushFrames {
				sink.flush()
			}
		}
		head, epoch := src.Head()
		sinkFrame(sink, "ready", readyFrame{Cursor: &b.Cursor, Head: head, Epoch: epoch})
		announced = epoch
		openCount = len(b.Events)
	}
	sink.flush()
	for _, f := range onOpen {
		f(openBytes, openCount)
	}

	ticker := time.NewTicker(hb)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case e, ok := <-ch:
			if !ok {
				return
			}
			// New words of a reply still being written (ADR-0036). No id: a
			// delta is never stored, so it must not move the client's
			// Last-Event-ID cursor.
			if e.Kind == sessionio.KindDelta {
				sink.printf("data: %s\n\n", e.JSON())
				sink.flush()
				continue
			}
			if e.ID <= lastID {
				continue // already delivered via replay
			}
			// Before the event: a client that cached between the two would
			// label this source's ids with the epoch a rebuilt source reports.
			if announced != "" {
				if _, epoch := src.Head(); epoch != announced {
					sinkFrame(sink, "epoch", epochFrame{Epoch: epoch})
					announced = epoch
				}
			}
			sink.printf("id: %d\ndata: %s\n\n", e.ID, e.JSON())
			lastID = e.ID
			sink.flush()
		case <-ag.sig:
			if ag.offer(sink, time.Now()) {
				sink.flush()
			}
		case <-ag.due:
			ag.stop()
			if ag.offer(sink, time.Now()) {
				sink.flush()
			}
		case <-ticker.C:
			sink.print(": hb\n\n")
			sink.flush()
		}
	}
}

// sinkFrame sends one NAMED SSE event carrying a JSON payload. Named so it
// reaches a listener rather than the client's message handler: nothing
// downstream has to learn to ignore it, and it never enters the event array.
func sinkFrame(s *sseSink, name string, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		log.Printf("sinkFrame %s: %v", name, err)
		return
	}
	s.printf("event: %s\ndata: %s\n\n", name, b)
}

// writeJSON sends a value as the JSON body of a 200. Encoding failures are left
// to the transport: the header is already out by then, and a half-written body
// is what the client's parse error will report anyway.
func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("writeJSON: %v", err)
	}
}

// history is the read side of everything below the live end: one step back in
// bytes (the current contract) or in turns (what a pre-2026-08-28 bundle asks
// for).
type history interface {
	Backfill(before int64, budget int) sessionio.Backfill
	Earlier(before int64, turns int) []sessionio.Event
}

// writeEarlier serves one step back through the transcript.
//
// Two shapes, chosen by whether the caller asked in bytes. A caller that did
// gets `{events, cursor}` — it needs the cursor because it cannot derive the
// next step from the events it holds: a split turn's prompt rides along from
// BELOW the cursor, so the oldest event received is not where the next step
// begins. A caller that did not is on the bundle deployed before 2026-08-28 and
// unpacks a bare array of turns; it keeps that until its browser reloads.
func writeEarlier(w http.ResponseWriter, r *http.Request, h history) {
	before, err := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	if err != nil || before <= 0 {
		http.Error(w, "bad before (need the id of the oldest event held)", http.StatusBadRequest)
		return
	}
	raw := r.URL.Query().Get("bytes")
	if raw == "" {
		writeJSON(w, h.Earlier(before, OpenWindowTurns))
		return
	}
	budget, err := strconv.Atoi(raw)
	if err != nil || budget <= 0 || budget > MaxResponseBytes {
		budget = MaxResponseBytes
	}
	b := h.Backfill(before, budget)
	if b.Events == nil {
		b.Events = []sessionio.Event{} // an empty list, never a JSON null
	}
	writeJSON(w, struct {
		Events []sessionio.Event `json:"events"`
		Cursor int64             `json:"cursor"`
	}{b.Events, b.Cursor})
}
