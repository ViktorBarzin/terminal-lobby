package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"terminal-lobby/sessionio"
)

// fakeSource is a controllable Source for the SSE test.
type fakeSource struct {
	all         []sessionio.Event
	live        chan sessionio.Event
	windowTurns int
	windowFrom  int64

	backfillBudget int
	backfillBefore int64
	statePrompts   int
	cursor         int64
	head           int64
	epoch          string
}

func (f *fakeSource) Head() (int64, string) { return f.head, f.epoch }

// windowTurns records what writeSSE asked for, so a test can prove a fresh open
// is windowed and a resume is not.
func (f *fakeSource) ReplayWindow(from int64, turns int) []sessionio.Event {
	f.windowTurns = turns
	f.windowFrom = from
	return f.Replay(from)
}

func (f *fakeSource) Replay(from int64) []sessionio.Event {
	var out []sessionio.Event
	for _, e := range f.all {
		if e.ID > from {
			out = append(out, e)
		}
	}
	return out
}
func (f *fakeSource) Subscribe() (<-chan sessionio.Event, func()) { return f.live, func() {} }

// backfillBudget records what writeSSE asked for, so a test can prove a fresh
// open is bounded in bytes and a resume is not backfilled at all.
func (f *fakeSource) Backfill(before int64, budget int) sessionio.Backfill {
	f.backfillBudget, f.backfillBefore = budget, before
	var out []sessionio.Event
	for _, e := range f.all {
		if before == 0 || e.ID < before {
			out = append(out, e)
		}
	}
	return sessionio.Backfill{Events: out, Cursor: f.cursor}
}

func (f *fakeSource) State(maxPrompts int) sessionio.SessionState {
	f.statePrompts = maxPrompts
	return sessionio.SessionState{At: 42, Mode: "bypassPermissions", Queue: []string{"waiting"}, Prompts: []string{"hello"}}
}

func TestWriteSSEReplaysFromCursorHeartbeatsAndTailsLive(t *testing.T) {
	src := &fakeSource{
		all:  []sessionio.Event{{ID: 1, Kind: sessionio.KindText, Body: "old"}, {ID: 3, Kind: sessionio.KindText, Body: "a"}, {ID: 4, Kind: sessionio.KindText, Body: "b"}},
		live: make(chan sessionio.Event, 1),
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeSSE(w, r, src, nil, 30*time.Millisecond)
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL, nil)
	req.Header.Set("Last-sessionio.Event-ID", "2") // resume: expect only id>2
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content-type = %q", ct)
	}

	lines := make(chan string, 64)
	go func() {
		sc := bufio.NewScanner(resp.Body)
		for sc.Scan() {
			lines <- sc.Text()
		}
		close(lines)
	}()

	want := func(pred func(string) bool, what string) {
		t.Helper()
		to := time.After(2 * time.Second)
		for {
			select {
			case l, ok := <-lines:
				if !ok {
					t.Fatalf("stream closed before seeing %s", what)
				}
				if pred(l) {
					return
				}
			case <-to:
				t.Fatalf("timeout waiting for %s", what)
			}
		}
	}

	// Replay: id 3 and 4 (not the old id-1), each framed as id:/data:.
	want(func(l string) bool { return l == "id: 3" }, "replay id 3")
	want(func(l string) bool { return strings.Contains(l, `"body":"a"`) }, "replay data a")
	want(func(l string) bool { return l == "id: 4" }, "replay id 4")

	// Live tail.
	src.live <- sessionio.Event{ID: 5, Kind: sessionio.KindText, Body: "live"}
	want(func(l string) bool { return l == "id: 5" }, "live id 5")
	want(func(l string) bool { return strings.Contains(l, `"body":"live"`) }, "live data")

	// The heartbeat appears, as a head frame.
	want(func(l string) bool { return l == "event: head" }, "heartbeat")
}

