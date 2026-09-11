package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// POST /sessions/{name}/origin — the rescue. Dragging a card out of the System
// group is the only caller: the drop writes the layout and then says so on the
// server, so the session stops being a system session everywhere rather than
// only in the browser that moved it.
//
// Same posture as the title-handler suite it is modelled on: hermetic table
// tests through the REAL route (handleSessionByName), the user map pointed at a
// fixture and the tmux binary swapped for a stub.

func TestSetOriginEndpoint(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)

	cases := []struct {
		name       string
		method     string
		path       string
		body       string
		auth       string
		stub       string
		wantStatus int
		wantArgv   []string // substrings every one of which must appear
		wantNoArgv bool
	}{
		{
			name:   "stamps the option",
			method: http.MethodPost, path: "/sessions/k7m2q9x4tp0v/origin",
			body: `{"origin":"user"}`, auth: "authself",
			wantStatus: http.StatusNoContent,
			// The pane target form, not the session one: set-option's -t takes
			// a pane, and the '=' stops a bare name resolving by prefix onto a
			// sibling.
			wantArgv: []string{"set-option", "-t", "=k7m2q9x4tp0v:", originOption, originUser},
		},
		{
			// The harnesses stamp their own sessions over tmux directly, but
			// the value is half the vocabulary and refusing it here would make
			// the endpoint disagree with the option it writes.
			name:   "test is a value a caller may set",
			method: http.MethodPost, path: "/sessions/qa-slug/origin",
			body: `{"origin":"test"}`, auth: "authself",
			wantStatus: http.StatusNoContent,
			wantArgv:   []string{"set-option", "=qa-slug:", originOption, originTest},
		},
		{
			name:   "surrounding whitespace is not a different value",
			method: http.MethodPost, path: "/sessions/work/origin",
			body: `{"origin":" user "}`, auth: "authself",
			wantStatus: http.StatusNoContent,
			wantArgv:   []string{originOption, originUser},
		},
		{
			// Only two values are ever written (origin.go). The third state is
			// the ABSENCE of the option, and no caller has a reason to ask for
			// it: a session with no origin already reads as system, which is
			// what dragging it out is undoing.
			name:   "a value outside the vocabulary never reaches tmux",
			method: http.MethodPost, path: "/sessions/work/origin",
			body: `{"origin":"human"}`, auth: "authself",
			wantStatus: http.StatusBadRequest, wantNoArgv: true,
		},
		{
			name:   "an empty origin never reaches tmux",
			method: http.MethodPost, path: "/sessions/work/origin",
			body: `{"origin":""}`, auth: "authself",
			wantStatus: http.StatusBadRequest, wantNoArgv: true,
		},
		{
			name:   "the value is case-sensitive, like the option tmux stores",
			method: http.MethodPost, path: "/sessions/work/origin",
			body: `{"origin":"User"}`, auth: "authself",
			wantStatus: http.StatusBadRequest, wantNoArgv: true,
		},
		{
			name:   "a session that is gone is a 404",
			method: http.MethodPost, path: "/sessions/absent/origin",
			body: `{"origin":"user"}`, auth: "authself",
			// The message set-option actually emits, measured on tmux 3.4 —
			// NOT the "can't find session" that rename and kill produce.
			stub:       "echo 'no such session: =absent:' >&2; exit 1",
			wantStatus: http.StatusNotFound,
		},
		{
			name:   "a stopped tmux server is a 404, not a 500",
			method: http.MethodPost, path: "/sessions/work/origin",
			body: `{"origin":"user"}`, auth: "authself",
			stub:       "echo 'no server running on /tmp/tmux-1000/default' >&2; exit 1",
			wantStatus: http.StatusNotFound,
		},
		{
			name:   "an unrecognised tmux failure stays a 500",
			method: http.MethodPost, path: "/sessions/work/origin",
			body: `{"origin":"user"}`, auth: "authself",
			stub:       "echo 'something else entirely' >&2; exit 1",
			wantStatus: http.StatusInternalServerError,
		},
		{
			name:   "an invalid session name never reaches tmux",
			method: http.MethodPost, path: "/sessions/not%20a%20name/origin",
			body: `{"origin":"user"}`, auth: "authself",
			wantStatus: http.StatusBadRequest, wantNoArgv: true,
		},
		{
			name:   "a malformed body never reaches tmux",
			method: http.MethodPost, path: "/sessions/work/origin",
			body: `{"origin":`, auth: "authself",
			wantStatus: http.StatusBadRequest, wantNoArgv: true,
		},
		{
			name:   "an unauthenticated caller never reaches tmux",
			method: http.MethodPost, path: "/sessions/work/origin",
			body: `{"origin":"user"}`, auth: "",
			wantStatus: http.StatusUnauthorized, wantNoArgv: true,
		},
		{
			name:   "GET is not a way to read an origin",
			method: http.MethodGet, path: "/sessions/work/origin",
			auth:       "authself",
			wantStatus: http.StatusMethodNotAllowed, wantNoArgv: true,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			withUserMap(t, "authself="+osSelf+"\n")
			argvFile := withTmuxStub(t, c.stub)

			w := httptest.NewRecorder()
			handleSessionByName(w, sessionReq(c.method, c.path, c.body, c.auth))

			if w.Code != c.wantStatus {
				t.Fatalf("status = %d, want %d (body %q)", w.Code, c.wantStatus, w.Body)
			}
			argv := recordedArgv(t, argvFile)
			if c.wantNoArgv && argv != "" {
				t.Fatalf("tmux was invoked when it should not have been: %q", argv)
			}
			for _, want := range c.wantArgv {
				if !strings.Contains(argv, want+"\n") {
					t.Errorf("argv missing %q:\n%s", want, argv)
				}
			}
		})
	}
}

