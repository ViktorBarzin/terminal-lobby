package main

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// The store answers one question: is THIS device looking at THIS session right
// now? Everything else about it — staleness, an unreported device, a device on
// the lobby list — answers no, which is the direction that notifies.
func TestFocusStoreAnswersOnlyForTheDeviceThatReported(t *testing.T) {
	now := time.Now()
	f := newFocusStore()
	f.now = func() time.Time { return now }

	f.report("alice", "https://push/phone", "billing")

	cases := []struct {
		name     string
		user     string
		endpoint string
		session  string
		want     bool
	}{
		{"the device that reported it", "alice", "https://push/phone", "billing", true},
		{"her other device", "alice", "https://push/desk", "billing", false},
		{"a different session on the same device", "alice", "https://push/phone", "invoices", false},
		{"someone else entirely", "bob", "https://push/phone", "billing", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := f.watching(tc.user, tc.endpoint, tc.session); got != tc.want {
				t.Fatalf("watching(%s, %s, %s) = %v, want %v", tc.user, tc.endpoint, tc.session, got, tc.want)
			}
		})
	}
}

// A report goes stale. The page heartbeats while it is on screen, so silence
// means the page is gone, frozen or backgrounded — none of which is looking.
func TestFocusStoreForgetsAStaleReport(t *testing.T) {
	now := time.Now()
	f := newFocusStore()
	f.now = func() time.Time { return now }
	f.report("alice", "https://push/phone", "billing")

	now = now.Add(focusTTL - time.Second)
	if !f.watching("alice", "https://push/phone", "billing") {
		t.Fatal("a report inside the TTL should still count")
	}
	now = now.Add(2 * time.Second)
	if f.watching("alice", "https://push/phone", "billing") {
		t.Fatal("a report past the TTL should not count")
	}
}

// Looking at the lobby list, or at nothing, is reported as the empty session —
// and must never match a real session, including one named "".
func TestFocusStoreEmptySessionMatchesNothing(t *testing.T) {
	f := newFocusStore()
	f.report("alice", "https://push/phone", "")
	if f.watching("alice", "https://push/phone", "") {
		t.Fatal("looking at nothing must not silence anything")
	}
	if f.watching("alice", "https://push/phone", "billing") {
		t.Fatal("looking at nothing must not silence a real session")
	}
}

// A later report replaces the earlier one for that device: you can only look at
// one session at a time.
func TestFocusStoreOneSessionPerDevice(t *testing.T) {
	f := newFocusStore()
	f.report("alice", "https://push/phone", "billing")
	f.report("alice", "https://push/phone", "invoices")
	if f.watching("alice", "https://push/phone", "billing") {
		t.Fatal("the session she looked away from is still silenced")
	}
	if !f.watching("alice", "https://push/phone", "invoices") {
		t.Fatal("the session she moved to is not silenced")
	}
}

// A device that goes away takes its record with it, so a re-subscribe at a new
// endpoint never inherits a stale one.
func TestFocusStoreForgetDropsADevice(t *testing.T) {
	f := newFocusStore()
	f.report("alice", "https://push/phone", "billing")
	f.forget("alice", "https://push/phone")
	if f.watching("alice", "https://push/phone", "billing") {
		t.Fatal("a forgotten device still reports focus")
	}
}

// One user cannot pin an unbounded number of endpoints in memory: a client
// looping on a fresh endpoint each time evicts the oldest record rather than
// growing the map, and the newest report always survives.
func TestFocusStoreCapsEndpointsPerUser(t *testing.T) {
	now := time.Now()
	f := newFocusStore()
	f.now = func() time.Time { return now }
	var last string
	for i := 0; i < maxFocusDevices+10; i++ {
		now = now.Add(time.Second)
		last = fmt.Sprintf("https://push/%d", i)
		f.report("alice", last, "billing")
	}
	if got := f.size("alice"); got > maxFocusDevices {
		t.Fatalf("held %d endpoints, want at most %d", got, maxFocusDevices)
	}
	if !f.watching("alice", last, "billing") {
		t.Fatal("the newest report was the one evicted")
	}
}

// The handler records what the page says, under the REAL caller — an act-as tab
// must not report focus on behalf of the person it is lensing (same carve-out
// as the subscription store, actas_test.go).
func TestHandlePushFocusRecordsTheReport(t *testing.T) {
	osA, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osA+"\n")
	swapFocusStore(t)

	req := httptest.NewRequest(http.MethodPost, "/push/focus",
		bytes.NewBufferString(`{"endpoint":"https://push/phone","session":"billing"}`))
	req.Header.Set(authHeader, "alice")
	w := httptest.NewRecorder()
	handlePushFocus(w, req)
	if w.Code != http.StatusNoContent {
		t.Fatalf("status %d, want 204: %s", w.Code, w.Body.String())
	}
	if !focusStoreInstance.watching(osA, "https://push/phone", "billing") {
		t.Fatal("the report was accepted but not recorded")
	}
}

// An unidentified caller records nothing.
func TestHandlePushFocusRequiresAuth(t *testing.T) {
	swapFocusStore(t)
	req := httptest.NewRequest(http.MethodPost, "/push/focus",
		bytes.NewBufferString(`{"endpoint":"https://push/phone","session":"billing"}`))
	w := httptest.NewRecorder()
	handlePushFocus(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status %d, want 401", w.Code)
	}
}

// swapFocusStore gives one test its own store and puts the real one back.
func swapFocusStore(t *testing.T) *focusStore {
	t.Helper()
	old := focusStoreInstance
	focusStoreInstance = newFocusStore()
	t.Cleanup(func() { focusStoreInstance = old })
	return focusStoreInstance
}

// A body the store would have to guess at is refused rather than half-recorded.
func TestHandlePushFocusRefusesBadInput(t *testing.T) {
	cases := []struct {
		name, body, method string
	}{
		{"not JSON", `{`, http.MethodPost},
		{"no endpoint", `{"session":"billing"}`, http.MethodPost},
		{"endpoint is not a URL", `{"endpoint":"phone","session":"billing"}`, http.MethodPost},
		{"session is not a session name", `{"endpoint":"https://push/p","session":"../etc"}`, http.MethodPost},
		{"wrong method", `{"endpoint":"https://push/p","session":""}`, http.MethodGet},
	}
	osA, _ := twoLocalUsers(t)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			withUserMap(t, "alice="+osA+"\n")
			swapFocusStore(t)
			req := httptest.NewRequest(tc.method, "/push/focus", bytes.NewBufferString(tc.body))
			req.Header.Set(authHeader, "alice")
			w := httptest.NewRecorder()
			handlePushFocus(w, req)
			if w.Code == http.StatusNoContent {
				t.Fatalf("accepted %s", tc.name)
			}
			if focusStoreInstance.size(osA) != 0 {
				t.Fatalf("recorded something from %s", tc.name)
			}
		})
	}
}