// A fresh open is windowed; a resume asks for everything after its cursor, or
// the client silently loses the gap it reconnected to collect.
func TestSSEWindowsAFreshOpenButNotAResume(t *testing.T) {
	src := &fakeSource{all: []sessionio.Event{{ID: 1, Kind: sessionio.KindText}}, live: make(chan sessionio.Event)}
	r := httptest.NewRequest("GET", "/events/demo", nil)
	w := httptest.NewRecorder()
	close(src.live)
	writeSSE(w, r, src, nil, time.Hour)
	if src.windowTurns != OpenWindowTurns || src.windowFrom != 0 {
		t.Fatalf("fresh open asked for turns=%d from=%d", src.windowTurns, src.windowFrom)
	}

	src2 := &fakeSource{all: src.all, live: make(chan sessionio.Event)}
	close(src2.live)
	r2 := httptest.NewRequest("GET", "/events/demo", nil)
	r2.Header.Set("Last-Event-ID", "7")
	writeSSE(httptest.NewRecorder(), r2, src2, nil, time.Hour)
	if src2.windowFrom != 7 {
		t.Fatalf("resume cursor lost: from=%d", src2.windowFrom)
	}
}

// The opening window ends with a marker, so a client can paint once from a
// complete window instead of rebuilding a partial one as the rest arrives.
//
// A NAMED event: it reaches a listener rather than the message handler, so it
// never enters the client's event array and nothing downstream has to learn to
// ignore it.
func TestWriteSSEMarksTheEndOfTheOpeningWindow(t *testing.T) {
	src := &fakeSource{all: []sessionio.Event{
		{ID: 1, Kind: sessionio.KindUser, Body: "hello"},
		{ID: 2, Kind: sessionio.KindText, Body: "hi"},
	}}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/events/s", nil)
	ctx, cancel := context.WithCancel(req.Context())
	req = req.WithContext(ctx)
	cancel() // return after the replay
	writeSSE(rec, req, src, nil, time.Hour)

	body := rec.Body.String()
	if !strings.Contains(body, "event: ready\ndata: 2\n\n") {
		t.Errorf("no ready marker naming the last replayed id:\n%s", body)
	}
	// It has to come AFTER the window it is marking the end of.
	if strings.Index(body, "event: ready") < strings.LastIndex(body, `"id":2`) {
		t.Errorf("the marker precedes the window it closes:\n%s", body)
	}
}

// ---- the reverse open (2026-08-28) -----------------------------------------

// read drives writeSSE to completion against a request whose context is already
// cancelled, so the whole opening exchange is in the recorder and nothing tails.
func read(t *testing.T, src Source, target string) string {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", target, nil)
	ctx, cancel := context.WithCancel(req.Context())
	cancel()
	writeSSE(rec, req.WithContext(ctx), src, nil, time.Hour)
	return rec.Body.String()
}

// The point of the whole change: the newest event is the first thing on the
// wire, so first paint stops depending on how much history follows it.
func TestSSEReverseOpenSendsStateThenNewestFirst(t *testing.T) {
	src := &fakeSource{all: []sessionio.Event{
		{ID: 1, Kind: sessionio.KindUser, Body: "one"},
		{ID: 2, Kind: sessionio.KindText, Body: "two"},
		{ID: 3, Kind: sessionio.KindText, Body: "three"},
	}, cursor: 0}
	body := read(t, src, "/events/demo?rev=1")

	if src.backfillBudget != OpenBackfillBytes || src.backfillBefore != 0 {
		t.Fatalf("fresh open asked for budget=%d before=%d", src.backfillBudget, src.backfillBefore)
	}
	if src.statePrompts != StatePrompts {
		t.Fatalf("state asked for %d prompts", src.statePrompts)
	}
	// The state frame leads: the composer is usable before any row exists.
	if !strings.HasPrefix(body, "event: state\n") {
		t.Fatalf("state frame does not lead:\n%s", body)
	}
	if !strings.Contains(body, `"mode":"bypassPermissions"`) {
		t.Fatalf("state frame lost its payload:\n%s", body)
	}
	// Backfill frames, newest first.
	three, two, one := strings.Index(body, `"body":"three"`), strings.Index(body, `"body":"two"`), strings.Index(body, `"body":"one"`)
	if three < 0 || two < 0 || one < 0 {
		t.Fatalf("not every event arrived:\n%s", body)
	}
	if !(three < two && two < one) {
		t.Fatalf("backfill is not newest-first (three=%d two=%d one=%d):\n%s", three, two, one, body)
	}
	if n := strings.Count(body, "event: back\n"); n != 3 {
		t.Fatalf("want 3 backfill frames, got %d:\n%s", n, body)
	}
	// ready closes the backfill and carries the cursor for the next step back.
	ready := strings.Index(body, "event: ready")
	if ready < one {
		t.Fatalf("ready precedes the backfill it closes:\n%s", body)
	}
	if !strings.Contains(body[ready:], `"cursor":0`) {
		t.Fatalf("ready did not carry a cursor:\n%s", body[ready:])
	}
}

