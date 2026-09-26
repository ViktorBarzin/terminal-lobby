package main

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"terminal-lobby/sessionio"
)

// fakeFeed is a controllable agentFeed: a test publishes a set and every
// subscriber is signalled, the way agentWatch signals after each scan.
type fakeFeed struct {
	mu   sync.Mutex
	set  sessionio.AgentSet
	ver  uint64
	ok   bool
	subs []chan struct{}
}

func (f *fakeFeed) Current() (sessionio.AgentSet, uint64, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.set, f.ver, f.ok
}

func (f *fakeFeed) Subscribe() (<-chan struct{}, func()) {
	f.mu.Lock()
	defer f.mu.Unlock()
	ch := make(chan struct{}, 1)
	f.subs = append(f.subs, ch)
	return ch, func() {}
}

func (f *fakeFeed) subscribers() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.subs)
}

// publish replaces the set with one agent described as desc.
func (f *fakeFeed) publish(desc string) {
	f.mu.Lock()
	f.ver++
	f.ok = true
	f.set = sessionio.AgentSet{Agents: []sessionio.AgentInfo{{ID: "a1", Description: desc, State: sessionio.AgentRunning}}}
	f.mu.Unlock()
	f.poke()
}

// poke signals every subscriber without changing anything: a scan that found
// nothing new.
func (f *fakeFeed) poke() {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, ch := range f.subs {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

func warmFeed(desc string) *fakeFeed {
	f := &fakeFeed{}
	f.publish(desc)
	return f
}

// readAgents is read() with an agent feed on the stream.
func readAgents(t *testing.T, src Source, feed agentFeed, target string) string {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", target, nil)
	ctx, cancel := context.WithCancel(req.Context())
	cancel()
	writeSSE(rec, req.WithContext(ctx), src, feed, time.Hour)
	return rec.Body.String()
}

// The contract: once on every open and resume, right after the state frame, so
// the panel is drawn with the composer rather than after the history. The at
// it carries is the server clock when it was written, which is what the client
// measures its own clock's skew against.
func TestSSESendsAgentsRightAfterState(t *testing.T) {
	for _, tc := range []struct{ name, target string }{
		{"a fresh reverse open", "/events/demo?rev=1"},
		{"a resume", "/events/demo?rev=1&lastEventId=1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			src := &fakeSource{all: []sessionio.Event{
				{ID: 1, Kind: sessionio.KindText, Body: "one"},
				{ID: 2, Kind: sessionio.KindText, Body: "two"},
			}}
			before := time.Now().UnixMilli()
			body := readAgents(t, src, warmFeed("look around"), tc.target)

			if !strings.HasPrefix(body, "event: state\n") {
				t.Fatalf("state does not lead:\n%s", body)
			}
			afterState := strings.Index(body, "\n\n") + 2
			rest := body[afterState:]
			if !strings.HasPrefix(rest, "event: agents\ndata: ") {
				t.Fatalf("the frame after state is not agents:\n%s", body)
			}
			if n := strings.Count(body, "event: agents\n"); n != 1 {
				t.Fatalf("%d agents frames on the opening exchange, want 1:\n%s", n, body)
			}
			data := strings.SplitN(strings.TrimPrefix(rest, "event: agents\ndata: "), "\n", 2)[0]
			var set sessionio.AgentSet
			if err := json.Unmarshal([]byte(data), &set); err != nil {
				t.Fatalf("agents payload %q: %v", data, err)
			}
			if len(set.Agents) != 1 || set.Agents[0].Description != "look around" {
				t.Fatalf("agents payload = %+v", set)
			}
			if set.At < before || set.At > time.Now().UnixMilli() {
				t.Fatalf("at = %d, want the time the frame was written (%d..now)", set.At, before)
			}
			if !strings.Contains(data, `"workflows":[]`) {
				t.Fatalf("an empty workflow list must be [], not null: %s", data)
			}
		})
	}
}

// The bundle built before the reverse open has no state frame to follow and no
// agent panel to feed, so its stream is left exactly as it was.
func TestSSELegacyOpenCarriesNoAgents(t *testing.T) {
	feed := warmFeed("look around")
	body := readAgents(t, &fakeSource{all: []sessionio.Event{{ID: 1, Kind: sessionio.KindText}}}, feed, "/events/demo")
	if strings.Contains(body, "event: agents") {
		t.Fatalf("a legacy open was sent agents:\n%s", body)
	}
	if n := feed.subscribers(); n != 0 {
		t.Fatalf("a legacy open subscribed to the agent feed %d times", n)
	}
}

// agentFrame is one agents frame as a client saw it arrive.
type agentFrame struct {
	at   time.Time
	desc string
}

