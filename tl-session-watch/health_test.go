package main

import (
	"strings"
	"testing"
	"time"
)

// The deploy-time check probes this, so it has to fail when the watcher is up
// but no longer looking. A process that answers 200 while wedged is the failure
// t3-watchdog was built for, and the reason SessionWatchSilent exists at all.
func TestHealthStatus(t *testing.T) {
	now := time.Date(2026, 9, 1, 18, 0, 0, 0, time.UTC)
	interval := 30 * time.Second

	cases := []struct {
		name     string
		lastTick time.Time
		want     int
	}{
		{"just ticked", now, 200},
		{"one interval ago", now.Add(-30 * time.Second), 200},
		{"two intervals ago", now.Add(-60 * time.Second), 200},
		{"past three intervals", now.Add(-91 * time.Second), 503},
		{"minutes stale", now.Add(-10 * time.Minute), 503},
		{"never ticked", time.Time{}, 503},
	}
	for _, c := range cases {
		got, _ := healthStatus(c.lastTick, now, interval)
		if got != c.want {
			t.Errorf("%s: want %d, got %d", c.name, c.want, got)
		}
	}
}

func TestHealthBodySaysWhenAndHowMany(t *testing.T) {
	now := time.Date(2026, 9, 1, 18, 0, 0, 0, time.UTC)
	_, body := healthStatus(now, now, 30*time.Second)
	if !strings.Contains(body, "2026-09-01T18:00:00Z") {
		t.Errorf("want the last tick time in the body, got %q", body)
	}
}
