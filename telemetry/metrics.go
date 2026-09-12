package telemetry

// Prometheus exposition for the lobby.
//
// WHY THIS EXISTS ALONGSIDE THE EVENT STREAM. ADR-0006 sends usage events to
// Loki as one JSON line each, and says so in its own trade-offs: "Long-term
// trends would need counters in Prometheus (26 weeks)." This is that. The two
// sinks answer different questions. Loki answers "what happened in this
// session", Prometheus answers "is the lobby up and how slow is it", and only
// the second can carry an alert that fires before somebody complains.
//
// It was written after 2026-09-12, when the devvm stalled badly enough that a
// user could not work for about three hours and nothing alerted, because
// t3-serve, tmux-api and ttyd expose nothing to Prometheus and the only target
// on that host is node_exporter.
//
// WHY NO client_golang. This module has three dependencies and the metric set
// here is small and fixed: counters, one histogram with static buckets, and
// gauges. The text exposition format is a few lines of printing, and matching
// the repo's dependency budget is worth more than the generality. If this ever
// needs exemplars, native histograms or a pushgateway, take the dependency
// then rather than growing a private imitation of one.
//
// CARDINALITY IS THE HAZARD, and it is the same one the event stream already
// designs around. Loki here is a single tenant with a global 5000-stream cap,
// so promtail strips labels and every attribute lives inside the line. A
// Prometheus metric labelled by session or project name would reintroduce
// exactly that problem: those names are user-supplied and unbounded. Record
// therefore takes an endpoint that has already been through EndpointGroup, and
// the tests assert that raw names never reach a label.

import (
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// Buckets in milliseconds. Chosen against what this service actually does
// rather than a default ladder: most handlers are a tmux call and answer in
// single-digit ms, the slow-request line in the event stream is 1s, and
// anything past 10s is a request a person has already given up on.
var durationBucketsMs = []float64{5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000}

type counterKey struct{ endpoint, outcome string }

type histo struct {
	counts []uint64 // one per bucket, cumulative applied at render
	sum    float64
	n      uint64
}

type gaugeKey struct {
	name   string
	labels string // pre-rendered, so the map key stays comparable
}

// Metrics is one service's Prometheus surface. Safe for concurrent use, and a
// nil *Metrics is valid and inert: this sits on the request path of the whole
// service and must never be the reason a request fails.
type Metrics struct {
	mu       sync.Mutex
	counters map[counterKey]uint64
	histos   map[string]*histo
	gauges   map[gaugeKey]float64
}

func NewMetrics() *Metrics {
	return &Metrics{
		counters: map[counterKey]uint64{},
		histos:   map[string]*histo{},
		gauges:   map[gaugeKey]float64{},
	}
}

// Record accounts one finished request. endpoint must already be grouped by
// EndpointGroup; passing a raw path is the cardinality bug this guards against.
func (m *Metrics) Record(endpoint string, status int, ms float64) {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.counters[counterKey{endpoint, outcomeOf(status)}]++
	h := m.histos[endpoint]
	if h == nil {
		h = &histo{counts: make([]uint64, len(durationBucketsMs))}
		m.histos[endpoint] = h
	}
	for i, b := range durationBucketsMs {
		if ms <= b {
			h.counts[i]++
		}
	}
	h.sum += ms
	h.n++
}

// SetGauge replaces a gauge's value. Labels may be nil.
func (m *Metrics) SetGauge(name string, labels map[string]string, v float64) {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.gauges[gaugeKey{name: name, labels: renderLabels(labels)}] = v
}

// Handler serves the exposition format. A nil *Metrics serves an empty body
// rather than 500ing, so a half-wired service still scrapes.
func (m *Metrics) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		if m == nil {
			return
		}
		m.Render(w)
	})
}

// Render writes every series. Named Render, not WriteTo: that signature is
// reserved by io.WriterTo, which must return (int64, error), and go vet's
// stdmethods check fails the build on a near-miss. `go test` does not run that
// check, so it passed locally and failed in CI.. Output is sorted so a diff between two scrapes
// is readable by a human debugging the endpoint.
func (m *Metrics) Render(w io.Writer) {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	if len(m.counters) > 0 {
		fmt.Fprintln(w, "# HELP tl_http_requests_total Requests served, by grouped endpoint and outcome class.")
		fmt.Fprintln(w, "# TYPE tl_http_requests_total counter")
		keys := make([]counterKey, 0, len(m.counters))
		for k := range m.counters {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool {
			if keys[i].endpoint != keys[j].endpoint {
				return keys[i].endpoint < keys[j].endpoint
			}
			return keys[i].outcome < keys[j].outcome
		})
		for _, k := range keys {
			fmt.Fprintf(w, "tl_http_requests_total{endpoint=%q,outcome=%q} %d\n",
				escape(k.endpoint), escape(k.outcome), m.counters[k])
		}
	}

	if len(m.histos) > 0 {
		fmt.Fprintln(w, "# HELP tl_http_request_duration_ms How long requests took, by grouped endpoint.")
		fmt.Fprintln(w, "# TYPE tl_http_request_duration_ms histogram")
		eps := make([]string, 0, len(m.histos))
		for e := range m.histos {
			eps = append(eps, e)
		}
		sort.Strings(eps)
		for _, e := range eps {
			h := m.histos[e]
			for i, b := range durationBucketsMs {
				fmt.Fprintf(w, "tl_http_request_duration_ms_bucket{endpoint=%q,le=%q} %d\n",
					escape(e), strconv.FormatFloat(b, 'f', -1, 64), h.counts[i])
			}
			fmt.Fprintf(w, "tl_http_request_duration_ms_bucket{endpoint=%q,le=\"+Inf\"} %d\n", escape(e), h.n)
			fmt.Fprintf(w, "tl_http_request_duration_ms_sum{endpoint=%q} %s\n", escape(e), strconv.FormatFloat(h.sum, 'f', -1, 64))
			fmt.Fprintf(w, "tl_http_request_duration_ms_count{endpoint=%q} %d\n", escape(e), h.n)
		}
	}

	if len(m.gauges) > 0 {
		byName := map[string][]gaugeKey{}
		for k := range m.gauges {
			byName[k.name] = append(byName[k.name], k)
		}
		names := make([]string, 0, len(byName))
		for n := range byName {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			fmt.Fprintf(w, "# TYPE %s gauge\n", n)
			ks := byName[n]
			sort.Slice(ks, func(i, j int) bool { return ks[i].labels < ks[j].labels })
			for _, k := range ks {
				fmt.Fprintf(w, "%s%s %s\n", k.name, k.labels, strconv.FormatFloat(m.gauges[k], 'f', -1, 64))
			}
		}
	}
}

// Outcome class rather than the raw status code: three values instead of
// dozens, and it is what an alert actually asks about.
func outcomeOf(status int) string {
	switch {
	case status >= 500:
		return "server_error"
	case status >= 400:
		return "client_error"
	default:
		return "ok"
	}
}

func renderLabels(labels map[string]string) string {
	if len(labels) == 0 {
		return ""
	}
	keys := make([]string, 0, len(labels))
	for k := range labels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s=%q", k, escape(labels[k])))
	}
	return "{" + strings.Join(parts, ",") + "}"
}

// A label value reaches here from a URL path, so it is attacker-influenced in
// the same way event attributes are. An unescaped newline would let whoever
// chose the name forge a series.
func escape(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`)
	return r.Replace(s)
}
