package main

import (
	"encoding/json"
	"io"
	"net/http"
	"time"

	"terminal-lobby/telemetry"
)

// events is this service's emitter. buildID is stamped by deploy.sh
// (-ldflags -X main.buildID=<rev>) so behaviour can be attributed to a release.
var (
	buildID = "dev"
	events  = telemetry.New("tmux-api", buildID, nil)
	// diagEvents is the health channel (docs/adr/0008-client-diagnostics.md).
	// Same intake, same auth, same identity resolution — a distinct marker and
	// catalog so the two can be queried and budgeted apart.
	diagEvents = telemetry.NewDiag("tmux-api", buildID, nil)
	// timing measures how long this service's own handlers take, so a
	// client-observed latency can be split into network and server. The client
	// stamps X-TL-Req and the middleware echoes it back to join the two.
	timing = telemetry.NewTiming(diagEvents, telemetry.TimingOpts{})
)

// The browser intake. The lobby pages cannot write to the journal themselves,
// so they POST batches here: tmux-api already authenticates every request via
// the Authentik header and resolves the OS user, which makes it the one place
// that can attribute a browser event to a person without trusting the client.
//
// Everything below exists because the intake is client-facing: the body is
// bounded, the batch is capped, the event vocabulary is closed, attributes are
// restricted to flat tl.* scalars, and identity is taken from the auth header,
// never from the payload. The per-user rate cap protects a SHARED Loki (single
// anonymous tenant, 30-day retention) from one runaway tab.
const (
	maxTelemetryBody    = 64 << 10 // 64 KiB per POST
	maxBatchEvents      = 50       // events honoured per POST
	intakeRatePerMinute = 600      // per OS user, ~10/s sustained
	// diagRatePerMinute is diagnostics' own budget, so a burst of health
	// records cannot starve usage events or the reverse. Steady state is ~2
	// records/min per active tab, so this is headroom, not a target.
	diagRatePerMinute = 300
)

// telemetryNow is a test seam for the rate limiter's clock.
var telemetryNow = time.Now

type intakeBucket struct {
	tokens float64
	last   time.Time
}

var (
	intakeBuckets = map[string]*intakeBucket{}
	diagBuckets   = map[string]*intakeBucket{}
)

// allowIntake is a token bucket per OS user: intakeRatePerMinute events a
// minute, burstable to one minute's worth.
func allowIntake(osUser string, want int) bool {
	return allowFrom(intakeBuckets, osUser, want, intakeRatePerMinute)
}

// allowDiag is the same shape over a separate pool, so the two channels cannot
// spend each other's budget.
func allowDiag(osUser string, want int) bool {
	return allowFrom(diagBuckets, osUser, want, diagRatePerMinute)
}

func allowFrom(buckets map[string]*intakeBucket, osUser string, want, perMinute int) bool {
	now := telemetryNow()
	b := buckets[osUser]
	if b == nil {
		b = &intakeBucket{tokens: float64(perMinute), last: now}
		buckets[osUser] = b
	}
	if elapsed := now.Sub(b.last).Minutes(); elapsed > 0 {
		b.tokens += elapsed * float64(perMinute)
		if b.tokens > float64(perMinute) {
			b.tokens = float64(perMinute)
		}
		b.last = now
	}
	if b.tokens < float64(want) {
		return false
	}
	b.tokens -= float64(want)
	return true
}

// clientKinds are the surfaces allowed to report, so tl.client stays a small
// known set rather than whatever a caller invents.
var clientKinds = map[string]bool{"lobby-vanilla": true, "lobby-v2": true, "term": true}

type intakeEvent struct {
	Name  string         `json:"name"`
	Attrs map[string]any `json:"attrs"`
}

type intakeBatch struct {
	// Kind selects the channel: "diag" for health records, anything else
	// (including absent) for usage. Absent means usage on purpose — a client
	// that predates diagnostics keeps working with no lockstep deploy.
	Kind   string        `json:"kind"`
	Client string        `json:"client"`
	Build  string        `json:"build"`
	Events []intakeEvent `json:"events"`
}

