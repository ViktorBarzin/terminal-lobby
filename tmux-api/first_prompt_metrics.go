package main

// First prompts into Prometheus
// (docs/plans/2026-10-04-warm-slot-at-send-design.md).
//
// The New-session composer times its first prompt from the Send press to
// Accepted on the browser's clock and sends it as prompt.accepted. Counting
// every sample and the ones over firstPromptSlowMs lets an alert ask what share
// of a day's first prompts were slow: more than 10% is a daily p90 over 2s.
// Counters rather than a histogram because the existing buckets jump from 1s to
// 2.5s, and the question is about 2s exactly.

import "terminal-lobby/telemetry"

// firstPromptSlowMs is the target: Send to Accepted under 2s.
const firstPromptSlowMs = 2000

// firstPromptSlots is the closed set of slot outcomes the composer reports.
// Anything else is "unknown", so a client cannot mint series.
var firstPromptSlots = map[string]bool{
	"warm": true, "booting": true, "stale": true, "none": true, "unknown": true,
}

func recordFirstPrompt(m *telemetry.Metrics, osUser string, attrs telemetry.Attrs) {
	if osUser == "" {
		return
	}
	ms, ok := attrs["tl.ms"].(float64)
	if !ok || ms < 0 {
		return
	}
	if hidden, _ := attrs["tl.hidden"].(bool); hidden {
		return
	}
	slot, _ := attrs["tl.slot"].(string)
	if !firstPromptSlots[slot] {
		slot = "unknown"
	}
	labels := map[string]string{"user": osUser, "slot": slot}
	m.AddCounter("tl_first_prompt_total", labels)
	if ms > firstPromptSlowMs {
		m.AddCounter("tl_first_prompt_slow_total", labels)
	}
}
