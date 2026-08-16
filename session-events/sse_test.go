package main

import (
	"bufio"
	"context"
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
