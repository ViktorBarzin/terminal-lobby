package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
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

// actAs makes `osUser` the user this process counts as, for the length of one
// test.
//
// It matters because tmuxCmd only runs tmuxBinary DIRECTLY when the target user
// is the current one; for anyone else it shells out to `sudo -n -u <osUser>`,
// which a stub installed by withTmuxStub never sees. A test that hardcodes an
// owner therefore only exercises what it means to on a box whose login happens
// to match that name, or one where sudo to that name succeeds. Both are true on
// the devvm and neither is true on a CI runner, so such a test passes locally
// and fails in CI having never run the code it names.
func actAs(t *testing.T, osUser string) {
	t.Helper()
	old := selfUser
	selfUser = osUser
	t.Cleanup(func() { selfUser = old })
}

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
	withUserMap(t, "alice="+osSelf+"\n") // so the sudo stub sees only the wrappers
	withTempLayoutStore(t)
	withTmuxStub(t, "exit 0")
	sudoArgv := withSudoStub(t, "exit 0")

	rec := httptest.NewRecorder()
	handleSessionByName(rec, sessionReq(http.MethodDelete, "/sessions/qa-restore", "", "alice"))

	if rec.Code != http.StatusOK {
		t.Fatalf("DELETE /sessions/qa-restore: got %d, want %d", rec.Code, http.StatusOK)
	}
	// The pre-kill snapshot comes first and is asserted in full by
	// kill_resurrect_test.go; what this test is about is the forget landing
	// after it, with the killed name.
	want := "\n" + persistForgetWrapper + "\n" + osSelf + "\nqa-restore\n"
	if got := recordedArgv(t, sudoArgv); !strings.HasSuffix(got, want) {
		t.Fatalf("forget invocation:\ngot  %q\nwant a run ending in %q", got, want)
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
	// The pre-kill snapshot has run by now, since it has to happen before the
	// kill that turned out to be impossible. It writes snapshot files and
	// nothing else, so it is not what this test is guarding: the forget is.
	if got := recordedArgv(t, sudoArgv); strings.Contains(got, persistForgetWrapper) {
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

	if rec.Code != http.StatusOK {
		t.Fatalf("DELETE with a failing forget: got %d, want %d", rec.Code, http.StatusOK)
	}
}

// tmuxCmd is the one place this service decides whether a tmux call goes
// through sudo, and its argv is what the sudoers grant is written against. It
// carries no -H: the two calls on this box that need one (the attach probe and
// the dirlist wrapper) build their own argv for a different binary, so nothing
// here may grow the flag on their behalf.
func TestTmuxCmdArgv(t *testing.T) {
	oldSelf, oldTmux, oldSudo := selfUser, tmuxBinary, sudoBinary
	t.Cleanup(func() { selfUser, tmuxBinary, sudoBinary = oldSelf, oldTmux, oldSudo })
	selfUser, tmuxBinary, sudoBinary = "wizard", "/opt/stub/tmux", "/opt/stub/sudo"

	own := tmuxCmd("wizard", "list-sessions", "-F", "#{session_name}")
	if strings.Join(own.Args, " ") != "/opt/stub/tmux list-sessions -F #{session_name}" {
		t.Errorf("own user must not go through sudo: %v", own.Args)
	}
	other := tmuxCmd("bob", "list-sessions", "-F", "#{session_name}")
	want := []string{"/opt/stub/sudo", "-n", "-u", "bob", "/opt/stub/tmux", "list-sessions", "-F", "#{session_name}"}
	if strings.Join(other.Args, " ") != strings.Join(want, " ") {
		t.Errorf("argv = %v, want %v", other.Args, want)
	}
	if other.Path != "/opt/stub/sudo" {
		t.Errorf("Path = %q, want the pinned sudo", other.Path)
	}
}
