package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"terminal-lobby/sessionio"
	"terminal-lobby/telemetry"
)

// answerMux serves POST /answer the way main() does, as the caller "wizard".
func answerMux(rg *registry) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /answer/{session}", handleAnswer(rg))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mux.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), osUserKey, "wizard")))
	})
}

func postAnswer(t *testing.T, h http.Handler, session, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/answer/"+session, strings.NewReader(body)))
	return rec
}

func decodeAnswer(t *testing.T, rec *httptest.ResponseRecorder) sessionio.AnswerResponse {
	t.Helper()
	var resp sessionio.AnswerResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("not an AnswerResponse (%v): %s", err, rec.Body.String())
	}
	return resp
}

func TestAnswerRefusesASessionWithNoMod(t *testing.T) {
	sink := captureEvents(t)
	rg, _ := newTestRegistry(t, "wizard/demo")
	rec := postAnswer(t, answerMux(rg), "demo", `{"plan":{"option":1,"label":"Yes"}}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if got := sink.only(t, "text.answer_failed"); got["tl.reason"] != answerNoSession {
		t.Fatalf("recorded %v", got)
	}
}

func TestAnswerBoundsTheBody(t *testing.T) {
	rg, _ := newTestRegistry(t, "wizard/demo")
	rec := postAnswer(t, answerMux(rg), "demo", `{"chat":"`+strings.Repeat("x", answerBodyLimit)+`"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestAnswerGoesToTheModAndIsRecorded(t *testing.T) {
	sink := captureEvents(t)
	rg, _ := newTestRegistry(t, "wizard/demo")
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	c := rg.mods.conn("wizard", "demo")
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModPlanEvent, ToolID: "toolu_p", Plan: "do it"}})
	// The mod: take each command and ack it.
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			case <-time.After(time.Millisecond):
			}
			c.mu.Lock()
			cmds := c.cmds
			c.cmds = nil
			c.mu.Unlock()
			for _, cmd := range cmds {
				c.deliver(cmd.ID, modAck{OK: true})
			}
		}
	}()
	rec := postAnswer(t, answerMux(rg), "demo", `{"plan":{"option":1,"label":"Yes, approve the plan"}}`)
	close(stop)
	wg.Wait()
	if resp := decodeAnswer(t, rec); !resp.Applied || !resp.Done {
		t.Fatalf("resp = %+v", resp)
	}
	if got := sink.only(t, "text.answer_sent"); got["tl.action"] != sessionio.ActionPlanApprove {
		t.Fatalf("recorded %v", got)
	}
	sink.only(t, "claude.answered")
}

// eventSink collects the telemetry lines a test emits.
type eventSink struct {
	mu    sync.Mutex
	lines []string
}

func (s *eventSink) Write(line string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lines = append(s.lines, line)
}

func (s *eventSink) snapshot() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.lines...)
}

// captureEvents points the package's emitter at a sink for the test.
func captureEvents(t *testing.T) *eventSink {
	t.Helper()
	sink := &eventSink{}
	old := events
	events = telemetry.New("session-events", buildID, sink)
	t.Cleanup(func() { events = old })
	return sink
}

type recorded struct {
	Name  string         `json:"event.name"`
	Attrs map[string]any `json:"attrs"`
}

func (s *eventSink) all(t *testing.T) []recorded {
	t.Helper()
	lines := s.snapshot()
	out := make([]recorded, 0, len(lines))
	for _, line := range lines {
		var rec recorded
		raw := strings.TrimPrefix(line, telemetry.Marker+" ")
		if err := json.Unmarshal([]byte(raw), &rec); err != nil {
			t.Fatalf("the event is not JSON (%v): %s", err, line)
		}
		out = append(out, rec)
	}
	return out
}

func (s *eventSink) names(t *testing.T) []string {
	t.Helper()
	var out []string
	for _, rec := range s.all(t) {
		out = append(out, rec.Name)
	}
	return out
}

func (s *eventSink) only(t *testing.T, name string) map[string]any {
	t.Helper()
	var found []recorded
	for _, rec := range s.all(t) {
		if rec.Name == name {
			found = append(found, rec)
		}
	}
	if len(found) != 1 {
		t.Fatalf("want exactly one %s, got %d: %v", name, len(found), s.names(t))
	}
	return found[0].Attrs
}
