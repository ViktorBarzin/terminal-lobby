package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPermissionRequestHookResponseShapeFallThrough(t *testing.T) {
	b := NewPermissionBroker(func(string) bool { return false }, func(Event) {}, time.Second)
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/hooks/permission-request",
		strings.NewReader(`{"session":"demo","tool_name":"Bash","tool_input":{"command":"ls"}}`))
	permissionRequestHandler(b)(w, r)

	var m map[string]map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatalf("resp not json: %s", w.Body.String())
	}
	if m["hookSpecificOutput"]["hookEventName"] != "PreToolUse" {
		t.Fatalf("hookEventName wrong: %s", w.Body.String())
	}
	if m["hookSpecificOutput"]["permissionDecision"] != "ask" { // no subscriber → ask
		t.Fatalf("permissionDecision wrong: %s", w.Body.String())
	}
}

func TestPermissionResolveHandlerViaMux(t *testing.T) {
	b := NewPermissionBroker(func(string) bool { return true }, func(Event) {}, time.Second)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /permission/{id}", permissionResolveHandler(b))

	// unknown id → 404
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("POST", "/permission/nope", strings.NewReader(`{"decision":"allow"}`)))
	if w.Code != http.StatusNotFound {
		t.Fatalf("unknown id: want 404, got %d", w.Code)
	}

	// invalid decision → 400 (validated before resolve)
	w2 := httptest.NewRecorder()
	mux.ServeHTTP(w2, httptest.NewRequest("POST", "/permission/whatever", strings.NewReader(`{"decision":"maybe"}`)))
	if w2.Code != http.StatusBadRequest {
		t.Fatalf("bad decision: want 400, got %d", w2.Code)
	}
}
