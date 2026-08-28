// Package telemetry emits the lobby's usage events.
//
// WHY IT LOOKS LIKE THIS (docs/adr/0006-usage-telemetry.md): the devvm already
// ships its journal to the cluster's Loki via promtail, so an event written to
// stdout is queryable in Grafana seconds later with no new service to run. Each
// event is therefore ONE line: a fixed marker followed by a JSON object using
// OpenTelemetry log-record naming (event.name / service.* / user.id / attrs),
// which keeps the payload swappable for a real OTLP exporter later without
// touching a single call site.
//
// Two constraints shape the format:
//
//   - Loki here is a single anonymous tenant with a GLOBAL 5000-active-stream
//     cap, and promtail deliberately strips labels to stay under it (blowing it
//     429s new streams for every service in the homelab). So every attribute
//     lives INSIDE the line; nothing here ever becomes a Loki label.
//   - Session names, project names and paths are user-supplied. A raw newline
//     in one would let anyone who can name a session forge telemetry records,
//     so values are JSON-escaped onto a single line and bounded in size.
//
// Never emit conversation content, prompt text, file contents or keystrokes —
// events record WHICH feature was used, not what was typed.
package telemetry

import (
	"encoding/json"
	"log"
	"sort"
	"time"
)

// Marker prefixes every event line, so LogQL can select events without
// parsing every log line the services write:
//
//	{job="devvm-journal"} |= "TLEVENT" | json
const Marker = "TLEVENT"

// Bounds on a single event. Generous for real call sites, small enough that a
// buggy one cannot flood a shared 30-day log store.
const (
	// 24 was too small for the record that carries the most: a fully active
	// perf.rollup can hold 8 correlation attributes, 2 window attributes, 5
	// metrics at 4 fields each, 3 counters, 4 WebSocket byte/frame counts and 7
	// tl.net.* wire-byte fields — 44. Measured against 24 hours of live
	// diagnostics before raising it: the maximum observed was exactly 24 and
	// 4.5% of records sat on the cap, so records WERE being truncated in
	// production, and bound() truncates by sorted key — which drops tl.tab,
	// tl.session, tl.win_s and tl.ws.* while keeping tl.api.*. Correlation was
	// being lost from precisely the busiest records.
	MaxAttrs    = 48
	MaxValueLen = 512
)

// Attrs are an event's attributes. Keys use the tl.* prefix; values must be
// JSON scalars (string, number, bool).
type Attrs map[string]any

// Writer is where finished lines go. Production uses the service logger;
// tests capture instead.
type Writer interface{ Write(line string) }

// LogWriter writes through the standard logger, i.e. to the service's journal.
type LogWriter struct{}

func (LogWriter) Write(line string) { log.Print(line) }

// Emitter stamps events with the resource fields of one service.
//
// marker, known and limit are what separate the two channels this module
// carries: usage events (Marker, the ADR-0006 catalog) and diagnostics
// (DiagMarker, the ADR-0008 catalog, with a larger allowance for stack
// traces). Everything else — escaping, bounding, the record shape — is shared,
// because both channels land in the same journal under the same constraints.
type Emitter struct {
	service string
	version string
	out     Writer
	marker  string
	known   func(string) bool
	limit   func(key string) int
}

// New builds an Emitter for a service. version is the deployed build id, so a
// behaviour change can be attributed to a release.
func New(service, version string, out Writer) *Emitter {
	if out == nil {
		out = LogWriter{}
	}
	return &Emitter{
		service: service, version: version, out: out,
		marker: Marker,
		known:  IsKnown,
		limit:  func(string) int { return MaxValueLen },
	}
}

// Emit records one event for one OS user. It is deliberately forgiving: a nil
// Emitter, an unknown event name, or a hostile attribute value is dropped or
// neutered rather than failing the request that triggered it — telemetry is
// never worth breaking the app over.
func (e *Emitter) Emit(name, osUser string, attrs Attrs) {
	if e == nil || !e.known(name) {
		return
	}
	rec := struct {
		TS      string `json:"ts"`
		Name    string `json:"event.name"`
		Service string `json:"service.name"`
		Version string `json:"service.version,omitempty"`
		User    string `json:"user.id,omitempty"`
		Attrs   Attrs  `json:"attrs,omitempty"`
	}{
		TS:      time.Now().UTC().Format(time.RFC3339Nano),
		Name:    name,
		Service: e.service,
		Version: e.version,
		User:    osUser,
		Attrs:   e.bound(attrs),
	}
	// Marshal (not Encode): one line, every control character escaped.
	payload, err := json.Marshal(rec)
	if err != nil {
		return
	}
	e.out.Write(e.marker + " " + string(payload))
}

// bound truncates oversized strings and caps the attribute count, choosing
// which keys survive deterministically so the same call site always logs the
// same shape. The per-key length comes from the emitter, because diagnostics
// allow tl.stack more room than any usage attribute gets.
//
// TraceKey is re-bounded here rather than trusted from the caller: it is the
// one array the record shape permits, and the byte cap is what keeps a shared
// 30-day store safe from a call site that forgets.
func (e *Emitter) bound(attrs Attrs) Attrs {
	if len(attrs) == 0 {
		return nil
	}
	keys := make([]string, 0, len(attrs))
	for k := range attrs {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if len(keys) > MaxAttrs {
		keys = keys[:MaxAttrs]
	}
	out := make(Attrs, len(keys))
	for _, k := range keys {
		if k == TraceKey {
			if t := BoundTrace(attrs[k]); t != nil {
				out[k] = t
			}
			continue
		}
		if s, ok := attrs[k].(string); ok {
			if max := e.limit(k); len(s) > max {
				out[k] = s[:max]
				continue
			}
		}
		out[k] = attrs[k]
	}
	return out
}
