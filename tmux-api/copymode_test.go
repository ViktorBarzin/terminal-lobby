package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Task M.2 (touch copy): POST /sessions/{name}/copy-mode and
// GET /sessions/{name}/capture — the server-side, binding-table-independent
// copy path for touch clients (client-side prefix-key synthesis breaks under
// prefix remaps; `tmux copy-mode` / `send-keys -X` / `capture-pane` don't
// consult the key tables at all). The suite clones the rename-handler test
// posture: hermetic table tests through the REAL route
// (handleSessionByName) with the user map pointed at a fixture and the tmux
// binary swapped for a stub.

// withTmuxStub swaps tmuxBinary (a var precisely for this seam, like
// mapPath) for a shell stub that appends its argv — one arg per line — to a
// file, then runs `script`. Returns the argv file path; a missing file
// after the request means tmux was never invoked.
func withTmuxStub(t *testing.T, script string) string {
	t.Helper()
	dir := t.TempDir()
	argvFile := filepath.Join(dir, "argv")
	stub := filepath.Join(dir, "tmux")
	// argvFile is single-quoted: subtest TempDirs embed the subtest name,
	// which may contain shell metacharacters (e.g. "(Mark)").
	body := "#!/bin/sh\nprintf '%s\\n' \"$@\" >> '" + argvFile + "'\n" + script + "\n"
	if err := os.WriteFile(stub, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	old := tmuxBinary
	tmuxBinary = stub
	t.Cleanup(func() { tmuxBinary = old })
	return argvFile
}

func recordedArgv(t *testing.T, argvFile string) string {
	t.Helper()
	raw, err := os.ReadFile(argvFile)
	if os.IsNotExist(err) {
		return ""
	}
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func sessionReq(method, path, body, authUser string) *http.Request {
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
	}
	if authUser != "" {
		r.Header.Set(authHeader, authUser)
	}
	return r
}

func TestCopyModeAndCaptureEndpoints(t *testing.T) {
	osSelf, _ := twoLocalUsers(t) // current user: tmuxCmd skips sudo → stub runs directly

	// tmux error transcripts verified live against tmux 3.4 (scratch
	// socket, 2026-07-12): pane-target commands say "can't find pane:",
	// NOT the "can't find session" that kill/rename match on; `send-keys
	// -X` outside copy-mode fails with "not in a mode".
	cases := []struct {
		name     string
		method   string
		path     string
		body     string
		auth     string // "" = no header
		stub     string // shell after argv-recording; "" = must not run
		wantCode int
		wantArgv string // "" = stub must NOT have been invoked
		wantBody string // exact body match when non-empty (capture)
	}{
		// --- happy paths -------------------------------------------------
		{
			name: "copy-mode entry happy path", method: http.MethodPost,
			path: "/sessions/work/copy-mode", auth: "alice",
			stub: "exit 0", wantCode: http.StatusNoContent,
			wantArgv: "copy-mode\n-t\nwork\n",
		},
		{
			name: "copy-mode begin-selection (Mark)", method: http.MethodPost,
			path: "/sessions/work/copy-mode", auth: "alice",
			body: `{"command":"begin-selection"}`,
			stub: "exit 0", wantCode: http.StatusNoContent,
			wantArgv: "send-keys\n-t\nwork\n-X\nbegin-selection\n",
		},
		{
			name: "copy-mode copy-selection-and-cancel (Yank)", method: http.MethodPost,
			path: "/sessions/work/copy-mode", auth: "alice",
			body: `{"command":"copy-selection-and-cancel"}`,
			stub: "exit 0", wantCode: http.StatusNoContent,
			wantArgv: "send-keys\n-t\nwork\n-X\ncopy-selection-and-cancel\n",
		},
		{
			name: "capture happy path", method: http.MethodGet,
			path: "/sessions/work/capture", auth: "alice",
			stub:     "printf 'ALPHA BRAVO\\nline two\\n'",
			wantCode: http.StatusOK,
			wantArgv: "capture-pane\n-p\n-J\n-t\nwork\n",
			wantBody: "ALPHA BRAVO\nline two\n",
		},
		// --- unknown session → 404 ---------------------------------------
		{
			name: "copy-mode unknown session", method: http.MethodPost,
			path: "/sessions/nope/copy-mode", auth: "alice",
			stub:     `echo "can't find pane: nope" >&2; exit 1`,
			wantCode: http.StatusNotFound,
			wantArgv: "copy-mode\n-t\nnope\n",
		},
		{
			name: "capture unknown session", method: http.MethodGet,
			path: "/sessions/nope/capture", auth: "alice",
			stub:     `echo "can't find pane: nope" >&2; exit 1`,
			wantCode: http.StatusNotFound,
			wantArgv: "capture-pane\n-p\n-J\n-t\nnope\n",
		},
		{
			name: "copy-mode no tmux server", method: http.MethodPost,
			path: "/sessions/work/copy-mode", auth: "alice",
			stub:     `echo "no server running on /tmp/tmux-1000/default" >&2; exit 1`,
			wantCode: http.StatusNotFound,
			wantArgv: "copy-mode\n-t\nwork\n",
		},
		// --- command guardrails ------------------------------------------
		{
			name: "copy-mode command outside whitelist", method: http.MethodPost,
			path: "/sessions/work/copy-mode", auth: "alice",
			body:     `{"command":"kill-server"}`,
			wantCode: http.StatusBadRequest,
		},
		{
			name: "copy-mode invalid JSON body", method: http.MethodPost,
			path: "/sessions/work/copy-mode", auth: "alice",
			body:     `{nope`,
			wantCode: http.StatusBadRequest,
		},
		{
			name: "copy-mode Mark outside copy-mode", method: http.MethodPost,
			path: "/sessions/work/copy-mode", auth: "alice",
			body:     `{"command":"begin-selection"}`,
			stub:     `echo "not in a mode" >&2; exit 1`,
			wantCode: http.StatusConflict,
			wantArgv: "send-keys\n-t\nwork\n-X\nbegin-selection\n",
		},
		{
			name: "copy-mode other tmux failure", method: http.MethodPost,
			path: "/sessions/work/copy-mode", auth: "alice",
			stub:     `echo "boom" >&2; exit 1`,
			wantCode: http.StatusInternalServerError,
			wantArgv: "copy-mode\n-t\nwork\n",
		},
		{
			name: "capture other tmux failure", method: http.MethodGet,
			path: "/sessions/work/capture", auth: "alice",
			stub:     `echo "boom" >&2; exit 1`,
			wantCode: http.StatusInternalServerError,
			wantArgv: "capture-pane\n-p\n-J\n-t\nwork\n",
		},
		// --- method guards ------------------------------------------------
		{
			name: "copy-mode rejects GET", method: http.MethodGet,
			path: "/sessions/work/copy-mode", auth: "alice",
			wantCode: http.StatusMethodNotAllowed,
		},
		{
			name: "capture rejects POST", method: http.MethodPost,
			path: "/sessions/work/capture", auth: "alice",
			wantCode: http.StatusMethodNotAllowed,
		},
		// --- auth-header user scoping --------------------------------------
		{
			name: "copy-mode without auth header", method: http.MethodPost,
			path: "/sessions/work/copy-mode", auth: "",
			wantCode: http.StatusUnauthorized,
		},
		{
			name: "capture without auth header", method: http.MethodGet,
			path: "/sessions/work/capture", auth: "",
			wantCode: http.StatusUnauthorized,
		},
		{
			name: "copy-mode unmapped user forbidden", method: http.MethodPost,
			path: "/sessions/work/copy-mode", auth: "stranger",
			wantCode: http.StatusForbidden,
		},
		{
			name: "capture unmapped user forbidden", method: http.MethodGet,
			path: "/sessions/work/capture", auth: "stranger",
			wantCode: http.StatusForbidden,
		},
		// --- route-level name validation -----------------------------------
		{
			name: "copy-mode invalid session name", method: http.MethodPost,
			path: "/sessions/we%7Cird/copy-mode", auth: "alice",
			wantCode: http.StatusBadRequest,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			withUserMap(t, "alice="+osSelf+"\n")
			stub := tc.stub
			if stub == "" {
				stub = "exit 0"
			}
			argvFile := withTmuxStub(t, stub)

			rec := httptest.NewRecorder()
			handleSessionByName(rec, sessionReq(tc.method, tc.path, tc.body, tc.auth))

			if rec.Code != tc.wantCode {
				t.Fatalf("%s %s: got %d, want %d (body %q)",
					tc.method, tc.path, rec.Code, tc.wantCode, rec.Body.String())
			}
			if got := recordedArgv(t, argvFile); got != tc.wantArgv {
				t.Fatalf("tmux argv: got %q, want %q", got, tc.wantArgv)
			}
			if tc.wantBody != "" && rec.Body.String() != tc.wantBody {
				t.Fatalf("body: got %q, want %q", rec.Body.String(), tc.wantBody)
			}
			if tc.wantCode == http.StatusOK && strings.HasSuffix(tc.path, "/capture") {
				if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
					t.Fatalf("capture content-type: got %q, want text/plain", ct)
				}
				if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
					t.Fatalf("capture cache-control: got %q, want no-store", cc)
				}
			}
		})
	}
}

// The capture body must be the tmux stdout VERBATIM — stderr chatter (e.g.
// a server-startup notice) must never leak into what lands on the user's
// clipboard.
func TestCaptureBodyExcludesStderr(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osSelf+"\n")
	withTmuxStub(t, "echo 'noise on stderr' >&2; printf 'clean stdout\\n'")

	rec := httptest.NewRecorder()
	handleSessionByName(rec, sessionReq(http.MethodGet, "/sessions/work/capture", "", "alice"))
	if rec.Code != http.StatusOK {
		t.Fatalf("capture: got %d, want 200 (body %q)", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); got != "clean stdout\n" {
		t.Fatalf("capture body: got %q, want stdout only", got)
	}
}
