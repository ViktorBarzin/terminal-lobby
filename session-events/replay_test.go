package main

import (
	"os"
	"path/filepath"
	"strconv"
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
	return historyAfterCompactionRunning(last, false)
}

func historyAfterCompactionRunning(last string, running bool) []sessionio.ModEvent {
	return []sessionio.ModEvent{
		{Type: sessionio.ModHistoryEvent, More: true, Messages: []sessionio.ModHistoryMessage{
			{Role: "user", Text: "This session is being continued from a previous conversation."}}},
		{Type: sessionio.ModHistoryEvent, Last: last, Running: running, Messages: []sessionio.ModHistoryMessage{
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
		running    bool
		want       string
	}{
		{"a barrier the transcript holds replays the whole conversation", "a2", false, "first|second"},
		// A Claude resumed and not prompted since names no row, and the mod's
		// history has no timestamps (2026-11-03).
		{"no barrier from an idle Claude replays the whole file", "", false, "first|second"},
		{"no barrier while a turn runs keeps the mod's history", "", true,
			"This session is being continued from a previous conversation.|second"},
		{"a barrier the file never reaches falls back to the mod's history", "nope", false,
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
			c.apply(historyAfterCompactionRunning(tc.last, tc.running))
			if got := userBodies(fs); got != tc.want {
				t.Fatalf("prompts = %q, want %q", got, tc.want)
			}
			// The mod resends a batch whose POST outlived its fetch cap.
			c.apply(historyAfterCompactionRunning(tc.last, tc.running))
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

// The engine never hands the mod the rows a /compact writes after its own
// record (2.1.296), so the turn that record opened is settled from the
// transcript once the mod reports the compaction over.
func TestCompactionEdgeCatchesUpFromTheTranscript(t *testing.T) {
	defer func(r, c time.Duration) { replayWait, compactWait = r, c }(replayWait, compactWait)
	replayWait, compactWait = 200*time.Millisecond, time.Second
	rg, _ := newTestRegistry(t, "wizard/demo")
	p := compactedTranscript(t, rg)
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3", CWD: "/w", Transcript: p, Model: "claude-opus-5-5"})
	c := rg.mods.conn("wizard", "demo")
	fs, _ := rg.source("wizard", "demo")
	c.apply(historyAfterCompaction("a2"))

	f, err := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.WriteString(strings.Join([]string{
		`{"type":"user","uuid":"c9","timestamp":"2026-10-05T10:01:00Z","message":{"role":"user","content":"/compact"}}`,
		`{"type":"system","uuid":"b9","subtype":"compact_boundary","timestamp":"2026-10-05T10:01:08Z","content":"Conversation compacted"}`,
		`{"type":"user","uuid":"s9","isCompactSummary":true,"timestamp":"2026-10-05T10:01:08Z","message":{"role":"user","content":"This session is being continued from a previous conversation."}}`,
		`{"type":"user","uuid":"o9","timestamp":"2026-10-05T10:01:09Z","message":{"role":"user","content":"<local-command-stdout>Compacted</local-command-stdout>"}}`,
	}, "\n") + "\n")
	f.Close()
	if err != nil {
		t.Fatal(err)
	}

	c.apply([]sessionio.ModEvent{{Type: sessionio.ModRowEvent, UUID: "c9", Door: "prompt",
		Message: &sessionio.ModMessage{Type: "user", Role: "user", Content: []byte(`[{"type":"text","text":"/compact"}]`)}}})
	if !fs.TurnOpen() {
		t.Fatal("the /compact row opened no turn")
	}
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModLevelEvent, Compacting: true}})
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModLevelEvent}})

	deadline := time.Now().Add(2 * time.Second)
	for fs.TurnOpen() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if fs.TurnOpen() {
		t.Fatal("the /compact turn is still open after the compaction ended")
	}
	var marker, receipt bool
	for _, e := range fs.Replay(0) {
		marker = marker || (e.Kind == sessionio.KindMeta && e.Meta == sessionio.MetaCompact && e.TurnID != "t1")
		receipt = receipt || (e.Kind == sessionio.KindState && e.Body == "Compacted")
	}
	if !marker || !receipt {
		t.Errorf("compaction marker %v, receipt %v; want both", marker, receipt)
	}
}

// A restart leaves @last_prompt as the last process wrote it, or unset on a
// session that predates it. The rebuilt log knows when the person last wrote,
// so the rebuild stamps it (2026-11-03).
func TestARebuildStampsTheLastPrompt(t *testing.T) {
	defer func(w time.Duration) { replayWait = w }(replayWait)
	replayWait = 200 * time.Millisecond
	rg, opts := writableRegistry(t, nil)
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3", CWD: "/w", Transcript: compactedTranscript(t, rg), Model: "claude-opus-5-5"})
	c := rg.mods.conn("wizard", "demo")
	c.apply(historyAfterCompaction("a2"))
	want := strconv.FormatInt(time.Date(2026, 10, 5, 10, 0, 3, 0, time.UTC).Unix(), 10)
	if got, _ := opts.Option("wizard", "demo", sessionio.OptionLastPrompt); got != want {
		t.Fatalf("@last_prompt = %q, want %s (the second prompt)", got, want)
	}
	// A log rebuilt from the mod's untimed history leaves it alone.
	rg2, opts2 := writableRegistry(t, map[string]string{sessionio.OptionLastPrompt: "1790000000"})
	rg2.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3", CWD: "/w", Model: "claude-opus-5-5"})
	rg2.mods.conn("wizard", "demo").apply(historyAfterCompactionRunning("", true))
	if got, _ := opts2.Option("wizard", "demo", sessionio.OptionLastPrompt); got != "1790000000" {
		t.Fatalf("an untimed rebuild moved @last_prompt to %q", got)
	}
}
