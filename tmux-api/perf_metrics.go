package main

// Echo latency into Prometheus.
//
// WHAT THIS IS AND IS NOT. It does not measure anything. The lobby has
// measured keystroke-to-echo since long before this file, and does it more
// carefully than a naive version would: a sample is only taken for a lone
// keystroke leaving a terminal that has been quiet for 300ms, an echo that
// takes longer than 2s is counted as unmatched rather than guessed at, and a
// second keystroke arriving before the echo makes the pairing ambiguous and
// discards it. Those three rules are what make the number trustworthy on a
// TUI that redraws on its own schedule. See frontend/diag.js.
//
// All this does is copy the rollup the browser already sends into Prometheus,
// beside Loki where it already goes.
//
// WHY DUPLICATE THE SINK. Viktor asked to hear when a user's typing gets slow.
// The plan is to watch the real distribution for a couple of weeks and set an
// alert threshold against it. Prometheus keeps 26 weeks where Loki keeps 30
// days, and deriving a percentile-of-a-percentile out of log lines to pick
// that threshold is awkward where a range query is not.
//
// The user label comes from resolveOSUser at the intake, never from the
// browser, the same rule event attribution follows. OS usernames are a closed
// roster set and safe as a label; nothing else here is labelled.

import (
	"time"

	"terminal-lobby/telemetry"
)

// perfRollupGauges maps the attributes perf.rollup already carries to metric
// names. echo is the round trip a person feels. input is keydown to ws.send,
// the client's own cost with nothing off-device in it, which is what separates
// "this box is slow" from "this laptop is busy".
var perfRollupGauges = map[string]string{
	"tl.echo.p50":  "tl_echo_latency_p50_ms",
	"tl.echo.p95":  "tl_echo_latency_p95_ms",
	"tl.echo.max":  "tl_echo_latency_max_ms",
	"tl.echo.n":    "tl_echo_latency_samples",
	"tl.input.p50": "tl_input_latency_p50_ms",
	"tl.input.p95": "tl_input_latency_p95_ms",
}

// perfNow is a test seam, the same shape as spendNow in agentspend.go.
// Production never reassigns it.
var perfNow = time.Now

// recordPerfRollup copies one browser rollup into gauges. Unusable input
// writes nothing: these values crossed the network from a page, so a missing
// or non-numeric field must produce no series rather than a wrong one.
//
// It also stamps when the rollup landed, because nothing here ever clears a
// gauge. A browser stops posting the moment its tab is hidden, and the last
// number it sent then sits in /metrics until the process restarts. Measured
// 2026-09-13: emo's p95 read 527 ms, identical to the millisecond, across 29
// consecutive scrapes covering 145 minutes. An alert reading that alone
// cannot distinguish a session that is slow now from one that was slow once,
// so it gates on the stamp instead.
func recordPerfRollup(m *telemetry.Metrics, osUser string, attrs telemetry.Attrs) {
	if osUser == "" {
		return
	}
	labels := map[string]string{"user": osUser}
	wrote := false
	for attr, metric := range perfRollupGauges {
		if v, ok := attrs[attr].(float64); ok {
			m.SetGauge(metric, labels, v)
			wrote = true
		}
	}
	if wrote {
		m.SetGauge("tl_echo_latency_updated_timestamp_seconds", labels, float64(perfNow().Unix()))
	}
}