// Backfill frames must not set the SSE id: field. The browser would take the
// OLDEST of them as Last-Event-ID and a reconnect would resume from history the
// client already holds, replaying the whole session forward.
func TestSSEBackfillFramesCarryNoEventID(t *testing.T) {
	src := &fakeSource{all: []sessionio.Event{
		{ID: 1, Kind: sessionio.KindText, Body: "one"},
		{ID: 2, Kind: sessionio.KindText, Body: "two"},
	}}
	body := read(t, src, "/events/demo?rev=1")
	if i := strings.Index(body, "\nid: "); i >= 0 {
		t.Fatalf("a backfill frame set an SSE id:\n%s", body)
	}
	if strings.HasPrefix(body, "id: ") {
		t.Fatalf("a backfill frame set an SSE id:\n%s", body)
	}
}

// A reconnecting client holds its history and is asking for the gap. Handing it
// a reverse backfill instead would drop everything it reconnected to collect.
func TestSSEResumeIsNeverBackfilled(t *testing.T) {
	src := &fakeSource{all: []sessionio.Event{
		{ID: 1, Kind: sessionio.KindText, Body: "old"},
		{ID: 9, Kind: sessionio.KindText, Body: "gap"},
	}}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/events/demo?rev=1", nil)
	req.Header.Set("Last-Event-ID", "5")
	ctx, cancel := context.WithCancel(req.Context())
	cancel()
	writeSSE(rec, req.WithContext(ctx), src, nil, time.Hour)
	body := rec.Body.String()

	if strings.Contains(body, "event: back") {
		t.Fatalf("a resume was backfilled:\n%s", body)
	}
	if !strings.Contains(body, "id: 9") || !strings.Contains(body, `"body":"gap"`) {
		t.Fatalf("the gap was not replayed:\n%s", body)
	}
	if strings.Contains(body, `"body":"old"`) {
		t.Fatalf("the resume replayed below its cursor:\n%s", body)
	}
	// The state frame still rides along: a client that was disconnected may have
	// missed a mode change or a queue operation entirely.
	if !strings.HasPrefix(body, "event: state\n") {
		t.Fatalf("a resume got no state frame:\n%s", body)
	}
	// ready must NOT claim a backfill cursor here — the client's own is correct.
	ready := strings.Index(body, "event: ready")
	if ready < 0 || strings.Contains(body[ready:], `"cursor"`) {
		t.Fatalf("a resume's ready carried a cursor:\n%s", body[ready:])
	}
}

// A client on the previously-deployed bundle keeps the contract it was built
// against for as long as it is in the wild.
func TestSSELegacyOpenIsUnchangedWithoutTheFlag(t *testing.T) {
	src := &fakeSource{all: []sessionio.Event{
		{ID: 1, Kind: sessionio.KindUser, Body: "one"},
		{ID: 2, Kind: sessionio.KindText, Body: "two"},
	}}
	body := read(t, src, "/events/demo")
	if strings.Contains(body, "event: back") || strings.Contains(body, "event: state") {
		t.Fatalf("a legacy client was given the new frames:\n%s", body)
	}
	if src.windowTurns != OpenWindowTurns {
		t.Fatalf("legacy open asked for turns=%d", src.windowTurns)
	}
	if one, two := strings.Index(body, `"body":"one"`), strings.Index(body, `"body":"two"`); one > two {
		t.Fatalf("legacy replay is not ascending:\n%s", body)
	}
	if !strings.Contains(body, "event: ready\ndata: 2\n\n") {
		t.Fatalf("legacy ready marker changed shape:\n%s", body)
	}
}

