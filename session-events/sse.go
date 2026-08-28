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
	// ReplayWindow is the pre-2026-08-28 fresh open: the most recent `turns`
	// turns, ascending. Still served to a client that does not ask for the
	// reverse open — see the `rev` flag on writeSSE.
	ReplayWindow(from int64, turns int) []sessionio.Event
	// Backfill is what a reverse open gets: the newest events below `before`,
	// bounded in bytes rather than turns.
	Backfill(before int64, budget int) sessionio.Backfill
	// State is the session-level truth a small backfill no longer carries.
	State(maxPrompts int) sessionio.SessionState
	Subscribe() (<-chan sessionio.Event, func())
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
func writeSSE(w http.ResponseWriter, r *http.Request, src Source, hb time.Duration, onOpen ...func(bytes, count int)) {
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
	var openBytes, openCount int
	resume := parseLastEventID(r)
	switch {
	case !reverseOpen(r):
		// The older contract, ascending and windowed by turns.
		for _, e := range src.ReplayWindow(resume, OpenWindowTurns) {
			fmt.Fprintf(w, "id: %d\ndata: %s\n\n", e.ID, e.JSON())
			lastID = e.ID
		}
		fmt.Fprintf(w, "event: ready\ndata: %d\n\n", lastID)

	case resume > 0:
		// A reconnecting client holds its history and is asking for the gap.
		// Backfilling it would drop exactly what it reconnected to collect, so
		// the resume stays forward — but the state frame still rides along,
		// because a disconnected client may have missed a mode change or a
		// queue operation with no row of its own.
		writeFrame(w, "state", src.State(StatePrompts))
		fl.Flush()
		for _, e := range src.Replay(resume) {
			fmt.Fprintf(w, "id: %d\ndata: %s\n\n", e.ID, e.JSON())
			lastID = e.ID
		}
		// No cursor: the client's own is the correct one, and overwriting it
		// with a backfill cursor it never asked for would strand its history.
		fmt.Fprint(w, "event: ready\ndata: {}\n\n")

	default:
		// The reverse open. The session's own state first — it is ~8 KB and the
		// composer, the mode chip and the context meter are usable the moment it
		// lands — then history from the newest event backwards, so the first
		// row a reader sees is the last thing that happened.
		writeFrame(w, "state", src.State(StatePrompts))
		fl.Flush()
		b := src.Backfill(0, OpenBackfillBytes)
		for i := len(b.Events) - 1; i >= 0; i-- {
			e := b.Events[i]
			// No `id:` on a backfill frame. The browser would take the OLDEST
			// of them as Last-Event-ID, and the next reconnect would resume
			// from history this client already holds. The id is in the payload,
			// which is where the client reads its cursor from.
			fmt.Fprintf(w, "event: back\ndata: %s\n\n", e.JSON())
			if e.ID > lastID {
				lastID = e.ID
			}
			if len(b.Events)-i <= eagerFlushFrames {
				fl.Flush()
			}
		}
		writeFrame(w, "ready", struct {
			Cursor int64 `json:"cursor"`
		}{b.Cursor})
		for _, e := range b.Events {
			openBytes += len(e.JSON())
		}
		openCount = len(b.Events)
	}
	fl.Flush()
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

// writeFrame sends one NAMED SSE event carrying a JSON payload. Named so it
// reaches a listener rather than the client's message handler: nothing
// downstream has to learn to ignore it, and it never enters the event array.
func writeFrame(w http.ResponseWriter, name string, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		log.Printf("writeFrame %s: %v", name, err)
		return
	}
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, b)
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
