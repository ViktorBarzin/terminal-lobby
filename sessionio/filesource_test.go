package sessionio

import (
	"os"
	"path/filepath"
	"strings"
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

// ---- windowed open + the payload a window leaves behind ---------------------

// feed pushes n turns of (prompt, tool call, answer) through a source's
// normalizer, the way the tail would.
func feed(f *FileSource, turns int) {
	for i := 0; i < turns; i++ {
		f.normMu.Lock()
		for _, e := range f.norm.Line([]byte(`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"prompt"}]}}`)) {
			f.Append(e)
		}
		for _, e := range f.norm.Line([]byte(`{"type":"assistant","message":{"role":"assistant","id":"m","stop_reason":"end_turn","content":[{"type":"text","text":"answer"}]}}`)) {
			f.Append(e)
		}
		f.normMu.Unlock()
	}
}

func TestReplayWindowOpensOnTheRecentTurnsOnly(t *testing.T) {
	f := NewFileSource("demo", "/nonexistent", time.Second)
	feed(f, 30)

	full := f.Replay(0)
	win := f.ReplayWindow(0, 5)
	if len(win) >= len(full) {
		t.Fatalf("a window of 5 turns should be shorter than all 30: %d vs %d", len(win), len(full))
	}
	turns := map[string]bool{}
	for _, e := range win {
		if e.TurnID != "" {
			turns[e.TurnID] = true
		}
	}
	if len(turns) != 5 {
		t.Fatalf("want 5 turns in the window, got %d", len(turns))
	}
	// The window is a SUFFIX: the newest event must be in it, or the view opens
	// on history instead of on now.
	if win[len(win)-1].ID != full[len(full)-1].ID {
		t.Fatalf("window does not end at the live end: %d vs %d", win[len(win)-1].ID, full[len(full)-1].ID)
	}
	// Whole turns only — a window must not begin midway through one.
	if win[0].Kind != KindUser {
		t.Fatalf("window starts mid-turn, at %s", win[0].Kind)
	}
}

func TestReplayWindowIsIgnoredWhenResuming(t *testing.T) {
	f := NewFileSource("demo", "/nonexistent", time.Second)
	feed(f, 30)
	// A reconnecting client asks from a cursor; it already has the history, and
	// clipping its resume to a window would silently lose the gap.
	from := f.Replay(0)[10].ID
	if got, want := len(f.ReplayWindow(from, 2)), len(f.Replay(from)); got != want {
		t.Fatalf("resume was windowed: %d events, want %d", got, want)
	}
}

func TestReplayWindowLargerThanTheSessionReturnsEverything(t *testing.T) {
	f := NewFileSource("demo", "/nonexistent", time.Second)
	feed(f, 3)
	if got, want := len(f.ReplayWindow(0, 20)), len(f.Replay(0)); got != want {
		t.Fatalf("short session was clipped: %d vs %d", got, want)
	}
}

func TestEarlierWalksBackOneWindowAtATime(t *testing.T) {
	f := NewFileSource("demo", "/nonexistent", time.Second)
	feed(f, 30)
	win := f.ReplayWindow(0, 5)
	earlier := f.Earlier(win[0].ID, 5)
	if len(earlier) == 0 {
		t.Fatal("no earlier events")
	}
	if last := earlier[len(earlier)-1]; last.ID >= win[0].ID {
		t.Fatalf("earlier overlaps the window it precedes: %d >= %d", last.ID, win[0].ID)
	}
	turns := map[string]bool{}
	for _, e := range earlier {
		turns[e.TurnID] = true
	}
	if len(turns) != 5 {
		t.Fatalf("want 5 earlier turns, got %d", len(turns))
	}
	if f.Earlier(f.Replay(0)[0].ID, 5) != nil {
		t.Fatal("there is nothing before the first event")
	}
}

func TestFullResultReadsThePayloadBackOffDisk(t *testing.T) {
	big := strings.Repeat("y", MaxInlineResult*2)
	dir := t.TempDir()
	path := filepath.Join(dir, "t.jsonl")
	lines := []string{
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_1","name":"Bash","input":{}}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","content":"` + big + `"}]},"toolUseResult":{"stdout":"` + big + `"}}`,
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	f := NewFileSource("demo", path, time.Second)
	f.TailOnce()

	body, result, err := f.FullResult("tu_1")
	if err != nil {
		t.Fatalf("FullResult: %v", err)
	}
	if len(body) != len(big) {
		t.Fatalf("body came back capped: %d bytes, want %d", len(body), len(big))
	}
	if len(result) == 0 {
		t.Fatal("structured result not returned")
	}
	if _, _, err := f.FullResult("tu_missing"); err == nil {
		t.Fatal("an unknown tool id must be an error, not an empty success")
	}
}

// Retiring a source has to END the streams reading it. A source is retired when
// the tmux name it is keyed by starts pointing at a different transcript — a new
// Claude in the same window, or a stamp corrected after the fact — and a reader
// that stays subscribed to the retired one simply stops receiving anything: the
// transcript it holds freezes at whatever was on screen, including a dialog that
// has since been answered. Closing the channel ends the SSE response, which is
// what makes the browser reconnect and land on the live source.
func TestFileSourceCloseEndsLiveSubscriptions(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	os.WriteFile(p, []byte(""), 0o644)
	fs := NewFileSource("demo", p, time.Millisecond)

	ch, cancel := fs.Subscribe()
	defer cancel() // must stay safe after Close — no double close
	if n := fs.Subscribers(); n != 1 {
		t.Fatalf("subscribers = %d, want 1", n)
	}
	fs.Close()

	select {
	case _, open := <-ch:
		if open {
			t.Fatal("subscription delivered an event instead of closing")
		}
	case <-time.After(time.Second):
		t.Fatal("Close left the subscription open — the reader freezes on a retired source")
	}
	if n := fs.Subscribers(); n != 0 {
		t.Fatalf("subscribers after close = %d, want 0", n)
	}
}

// Head is what lets a client tell "nothing new" from "not the log you were
// reading". Ids are per-source and start again at 1 for a new transcript, so a
// client holding id 5,000 asks for the gap above it and a rebuilt log — which
// tops out at, say, 340 — has nothing to answer with. Silence and "you are up to
// date" look identical on the wire; the epoch and the head id are what separate
// them.
func TestFileSourceHeadReportsTheNewestIDAndAStableEpoch(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "s.jsonl")
	os.WriteFile(p, []byte(`{"type":"assistant","message":{"content":[{"type":"text","text":"one"}]}}`+"\n"), 0o644)

	fs := NewFileSource("demo", p, time.Millisecond)
	id, epoch := fs.Head()
	if id != 0 || epoch == "" {
		t.Fatalf("empty log: head = (%d, %q), want (0, non-empty)", id, epoch)
	}
	fs.TailOnce()
	if id, _ := fs.Head(); id != 1 {
		t.Fatalf("head after one event = %d, want 1", id)
	}

	// The same transcript read by a NEW source — every deploy does this — keeps
	// the epoch, so a restart costs no client a resync.
	again := NewFileSource("demo", p, time.Millisecond)
	if _, e2 := again.Head(); e2 != epoch {
		t.Fatalf("epoch moved across a restart: %q -> %q", epoch, e2)
	}
	// A different transcript is a different log, and says so.
	other := NewFileSource("demo", filepath.Join(dir, "t.jsonl"), time.Millisecond)
	if _, e3 := other.Head(); e3 == epoch {
		t.Fatalf("two transcripts share epoch %q", e3)
	}
}

// The pane watcher appends at most one event per CHANGE: a dialog that sits on
// screen for two minutes must not put a hundred events in the log.
func TestFileSourceAskingAppendsOnlyOnChange(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	os.WriteFile(p, []byte(""), 0o644)
	fs := NewFileSource("demo", p, time.Millisecond)

	if !fs.SetAsking(`{"count":1}`) {
		t.Fatal("the first reading was not recorded")
	}
	if fs.SetAsking(`{"count":1}`) {
		t.Fatal("an unchanged reading was recorded again")
	}
	if !fs.SetAsking("") {
		t.Fatal("the dialog going away was not recorded")
	}
	if fs.SetAsking("") {
		t.Fatal("still-no-dialog was recorded")
	}

	got := fs.Replay(0)
	if len(got) != 2 {
		t.Fatalf("events = %+v, want one per change", got)
	}
	for _, e := range got {
		if e.Kind != KindMeta || e.Meta != MetaAsking {
			t.Fatalf("event = %+v", e)
		}
	}
	if got[0].Body != `{"count":1}` || got[1].Body != "" {
		t.Fatalf("bodies = %q, %q", got[0].Body, got[1].Body)
	}
}

// A source with no reader attached is not worth a tmux round trip, and one
// whose turn has settled cannot be sitting on a dialog.
func TestFileSourceWorthWatchingOnlyWhileReadAndWorking(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	os.WriteFile(p, []byte(""), 0o644)
	fs := NewFileSource("demo", p, time.Millisecond)

	fs.Append(Event{Kind: KindUser, Body: "go"})
	if fs.WorthWatching() {
		t.Fatal("a source nobody is reading is being polled")
	}
	ch, cancel := fs.Subscribe()
	defer cancel()
	go func() {
		for range ch {
		}
	}()
	if !fs.WorthWatching() {
		t.Fatal("a watched session mid-turn is not being polled")
	}
	fs.Append(Event{Kind: KindTurnEnd})
	if fs.WorthWatching() {
		t.Fatal("a settled turn is still being polled")
	}
}
