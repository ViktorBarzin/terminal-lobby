package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"terminal-lobby/sessionio"
)

// A transcript with the conversation's first prompt before a /compact. The
// mod's own history after that compaction starts at the summary.
func compactedTranscript(t *testing.T, rg *registry) string {
	t.Helper()
	lines := []string{
		`{"type":"user","uuid":"u1","timestamp":"2026-10-05T10:00:00Z","message":{"role":"user","content":"first"}}`,
		`{"type":"assistant","uuid":"a1","timestamp":"2026-10-05T10:00:01Z","message":{"id":"m1","role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"one"}]}}`,
		`{"type":"user","uuid":"c1","isCompactSummary":true,"timestamp":"2026-10-05T10:00:02Z","message":{"role":"user","content":"This session is being continued from a previous conversation."}}`,
		`{"type":"user","uuid":"u2","timestamp":"2026-10-05T10:00:03Z","message":{"role":"user","content":"second"}}`,
		`{"type":"assistant","uuid":"a2","timestamp":"2026-10-05T10:00:04Z","message":{"id":"m2","role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"two"}]}}`,
	}
	p := sessionio.TranscriptPath(sessionio.ProjectsRoot(rg.homeBase, "wizard"), "/w", "sid1")
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

// What the mod's history holds for that transcript: from the summary on.
func historyAfterCompaction(last string) []sessionio.ModEvent {
	return []sessionio.ModEvent{
		{Type: sessionio.ModHistoryEvent, More: true, Messages: []sessionio.ModHistoryMessage{
			{Role: "user", Text: "This session is being continued from a previous conversation."}}},
		{Type: sessionio.ModHistoryEvent, Last: last, Messages: []sessionio.ModHistoryMessage{
			{Role: "user", Text: "second"}, {Role: "assistant", Text: "two"}}},
	}
}

func userBodies(fs *sessionio.FileSource) string {
	var out []string
	for _, e := range fs.Replay(0) {
		if e.Kind == sessionio.KindUser {
			out = append(out, e.Body)
		}
	}
	return strings.Join(out, "|")
}

func TestHistoryRebuild(t *testing.T) {
	defer func(w time.Duration) { replayWait = w }(replayWait)
	replayWait = 200 * time.Millisecond
	for _, tc := range []struct {
		name, last string
		want       string
	}{
		{"a barrier the transcript holds replays the whole conversation", "a2", "first|second"},
		{"no barrier, from a mod before 0.4.0, keeps the mod's history", "",
			"This session is being continued from a previous conversation.|second"},
		{"a barrier the file never reaches falls back to the mod's history", "nope",
			"This session is being continued from a previous conversation.|second"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rg, _ := newTestRegistry(t, "wizard/demo")
			rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3", CWD: "/w", Transcript: compactedTranscript(t, rg), Model: "claude-opus-5-5"})
			c := rg.mods.conn("wizard", "demo")
			fs, _ := rg.source("wizard", "demo")
			if n := len(fs.Replay(0)); n != 0 {
				t.Fatalf("%d events before the history; a reader holding them would be handed the rebuild as a gap", n)
			}
			c.apply(historyAfterCompaction(tc.last))
			if got := userBodies(fs); got != tc.want {
				t.Fatalf("prompts = %q, want %q", got, tc.want)
			}
			// The mod resends a batch whose POST outlived its fetch cap.
			c.apply(historyAfterCompaction(tc.last))
			if got := userBodies(fs); got != tc.want {
				t.Fatalf("after a resent history, prompts = %q", got)
			}
			model := false
			for _, e := range fs.Replay(0) {
				if e.Kind == sessionio.KindMeta && e.Meta == sessionio.MetaModel {
					model = true
				}
			}
			if !model {
				t.Error("the hello's model never reached the log")
			}
		})
	}
}
