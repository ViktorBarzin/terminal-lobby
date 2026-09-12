package main

import (
	"strings"
	"testing"

	"terminal-lobby/telemetry"
)

func TestPerfRollupReachesPrometheusLabelledByUser(t *testing.T) {
	m := telemetry.NewMetrics()
	recordPerfRollup(m, "emo", telemetry.Attrs{"tl.echo.p50": 41.5, "tl.echo.p95": 900.0, "tl.echo.n": 12.0})

	var sb strings.Builder
	m.Render(&sb)
	got := sb.String()
	for _, w := range []string{
		`tl_echo_latency_p50_ms{user="emo"} 41.5`,
		`tl_echo_latency_p95_ms{user="emo"} 900`,
		`tl_echo_latency_samples{user="emo"} 12`,
	} {
		if !strings.Contains(got, w) {
			t.Errorf("missing %q in:\n%s", w, got)
		}
	}
}

// The browser sends these and the browser is not trusted. A garbage or
// missing field must not produce a series rather than a wrong one.
func TestPerfRollupIgnoresUnusableAttrs(t *testing.T) {
	m := telemetry.NewMetrics()
	recordPerfRollup(m, "emo", telemetry.Attrs{"tl.echo.p50": "not a number"})
	recordPerfRollup(m, "emo", telemetry.Attrs{})
	var sb strings.Builder
	m.Render(&sb)
	if strings.Contains(sb.String(), "tl_echo_latency") {
		t.Fatalf("wrote a series from unusable input:\n%s", sb.String())
	}
}

// OS usernames are a closed roster set and safe as labels. An empty one is
// not a user and must not create a series.
func TestPerfRollupRequiresAUser(t *testing.T) {
	m := telemetry.NewMetrics()
	recordPerfRollup(m, "", telemetry.Attrs{"tl.echo.p50": 10.0})
	var sb strings.Builder
	m.Render(&sb)
	if strings.Contains(sb.String(), "tl_echo_latency") {
		t.Fatal("wrote a series with no user")
	}
}
