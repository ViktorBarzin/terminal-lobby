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

// /clear's own rows are the first the new transcript holds, but the mod sends
// them on the old conversation's link, so the new conversation's history comes
// empty and names no row (measured 2026-10-11, mod 0.6.0 on 2.1.296). Its log
// is replayed from the file, so the /clear a device is still standing in for
// arrives, and the turn its record opened is settled by its receipt.
func TestEmptyHistoryReplaysAFreshConversation(t *testing.T) {
	rg, _ := newTestRegistry(t, "wizard/demo")
	p := sessionio.TranscriptPath(sessionio.ProjectsRoot(rg.homeBase, "wizard"), "/w", "sid2")
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		t.Fatal(err)
	}
	// The file exists before the hello, but the /clear rows land in the
	// next 100 ms batch, after it (measured live: created 08:53:25.128,
	// hello 25.205, rows 25.229).
	if err := os.WriteFile(p, []byte(`{"type":"mode","mode":"normal"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	go func() {
		time.Sleep(150 * time.Millisecond)
		f, err := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
		if err != nil {
			t.Error(err)
			return
		}
		defer f.Close()
		f.WriteString(strings.Join([]string{
			`{"type":"user","uuid":"k1","isMeta":true,"timestamp":"2026-10-11T07:38:50.199Z","message":{"role":"user","content":"<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>"}}`,
			`{"type":"user","uuid":"n1","timestamp":"2026-10-11T07:38:50.293Z","message":{"role":"user","content":"<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>"}}`,
			`{"type":"system","uuid":"o1","subtype":"local_command","timestamp":"2026-10-11T07:38:50.320Z","content":"<local-command-stdout></local-command-stdout>"}`,
		}, "\n") + "\n")
	}()
	rg.mods.hello("wizard", modHello{SID: "sid2", Session: "demo", Pane: "%3", CWD: "/w", Transcript: p, Model: "claude-opus-5-5"})
	c := rg.mods.conn("wizard", "demo")
	fs, _ := rg.source("wizard", "demo")
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModHistoryEvent}})

	if got := userBodies(fs); got != "/clear" {
		t.Errorf("prompts = %q, want the /clear the device sent", got)
	}
	if fs.TurnOpen() {
		t.Error("the /clear turn is still open")
	}
}

// A brand-new session has no transcript until its first row is stored, and
// its empty log must not wait for one.
func TestEmptyHistoryWithNoTranscriptDoesNotWait(t *testing.T) {
	rg, _ := newTestRegistry(t, "wizard/demo")
	p := sessionio.TranscriptPath(sessionio.ProjectsRoot(rg.homeBase, "wizard"), "/w", "sid3")
	rg.mods.hello("wizard", modHello{SID: "sid3", Session: "demo", Pane: "%3", CWD: "/w", Transcript: p, Model: "claude-opus-5-5"})
	c := rg.mods.conn("wizard", "demo")
	start := time.Now()
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModHistoryEvent}})
	if d := time.Since(start); d > time.Second {
		t.Errorf("an empty history with no transcript took %v to rebuild", d)
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
