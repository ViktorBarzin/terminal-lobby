package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// POST /sessions/{name}/state — a person correcting a state the hooks got
// wrong (docs/adr/0001-claude-state-via-hooks.md, "A person is the third
// writer").
//
// Same posture as the origin-handler suite it is modelled on: hermetic table
// tests through the REAL route (handleSessionByName), the user map pointed at
// a fixture and the tmux binary swapped for a stub. The stub answers the read
// this handler makes before it writes, and records every argv either way.

// stateStub is the tmux stub script for these tests: a display-message that
// answers with the three marks the handler reads — session name, @tl_suspended,
// @claude_state — and any other verb succeeding silently.
//
// The name has to come back matching what was asked for, because a
// display-message against a session that is not there still exits 0 (tmux 3.4)
// and the echoed name is what catches it.
func stateStub(name, suspended, state string) string {
	return "case \"$1\" in\n" +
		"display-message) printf '%s\\t%s\\t%s\\n' '" + name + "' '" + suspended + "' '" + state + "' ;;\n" +
		"esac\nexit 0\n"
}

func TestSetStateEndpoint(t *testing.T) {
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
		wantNoArgv []string // substrings none of which may appear
		wantNoTmux bool     // tmux was not to be run at all
	}{
		{
			name:   "done stamps the option",
			method: http.MethodPost, path: "/sessions/work/state",
			body: `{"state":"done"}`, auth: "authself",
			stub:       stateStub("work", "", "running"),
			wantStatus: http.StatusNoContent,
			// The pane target form, not the session one: set-option's -t takes
			// a pane, and the '=' stops a bare name resolving by prefix onto a
			// sibling.
			wantArgv: []string{"set-option", "-t", "=work:", sessionStateOption, stateDone},
		},
		{
			// A done session that still owes work is a contradiction the card
			// would draw ("Done · 2 agents"), and a background id nobody
			// retired is exactly what nothing else clears between turns.
			name:   "done clears the outstanding-work set",
			method: http.MethodPost, path: "/sessions/work/state",
			body: `{"state":"done"}`, auth: "authself",
			stub:       stateStub("work", "", "running"),
			wantStatus: http.StatusNoContent,
			wantArgv:   []string{"-u", sessionBackgroundOption},
		},
		{
			// Nothing here says the work stopped, so the count stands.
			name:   "running leaves the outstanding-work set alone",
			method: http.MethodPost, path: "/sessions/work/state",
			body: `{"state":"running"}`, auth: "authself",
			stub:       stateStub("work", "", "done"),
			wantStatus: http.StatusNoContent,
			wantArgv:   []string{sessionStateOption, stateRunning},
			wantNoArgv: []string{sessionBackgroundOption},
		},
		{
			// The hook script resolves EVERY stamp to awaiting while a dialog
			// is marked as drawn (ADR-0001), so a correction away from
			// awaiting that left the marker standing would be undone by the
			// very next hook event. Cancel clears it for the same reason.
			name:   "a correction away from awaiting takes the dialog marker with it",
			method: http.MethodPost, path: "/sessions/work/state",
			body: `{"state":"done"}`, auth: "authself",
			stub:       stateStub("work", "", "awaiting"),
			wantStatus: http.StatusNoContent,
			wantArgv:   []string{"-u", askOption},
		},
		{
			// Saying "this session is waiting on me" must not invent a dialog
			// that is not on screen: the marker holds the state indefinitely,
			// which is more than one turn.
			name:   "awaiting leaves the dialog marker alone",
			method: http.MethodPost, path: "/sessions/work/state",
			body: `{"state":"awaiting"}`, auth: "authself",
			stub:       stateStub("work", "", "running"),
			wantStatus: http.StatusNoContent,
			wantArgv:   []string{sessionStateOption, stateAwaiting},
			wantNoArgv: []string{askOption},
		},
		{
			name:   "surrounding whitespace is not a different value",
			method: http.MethodPost, path: "/sessions/work/state",
			body: `{"state":" done "}`, auth: "authself",
			stub:       stateStub("work", "", "running"),
			wantStatus: http.StatusNoContent,
			wantArgv:   []string{sessionStateOption, stateDone},
		},
		{
			// suspended is DERIVED from @tl_suspended by parseSessions, not
			// stamped by anything. Accepting it would write a value the list
			// then overrules, which reads to the person who asked as the
			// button doing nothing.
			name:   "suspended is not a state a person may stamp",
			method: http.MethodPost, path: "/sessions/work/state",
			body: `{"state":"suspended"}`, auth: "authself",
			wantStatus: http.StatusBadRequest, wantNoTmux: true,
		},
		{
			name:   "a value outside the vocabulary never reaches tmux",
			method: http.MethodPost, path: "/sessions/work/state",
			body: `{"state":"finished"}`, auth: "authself",
			wantStatus: http.StatusBadRequest, wantNoTmux: true,
		},
		{
			name:   "an empty state never reaches tmux",
			method: http.MethodPost, path: "/sessions/work/state",
			body: `{"state":""}`, auth: "authself",
			wantStatus: http.StatusBadRequest, wantNoTmux: true,
		},
		{
			name:   "the value is case-sensitive, like the option tmux stores",
			method: http.MethodPost, path: "/sessions/work/state",
			body: `{"state":"Done"}`, auth: "authself",
			wantStatus: http.StatusBadRequest, wantNoTmux: true,
		},
		{
			// A suspended session's dot is the one reading that is not the
			// hooks' to get wrong, and parseSessions forces it whatever the
			// option says. Resume is the way back, so say so.
			name:   "a suspended session is a 409, and keeps its marks",
			method: http.MethodPost, path: "/sessions/work/state",
			body: `{"state":"done"}`, auth: "authself",
			stub:       stateStub("work", "1758300000", "running"),
			wantStatus: http.StatusConflict,
			wantNoArgv: []string{"set-option"},
		},
		{
			// An unstamped session is one no Claude has run in, and a stamp
			// would grow a state dot on a plain shell. Cancel declines the
			// same write for the same reason.
			name:   "a session with no Claude state is a 409",
			method: http.MethodPost, path: "/sessions/work/state",
			body: `{"state":"done"}`, auth: "authself",
			stub:       stateStub("work", "", ""),
			wantStatus: http.StatusConflict,
			wantNoArgv: []string{"set-option"},
		},
		{
			name:   "a session that is gone is a 404",
			method: http.MethodPost, path: "/sessions/absent/state",
			body: `{"state":"done"}`, auth: "authself",
			// display-message exits 0 for a session that is not there
			// (tmux 3.4) and prints the format with empty fields, so the
			// echoed name is what fails to match.
			stub:       stateStub("", "", ""),
			wantStatus: http.StatusNotFound,
			wantNoArgv: []string{"set-option"},
		},
		{
			name:   "a stopped tmux server is a 404, not a 500",
			method: http.MethodPost, path: "/sessions/work/state",
			body: `{"state":"done"}`, auth: "authself",
			stub:       "echo 'no server running on /tmp/tmux-1000/default' >&2; exit 1",
			wantStatus: http.StatusNotFound,
		},
		{
			name:   "a write that fails for an unrecognised reason is a 500",
			method: http.MethodPost, path: "/sessions/work/state",
			body: `{"state":"done"}`, auth: "authself",
			stub: "case \"$1\" in\n" +
				"display-message) printf '%s\\t%s\\t%s\\n' 'work' '' 'running' ;;\n" +
				"set-option) echo 'something else entirely' >&2; exit 1 ;;\n" +
				"esac\nexit 0\n",
			wantStatus: http.StatusInternalServerError,
		},
		{
			name:   "an invalid session name never reaches tmux",
			method: http.MethodPost, path: "/sessions/not%20a%20name/state",
			body: `{"state":"done"}`, auth: "authself",
			wantStatus: http.StatusBadRequest, wantNoTmux: true,
		},
		{
			name:   "a malformed body never reaches tmux",
			method: http.MethodPost, path: "/sessions/work/state",
			body: `{"state":`, auth: "authself",
			wantStatus: http.StatusBadRequest, wantNoTmux: true,
		},
		{
			name:   "an unauthenticated caller never reaches tmux",
			method: http.MethodPost, path: "/sessions/work/state",
			body: `{"state":"done"}`, auth: "",
			wantStatus: http.StatusUnauthorized, wantNoTmux: true,
		},
		{
			name:   "GET is not a way to read a state",
			method: http.MethodGet, path: "/sessions/work/state",
			auth:       "authself",
			wantStatus: http.StatusMethodNotAllowed, wantNoTmux: true,
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
			if c.wantNoTmux && argv != "" {
				t.Fatalf("tmux was invoked when it should not have been: %q", argv)
			}
			for _, want := range c.wantArgv {
				if !strings.Contains(argv, want+"\n") {
					t.Errorf("argv missing %q:\n%s", want, argv)
				}
			}
			for _, unwanted := range c.wantNoArgv {
				if strings.Contains(argv, unwanted+"\n") {
					t.Errorf("argv carries %q, which it should not:\n%s", unwanted, argv)
				}
			}
		})
	}
}

