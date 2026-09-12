package main

// Typing latency, from the browser's rollup into Prometheus.
//
// The event already reaches Loki like every other usage event, and that is
// where the raw records live. This puts the same numbers in Prometheus too,
// for one reason: the plan is to watch the distribution for a couple of weeks
// and then set an alert threshold against what it actually shows. Deriving a
// percentile-of-a-percentile from log lines is awkward, and Prometheus keeps
// 26 weeks against Loki's 30 days.
//
// The user label comes from resolveOSUser at the intake, never from the
// browser, which is the same rule the event attribution follows. OS usernames
// are a closed roster set and safe as a label; nothing else here is labelled.

import "terminal-lobby/telemetry"

// recordTypingLatency turns one browser rollup into gauges. Unusable input
// writes nothing: these values crossed the network from a page, so a missing
// or non-numeric field must produce no series rather than a wrong one.
func recordTypingLatency(m *telemetry.Metrics, osUser string, attrs telemetry.Attrs) {
	if osUser == "" {
		return
	}
	labels := map[string]string{"user": osUser}
	for attr, metric := range map[string]string{
		"tl.p50": "tl_typing_latency_p50_ms",
		"tl.p95": "tl_typing_latency_p95_ms",
		"tl.max": "tl_typing_latency_max_ms",
		"tl.n":   "tl_typing_latency_samples",
	} {
		if v, ok := attrs[attr].(float64); ok {
			m.SetGauge(metric, labels, v)
		}
	}
}
