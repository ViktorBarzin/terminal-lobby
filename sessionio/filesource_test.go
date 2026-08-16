package sessionio

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestFileSourceTailsTranscriptAndAssignsMonotonicIDs(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	os.WriteFile(p, []byte(`{"type":"assistant","message":{"content":[{"type":"text","text":"one"}]}}`+"\n"), 0o644)

	fs := NewFileSource("demo", p, time.Millisecond)
	fs.TailOnce() // pick up the initial line

	got := fs.Replay(0)
	if len(got) != 1 || got[0].Kind != KindText || got[0].Body != "one" || got[0].ID != 1 {
		t.Fatalf("after first tail: %+v", got)
	}

	// A permission event shares the same ID space.
	fs.Append(Event{Kind: KindPermissionRequest, ReqID: "perm-1"})
	got = fs.Replay(0)
	if len(got) != 2 || got[1].Kind != KindPermissionRequest || got[1].ID != 2 {
		t.Fatalf("after append: %+v", got)
	}

	// Append a new transcript line; tail picks it up with the next ID.
	f, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0o644)
	f.WriteString(`{"type":"assistant","message":{"content":[{"type":"text","text":"two"}]}}` + "\n")
	f.Close()
	fs.TailOnce()

	got = fs.Replay(2) // resume after the permission event
	if len(got) != 1 || got[0].Body != "two" || got[0].ID != 3 {
		t.Fatalf("resume from 2: %+v", got)
	}
}

func TestFileSourceSubscribeReceivesLive(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	os.WriteFile(p, []byte(""), 0o644)
	fs := NewFileSource("demo", p, time.Millisecond)

	ch, cancel := fs.Subscribe()
	defer cancel()
	fs.Append(Event{Kind: KindText, Body: "live"})

	select {
	case e := <-ch:
		if e.Kind != KindText || e.Body != "live" || e.ID != 1 {
			t.Fatalf("live event = %+v", e)
		}
	case <-time.After(time.Second):
		t.Fatal("no live event received")
	}
}

// The cancel path settles the turn on the stream: an interrupt that never
// reaches the transcript has no other way to reach the renderer, and a
// subscriber already connected must see it without reconnecting.
func TestFileSourceInterruptSettlesTheTurnOnTheStream(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	os.WriteFile(p, []byte(`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"count to 400"}]},"timestamp":"2026-08-06T10:00:00Z"}`+"\n"), 0o644)

	fs := NewFileSource("demo", p, time.Millisecond)
	fs.TailOnce()
	got := fs.Replay(0)
	if len(got) != 1 || got[0].Kind != KindUser {
		t.Fatalf("after tail: %+v", got)
	}

	ch, cancel := fs.Subscribe()
	defer cancel()
	fs.Interrupt(1786053601000)

	select {
	case e := <-ch:
		if e.Kind != KindTurnEnd {
			t.Fatalf("live event = %+v, want a %v", e, KindTurnEnd)
		}
		if e.TurnID != got[0].TurnID {
			t.Fatalf("turn_end closes %q, want the open turn %q", e.TurnID, got[0].TurnID)
		}
		if e.ID != 2 || e.Session != "demo" {
			t.Fatalf("injected event = %+v, want id 2 in the session's own ID space", e)
		}
	case <-time.After(time.Second):
		t.Fatal("the interrupt never reached the stream — the composer stays on Stop")
	}

	// It is part of the log, so a reconnecting client replays it too.
	if last := fs.Replay(0); len(last) != 2 || last[1].Kind != KindTurnEnd {
		t.Fatalf("replay = %+v, want the settle event recorded", last)
	}
}

// Cancelling an idle session must not append anything.
func TestFileSourceInterruptOnASettledTurnAppendsNothing(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	os.WriteFile(p, []byte(
		`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]},"timestamp":"2026-08-06T10:00:00Z"}`+"\n"+
			`{"type":"assistant","message":{"id":"m1","role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"hello"}]},"timestamp":"2026-08-06T10:00:01Z"}`+"\n"), 0o644)

	fs := NewFileSource("demo", p, time.Millisecond)
	fs.TailOnce()
	before := len(fs.Replay(0))
	fs.Interrupt(1786053601000)
	if after := len(fs.Replay(0)); after != before {
		t.Fatalf("interrupt on a settled turn appended %d events", after-before)
	}
}
