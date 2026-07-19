package main

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTranscriptPathSlug(t *testing.T) {
	got := transcriptPath("/home/wizard/.claude/projects", "/home/wizard/code/terminal-lobby", "abc-123")
	want := "/home/wizard/.claude/projects/-home-wizard-code-terminal-lobby/abc-123.jsonl"
	if got != want {
		t.Fatalf("transcriptPath =\n %s\nwant %s", got, want)
	}
}

func TestSessionStartHandlerPopulatesMap(t *testing.T) {
	sm := newSessionMap("/root")
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/hooks/session-start",
		strings.NewReader(`{"session_id":"s1","cwd":"/home/wizard/x","tmux_session":"demo"}`))
	sessionStartHandler(sm)(w, r)
	if w.Code != 204 {
		t.Fatalf("want 204, got %d (%s)", w.Code, w.Body.String())
	}
	info, ok := sm.get("demo")
	if !ok {
		t.Fatal("session 'demo' not registered")
	}
	if info.ClaudeID != "s1" || info.Transcript != "/root/-home-wizard-x/s1.jsonl" {
		t.Fatalf("info = %+v", info)
	}
}

func TestSessionStartRejectsIncomplete(t *testing.T) {
	sm := newSessionMap("/root")
	w := httptest.NewRecorder()
	sessionStartHandler(sm)(w, httptest.NewRequest("POST", "/x", strings.NewReader(`{"cwd":"/x"}`)))
	if w.Code != 400 {
		t.Fatalf("want 400 for missing ids, got %d", w.Code)
	}
}
