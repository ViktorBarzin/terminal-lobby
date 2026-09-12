package main

import (
	"strings"
	"testing"

	"terminal-lobby/telemetry"
)

func TestTypingLatencyReachesPrometheusLabelledByUser(t *testing.T) {
	m := telemetry.NewMetrics()
	recordTypingLatency(m, "emo", telemetry.Attrs{"tl.p50": 41.5, "tl.p95": 900.0, "tl.n": 12.0})

	var sb strings.Builder
	m.Render(&sb)
	got := sb.String()
	for _, w := range []string{
		`tl_typing_latency_p50_ms{user="emo"} 41.5`,
		`tl_typing_latency_p95_ms{user="emo"} 900`,
		`tl_typing_latency_samples{user="emo"} 12`,
	} {
		if !strings.Contains(got, w) {
			t.Errorf("missing %q in:\n%s", w, got)
		}
	}
}

// The browser sends these and the browser is not trusted. A garbage or
// missing field must not produce a series rather than a wrong one.
func TestTypingLatencyIgnoresUnusableAttrs(t *testing.T) {
	m := telemetry.NewMetrics()
	recordTypingLatency(m, "emo", telemetry.Attrs{"tl.p50": "not a number"})
	recordTypingLatency(m, "emo", telemetry.Attrs{})
	var sb strings.Builder
	m.Render(&sb)
	if strings.Contains(sb.String(), "tl_typing_latency") {
		t.Fatalf("wrote a series from unusable input:\n%s", sb.String())
	}
}

// OS usernames are a closed roster set and safe as labels. An empty one is
// not a user and must not create a series.
func TestTypingLatencyRequiresAUser(t *testing.T) {
	m := telemetry.NewMetrics()
	recordTypingLatency(m, "", telemetry.Attrs{"tl.p50": 10.0})
	var sb strings.Builder
	m.Render(&sb)
	if strings.Contains(sb.String(), "tl_typing_latency") {
		t.Fatal("wrote a series with no user")
	}
}
