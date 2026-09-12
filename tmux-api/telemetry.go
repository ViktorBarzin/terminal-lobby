package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"sync"
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

	// metrics is the Prometheus view of the same requests timing already sees.
	// Wired here rather than inside NewTiming so the two sinks stay
	// independent: the event side is disabled by a nil emitter, the scrape side
	// must keep working regardless.
	metrics = telemetry.NewMetrics()
)

// System sessions are not recorded
// (docs/plans/2026-09-06-test-session-origin-design.md). The QA fleet drives
// the real deployed lobby against the real backends on purpose, so its turns
// are real events from a real service and only the session they name says they
// are not a person's work. The rule below is what tells the emitter that.
//
// Installed on `events` alone. Diagnostics (ADR-0008) is health data — a stall,
// an exception, a dropped connection — and a fleet session hitting a bug is
// exactly as interesting as a person hitting it. The decision was about the
// USAGE record.
//
// The browser leg of the same question is answered elsewhere: an event like
// app.loaded or theme.changed carries no tl.session, so a session-keyed rule
// cannot see it, and the qa-harness proxy refuses POST /telemetry outright.
func init() {
	events.SetDropRule(systemSessionRule.isSystem)
}

// How long one parse of the cached list answers for, and how stale that answer
// may get before the rule stops trusting it.
//
// The refresh window is the sessions cache's own, so the rule tracks the list
// the service is serving rather than lagging it. The max age exists because the
// memo is the only thing that can answer while the cache is COLD, which is not
// a rare case here: the mutating handlers invalidate the cache and THEN emit,
// so session.killed, session.renamed and session.retitled all arrive in the
// window between. A memo seconds old answers those correctly; a memo minutes
// old is describing a box that has moved on, and a wrong "system" there means
// a person's event silently lost.
const (
	systemSessionRefresh = sessionsTTL
	systemSessionMaxAge  = time.Minute
)

// systemSessionMemo answers "is this session tooling's" for the telemetry drop
// rule, out of the body the sessions cache already holds.
//
// It NEVER lists sessions itself, and that is a correctness requirement rather
// than a performance one. Building the list emits events of its own —
// autoTitleSessions and backfillDerivedNames rename sessions and say so — so a
// rule that listed on a miss would re-enter the emitter that called it, from
// inside Emit, on every event. The cost of not listing is the fallback below.
type systemSessionMemo struct {
	mu   sync.Mutex
	now  func() time.Time
	seen map[string]systemSessionSnapshot
}

// systemSessionSnapshot is one user's verdicts, with the time they were read.
// verdict holds EVERY session the list carried, not just the system ones, so a
// name that is absent from it can be told apart from one that is present and a
// person's.
type systemSessionSnapshot struct {
	at      time.Time
	verdict map[string]bool
}

var systemSessionRule = &systemSessionMemo{now: time.Now, seen: map[string]systemSessionSnapshot{}}

// isSystem is the predicate the emitter consults. It answers from the cached
// list when it can, and from the session's NAME when it cannot.
//
// The name fallback is not a guess: reservedName is half of isSystemSession
// already, so a harness session called qa-… or t3e2e-… is answered correctly
// with no list at all. What the fallback cannot see is an unstamped session
// whose name looks ordinary — and there it fails towards RECORDING, which is
// the direction telemetry has to fail in: a wrongly-kept event is noise in a
// query, a wrongly-dropped one is invisible.
func (m *systemSessionMemo) isSystem(osUser, session string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()
	snap, have := m.seen[osUser]
	if !have || now.Sub(snap.at) > systemSessionRefresh {
		if body, warm := sessionsCacheInstance.get(osUser); warm {
			snap = systemSessionSnapshot{at: now, verdict: systemSessionVerdicts(body)}
			m.seen[osUser] = snap
			have = true
		}
	}
	if have && now.Sub(snap.at) <= systemSessionMaxAge {
		if sys, known := snap.verdict[session]; known {
			return sys
		}
	}
	return reservedName(session)
}

// systemSessionVerdicts reads the served list back into one verdict per
// session. Parsing the body rather than keeping a parallel structure is what
// makes this free of the list-building path: the bytes are already there, and
// this runs at most once per user per refresh window however many events
// arrive in it.
func systemSessionVerdicts(body []byte) map[string]bool {
	var sessions []Session
	if err := json.Unmarshal(body, &sessions); err != nil {
		// "[]" is the historic tmux-is-down body and parses fine; anything
		// that does not is a body nobody should be answering from.
		log.Printf("telemetry drop rule: the cached session list would not parse: %v", err)
		return nil
	}
	out := make(map[string]bool, len(sessions))
	for _, s := range sessions {
		out[s.Name] = isSystemSession(s)
	}
	return out
}

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

// bucketPool holds one bucket per OS user behind a lock. The intake is an HTTP
// handler, one goroutine per request, so both the map and the counters inside
// it are reached concurrently: two tabs of the same person race on one
// bucket's tokens, and two different people race on the map itself. The map
// write only runs for an OS user nobody has reported for yet, which is why an
// unlocked map survived the ordinary day and would throw on the reconnect
// burst after a restart.
type bucketPool struct {
	mu      sync.Mutex
	buckets map[string]*intakeBucket
}

func newBucketPool() *bucketPool {
	return &bucketPool{buckets: map[string]*intakeBucket{}}
}

var (
	intakeBuckets = newBucketPool()
	diagBuckets   = newBucketPool()
)

// allowIntake is a token bucket per OS user: intakeRatePerMinute events a
// minute, burstable to one minute's worth.
func allowIntake(osUser string, want int) bool {
	return intakeBuckets.allow(osUser, want, intakeRatePerMinute)
}

// allowDiag is the same shape over a separate pool, so the two channels cannot
// spend each other's budget.
func allowDiag(osUser string, want int) bool {
	return diagBuckets.allow(osUser, want, diagRatePerMinute)
}

func (p *bucketPool) allow(osUser string, want, perMinute int) bool {
	now := telemetryNow()
	p.mu.Lock()
	defer p.mu.Unlock()
	b := p.buckets[osUser]
	if b == nil {
		b = &intakeBucket{tokens: float64(perMinute), last: now}
		p.buckets[osUser] = b
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
// "sw" is the service worker. It reports the one thing the page cannot observe:
// whether the tap record survived being written, in a context where IndexedDB is
// known to be unreliable. A worker fetch carries the ingress identity header, so
// it authenticates exactly as the page does.
var clientKinds = map[string]bool{"lobby-vanilla": true, "lobby-v2": true, "term": true, "sw": true}

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
		// Typing latency goes to Prometheus as well as Loki, because the plan
		// is to set an alert threshold against a couple of weeks of the real
		// distribution and Prometheus keeps 26 weeks where Loki keeps 30 days.
		if ev.Name == "term.typing_latency" {
			recordTypingLatency(metrics, osUser, attrs)
		}
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
