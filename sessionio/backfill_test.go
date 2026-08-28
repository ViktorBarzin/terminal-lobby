package sessionio

import (
	"strings"
	"testing"
	"time"
)

// ---- helpers ---------------------------------------------------------------

// src is an empty in-memory source. Nothing tails it; tests Append directly so
// they control turn ids and payload sizes exactly.
func src() *FileSource { return NewFileSource("demo", "/nonexistent", time.Second) }

// turn appends one settled turn: a prompt, `steps` tool calls of `size` bytes
// each, an answer and a turn_end — the shape the backfill walks over.
func turn(f *FileSource, id string, steps, size int) {
	f.Append(Event{Kind: KindUser, TurnID: id, Body: "prompt " + id})
	for i := 0; i < steps; i++ {
		f.Append(Event{Kind: KindToolUse, TurnID: id, Tool: "Bash", Body: strings.Repeat("x", size)})
		f.Append(Event{Kind: KindToolResult, TurnID: id, Body: strings.Repeat("y", size)})
	}
	f.Append(Event{Kind: KindText, TurnID: id, Body: "answer " + id})
	f.Append(Event{Kind: KindTurnEnd, TurnID: id})
}

func wire(events []Event) int {
	n := 0
	for _, e := range events {
		n += len(e.JSON())
	}
	return n
}

func ascending(t *testing.T, events []Event) {
	t.Helper()
	for i := 1; i < len(events); i++ {
		if events[i-1].ID >= events[i].ID {
			t.Fatalf("events are not ascending at %d: %d then %d", i, events[i-1].ID, events[i].ID)
		}
	}
}

// ---- Backfill --------------------------------------------------------------

// A fresh open must end at the live end: the newest event is the whole point.
func TestBackfillEndsAtTheLiveEnd(t *testing.T) {
	f := src()
	for i := 0; i < 5; i++ {
		turn(f, string(rune('a'+i)), 2, 100)
	}
	all := f.Replay(0)
	b := f.Backfill(0, 1<<20)
	ascending(t, b.Events)
	if len(b.Events) != len(all) {
		t.Fatalf("a budget larger than the log clipped it: %d of %d", len(b.Events), len(all))
	}
	if b.Cursor != 0 {
		t.Fatalf("reaching the start of the log should clear the cursor, got %d", b.Cursor)
	}
	if b.Events[len(b.Events)-1].ID != all[len(all)-1].ID {
		t.Fatal("backfill does not end at the live end")
	}
}

// The budget is the point: a big session must not arrive whole.
func TestBackfillStopsOnTheByteBudget(t *testing.T) {
	f := src()
	for i := 0; i < 20; i++ {
		turn(f, string(rune('a'+i)), 10, 500)
	}
	const budget = 8 << 10
	b := f.Backfill(0, budget)
	ascending(t, b.Events)
	if len(b.Events) == 0 {
		t.Fatal("no events")
	}
	if len(b.Events) >= len(f.Replay(0)) {
		t.Fatal("the budget did not clip anything")
	}
	// The walk stops as soon as the budget is met, so the carried bytes may
	// overshoot by at most the last event plus the split turn's prompt.
	if got := wire(b.Events); got > budget*2 {
		t.Fatalf("carried %d bytes against a %d-byte budget", got, budget)
	}
	if b.Cursor == 0 {
		t.Fatal("history remains, so the cursor must point at the next step back")
	}
}

// A budget smaller than one event still has to produce something to render.
func TestBackfillAlwaysCarriesAtLeastOneEvent(t *testing.T) {
	f := src()
	turn(f, "a", 1, 4096)
	if b := f.Backfill(0, 1); len(b.Events) == 0 {
		t.Fatal("a one-byte budget returned nothing at all")
	}
}

// A turn may be split across steps — but never so that an answer arrives with
// no question above it.
func TestBackfillCarriesTheSplitTurnsPrompt(t *testing.T) {
	f := src()
	turn(f, "old", 1, 10)
	turn(f, "big", 40, 500)
	b := f.Backfill(0, 4<<10)
	ascending(t, b.Events)
	var prompt, split bool
	for _, e := range b.Events {
		if e.TurnID != "big" {
			continue
		}
		if e.Kind == KindUser {
			prompt = true
		}
	}
	// It really is a split: the walk did not reach the whole turn.
	whole := 0
	for _, e := range f.Replay(0) {
		if e.TurnID == "big" {
			whole++
		}
	}
	split = len(b.Events) < whole
	if !split {
		t.Fatalf("fixture did not split the turn: %d of %d events", len(b.Events), whole)
	}
	if !prompt {
		t.Fatal("the split turn's prompt did not ride along")
	}
	if b.Events[0].Kind != KindUser {
		t.Fatalf("the prompt must lead the backfill, got %s", b.Events[0].Kind)
	}
}

// Paging with the returned cursor has to cover the log without leaving a hole.
func TestBackfillCursorPagesBackWithoutGaps(t *testing.T) {
	f := src()
	for i := 0; i < 12; i++ {
		turn(f, string(rune('a'+i)), 6, 300)
	}
	seen := map[int64]bool{}
	cursor := int64(0)
	for step := 0; ; step++ {
		if step > 200 {
			t.Fatal("paging did not terminate")
		}
		b := f.Backfill(cursor, 4<<10)
		if len(b.Events) == 0 {
			t.Fatal("a step returned nothing while history remained")
		}
		for _, e := range b.Events {
			seen[e.ID] = true
		}
		if b.Cursor == 0 {
			break
		}
		if cursor != 0 && b.Cursor >= cursor {
			t.Fatalf("cursor did not move back: %d then %d", cursor, b.Cursor)
		}
		cursor = b.Cursor
	}
	for _, e := range f.Replay(0) {
		if !seen[e.ID] {
			t.Fatalf("event %d (%s) was never delivered by paging", e.ID, e.Kind)
		}
	}
}