// A stamp the sessions cache does not know about is a stamp nothing reads: the
// list is memoised for five seconds per user, and the drop that rescued the
// session redraws the sidebar from the very next poll.
func TestSetOriginInvalidatesTheSessionsCache(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "authself="+osSelf+"\n")
	withTmuxStub(t, "exit 0")

	sessionsCacheInstance.put(osSelf, []byte(`[{"name":"work","origin":""}]`))
	t.Cleanup(func() { sessionsCacheInstance.invalidate(osSelf) })

	w := httptest.NewRecorder()
	handleSessionByName(w, sessionReq(http.MethodPost, "/sessions/work/origin", `{"origin":"user"}`, "authself"))
	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 (body %q)", w.Code, w.Body)
	}
	if _, warm := sessionsCacheInstance.get(osSelf); warm {
		t.Error("the cached list survived the stamp, so the sidebar would keep the session in System")
	}
}

// The endpoint against a REAL tmux server. The stub above proves the handler
// sends what it means to; only tmux can say whether the option lands and comes
// back through list-sessions as the origin the session now reports — which is
// the whole of what the rescue has to achieve.
//
// Skipped when tmux is missing, the way title_live_test.go is.
func TestSetOriginEndpointRoundTripsThroughRealTmux(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	tmux := withRealTmux(t)
	withUserMap(t, "authself="+osSelf+"\n")

	for _, name := range []string{"rescued", "rescue"} {
		if out, err := tmux("new-session", "-d", "-s", name); err != nil {
			t.Fatalf("creating %s: %v: %s", name, err, out)
		}
	}

	w := httptest.NewRecorder()
	handleSessionByName(w, sessionReq(http.MethodPost, "/sessions/rescued/origin", `{"origin":"user"}`, "authself"))
	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 (body %q)", w.Code, w.Body)
	}

	sessions := liveSessions(t, osSelf)
	rescued := findSession(t, sessions, "rescued")
	if rescued.Origin != originUser {
		t.Errorf("origin read back as %q, want %q", rescued.Origin, originUser)
	}
	if isSystemSession(rescued) {
		t.Error("a rescued session is still being read as a system session")
	}
	// The sibling whose name is a PREFIX of the one that was stamped. A bare
	// `-t rescued` would be unambiguous, but `-t rescue` resolves by prefix
	// onto `rescued`, and the '=' is what stops the reverse mistake landing
	// silently on a stranger.
	if sibling := findSession(t, sessions, "rescue"); sibling.Origin != "" {
		t.Errorf("the sibling was stamped too: origin %q, want empty", sibling.Origin)
	}

	// A session that is gone is a 404 through the real binary as well, which
	// is the assertion the four spellings of "not there" exist for.
	w = httptest.NewRecorder()
	handleSessionByName(w, sessionReq(http.MethodPost, "/sessions/absent/origin", `{"origin":"user"}`, "authself"))
	if w.Code != http.StatusNotFound {
		t.Fatalf("a missing session gave status %d, want 404 (body %q)", w.Code, w.Body)
	}
}