// streamAgents opens a live reverse-open stream and reports every agents frame
// as it arrives, and when the opening exchange closed.
func streamAgents(t *testing.T, feed agentFeed) (<-chan agentFrame, <-chan struct{}) {
	t.Helper()
	src := &fakeSource{all: []sessionio.Event{{ID: 1, Kind: sessionio.KindText, Body: "one"}}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeSSE(w, r, src, feed, time.Hour)
	}))
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() {
		cancel()
		srv.Close()
	})
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/events/demo?rev=1", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })

	frames, ready := make(chan agentFrame, 16), make(chan struct{})
	go func() {
		sc := bufio.NewScanner(resp.Body)
		named := ""
		for sc.Scan() {
			line := sc.Text()
			switch {
			case strings.HasPrefix(line, "event: "):
				named = strings.TrimPrefix(line, "event: ")
				if named == "ready" {
					close(ready)
				}
			case named == "agents" && strings.HasPrefix(line, "data: "):
				var set sessionio.AgentSet
				if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &set) == nil && len(set.Agents) > 0 {
					frames <- agentFrame{time.Now(), set.Agents[0].Description}
				}
			case line == "":
				named = ""
			}
		}
	}()
	return frames, ready
}

func nextFrame(t *testing.T, frames <-chan agentFrame, within time.Duration) agentFrame {
	t.Helper()
	select {
	case f := <-frames:
		return f
	case <-time.After(within):
		t.Fatalf("no agents frame within %s", within)
		return agentFrame{}
	}
}

func noFrame(t *testing.T, frames <-chan agentFrame, within time.Duration) {
	t.Helper()
	select {
	case f := <-frames:
		t.Fatalf("an agents frame arrived that should not have: %+v", f)
	case <-time.After(within):
	}
}

// State, history and ready never wait on agent files. A watcher still on its
// first read has nothing to offer, so the stream opens without it, and the
// first set goes out the moment there is one: after ready, and unpaced.
func TestSSESendsAColdFeedsFirstFrameWhenItArrives(t *testing.T) {
	feed := &fakeFeed{}
	frames, ready := streamAgents(t, feed)
	select {
	case <-ready:
	case <-time.After(2 * time.Second):
		t.Fatal("the opening exchange waited on the agent feed")
	}
	noFrame(t, frames, 50*time.Millisecond)

	published := time.Now()
	feed.publish("first read done")
	f := nextFrame(t, frames, time.Second)
	if f.desc != "first read done" {
		t.Fatalf("frame = %+v", f)
	}
	if lag := f.at.Sub(published); lag > 500*time.Millisecond {
		t.Fatalf("the first frame was held back %s; it should never wait", lag)
	}
}

// Again on change, at most one frame per second per stream, and never when
// nothing changed. A burst inside one second goes out as its last state.
func TestSSEPacesAgentFrames(t *testing.T) {
	feed := warmFeed("v1")
	frames, _ := streamAgents(t, feed)
	first := nextFrame(t, frames, 2*time.Second)
	if first.desc != "v1" {
		t.Fatalf("opening frame = %+v", first)
	}

	for range 3 {
		feed.poke() // scans that found nothing new
	}
	noFrame(t, frames, 100*time.Millisecond)

	feed.publish("v2")
	second := nextFrame(t, frames, 2*time.Second)
	if second.desc != "v2" {
		t.Fatalf("second frame = %+v", second)
	}
	if gap := second.at.Sub(first.at); gap < AgentFrameEvery-100*time.Millisecond {
		t.Fatalf("two frames %s apart; at most one per %s", gap, AgentFrameEvery)
	}

	feed.publish("v3")
	feed.publish("v4")
	third := nextFrame(t, frames, 2*time.Second)
	if third.desc != "v4" {
		t.Fatalf("a burst went out as %q, want its last state v4", third.desc)
	}
	noFrame(t, frames, 200*time.Millisecond)
}

func TestAgentPacer(t *testing.T) {
	t0 := time.Unix(1000, 0)
	for _, tc := range []struct {
		name     string
		sent     bool
		sentVer  uint64
		ok       bool
		ver      uint64
		since    time.Duration
		wantSend bool
		wantWait time.Duration
	}{
		{"nothing to send yet", false, 0, false, 0, 0, false, 0},
		{"the first set goes at once", false, 0, true, 3, 0, true, 0},
		{"unchanged is never sent", true, 3, true, 3, time.Hour, false, 0},
		{"a change a second later goes", true, 3, true, 4, AgentFrameEvery, true, 0},
		{"a change inside the second waits out the rest", true, 3, true, 4, 300 * time.Millisecond, false, 700 * time.Millisecond},
		{"a stale set is not sent", true, 3, false, 4, time.Hour, false, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var p agentPacer
			if tc.sent {
				p.mark(tc.sentVer, t0)
			}
			send, wait := p.due(tc.ok, tc.ver, t0.Add(tc.since))
			if send != tc.wantSend || wait != tc.wantWait {
				t.Fatalf("due = %v, %s; want %v, %s", send, wait, tc.wantSend, tc.wantWait)
			}
		})
	}
}
