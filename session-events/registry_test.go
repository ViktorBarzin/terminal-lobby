package main

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRegistrySourceRequiresSessionStart(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rg := newRegistry(ctx, time.Millisecond, "/root")

	if _, ok := rg.source("wizard", "demo"); ok {
		t.Fatal("unregistered session must not resolve")
	}

	w := httptest.NewRecorder()
	rg.handleSessionStart()(w, httptest.NewRequest("POST", "/hooks/session-start",
		strings.NewReader(`{"user":"wizard","session_id":"s1","cwd":"/home/wizard/x","tmux_session":"demo"}`)))
	if w.Code != 204 {
		t.Fatalf("session-start: want 204, got %d (%s)", w.Code, w.Body.String())
	}

	fs, ok := rg.source("wizard", "demo")
	if !ok || fs == nil {
		t.Fatal("session should resolve after SessionStart")
	}
	if fs.path != "/root/wizard/.claude/projects/-home-wizard-x/s1.jsonl" {
		t.Fatalf("transcript path = %q", fs.path)
	}
}

func TestRegistryMissingSessionStartFields(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rg := newRegistry(ctx, time.Millisecond, "/root")
	w := httptest.NewRecorder()
	rg.handleSessionStart()(w, httptest.NewRequest("POST", "/x", strings.NewReader(`{"user":"wizard"}`)))
	if w.Code != 400 {
		t.Fatalf("missing fields: want 400, got %d", w.Code)
	}
}
