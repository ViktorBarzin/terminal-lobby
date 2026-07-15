package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// GET /dirs feeds the project directory picker: the candidate directories
// under the calling user's home, scanned by the audited tmux-user-dirlist
// wrapper. The suite clones the copy-mode posture — hermetic tests through the
// real handler with the user map pointed at a fixture and the wrapper binary
// swapped for a stub (dirlistWrapper is a var precisely for this seam).

// withDirlistStub swaps dirlistWrapper for a shell stub running `script`.
// The wrapper takes no arguments, so (unlike the tmux stub) there is no argv
// to record — the script just emits fake dir lines or an error/exit code.
func withDirlistStub(t *testing.T, script string) {
	t.Helper()
	dir := t.TempDir()
	stub := filepath.Join(dir, "dirlist")
	body := "#!/bin/sh\n" + script + "\n"
	if err := os.WriteFile(stub, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	old := dirlistWrapper
	dirlistWrapper = stub
	t.Cleanup(func() { dirlistWrapper = old })
}

func dirsResp(t *testing.T, rec *httptest.ResponseRecorder) (dirs []string, truncated bool) {
	t.Helper()
	var body struct {
		Dirs      []string `json:"dirs"`
		Truncated bool     `json:"truncated"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode /dirs body %q: %v", rec.Body.String(), err)
	}
	return body.Dirs, body.Truncated
}

func TestHandleDirsHappyPath(t *testing.T) {
	osSelf, _ := twoLocalUsers(t) // current user: dirlistCmd skips sudo → stub runs directly
	withUserMap(t, "alice="+osSelf+"\n")
	// Blank lines and trailing whitespace must be dropped/trimmed.
	withDirlistStub(t, "printf '/home/u/code\\n/home/u/code/tripit\\n\\n  /home/u/notes  \\n'")

	rec := httptest.NewRecorder()
	handleDirs(rec, sessionReq(http.MethodGet, "/dirs", "", "alice"))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /dirs: got %d, want 200 (body %q)", rec.Code, rec.Body.String())
	}
	dirs, truncated := dirsResp(t, rec)
	want := []string{"/home/u/code", "/home/u/code/tripit", "/home/u/notes"}
	if strings.Join(dirs, "|") != strings.Join(want, "|") {
		t.Fatalf("dirs: got %v, want %v", dirs, want)
	}
	if truncated {
		t.Fatalf("truncated: got true, want false for a short list")
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("cache-control: got %q, want no-store", cc)
	}
}

func TestHandleDirsTruncatesAtCap(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osSelf+"\n")
	// Emit one more than the response cap → truncated, list clamped to the cap.
	withDirlistStub(t, fmt.Sprintf("seq 1 %d | sed 's|^|/home/u/d|'", maxDirsResponse+1))

	rec := httptest.NewRecorder()
	handleDirs(rec, sessionReq(http.MethodGet, "/dirs", "", "alice"))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /dirs: got %d, want 200", rec.Code)
	}
	dirs, truncated := dirsResp(t, rec)
	if len(dirs) != maxDirsResponse {
		t.Fatalf("dirs length: got %d, want cap %d", len(dirs), maxDirsResponse)
	}
	if !truncated {
		t.Fatalf("truncated: got false, want true past the cap")
	}
}

func TestHandleDirsWrapperFailureIs500(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osSelf+"\n")
	withDirlistStub(t, `echo "fd: boom" >&2; exit 1`)

	rec := httptest.NewRecorder()
	handleDirs(rec, sessionReq(http.MethodGet, "/dirs", "", "alice"))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("wrapper failure: got %d, want 500", rec.Code)
	}
}

func TestHandleDirsMethodAndAuthGuards(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	cases := []struct {
		name     string
		method   string
		auth     string
		wantCode int
	}{
		{"rejects POST", http.MethodPost, "alice", http.StatusMethodNotAllowed},
		{"missing auth header", http.MethodGet, "", http.StatusUnauthorized},
		{"unmapped user forbidden", http.MethodGet, "stranger", http.StatusForbidden},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			withUserMap(t, "alice="+osSelf+"\n")
			withDirlistStub(t, "printf '/home/u/code\\n'")
			rec := httptest.NewRecorder()
			handleDirs(rec, sessionReq(tc.method, "/dirs", "", tc.auth))
			if rec.Code != tc.wantCode {
				t.Fatalf("%s: got %d, want %d", tc.name, rec.Code, tc.wantCode)
			}
		})
	}
}