// The dialog marker is unset BEFORE the state is written, so the two can never
// be read in an order that contradicts itself — a reader that saw the new state
// with the old marker still standing would resolve it straight back to
// awaiting. Cancel writes them in this order for the same reason.
func TestSetStateClearsTheDialogMarkerBeforeItStamps(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "authself="+osSelf+"\n")
	argvFile := withTmuxStub(t, stateStub("work", "", "awaiting"))

	w := httptest.NewRecorder()
	handleSessionByName(w, sessionReq(http.MethodPost, "/sessions/work/state", `{"state":"done"}`, "authself"))
	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 (body %q)", w.Code, w.Body)
	}

	argv := recordedArgv(t, argvFile)
	ask := strings.Index(argv, askOption+"\n")
	state := strings.Index(argv, sessionStateOption+"\n")
	if ask < 0 || state < 0 {
		t.Fatalf("both writes should be here:\n%s", argv)
	}
	if ask > state {
		t.Errorf("the state was stamped before the dialog marker was cleared:\n%s", argv)
	}
}

// The outstanding-work set is cleared AFTER the state lands, not before: a
// write that fails would otherwise have taken a live count with it and changed
// nothing else.
func TestSetStateClearsTheWorkSetAfterItStamps(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "authself="+osSelf+"\n")
	argvFile := withTmuxStub(t, stateStub("work", "", "running"))

	w := httptest.NewRecorder()
	handleSessionByName(w, sessionReq(http.MethodPost, "/sessions/work/state", `{"state":"done"}`, "authself"))
	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 (body %q)", w.Code, w.Body)
	}

	argv := recordedArgv(t, argvFile)
	bg := strings.Index(argv, sessionBackgroundOption+"\n")
	state := strings.Index(argv, sessionStateOption+"\n")
	if bg < 0 || state < 0 {
		t.Fatalf("both writes should be here:\n%s", argv)
	}
	if bg < state {
		t.Errorf("the work set was cleared before the state landed:\n%s", argv)
	}
}

