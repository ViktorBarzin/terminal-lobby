package main

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
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

// EVERY TILE ON SCREEN IS SILENCED ON THAT DEVICE, not only the one taking
// keystrokes.
//
// This is the whole of defect 3. The bell badge, the unseen marker, the tab
// title and the favicon were widened to the visible set and shipped; push was
// not, because the wire carried one name (`{"session":"auth"}`) and the store
// compared it for equality. So a two-tile workspace with `auth` focused left
// `deploy` fully notifiable, and a push landed on the phone about a session the
// reader was watching arrive on the desktop in front of them.
func TestFocusStoreSilencesEveryTileOnScreen(t *testing.T) {
	f := newFocusStore()
	f.report("alice", "https://push/desk", "auth", "deploy")

	cases := []struct {
		name    string
		session string
		want    bool
	}{
		{"the focused tile", "auth", true},
		{"the tile beside it", "deploy", true},
		{"a session in neither tile", "payroll", false},
		{"nothing at all", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := f.watching("alice", "https://push/desk", tc.session); got != tc.want {
				t.Fatalf("watching(%q) = %v, want %v", tc.session, got, tc.want)
			}
		})
	}
}

// Closing a tile un-silences it at once. A report is the whole truth about that
// screen, so the set REPLACES the last one rather than accumulating: a device
// that kept every session it had ever shown would end up silencing all of them.
func TestFocusStoreReplacesTheWholeSet(t *testing.T) {
	f := newFocusStore()
	f.report("alice", "https://push/desk", "auth", "deploy")
	f.report("alice", "https://push/desk", "auth")
	if !f.watching("alice", "https://push/desk", "auth") {
		t.Fatal("the tile still on screen stopped being silenced")
	}
	if f.watching("alice", "https://push/desk", "deploy") {
		t.Fatal("the closed tile is still silenced")
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

// BOTH WIRE SHAPES, one record.
//
// The page is a static build behind the ingress and this is a Go binary on the
// box, so the two halves deploy separately and each will meet the other at the
// wrong version for a while. An old page keeps sending one name and must keep
// silencing that one session; a new page sends the whole visible set alongside
// that name and must silence all of it. Neither may start delivering a push
// about a session somebody is looking at, and neither may start swallowing one
// about a session nobody is.
func TestHandlePushFocusAcceptsBothShapes(t *testing.T) {
	osA, _ := twoLocalUsers(t)
	cases := []struct {
		name     string
		body     string
		silenced []string
		notified []string
	}{
		{
			"an old page sends one name",
			`{"endpoint":"https://push/phone","session":"billing"}`,
			[]string{"billing"},
			[]string{"invoices"},
		},
		{
			"a new page sends every tile it is showing",
			`{"endpoint":"https://push/phone","sessions":["auth","deploy"],"session":"auth"}`,
			[]string{"auth", "deploy"},
			[]string{"payroll"},
		},
		{
			"a new page showing one session sends a set of one",
			`{"endpoint":"https://push/phone","sessions":["billing"],"session":"billing"}`,
			[]string{"billing"},
			[]string{"invoices"},
		},
		// The union, not a preference: a focused tile is on screen by
		// definition, so a set that somehow left it out would be wrong about the
		// one session we are surest of.
		{
			"a focused name absent from the set is still on screen",
			`{"endpoint":"https://push/phone","sessions":["deploy"],"session":"auth"}`,
			[]string{"auth", "deploy"},
			[]string{"payroll"},
		},
		{
			"looking away names nothing, in either shape",
			`{"endpoint":"https://push/phone","sessions":[],"session":""}`,
			nil,
			[]string{"auth", "deploy"},
		},
		{
			"a repeated tile is stored once and still silenced",
			`{"endpoint":"https://push/phone","sessions":["auth","auth"],"session":"auth"}`,
			[]string{"auth"},
			[]string{"deploy"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			withUserMap(t, "alice="+osA+"\n")
			swapFocusStore(t)
			req := httptest.NewRequest(http.MethodPost, "/push/focus", bytes.NewBufferString(tc.body))
			req.Header.Set(authHeader, "alice")
			w := httptest.NewRecorder()
			handlePushFocus(w, req)
			if w.Code != http.StatusNoContent {
				t.Fatalf("status %d, want 204: %s", w.Code, w.Body.String())
			}
			for _, s := range tc.silenced {
				if !focusStoreInstance.watching(osA, "https://push/phone", s) {
					t.Errorf("%q is on screen and was not silenced", s)
				}
			}
			for _, s := range tc.notified {
				if focusStoreInstance.watching(osA, "https://push/phone", s) {
					t.Errorf("%q is not on screen and was silenced anyway", s)
				}
			}
		})
	}
}

// One device cannot pin an unbounded set. Over the cap the report is refused
// rather than half-recorded, and the device keeps whatever it last said until
// its next tick lands — so the failure direction is a push about something the
// reader may be able to see, never silence about something they cannot.
func TestHandlePushFocusRefusesTooManySessions(t *testing.T) {
	osA, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osA+"\n")
	swapFocusStore(t)
	names := make([]string, 0, maxFocusSessions+1)
	for i := 0; i <= maxFocusSessions; i++ {
		names = append(names, fmt.Sprintf(`"s%d"`, i))
	}
	body := fmt.Sprintf(`{"endpoint":"https://push/phone","sessions":[%s],"session":"s0"}`,
		strings.Join(names, ","))
	req := httptest.NewRequest(http.MethodPost, "/push/focus", bytes.NewBufferString(body))
	req.Header.Set(authHeader, "alice")
	w := httptest.NewRecorder()
	handlePushFocus(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400: %s", w.Code, w.Body.String())
	}
	if focusStoreInstance.size(osA) != 0 {
		t.Fatal("an over-cap report was recorded anyway")
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
		// Every element carries the same name check the single field always
		// had: each one goes on to be compared against a real session.
		{"a session in the set is not a session name", `{"endpoint":"https://push/p","sessions":["ok","../etc"],"session":"ok"}`, http.MethodPost},
		// "" means "showing nothing" as the whole report. As an ELEMENT it is a
		// claim about a tile, and there is no tile called "".
		{"an empty name inside the set", `{"endpoint":"https://push/p","sessions":[""],"session":""}`, http.MethodPost},
		{"sessions is not an array", `{"endpoint":"https://push/p","sessions":"auth"}`, http.MethodPost},
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
