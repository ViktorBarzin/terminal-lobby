package telemetry

import "encoding/json"

// Diagnostics — the performance and reliability channel
// (docs/adr/0008-client-diagnostics.md).
//
// It shares this module's transport, escaping and bounding with usage events,
// and differs in three ways:
//
//   - a distinct marker, so a LogQL line filter selects health records without
//     parsing every usage line;
//   - its own closed catalog, so the two vocabularies cannot bleed into each
//     other and make the marker an unreliable selector;
//   - two bounded relaxations of the usage attribute contract: tl.stack may
//     reach MaxStackLen, and tl.trace may be an array.
//
// The relaxations are deliberate and narrow. A stack cut to MaxValueLen
// routinely loses the frames that identify the call path, and the trace is the
// flight recorder — the raw events immediately preceding an incident, which is
// what made the selection-diagnostics channel this replaces worth having.
// Both are capped hard, because a shared single-tenant Loki with 30-day
// retention is what absorbs a call site that misbehaves.

// DiagMarker prefixes every diagnostics line:
//
//	{job="devvm-journal"} |= "TLDIAG" | json
const DiagMarker = "TLDIAG"

// TraceKey is the one attribute permitted to hold an array.
const TraceKey = "tl.trace"

// Bounds specific to diagnostics records.
const (
	// MaxStackLen is the allowance for tl.stack alone. Every other attribute
	// keeps MaxValueLen.
	MaxStackLen = 1024
	// MaxTraceEntries caps the flight recorder's length; MaxTraceBytes caps
	// what it can actually cost once encoded, which the entry count cannot
	// since one entry can be arbitrarily wide.
	MaxTraceEntries = 30
	MaxTraceBytes   = 4096
	// MaxTraceValueLen keeps a single trace field small. Real entries are
	// timestamps, event kinds, key names and coordinates.
	MaxTraceValueLen = 200
)

// NewDiag builds an Emitter for the diagnostics channel.
func NewDiag(service, version string, out Writer) *Emitter {
	if out == nil {
		out = LogWriter{}
	}
	return &Emitter{
		service: service, version: version, out: out,
		marker: DiagMarker,
		known:  IsKnownDiag,
		limit:  diagLimit,
	}
}

// diagLimit gives tl.stack its larger allowance and leaves everything else on
// the usage bound.
func diagLimit(key string) int {
	if key == "tl.stack" {
		return MaxStackLen
	}
	return MaxValueLen
}

// BoundTrace validates and bounds a flight-recorder trace, returning nil for
// anything that is not one. A trace is an array of flat objects whose values
// are JSON scalars; nested structure is dropped rather than rejected, so one
// malformed field does not cost the whole recording.
//
// When the trace is too long or too large, the OLDEST entries go first: the
// events nearest the incident are the ones that explain it.
func BoundTrace(v any) any {
	in, ok := v.([]any)
	if !ok || len(in) == 0 {
		return nil
	}
	if len(in) > MaxTraceEntries {
		in = in[len(in)-MaxTraceEntries:]
	}

	out := make([]any, 0, len(in))
	for _, raw := range in {
		entry, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		clean := make(map[string]any, len(entry))
		for k, val := range entry {
			switch t := val.(type) {
			case string:
				if len(t) > MaxTraceValueLen {
					t = t[:MaxTraceValueLen]
				}
				clean[k] = t
			case float64, bool, nil:
				clean[k] = val
			default: // objects and arrays are not part of an entry
			}
		}
		if len(clean) > 0 {
			out = append(out, clean)
		}
	}
	if len(out) == 0 {
		return nil
	}

	// Drop from the front until the encoded trace fits. Marshaling to measure
	// is exact, and a trace is at most MaxTraceEntries long.
	for len(out) > 0 {
		encoded, err := json.Marshal(out)
		if err != nil {
			return nil
		}
		if len(encoded) <= MaxTraceBytes {
			return out
		}
		out = out[1:]
	}
	return nil
}
