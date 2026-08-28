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
	// ReplayWindow is what a fresh open gets: the most recent `turns` turns
	// rather than the whole session. A resume (from > 0) ignores the window.
	ReplayWindow(from int64, turns int) []sessionio.Event
	Subscribe() (<-chan sessionio.Event, func())
}

// OpenWindowTurns is how many turns a client sees when it opens a session. A
// reader arrives at the live end and scrolls back from there, so replaying a
// months-old session in full costs bytes and layout for rows nobody asked for.
// Older turns come from GET /earlier.
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

func writeSSE(w http.ResponseWriter, r *http.Request, src Source, hb time.Duration) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
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
		defer sink.close()
	}
	w.WriteHeader(http.StatusOK)

	// Subscribe BEFORE replaying so no event appended in between is lost; then
	// skip any live event whose ID was already covered by the replay (dedup).
	ch, cancel := src.Subscribe()
	defer cancel()

	var lastID int64
	for _, e := range src.ReplayWindow(parseLastEventID(r), parseOpenWindow(r)) {
		sink.printf("id: %d\ndata: %s\n\n", e.ID, e.JSON())
		lastID = e.ID
	}
	// The opening window is complete. A client cannot tell that from the events
	// alone — they simply stop for a moment — so it either paints a partial
	// transcript and rebuilds it as the rest lands, or waits on a guess. This
	// says so once, as a NAMED event, so it reaches a listener rather than the
	// event array: nothing downstream has to learn to ignore it.
	sink.printf("event: ready\ndata: %d\n\n", lastID)
	sink.flush()

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
			if e.ID <= lastID {
				continue // already delivered via replay
			}
			sink.printf("id: %d\ndata: %s\n\n", e.ID, e.JSON())
			lastID = e.ID
			sink.flush()
		case <-ticker.C:
			sink.print(": hb\n\n")
			sink.flush()
		}
	}
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