// The live channel is subscribed before the backfill, so an event that landed
// in between must not be delivered twice.
func TestSSEReverseOpenDedupsAgainstTheLiveChannel(t *testing.T) {
	live := make(chan sessionio.Event, 2)
	live <- sessionio.Event{ID: 2, Kind: sessionio.KindText, Body: "two"}
	live <- sessionio.Event{ID: 3, Kind: sessionio.KindText, Body: "three"}
	close(live)
	src := &fakeSource{all: []sessionio.Event{
		{ID: 1, Kind: sessionio.KindText, Body: "one"},
		{ID: 2, Kind: sessionio.KindText, Body: "two"},
	}, live: live}
	rec := httptest.NewRecorder()
	writeSSE(rec, httptest.NewRequest("GET", "/events/demo?rev=1", nil), src, nil, time.Hour)
	body := rec.Body.String()
	if n := strings.Count(body, `"body":"two"`); n != 1 {
		t.Fatalf("event 2 delivered %d times:\n%s", n, body)
	}
	if !strings.Contains(body, "id: 3") {
		t.Fatalf("the live event after the backfill was dropped:\n%s", body)
	}
}

// A slow client asks for a smaller opening window. Twenty turns measured
// 766,661-2,098,703 bytes per open, 99.93% of it arriving inside 0.1s as one
// backlog dump: 42 seconds at 400kbps for the view that is meant to be the one
// that still works on a bad link.
func TestSSEOpenWindowIsClientCappable(t *testing.T) {
	openWith := func(query string) int {
		src := &fakeSource{all: []sessionio.Event{{ID: 1, Kind: sessionio.KindText}}, live: make(chan sessionio.Event)}
		close(src.live)
		r := httptest.NewRequest("GET", "/events/demo"+query, nil)
		writeSSE(httptest.NewRecorder(), r, src, nil, time.Hour)
		return src.windowTurns
	}

	if got := openWith("?turns=3"); got != 3 {
		t.Fatalf("?turns=3 gave a window of %d", got)
	}
	if got := openWith("?turns=1"); got != MinOpenWindowTurns {
		t.Fatalf("the floor is %d, got %d", MinOpenWindowTurns, got)
	}
	// A client can only ask for LESS. More would let one client make the server
	// parse and ship an entire months-old transcript.
	for _, q := range []string{"?turns=9999", "?turns=0", "?turns=-4", "?turns=abc", ""} {
		if got := openWith(q); got != OpenWindowTurns {
			t.Fatalf("%q should fall back to the default %d, got %d", q, OpenWindowTurns, got)
		}
	}
}

// The opening window arrives compressed when the client offers gzip. Measured
// uncompressed opens ran 766,661-2,098,703 bytes with 99.93% of it inside 0.1s;
// gzip -6 over the same content gives 4.8-5.4x. The edge will not do it: the
// Traefik compress middleware leaves text/event-stream out on purpose, and it is
// an entrypoint middleware shared by the whole cluster.
func TestSSECompressesWhenTheClientOffersIt(t *testing.T) {
	events := make([]sessionio.Event, 0, 40)
	for i := 1; i <= 40; i++ {
		events = append(events, sessionio.Event{ID: int64(i), Kind: sessionio.KindText})
	}
	open := func(acceptEncoding string) *httptest.ResponseRecorder {
		src := &fakeSource{all: events, live: make(chan sessionio.Event)}
		close(src.live)
		r := httptest.NewRequest("GET", "/events/demo", nil)
		if acceptEncoding != "" {
			r.Header.Set("Accept-Encoding", acceptEncoding)
		}
		w := httptest.NewRecorder()
		writeSSE(w, r, src, nil, time.Hour)
		return w
	}

	plain := open("")
	if enc := plain.Header().Get("Content-Encoding"); enc != "" {
		t.Fatalf("a client that did not ask for gzip got Content-Encoding %q", enc)
	}

	gzipped := open("gzip, deflate, br")
	if enc := gzipped.Header().Get("Content-Encoding"); enc != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", enc)
	}
	if vary := gzipped.Header().Get("Vary"); !strings.Contains(vary, "Accept-Encoding") {
		t.Fatalf("Vary = %q; a cache must not hand this stream to a client that did not ask", vary)
	}
	if gzipped.Body.Len() >= plain.Body.Len() {
		t.Fatalf("gzipped body %d bytes >= plain %d", gzipped.Body.Len(), plain.Body.Len())
	}

	// It has to be READABLE as it arrives, not only at the end: gzip.Flush emits
	// a sync marker per event, and without it a browser sees nothing until the
	// compressor's buffer fills.
	zr, err := gzip.NewReader(bytes.NewReader(gzipped.Body.Bytes()))
	if err != nil {
		t.Fatalf("gzip reader: %v", err)
	}
	got, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(got) != plain.Body.String() {
		t.Fatalf("decompressed stream differs from the plain one")
	}
	if !strings.Contains(string(got), "event: ready") {
		t.Fatalf("the ready marker did not survive compression")
	}
}

