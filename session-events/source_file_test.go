package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestFileSourceTailsTranscriptAndAssignsMonotonicIDs(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	os.WriteFile(p, []byte(`{"type":"assistant","message":{"content":[{"type":"text","text":"one"}]}}`+"\n"), 0o644)

	fs := newFileSource("demo", p, time.Millisecond)
	fs.tailOnce() // pick up the initial line

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
	fs.tailOnce()

	got = fs.Replay(2) // resume after the permission event
	if len(got) != 1 || got[0].Body != "two" || got[0].ID != 3 {
		t.Fatalf("resume from 2: %+v", got)
	}
}

func TestFileSourceSubscribeReceivesLive(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	os.WriteFile(p, []byte(""), 0o644)
	fs := newFileSource("demo", p, time.Millisecond)

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
