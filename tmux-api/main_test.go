package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// handleRestore must reject the wrong method before doing anything privileged.
func TestHandleRestoreRejectsGet(t *testing.T) {
	rec := httptest.NewRecorder()
	handleRestore(rec, httptest.NewRequest(http.MethodGet, "/restore", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET /restore: got %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}
}

// Without the Authentik identity header there is no user to restore — must be
// 401, and crucially must NOT shell out to the restore wrapper.
func TestHandleRestoreRequiresAuth(t *testing.T) {
	rec := httptest.NewRecorder()
	handleRestore(rec, httptest.NewRequest(http.MethodPost, "/restore", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("POST /restore without %s: got %d, want %d", authHeader, rec.Code, http.StatusUnauthorized)
	}
}
