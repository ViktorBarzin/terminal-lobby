package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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

// --- a UI kill must not be undoable by Restore ---------------------------------
//
// POST /restore shells tmux-persist, which recreates every row of
// /var/lib/tmux-persist/<user>.tsv that is not currently live. That manifest is
// rewritten only every 5 minutes (tmux-persist-save.timer), so a session killed
// through the UI stays in it and the sidebar's Restore button brings it back —
// and a row carrying a claude uuid comes back as `claude --resume <uuid>`,
// restarting a conversation the user chose to end. killSession therefore has to
// drop the name from the manifest, the same way it already drops the layout
// assignment. Deaths OUTSIDE the API never reach killSession, so the crash /
// OOM recovery the feature exists for is untouched.

// withSudoStub swaps sudoBinary for a shell stub that appends its argv — one
// arg per line — to a file, then runs `script`. Returns the argv file path; a
// missing file means sudo was never invoked. Mirrors withTmuxStub.
func withSudoStub(t *testing.T, script string) string {
	t.Helper()
	dir := t.TempDir()
	argvFile := filepath.Join(dir, "sudo-argv")
	stub := filepath.Join(dir, "sudo")
	body := "#!/bin/sh\nprintf '%s\\n' \"$@\" >> '" + argvFile + "'\n" + script + "\n"
	if err := os.WriteFile(stub, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	old := sudoBinary
	sudoBinary = stub
	t.Cleanup(func() { sudoBinary = old })
	return argvFile
}

// withTempLayoutStore points layoutStoreInstance at a scratch dir so a kill
// test cannot touch the real /var/lib/tmux-api/layout of whoever runs `go test`.
func withTempLayoutStore(t *testing.T) {
	t.Helper()
	old := layoutStoreInstance
	layoutStoreInstance = newLayoutStore(t.TempDir())
	t.Cleanup(func() { layoutStoreInstance = old })
}

func TestKillSessionForgetsPersistedSession(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)        // caller == current user: tmuxCmd skips sudo,
	withUserMap(t, "alice="+osSelf+"\n") // so the sudo stub only ever sees the forget
	withTempLayoutStore(t)
	withTmuxStub(t, "exit 0")
	sudoArgv := withSudoStub(t, "exit 0")

	rec := httptest.NewRecorder()
	handleSessionByName(rec, sessionReq(http.MethodDelete, "/sessions/qa-restore", "", "alice"))

	if rec.Code != http.StatusNoContent {
		t.Fatalf("DELETE /sessions/qa-restore: got %d, want %d", rec.Code, http.StatusNoContent)
	}
	want := "-n\n" + persistForgetWrapper + "\n" + osSelf + "\nqa-restore\n"
	if got := recordedArgv(t, sudoArgv); got != want {
		t.Fatalf("forget invocation:\ngot  %q\nwant %q", got, want)
	}
}

// A kill that did not happen must not forget anything: the session is either
// unknown or died out of band, and the out-of-band case is exactly what restore
// exists to recover.
func TestKillSessionFailureLeavesManifestAlone(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osSelf+"\n")
	withTempLayoutStore(t)
	withTmuxStub(t, `echo "can't find session: gone" >&2; exit 1`)
	sudoArgv := withSudoStub(t, "exit 0")

	rec := httptest.NewRecorder()
	handleSessionByName(rec, sessionReq(http.MethodDelete, "/sessions/gone", "", "alice"))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("DELETE of a dead session: got %d, want %d", rec.Code, http.StatusNotFound)
	}
	if got := recordedArgv(t, sudoArgv); got != "" {
		t.Fatalf("forget ran after a failed kill: %q", got)
	}
}

// The tmux session is already gone by the time the manifest is touched, so a
// forget that fails must be logged, not turned into a 500 the UI would show as
// "kill failed" for a session that is in fact dead.
func TestKillSessionSucceedsWhenForgetFails(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osSelf+"\n")
	withTempLayoutStore(t)
	withTmuxStub(t, "exit 0")
	withSudoStub(t, `echo "tmux-persist-forget: boom" >&2; exit 2`)

	rec := httptest.NewRecorder()
	handleSessionByName(rec, sessionReq(http.MethodDelete, "/sessions/qa-restore", "", "alice"))

	if rec.Code != http.StatusNoContent {
		t.Fatalf("DELETE with a failing forget: got %d, want %d", rec.Code, http.StatusNoContent)
	}
}