// A resumed stream has to say WHICH log it is resuming.
//
// Ids are per-source and start again at 1 for a new transcript, so a client
// holding id 5,000 that reconnects onto a rebuilt log asks for the gap above
// 5,000 and is answered with nothing — which is exactly what "you are up to
// date" looks like. It then shows the previous conversation for as long as the
// tab stays open. The epoch names the log and the head id says how far it goes,
// so the client can tell the two apart and resync instead of freezing.
func TestResumeReadyNamesTheLogItIsResuming(t *testing.T) {
	src := &fakeSource{
		all:   []sessionio.Event{{ID: 1, Kind: sessionio.KindText, Body: "a"}},
		live:  make(chan sessionio.Event),
		head:  1,
		epoch: "cafebabe",
	}
	body := read(t, src, "/events/demo?rev=1&lastEventId=5000")

	at := strings.Index(body, "event: ready")
	if at < 0 {
		t.Fatalf("no ready frame:\n%s", body)
	}
	if !strings.Contains(body[at:], `"epoch":"cafebabe"`) {
		t.Fatalf("a resume's ready did not name its log:\n%s", body[at:])
	}
	if !strings.Contains(body[at:], `"head":1`) {
		t.Fatalf("a resume's ready did not carry the head id:\n%s", body[at:])
	}
	// The client's own cursor stays authoritative on a resume.
	if strings.Contains(body[at:], `"cursor"`) {
		t.Fatalf("a resume's ready carried a backfill cursor:\n%s", body[at:])
	}
}

// The fresh open carries it too, so the client records which log its history
// belongs to before anything can move underneath it.
func TestFreshOpenReadyNamesTheLog(t *testing.T) {
	src := &fakeSource{
		all:   []sessionio.Event{{ID: 1, Kind: sessionio.KindText, Body: "a"}},
		live:  make(chan sessionio.Event),
		head:  1,
		epoch: "cafebabe",
	}
	body := read(t, src, "/events/demo?rev=1")

	at := strings.Index(body, "event: ready")
	if at < 0 || !strings.Contains(body[at:], `"epoch":"cafebabe"`) {
		t.Fatalf("the opening ready did not name its log:\n%s", body)
	}
}

// movingEpoch is a source whose numbering stops being replayable after the
// stream opened: the first Head is the opening's, every later one the moved
// epoch (sessionio FileSource.Head).
type movingEpoch struct {
	*fakeSource
	calls int
}

func (m *movingEpoch) Head() (int64, string) {
	m.calls++
	if m.calls == 1 {
		return m.head, "cafebabe"
	}
	return m.head, "feedface"
}

