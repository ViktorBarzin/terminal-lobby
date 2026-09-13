package main

import (
	"strings"
	"testing"
	"time"

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

// A gauge here is never cleared, so the last rollup a browser sent sits in
// /metrics for as long as the process lives. Measured 2026-09-13: emo's
// tl_echo_latency_p95_ms read 527 ms, unchanged to the millisecond, across 29
// consecutive scrapes spanning 145 minutes — one real measurement and then a
// frozen number. Without a freshness stamp an alert cannot tell that apart
// from a session that is genuinely slow right now, and would latch on.
func TestPerfRollupStampsWhenItWasWritten(t *testing.T) {
	m := telemetry.NewMetrics()
	old := perfNow
	perfNow = func() time.Time { return time.Unix(1789265690, 0) }
	defer func() { perfNow = old }()

	recordPerfRollup(m, "emo", telemetry.Attrs{"tl.echo.p95": 527.0})

	var sb strings.Builder
	m.Render(&sb)
	want := `tl_echo_latency_updated_timestamp_seconds{user="emo"} 1789265690`
	if !hasLine(sb.String(), want) {
		t.Errorf("missing %q in:\n%s", want, sb.String())
	}
}

// The stamp says "a usable measurement arrived". A rollup carrying nothing we
// can read is not one, and must not refresh the clock a staleness gate reads,
// or a browser posting junk every minute would keep a dead gauge looking live.
func TestPerfRollupDoesNotStampWithoutAUsableValue(t *testing.T) {
	m := telemetry.NewMetrics()
	recordPerfRollup(m, "emo", telemetry.Attrs{"tl.echo.p95": "not a number"})
	var sb strings.Builder
	m.Render(&sb)
	if strings.Contains(sb.String(), "tl_echo_latency_updated_timestamp_seconds") {
		t.Fatalf("stamped a rollup that carried nothing usable:\n%s", sb.String())
	}
}

// Whole-line match. A previous test in this repo asserted with
// strings.Contains on "...} 0" and passed against a value of 0.3.
func hasLine(body, want string) bool {
	for _, l := range strings.Split(body, "\n") {
		if strings.TrimRight(l, "\r") == want {
			return true
		}
	}
	return false
}
