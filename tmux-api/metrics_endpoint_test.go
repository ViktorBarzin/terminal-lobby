package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMetricsEndpointReportsLivenessAndBuild(t *testing.T) {
	body := scrape(t)
	for _, want := range []string{
		"tl_build_info{",
		"tl_uptime_seconds ",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %q in:\n%s", want, body)
		}
	}
}

// The point of the endpoint. A scrape that succeeds is itself the liveness
// signal, so the handler must answer even when tmux is unreachable and every
// gauge below is therefore unknown.
func TestMetricsEndpointAnswersEvenWhenTmuxIsUnavailable(t *testing.T) {
	prev := sessionCounter
	sessionCounter = func() map[string]int { return nil }
	defer func() { sessionCounter = prev }()

	rec := httptest.NewRecorder()
	handleMetrics(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d; a scrape must not fail because tmux is down", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "tl_uptime_seconds") {
		t.Error("liveness metrics vanished with the session gauges")
	}
}

func TestMetricsEndpointReportsSessionsPerUser(t *testing.T) {
	prev := sessionCounter
	sessionCounter = func() map[string]int { return map[string]int{"wizard": 33, "emo": 16} }
	defer func() { sessionCounter = prev }()

	body := scrape(t)
	for _, want := range []string{
		`tl_sessions{user="wizard"} 33`,
		`tl_sessions{user="emo"} 16`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %q in:\n%s", want, body)
		}
	}
}

// Session names are user-supplied and unbounded; OS usernames are not. Only
// the second may become a label, which is the same rule the event stream
// follows for Loki.
func TestMetricsEndpointNeverLabelsBySessionName(t *testing.T) {
	prev := sessionCounter
	sessionCounter = func() map[string]int { return map[string]int{"wizard": 2} }
	defer func() { sessionCounter = prev }()

	if body := scrape(t); strings.Contains(body, "session=") {
		t.Fatalf("a session-name label reached the exposition:\n%s", body)
	}
}

func scrape(t *testing.T) string {
	t.Helper()
	rec := httptest.NewRecorder()
	handleMetrics(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	return rec.Body.String()
}
