package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// POST /sessions/{name}/grid, through the REAL route (handleSessionByName) with
// the user map pointed at a fixture, as the copy-mode suite does. The three tmux
// seams are package vars, so these stay pure units: nothing here starts a tmux
// server.

type gridCall struct {
	osUser, name string
	cols, rows   int
}

// stubGrid swaps the handler's three seams and hands back the calls SizeGrid
// received. `driven` is whether the session has a read-write client; `sized` and
// `err` are what SizeGrid answers.
func stubGridSizing(t *testing.T, exists, driven, sized bool, err error) *[]gridCall {
	t.Helper()
	var calls []gridCall

	oldExists, oldDriven, oldSize := sessionExists, sessionDriven, sizeGrid
	sessionExists = func(string, string) bool { return exists }
	sessionDriven = func(string, string) bool { return driven }
	sizeGrid = func(osUser, name string, cols, rows int) (bool, error) {
		calls = append(calls, gridCall{osUser, name, cols, rows})
		return sized, err
	}
	t.Cleanup(func() { sessionExists, sessionDriven, sizeGrid = oldExists, oldDriven, oldSize })
	return &calls
}

func TestSizeGridEndpoint(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)

	cases := []struct {
		name string
		// the world the handler runs in
		exists, driven, sized bool
		sizeErr               error
		// the request
		method, path, body, auth string
		// what should come back
		wantCode  int
		wantCalls []gridCall
	}{
		{
			name:   "a pinned session is pointed at the client that asked",
			exists: true, driven: true, sized: true,
			method: http.MethodPost, path: "/sessions/work/grid", auth: "alice",
			body: `{"cols":231,"rows":62}`, wantCode: http.StatusNoContent,
			wantCalls: []gridCall{{osUser: "", name: "work", cols: 231, rows: 62}},
		},
		{
			// The majority case. An unpinned session is left to tmux, and the
			// caller has nothing to do differently, so it reads the same 204.
			name:   "an unpinned session answers the same 204",
			exists: true, driven: true, sized: false,
			method: http.MethodPost, path: "/sessions/work/grid", auth: "alice",
			body: `{"cols":231,"rows":62}`, wantCode: http.StatusNoContent,
			wantCalls: []gridCall{{osUser: "", name: "work", cols: 231, rows: 62}},
		},
		{
			// The one thing the server CAN tell about a watcher: with no
			// read-write client attached, nobody is driving, and a pin exists
			// precisely so a lone watcher does not take the size.
			name:   "nobody driving means nobody may claim the grid",
			exists: true, driven: false, sized: true,
			method: http.MethodPost, path: "/sessions/work/grid", auth: "alice",
			body: `{"cols":80,"rows":24}`, wantCode: http.StatusConflict,
		},
		{
			name: "unknown session", exists: false, driven: true,
			method: http.MethodPost, path: "/sessions/nope/grid", auth: "alice",
			body: `{"cols":231,"rows":62}`, wantCode: http.StatusNotFound,
		},
		{
			name: "tmux failed", exists: true, driven: true,
			sizeErr: fmt.Errorf("boom"),
			method:  http.MethodPost, path: "/sessions/work/grid", auth: "alice",
			body: `{"cols":231,"rows":62}`, wantCode: http.StatusInternalServerError,
			wantCalls: []gridCall{{osUser: "", name: "work", cols: 231, rows: 62}},
		},

		// --- the grid itself ------------------------------------------------
		// A browser mid-layout reports 0, and xterm fitting against a
		// display:none host computes ~13x7. Neither is a size anybody is
		// reading, and neither should reach tmux.
		{
			name: "zero columns", exists: true, driven: true,
			method: http.MethodPost, path: "/sessions/work/grid", auth: "alice",
			body: `{"cols":0,"rows":62}`, wantCode: http.StatusBadRequest,
		},
		{
			name: "zero rows", exists: true, driven: true,
			method: http.MethodPost, path: "/sessions/work/grid", auth: "alice",
			body: `{"cols":231,"rows":0}`, wantCode: http.StatusBadRequest,
		},
		{
			name: "negative", exists: true, driven: true,
			method: http.MethodPost, path: "/sessions/work/grid", auth: "alice",
			body: `{"cols":-1,"rows":62}`, wantCode: http.StatusBadRequest,
		},
		{
			name: "absurdly wide", exists: true, driven: true,
			method: http.MethodPost, path: "/sessions/work/grid", auth: "alice",
			body: `{"cols":99999,"rows":62}`, wantCode: http.StatusBadRequest,
		},
		{
			name:   "a missing field is a zero, which is out of range",
			exists: true, driven: true,
			method: http.MethodPost, path: "/sessions/work/grid", auth: "alice",
			body: `{"cols":231}`, wantCode: http.StatusBadRequest,
		},
		{
			name: "garbage body", exists: true, driven: true,
			method: http.MethodPost, path: "/sessions/work/grid", auth: "alice",
			body: `{nope`, wantCode: http.StatusBadRequest,
		},

		// --- the guards every session endpoint has ---------------------------
		{
			name: "rejects GET", exists: true, driven: true,
			method: http.MethodGet, path: "/sessions/work/grid", auth: "alice",
			wantCode: http.StatusMethodNotAllowed,
		},
		{
			name: "without auth header", exists: true, driven: true,
			method: http.MethodPost, path: "/sessions/work/grid", auth: "",
			body: `{"cols":231,"rows":62}`, wantCode: http.StatusUnauthorized,
		},
		{
			name: "unmapped user", exists: true, driven: true,
			method: http.MethodPost, path: "/sessions/work/grid", auth: "stranger",
			body: `{"cols":231,"rows":62}`, wantCode: http.StatusForbidden,
		},
		{
			name: "invalid session name", exists: true, driven: true,
			method: http.MethodPost, path: "/sessions/we%7Cird/grid", auth: "alice",
			body: `{"cols":231,"rows":62}`, wantCode: http.StatusBadRequest,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			withUserMap(t, "alice="+osSelf+"\n")
			calls := stubGridSizing(t, tc.exists, tc.driven, tc.sized, tc.sizeErr)

			w := httptest.NewRecorder()
			handleSessionByName(w, sessionReq(tc.method, tc.path, tc.body, tc.auth))

			if w.Code != tc.wantCode {
				t.Errorf("status = %d, want %d (body %q)", w.Code, tc.wantCode, w.Body.String())
			}
			if len(*calls) != len(tc.wantCalls) {
				t.Fatalf("SizeGrid called %d time(s), want %d: %+v", len(*calls), len(tc.wantCalls), *calls)
			}
			for i, want := range tc.wantCalls {
				got := (*calls)[i]
				if got.name != want.name || got.cols != want.cols || got.rows != want.rows {
					t.Errorf("SizeGrid call %d = %+v, want name=%s %dx%d",
						i, got, want.name, want.cols, want.rows)
				}
				if got.osUser != osSelf {
					t.Errorf("SizeGrid call %d ran as %q, want the mapped user %q", i, got.osUser, osSelf)
				}
			}
		})
	}
}

// A read-only client never counts towards "somebody is driving this", which is
// the same reading markDriven does of the same flag list.
func TestIsReadOnlyReadsTheClientFlags(t *testing.T) {
	cases := []struct {
		flags string
		want  bool
	}{
		{"attached,UTF-8", false},
		{"attached,read-only,UTF-8", true},
		{"attached,focused,read-only", true},
		{"", false},
	}
	for _, tc := range cases {
		if got := isReadOnly(tc.flags); got != tc.want {
			t.Errorf("isReadOnly(%q) = %v, want %v", tc.flags, got, tc.want)
		}
	}
}
