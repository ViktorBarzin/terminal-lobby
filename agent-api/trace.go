package main

// The trace: one JSON object per line, for every request a caller makes.
//
// The design doc calls this the main control. There is no approval gate in
// front of a task, so what protects us is that everything asked for is
// recorded verbatim and replayable, and that the record outlives the devvm by
// being tailed into Loki.
//
// Two properties are worth more than the rest of this file.
//
// The request is the caller's OWN WORDS, byte for byte. Summarising it, or
// re-encoding a decoded struct, would drop whatever field the next version of
// the caller starts sending and would make the replay a paraphrase.
//
// The bearer token is never written. Nothing here takes a request's headers,
// which is the structural version of that promise rather than a redaction pass
// that has to be remembered — and a test greps a real trace file for a real
// token to keep it true.
//
// The limit of that promise, stated so nobody has to discover it: a caller
// that writes a secret into its own MESSAGE has written it into the trace,
// because the message is recorded verbatim. Redacting it would cost the
// verbatim guarantee and buy nothing, since the same text has already gone
// through tmux into the conversation's transcript on disk. The rule for a
// caller is the ordinary one: do not put credentials in a prompt.

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// DefaultTracePath is where the trace lands unless TL_AGENT_TRACE says
// otherwise. Rotation and the Loki scrape are declared in the playbook, not
// here.
const DefaultTracePath = "/var/log/agent-api/trace.jsonl"

// TraceEntry is one line. Field order follows the design doc's example so a
// hand-read line looks like the one in the document.
type TraceEntry struct {
	TS             string `json:"ts"`
	TraceID        string `json:"trace_id"`
	TaskID         string `json:"task_id,omitempty"`
	ConversationID string `json:"conversation_id,omitempty"`
	// Actor is the credential's NAME. On a bearer request authuser puts that
	// in Identity.Header, never the token itself.
	Actor string `json:"actor"`
	// Verb is the ROUTE PATTERN, not the concrete path:
	// "POST /v1/conversations/{id}/messages". The id is already its own field,
	// and a pattern is what makes a trace groupable.
	Verb string `json:"verb"`
	// Request is what the caller sent, verbatim — the JSON body as it arrived
	// for a write, the query parameters for a read. Never headers.
	Request json.RawMessage `json:"request"`
	// Response is what was sent back: the body for a success, {"error": …} for
	// a refusal.
	Response json.RawMessage `json:"response"`
	Status   int             `json:"status"`
	Duration float64         `json:"duration_ms"`
}

// Trace appends entries to a file. A disabled trace — one whose file could not
// be opened — is a working Trace whose writes go nowhere, because the service
// must keep serving when /var/log is unwritable. The design doc is explicit:
// the trace is not allowed to take the service down.
type Trace struct {
	mu sync.Mutex
	w  io.Writer
	c  io.Closer
	// warned keeps a broken sink from writing a log line per request. The
	// first failure is worth a line; the thousandth is a second outage.
	warned bool
}

// OpenTrace opens the trace file for appending, creating its directory if it
// can. Every failure is a warning and a disabled trace, never an error the
// caller has to decide about — there is only one sensible decision and this is
// it.
func OpenTrace(path string) *Trace {
	if path == "" {
		return &Trace{}
	}
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			logf("agent-api: trace disabled: cannot create %s: %v "+
				"(the service is serving; requests will not be recorded)", dir, err)
			return &Trace{}
		}
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o640)
	if err != nil {
		logf("agent-api: trace disabled: cannot open %s: %v "+
			"(the service is serving; requests will not be recorded)", path, err)
		return &Trace{}
	}
	logf("agent-api: tracing to %s", path)
	return &Trace{w: f, c: f}
}

// NewTraceTo writes to an arbitrary sink. The tests use it; nothing else does.
func NewTraceTo(w io.Writer) *Trace { return &Trace{w: w} }

// Enabled reports whether anything is being recorded, for the startup log and
// for /health's own honesty.
func (t *Trace) Enabled() bool {
	if t == nil {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.w != nil
}

// Write appends one entry. A marshalling or write failure is logged once and
// swallowed: a request that was served must not be failed because the record
// of it could not be kept.
func (t *Trace) Write(e TraceEntry) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.w == nil {
		return
	}
	line, err := json.Marshal(e)
	if err != nil {
		t.warnLocked("cannot encode trace entry: %v", err)
		return
	}
	if _, err := t.w.Write(append(line, '\n')); err != nil {
		t.warnLocked("cannot write trace entry: %v", err)
	}
}

// warnLocked logs the first failure and stays quiet after it. Called with the
// lock held.
func (t *Trace) warnLocked(format string, args ...any) {
	if t.warned {
		return
	}
	t.warned = true
	logf("agent-api: "+format+" (further trace failures are silent)", args...)
}

// Close releases the file. Only main calls it.
func (t *Trace) Close() error {
	if t == nil {
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.c == nil {
		return nil
	}
	err := t.c.Close()
	t.w, t.c = nil, nil
	return err
}

// traceTime formats a timestamp the way the design doc's example does:
// RFC3339 in UTC with milliseconds, so a line sorts as text.
func traceTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
