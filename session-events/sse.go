package main

import (
	"fmt"
	"net/http"
	"strconv"
	"time"

	"terminal-lobby/sessionio"
)

// Source is the read side of a session's event stream. Replay returns all events
// with ID greater than `from` (0 = from the start); Subscribe returns a channel
// of live events and a cancel func to release the subscription. Kept an interface
// so the SSE layer is tested without files (sessionio.FileSource wires the real one).
type Source interface {
	Replay(from int64) []sessionio.Event
	Subscribe() (<-chan sessionio.Event, func())
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
func writeSSE(w http.ResponseWriter, r *http.Request, src Source, hb time.Duration) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	// Subscribe BEFORE replaying so no event appended in between is lost; then
	// skip any live event whose ID was already covered by the replay (dedup).
	ch, cancel := src.Subscribe()
	defer cancel()

	var lastID int64
	for _, e := range src.Replay(parseLastEventID(r)) {
		fmt.Fprintf(w, "id: %d\ndata: %s\n\n", e.ID, e.JSON())
		lastID = e.ID
	}
	fl.Flush()

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
			fmt.Fprintf(w, "id: %d\ndata: %s\n\n", e.ID, e.JSON())
			lastID = e.ID
			fl.Flush()
		case <-ticker.C:
			fmt.Fprint(w, ": hb\n\n")
			fl.Flush()
		}
	}
}