// A stamp the sessions cache does not know about is a stamp nothing reads: the
// list is memoised for five seconds per user, and a person who has just told
// the lobby what a session is doing is watching the dot.
func TestSetStateInvalidatesTheSessionsCache(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "authself="+osSelf+"\n")
	withTmuxStub(t, stateStub("work", "", "running"))

	sessionsCacheInstance.put(osSelf, []byte(`[{"name":"work","state":"running"}]`))
	t.Cleanup(func() { sessionsCacheInstance.invalidate(osSelf) })

	w := httptest.NewRecorder()
	handleSessionByName(w, sessionReq(http.MethodPost, "/sessions/work/state", `{"state":"done"}`, "authself"))
	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 (body %q)", w.Code, w.Body)
	}
	if _, warm := sessionsCacheInstance.get(osSelf); warm {
		t.Error("the cached list survived the stamp, so the sidebar would keep the old dot")
	}
}

// The endpoint against a REAL tmux server. The stub above proves the handler
// sends what it means to; only tmux can say whether the option lands and comes
// back through list-sessions as the state the session now reports.
//
// Skipped when tmux is missing, the way title_live_test.go is.
func TestSetStateEndpointRoundTripsThroughRealTmux(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	tmux := withRealTmux(t)
	withUserMap(t, "authself="+osSelf+"\n")

	if out, err := tmux("new-session", "-d", "-s", "stuck"); err != nil {
		t.Fatalf("creating stuck: %v: %s", err, out)
	}
	for opt, val := range map[string]string{
		sessionStateOption:      stateRunning,
		sessionBackgroundOption: "w:w7t7pnsug",
		askOption:               "toolu_01abc",
	} {
		if out, err := tmux("set-option", "-t", "=stuck:", opt, val); err != nil {
			t.Fatalf("stamping %s: %v: %s", opt, err, out)
		}
	}

	w := httptest.NewRecorder()
	handleSessionByName(w, sessionReq(http.MethodPost, "/sessions/stuck/state", `{"state":"done"}`, "authself"))
	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 (body %q)", w.Code, w.Body)
	}

	stuck := findSession(t, liveSessions(t, osSelf), "stuck")
	if stuck.State != stateDone {
		t.Errorf("state = %q, want %q", stuck.State, stateDone)
	}
	if stuck.Background != nil {
		t.Errorf("bg = %+v, want nil: a done session owes nothing", stuck.Background)
	}
	// display-message rather than show-options: an option that is not set is
	// not an option at all to `show-options -v`, which exits 1 with "invalid
	// option" (tmux 3.4), while the format renders it as empty.
	out, err := tmux("display-message", "-p", "-t", "=stuck:", "#{"+askOption+"}")
	if err != nil {
		t.Fatalf("reading %s back: %v: %s", askOption, err, out)
	}
	if strings.TrimSpace(out) != "" {
		t.Errorf("%s = %q, want it unset: the next hook event would put the session back to awaiting", askOption, out)
	}
}
