package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestLocalhostOnly(t *testing.T) {
	reached := false
	h := localhostOnly(func(w http.ResponseWriter, r *http.Request) { reached = true; w.WriteHeader(204) })

	// loopback → passes
	reached = false
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/hooks/x", nil)
	r.RemoteAddr = "127.0.0.1:5000"
	h(w, r)
	if w.Code != 204 || !reached {
		t.Fatalf("loopback should pass: code=%d reached=%v", w.Code, reached)
	}

	// non-loopback → 403
	reached = false
	w2 := httptest.NewRecorder()
	r2 := httptest.NewRequest("POST", "/hooks/x", nil)
	r2.RemoteAddr = "10.0.20.5:5000"
	h(w2, r2)
	if w2.Code != http.StatusForbidden || reached {
		t.Fatalf("LAN IP should be 403: code=%d reached=%v", w2.Code, reached)
	}
}
