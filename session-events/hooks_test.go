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
	b := NewPermissionBroker(time.Second)
	// Session known but no subscriber watching → ask (fall through to terminal).
	resolve := func(user, session string) (bool, func(Event), bool) { return false, func(Event) {}, true }
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/hooks/permission-request",
		strings.NewReader(`{"user":"wizard","session":"demo","tool_name":"Bash","tool_input":{"command":"ls"}}`))
	permissionRequestHandler(b, resolve)(w, r)

	var m map[string]map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatalf("resp not json: %s", w.Body.String())
	}
	if m["hookSpecificOutput"]["hookEventName"] != "PreToolUse" {
		t.Fatalf("hookEventName wrong: %s", w.Body.String())
	}
	if m["hookSpecificOutput"]["permissionDecision"] != "ask" {
		t.Fatalf("permissionDecision wrong: %s", w.Body.String())
	}
}

func TestPermissionRequestUnknownSessionAsks(t *testing.T) {
	b := NewPermissionBroker(time.Second)
	resolve := func(user, session string) (bool, func(Event), bool) { return false, nil, false } // unknown
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/hooks/permission-request",
		strings.NewReader(`{"user":"wizard","session":"ghost","tool_name":"Bash","tool_input":{}}`))
	permissionRequestHandler(b, resolve)(w, r)
	var m map[string]map[string]string
	json.Unmarshal(w.Body.Bytes(), &m)
	if m["hookSpecificOutput"]["permissionDecision"] != "ask" {
		t.Fatalf("unknown session should ask: %s", w.Body.String())
	}
}

func TestPermissionResolveHandlerViaMux(t *testing.T) {
	b := NewPermissionBroker(time.Second)
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
