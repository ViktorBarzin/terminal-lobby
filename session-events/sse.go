package main

import (
	"encoding/json"
	"fmt"
	"log"
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
	for _, e := range src.ReplayWindow(parseLastEventID(r), OpenWindowTurns) {
		fmt.Fprintf(w, "id: %d\ndata: %s\n\n", e.ID, e.JSON())
		lastID = e.ID
	}
	// The opening window is complete. A client cannot tell that from the events
	// alone — they simply stop for a moment — so it either paints a partial
	// transcript and rebuilds it as the rest lands, or waits on a guess. This
	// says so once, as a NAMED event, so it reaches a listener rather than the
	// event array: nothing downstream has to learn to ignore it.
	fmt.Fprintf(w, "event: ready\ndata: %d\n\n", lastID)
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

// writeJSON sends a value as the JSON body of a 200. Encoding failures are left
// to the transport: the header is already out by then, and a half-written body
// is what the client's parse error will report anyway.
func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("writeJSON: %v", err)
	}
}