// `before` is exclusive — a step back must not re-deliver the event it was
// given, or the client's dedup is doing work the server should not create.
func TestBackfillBeforeIsExclusive(t *testing.T) {
	f := src()
	for i := 0; i < 6; i++ {
		turn(f, string(rune('a'+i)), 2, 100)
	}
	all := f.Replay(0)
	mid := all[len(all)/2].ID
	for _, e := range f.Backfill(mid, 1<<20).Events {
		if e.ID >= mid {
			t.Fatalf("event %d is not before %d", e.ID, mid)
		}
	}
}

func TestBackfillOnAnEmptyLog(t *testing.T) {
	b := src().Backfill(0, 1<<20)
	if len(b.Events) != 0 || b.Cursor != 0 {
		t.Fatalf("empty log gave %d events, cursor %d", len(b.Events), b.Cursor)
	}
}

// ---- State -----------------------------------------------------------------

// The mode is session state, and the client can no longer scan for it: at a
// 100 KB backfill the meta that carries it is usually outside the window.
func TestStateCarriesTheNewestPermissionMode(t *testing.T) {
	f := src()
	f.Append(Event{Kind: KindMeta, Meta: MetaPermissionMode, Body: "default"})
	for i := 0; i < 30; i++ {
		turn(f, string(rune('a'+i%26)), 4, 400)
	}
	f.Append(Event{Kind: KindMeta, Meta: MetaPermissionMode, Body: "bypassPermissions"})
	turn(f, "last", 1, 10)
	if got := f.State(20).Mode; got != "bypassPermissions" {
		t.Fatalf("mode = %q", got)
	}
}

func TestStateCarriesTheNewestContextReading(t *testing.T) {
	f := src()
	f.Append(Event{Kind: KindMeta, Meta: MetaContext, Context: &ContextReading{UsedTokens: 1000, MaxTokens: 200000}})
	turn(f, "a", 1, 10)
	f.Append(Event{Kind: KindMeta, Meta: MetaContext, Context: &ContextReading{UsedTokens: 65200, MaxTokens: 1000000}})
	turn(f, "b", 1, 10)
	turn(f, "c", 1, 10)
	st := f.State(20)
	if st.Context == nil || st.Context.UsedTokens != 65200 {
		t.Fatalf("context = %+v", st.Context)
	}
	// Two turns have settled since the reading was taken.
	if st.ContextTurnsAgo != 2 {
		t.Fatalf("turnsAgo = %d, want 2", st.ContextTurnsAgo)
	}
}

// The queue is the case a window gets WRONG rather than merely incomplete: a
// dequeue whose enqueue fell outside it shifts the wrong head.
func TestStateFoldsTheQueueOverTheWholeLog(t *testing.T) {
	f := src()
	f.Append(Event{Kind: KindMeta, Meta: MetaQueued, Body: "first"})
	f.Append(Event{Kind: KindMeta, Meta: MetaQueued, Body: "second"})
	for i := 0; i < 30; i++ {
		turn(f, string(rune('a'+i%26)), 4, 400)
	}
	f.Append(Event{Kind: KindMeta, Meta: MetaDequeued})
	f.Append(Event{Kind: KindMeta, Meta: MetaQueued, Body: "third"})
	st := f.State(20)
	if len(st.Queue) != 2 || st.Queue[0] != "second" || st.Queue[1] != "third" {
		t.Fatalf("queue = %#v", st.Queue)
	}
}

func TestStateQueueHonoursUnqueueAndClear(t *testing.T) {
	f := src()
	f.Append(Event{Kind: KindMeta, Meta: MetaQueued, Body: "a"})
	f.Append(Event{Kind: KindMeta, Meta: MetaQueued, Body: "b"})
	f.Append(Event{Kind: KindMeta, Meta: MetaUnqueued, Body: "a"})
	if got := f.State(20).Queue; len(got) != 1 || got[0] != "b" {
		t.Fatalf("after unqueue: %#v", got)
	}
	f.Append(Event{Kind: KindMeta, Meta: MetaQueueCleared})
	if got := f.State(20).Queue; len(got) != 0 {
		t.Fatalf("after clear: %#v", got)
	}
}

// The composer's history is the other thing a small window would shorten.
func TestStateCarriesTheLastNPrompts(t *testing.T) {
	f := src()
	for i := 0; i < 30; i++ {
		f.Append(Event{Kind: KindUser, TurnID: "t", Body: "prompt " + string(rune('a'+i%26))})
	}
	f.Append(Event{Kind: KindUser, TurnID: "t", Body: "last"})
	f.Append(Event{Kind: KindUser, TurnID: "t", Body: "last"}) // consecutive repeat
	st := f.State(20)
	if len(st.Prompts) != 20 {
		t.Fatalf("want 20 prompts, got %d", len(st.Prompts))
	}
	if st.Prompts[len(st.Prompts)-1] != "last" {
		t.Fatalf("history must end at the newest prompt, got %q", st.Prompts[len(st.Prompts)-1])
	}
	for i := 1; i < len(st.Prompts); i++ {
		if st.Prompts[i] == st.Prompts[i-1] {
			t.Fatalf("consecutive repeat survived at %d: %q", i, st.Prompts[i])
		}
	}
}

// The frame is a snapshot: the client folds only what happened after it.
func TestStateAtIsTheNewestEventID(t *testing.T) {
	f := src()
	turn(f, "a", 2, 10)
	all := f.Replay(0)
	if got := f.State(20).At; got != all[len(all)-1].ID {
		t.Fatalf("at = %d, want %d", got, all[len(all)-1].ID)
	}
}