// A live-only event moves the source's epoch while a client is reading. The
// client's ids are still this source's, so it adopts the new epoch rather than
// resyncing, and it must hear of the move BEFORE the event that caused it: a
// cache written between the two would label this source's ids with an epoch a
// rebuilt source also reports, which is how a reopen lost an answer, a reply
// and a prompt on 2026-09-27.
func TestSSEAnnouncesAnEpochThatMovesMidStream(t *testing.T) {
	live := make(chan sessionio.Event, 2)
	live <- sessionio.Event{ID: 2, Kind: sessionio.KindMeta, Meta: sessionio.MetaAsking, Body: "{}"}
	live <- sessionio.Event{ID: 3, Kind: sessionio.KindText, Body: "three"}
	close(live)
	src := &movingEpoch{fakeSource: &fakeSource{
		all:  []sessionio.Event{{ID: 1, Kind: sessionio.KindText, Body: "one"}},
		live: live,
		head: 1,
	}}
	rec := httptest.NewRecorder()
	writeSSE(rec, httptest.NewRequest("GET", "/events/demo?rev=1", nil), src, nil, time.Hour)
	body := rec.Body.String()
	frame := "event: epoch\ndata: {\"epoch\":\"feedface\"}\n\n"
	if n := strings.Count(body, frame); n != 1 {
		t.Fatalf("epoch frame sent %d times, want once:\n%s", n, body)
	}
	if strings.Index(body, frame) > strings.Index(body, "id: 2") {
		t.Fatalf("the epoch frame came after the event that moved it:\n%s", body)
	}
}

// A legacy open named no epoch, so there is nothing to re-announce.
func TestSSELegacyOpenAnnouncesNoEpoch(t *testing.T) {
	live := make(chan sessionio.Event, 1)
	live <- sessionio.Event{ID: 2, Kind: sessionio.KindText, Body: "two"}
	close(live)
	src := &movingEpoch{fakeSource: &fakeSource{
		all:  []sessionio.Event{{ID: 1, Kind: sessionio.KindText, Body: "one"}},
		live: live,
	}}
	rec := httptest.NewRecorder()
	writeSSE(rec, httptest.NewRequest("GET", "/events/demo", nil), src, nil, time.Hour)
	if strings.Contains(rec.Body.String(), "event: epoch") {
		t.Fatalf("a legacy client was sent an epoch frame:\n%s", rec.Body.String())
	}
}

// Viktor's iPhone reaches the lobby through Cloudflare when it is off the home
// network, and that was when the Text view stayed blank most often
// (2026-10-03): Traefik handed each stream 26-48 KB that never drew. A proxy
// may buffer a response it means to recompress, and nginx-style proxies buffer
// any proxied response, so a stream says it must reach the reader as written.
func TestSSETellsProxiesNotToHoldTheStream(t *testing.T) {
	for _, enc := range []string{"", "gzip, deflate, br"} {
		src := &fakeSource{live: make(chan sessionio.Event)}
		close(src.live)
		r := httptest.NewRequest("GET", "/events/demo", nil)
		if enc != "" {
			r.Header.Set("Accept-Encoding", enc)
		}
		w := httptest.NewRecorder()
		writeSSE(w, r, src, nil, time.Hour)
		if cc := w.Header().Get("Cache-Control"); !strings.Contains(cc, "no-cache") || !strings.Contains(cc, "no-transform") {
			t.Errorf("Accept-Encoding %q: Cache-Control = %q, want no-cache and no-transform", enc, cc)
		}
		if b := w.Header().Get("X-Accel-Buffering"); b != "no" {
			t.Errorf("Accept-Encoding %q: X-Accel-Buffering = %q, want no", enc, b)
		}
	}
}

// The heartbeat names the newest event the server holds, so a client can tell
// a quiet session from a stream that stopped delivering: if it is still behind
// the head a heartbeat ago, events exist that never reached it (text.stale).
func TestTheHeartbeatCarriesTheHead(t *testing.T) {
	src := &fakeSource{live: make(chan sessionio.Event), head: 7, epoch: "aaaa"}
	ctx, cancel := context.WithCancel(context.Background())
	r := httptest.NewRequest("GET", "/events/demo?rev=1", nil).WithContext(ctx)
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		writeSSE(w, r, src, nil, 5*time.Millisecond)
	}()
	time.Sleep(40 * time.Millisecond)
	cancel()
	<-done
	if body := w.Body.String(); !strings.Contains(body, "event: head\ndata: {\"head\":7}\n\n") {
		t.Fatalf("no head frame in %q", body)
	}
}
