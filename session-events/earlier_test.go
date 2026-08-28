package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"terminal-lobby/sessionio"
)

type fakeHistory struct {
	budget int
	before int64
	turns  int
	events []sessionio.Event
	cursor int64
}

func (f *fakeHistory) Backfill(before int64, budget int) sessionio.Backfill {
	f.before, f.budget = before, budget
	return sessionio.Backfill{Events: f.events, Cursor: f.cursor}
}

func (f *fakeHistory) Earlier(before int64, turns int) []sessionio.Event {
	f.before, f.turns = before, turns
	return f.events
}

func get(t *testing.T, h *fakeHistory, target string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	writeEarlier(rec, httptest.NewRequest("GET", target, nil), h)
	return rec
}

// A client asking in bytes gets the cursor it needs to take the NEXT step. It
// cannot derive that from the events: a split turn's prompt rides along from
// below the cursor, so the oldest event held is not where the next step starts.
func TestEarlierInBytesReturnsEventsAndACursor(t *testing.T) {
	h := &fakeHistory{
		events: []sessionio.Event{{ID: 7, Kind: sessionio.KindUser}, {ID: 9, Kind: sessionio.KindText}},
		cursor: 5,
	}
	rec := get(t, h, "/earlier/demo?before=12&bytes=65536")
	if h.before != 12 || h.budget != 65536 {
		t.Fatalf("asked for before=%d budget=%d", h.before, h.budget)
	}
	var got struct {
		Events []sessionio.Event `json:"events"`
		Cursor int64             `json:"cursor"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("body is not the new shape: %v\n%s", err, rec.Body.String())
	}
	if len(got.Events) != 2 || got.Cursor != 5 {
		t.Fatalf("events=%d cursor=%d", len(got.Events), got.Cursor)
	}
}

// No caller may ask for an unbounded body, however large a number it sends.
func TestEarlierClampsTheBudget(t *testing.T) {
	h := &fakeHistory{}
	get(t, h, "/earlier/demo?before=12&bytes=99999999")
	if h.budget != MaxResponseBytes {
		t.Fatalf("budget = %d, want the %d cap", h.budget, MaxResponseBytes)
	}
	get(t, h, "/earlier/demo?before=12&bytes=0")
	if h.budget != MaxResponseBytes {
		t.Fatalf("a zero budget should fall back to the cap, got %d", h.budget)
	}
	get(t, h, "/earlier/demo?before=12&bytes=-4")
	if h.budget != MaxResponseBytes {
		t.Fatalf("a negative budget should fall back to the cap, got %d", h.budget)
	}
}

// The bundle deployed before 2026-08-28 asks without `bytes` and unpacks a bare
// array. It keeps that until it is reloaded.
func TestEarlierWithoutBytesKeepsTheLegacyArray(t *testing.T) {
	h := &fakeHistory{events: []sessionio.Event{{ID: 3, Kind: sessionio.KindText}}}
	rec := get(t, h, "/earlier/demo?before=12")
	if h.turns != OpenWindowTurns {
		t.Fatalf("legacy call asked for turns=%d", h.turns)
	}
	body := strings.TrimSpace(rec.Body.String())
	if !strings.HasPrefix(body, "[") {
		t.Fatalf("legacy response is not a bare array: %s", body)
	}
}

// `before` names the oldest event held; without it there is nothing to page
// back from and the request is malformed rather than "from the start".
func TestEarlierRejectsAMissingBefore(t *testing.T) {
	if code := get(t, &fakeHistory{}, "/earlier/demo").Code; code != 400 {
		t.Fatalf("missing before gave %d", code)
	}
	if code := get(t, &fakeHistory{}, "/earlier/demo?before=0&bytes=100").Code; code != 400 {
		t.Fatalf("before=0 gave %d", code)
	}
}