// traceAllowed lists the records that may carry the flight recorder. A trace
// belongs to an incident — the raw events leading up to a failure — so a
// once-a-minute rollup cannot be used to attach one.
var traceAllowed = map[string]bool{
	"diag.incident": true,
	"app.exception": true,
	"conn.dropped":  true,
	"term.stall":    true,
}

func handleTelemetry(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxTelemetryBody))
	if err != nil {
		http.Error(w, "body too large", http.StatusRequestEntityTooLarge)
		return
	}
	var batch intakeBatch
	if err := json.Unmarshal(body, &batch); err != nil {
		http.Error(w, "bad JSON", http.StatusBadRequest)
		return
	}
	// One intake, two channels. Auth, identity and bounding are shared; the
	// catalog, emitter, budget and attribute rules follow the batch's kind.
	isDiag := batch.Kind == "diag"
	allow, emitter, known := allowIntake, events, telemetry.IsKnown
	if isDiag {
		allow, emitter, known = allowDiag, diagEvents, telemetry.IsKnownDiag
	}

	if !allow(osUser, len(batch.Events)) {
		// Deliberately NOT emitted as an event: a throttled client would have
		// its retries logged as fast as it retries.
		http.Error(w, "telemetry rate exceeded", http.StatusTooManyRequests)
		return
	}

	client := batch.Client
	if !clientKinds[client] {
		client = "unknown"
	}
	accepted, dropped := 0, 0
	for i, ev := range batch.Events {
		if i >= maxBatchEvents {
			dropped += len(batch.Events) - maxBatchEvents
			break
		}
		if !known(ev.Name) {
			dropped++
			continue
		}
		var attrs telemetry.Attrs
		if isDiag {
			attrs = sanitizeDiagAttrs(ev.Attrs, ev.Name)
		} else {
			attrs = sanitizeAttrs(ev.Attrs)
		}
		attrs["tl.client"] = client
		if batch.Build != "" {
			attrs["tl.build"] = clip(batch.Build, 40)
		}
		emitter.Emit(ev.Name, osUser, attrs)
		accepted++
	}
	if dropped > 0 {
		emitter.Emit("api.rejected", osUser, telemetry.Attrs{
			"tl.kind":   "telemetry.unknown_event",
			"tl.count":  dropped,
			"tl.client": client,
		})
	}
	w.WriteHeader(http.StatusNoContent)
}

// sanitizeDiagAttrs is sanitizeAttrs with the two relaxations ADR-0008 names,
// and nothing more: tl.stack gets its own larger bound, and tl.trace may be an
// array on an incident record. The array is validated and capped by
// telemetry.BoundTrace rather than passed through, because it is the one place
// the flat-scalar contract is opened.
func sanitizeDiagAttrs(in map[string]any, event string) telemetry.Attrs {
	out := make(telemetry.Attrs, len(in)+2)
	for k, v := range in {
		if len(k) < 4 || k[:3] != "tl." {
			continue
		}
		if k == telemetry.TraceKey {
			if !traceAllowed[event] {
				continue
			}
			if t := telemetry.BoundTrace(v); t != nil {
				out[k] = t
			}
			continue
		}
		switch val := v.(type) {
		case string:
			max := telemetry.MaxValueLen
			if k == "tl.stack" {
				max = telemetry.MaxStackLen
			}
			out[k] = clip(val, max)
		case float64, bool, nil:
			out[k] = val
		default: // objects and other arrays are not part of the contract
		}
	}
	return out
}

// sanitizeAttrs keeps flat tl.* scalars and discards everything else, so a
// client can populate the documented attributes but cannot reshape the record
// (nested objects, arrays, or fields like user.id that the server owns).
func sanitizeAttrs(in map[string]any) telemetry.Attrs {
	out := make(telemetry.Attrs, len(in)+2)
	for k, v := range in {
		if len(k) < 4 || k[:3] != "tl." {
			continue
		}
		switch val := v.(type) {
		case string:
			out[k] = clip(val, telemetry.MaxValueLen)
		case float64, bool, nil:
			out[k] = val
		default: // objects, arrays — not part of the attribute contract
		}
	}
	return out
}

func clip(s string, max int) string {
	if len(s) > max {
		return s[:max]
	}
	return s
}
