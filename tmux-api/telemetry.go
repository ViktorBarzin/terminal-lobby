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
)

// telemetryNow is a test seam for the rate limiter's clock.
var telemetryNow = time.Now

type intakeBucket struct {
	tokens float64
	last   time.Time
}

var intakeBuckets = map[string]*intakeBucket{}

// allowIntake is a token bucket per OS user: intakeRatePerMinute events a
// minute, burstable to one minute's worth.
func allowIntake(osUser string, want int) bool {
	now := telemetryNow()
	b := intakeBuckets[osUser]
	if b == nil {
		b = &intakeBucket{tokens: float64(intakeRatePerMinute), last: now}
		intakeBuckets[osUser] = b
	}
	if elapsed := now.Sub(b.last).Minutes(); elapsed > 0 {
		b.tokens += elapsed * float64(intakeRatePerMinute)
		if b.tokens > float64(intakeRatePerMinute) {
			b.tokens = float64(intakeRatePerMinute)
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
	Client string        `json:"client"`
	Build  string        `json:"build"`
	Events []intakeEvent `json:"events"`
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
	if !allowIntake(osUser, len(batch.Events)) {
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
		if !telemetry.IsKnown(ev.Name) {
			dropped++
			continue
		}
		attrs := sanitizeAttrs(ev.Attrs)
		attrs["tl.client"] = client
		if batch.Build != "" {
			attrs["tl.build"] = clip(batch.Build, 40)
		}
		events.Emit(ev.Name, osUser, attrs)
		accepted++
	}
	if dropped > 0 {
		events.Emit("api.rejected", osUser, telemetry.Attrs{
			"tl.kind":   "telemetry.unknown_event",
			"tl.count":  dropped,
			"tl.client": client,
		})
	}
	w.WriteHeader(http.StatusNoContent)
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
