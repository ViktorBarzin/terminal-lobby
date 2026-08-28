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
}

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

func TestWriteSSEReplaysFromCursorHeartbeatsAndTailsLive(t *testing.T) {
	src := &fakeSource{
		all:  []sessionio.Event{{ID: 1, Kind: sessionio.KindText, Body: "old"}, {ID: 3, Kind: sessionio.KindText, Body: "a"}, {ID: 4, Kind: sessionio.KindText, Body: "b"}},
		live: make(chan sessionio.Event, 1),
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeSSE(w, r, src, 30*time.Millisecond)
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

	// Heartbeat comment appears.
	want(func(l string) bool { return strings.HasPrefix(l, ":") }, "heartbeat comment")
}

// A fresh open is windowed; a resume asks for everything after its cursor, or
// the client silently loses the gap it reconnected to collect.
func TestSSEWindowsAFreshOpenButNotAResume(t *testing.T) {
	src := &fakeSource{all: []sessionio.Event{{ID: 1, Kind: sessionio.KindText}}, live: make(chan sessionio.Event)}
	r := httptest.NewRequest("GET", "/events/demo", nil)
	w := httptest.NewRecorder()
	close(src.live)
	writeSSE(w, r, src, time.Hour)
	if src.windowTurns != OpenWindowTurns || src.windowFrom != 0 {
		t.Fatalf("fresh open asked for turns=%d from=%d", src.windowTurns, src.windowFrom)
	}

	src2 := &fakeSource{all: src.all, live: make(chan sessionio.Event)}
	close(src2.live)
	r2 := httptest.NewRequest("GET", "/events/demo", nil)
	r2.Header.Set("Last-Event-ID", "7")
	writeSSE(httptest.NewRecorder(), r2, src2, time.Hour)
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
	writeSSE(rec, req, src, time.Hour)

	body := rec.Body.String()
	if !strings.Contains(body, "event: ready\ndata: 2\n\n") {
		t.Errorf("no ready marker naming the last replayed id:\n%s", body)
	}
	// It has to come AFTER the window it is marking the end of.
	if strings.Index(body, "event: ready") < strings.LastIndex(body, `"id":2`) {
		t.Errorf("the marker precedes the window it closes:\n%s", body)
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
		writeSSE(httptest.NewRecorder(), r, src, time.Hour)
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
		writeSSE(w, r, src, time.Hour)
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
