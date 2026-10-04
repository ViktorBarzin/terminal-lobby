package main

import (
	"strings"
	"testing"

	"terminal-lobby/telemetry"
)

// A first prompt's Send to Accepted, as the composer measured it, reaches
// Prometheus as two counters, so an alert can ask what share of a day's first
// prompts took longer than 2s (docs/plans/2026-10-04-warm-slot-at-send-design.md).

func renderMetrics(m *telemetry.Metrics) string {
	var sb strings.Builder
	m.Render(&sb)
	return sb.String()
}

func TestAFirstPromptIsCountedAndASlowOneTwice(t *testing.T) {
	m := telemetry.NewMetrics()
	recordFirstPrompt(m, "emo", telemetry.Attrs{"tl.ms": 640.0, "tl.slot": "warm"})
	recordFirstPrompt(m, "emo", telemetry.Attrs{"tl.ms": 12948.0, "tl.slot": "booting"})
	got := renderMetrics(m)
	for _, w := range []string{
		`tl_first_prompt_total{slot="warm",user="emo"} 1`,
		`tl_first_prompt_total{slot="booting",user="emo"} 1`,
		`tl_first_prompt_slow_total{slot="booting",user="emo"} 1`,
	} {
		if !strings.Contains(got, w) {
			t.Errorf("missing %q in:\n%s", w, got)
		}
	}
	if strings.Contains(got, `tl_first_prompt_slow_total{slot="warm"`) {
		t.Errorf("a 640ms first prompt was counted slow:\n%s", got)
	}
}

// The browser is not trusted: an unknown slot is one label, not a new series
// per value, and a sample with no usable time writes nothing.
func TestAFirstPromptsAttrsAreBounded(t *testing.T) {
	m := telemetry.NewMetrics()
	recordFirstPrompt(m, "emo", telemetry.Attrs{"tl.ms": 900.0, "tl.slot": "warm\"} 99\nforged"})
	recordFirstPrompt(m, "emo", telemetry.Attrs{"tl.ms": "fast", "tl.slot": "warm"})
	recordFirstPrompt(m, "emo", telemetry.Attrs{"tl.slot": "warm"})
	recordFirstPrompt(m, "", telemetry.Attrs{"tl.ms": 900.0, "tl.slot": "warm"})
	got := renderMetrics(m)
	if !strings.Contains(got, `tl_first_prompt_total{slot="unknown",user="emo"} 1`) || strings.Count(got, "tl_first_prompt_total{") != 1 {
		t.Fatalf("want exactly one unknown-slot sample:\n%s", got)
	}
}

// A tab hidden after Send can stretch the browser's share of the time by
// however long the phone kept it in the background, which says nothing about
// the lobby.
func TestAFirstPromptFromAHiddenTabIsNotCounted(t *testing.T) {
	m := telemetry.NewMetrics()
	recordFirstPrompt(m, "emo", telemetry.Attrs{"tl.ms": 30000.0, "tl.slot": "warm", "tl.hidden": true})
	if got := renderMetrics(m); strings.Contains(got, "tl_first_prompt") {
		t.Fatalf("a hidden tab's sample was counted:\n%s", got)
	}
}

func TestPromptAcceptedIsInTheCatalog(t *testing.T) {
	if !telemetry.IsKnown("prompt.accepted") {
		t.Fatal("prompt.accepted is not in the event catalog, so the intake drops it")
	}
}
