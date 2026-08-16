package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// fakeTmuxAPI is an httptest stand-in for tmux-api. It answers the two routes
// the syncer uses and records what it was asked, including the auth header —
// which is the part a syncer running as an OS user has to get right.
type fakeTmuxAPI struct {
	*httptest.Server
	mu      sync.Mutex
	calls   []string // "<METHOD> <path> <auth> <body>"
	status  map[string]int
	renamed map[string]string
}

func newFakeTmuxAPI(t *testing.T) *fakeTmuxAPI {
	t.Helper()
	f := &fakeTmuxAPI{status: map[string]int{}, renamed: map[string]string{}}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := readAllString(r)
		f.mu.Lock()
		f.calls = append(f.calls, r.Method+" "+r.URL.Path+" "+r.Header.Get("X-Authentik-Username")+" "+body)
		status, forced := f.status[r.URL.Path]
		f.mu.Unlock()

		if forced {
			http.Error(w, http.StatusText(status), status)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/rename") {
			var payload struct {
				Name string `json:"name"`
			}
			if err := json.Unmarshal([]byte(body), &payload); err != nil {
				http.Error(w, "invalid body", http.StatusBadRequest)
				return
			}
			old := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/sessions/"), "/rename")
			f.mu.Lock()
			f.renamed[old] = payload.Name
			f.mu.Unlock()
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(f.Close)
	return f
}

func (f *fakeTmuxAPI) seenCalls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.calls))
	copy(out, f.calls)
	return out
}

func (f *fakeTmuxAPI) forceStatus(path string, status int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.status[path] = status
}

func readAllString(r *http.Request) (string, error) {
	if r.Body == nil {
		return "", nil
	}
	defer r.Body.Close()
	var sb strings.Builder
	buf := make([]byte, 4096)
	for {
		n, err := r.Body.Read(buf)
		sb.Write(buf[:n])
		if err != nil {
			return sb.String(), nil
		}
	}
}

// Renaming goes THROUGH tmux-api rather than through tmux, so the project
// assignment and the layout follow the new name. A bare `tmux rename-session`
// would leave the session silently out of its project.
func TestTmuxAPIRename(t *testing.T) {
	f := newFakeTmuxAPI(t)
	api := NewTmuxAPI(f.URL, "alice")

	if err := api.Rename(context.Background(), "feat-header", "polish-header"); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	calls := f.seenCalls()
	if len(calls) != 1 {
		t.Fatalf("made %d calls, want 1: %v", len(calls), calls)
	}
	want := `POST /sessions/feat-header/rename alice {"name":"polish-header"}`
	if calls[0] != want {
		t.Errorf("call = %q, want %q", calls[0], want)
	}
	if got := f.renamed["feat-header"]; got != "polish-header" {
		t.Errorf("session renamed to %q", got)
	}
}

func TestTmuxAPIKill(t *testing.T) {
	f := newFakeTmuxAPI(t)
	api := NewTmuxAPI(f.URL, "alice")

	if err := api.Kill(context.Background(), "doomed"); err != nil {
		t.Fatalf("Kill: %v", err)
	}
	calls := f.seenCalls()
	if len(calls) != 1 || !strings.HasPrefix(calls[0], "DELETE /sessions/doomed ") {
		t.Errorf("calls = %v, want one DELETE /sessions/doomed", calls)
	}
}

// A session that is already gone is the end state a kill was asking for. The
// syncer races tmux constantly (a Claude can exit between the snapshot and the
// dispatch), so this has to be success rather than a retry forever.
func TestTmuxAPIKillTreatsMissingAsDone(t *testing.T) {
	f := newFakeTmuxAPI(t)
	f.forceStatus("/sessions/already-gone", http.StatusNotFound)
	api := NewTmuxAPI(f.URL, "alice")

	if err := api.Kill(context.Background(), "already-gone"); err != nil {
		t.Errorf("Kill of a missing session returned %v, want nil", err)
	}
}

// A rename cannot succeed against a session that is gone, and saying it did
// would leave T3's title mirroring a name nothing carries. It is still not a
// fault — the next pass simply will not plan it.
func TestTmuxAPIRenameReportsGone(t *testing.T) {
	f := newFakeTmuxAPI(t)
	f.forceStatus("/sessions/vanished/rename", http.StatusNotFound)
	api := NewTmuxAPI(f.URL, "alice")

	err := api.Rename(context.Background(), "vanished", "whatever")
	if err == nil {
		t.Fatal("Rename of a missing session returned nil")
	}
	var apiErr *TmuxAPIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("error %v is not a *TmuxAPIError", err)
	}
	if !apiErr.Gone() {
		t.Errorf("Gone() = false for a 404: %v", apiErr)
	}
}

func TestTmuxAPIRenameReportsConflict(t *testing.T) {
	f := newFakeTmuxAPI(t)
	f.forceStatus("/sessions/a/rename", http.StatusConflict)
	api := NewTmuxAPI(f.URL, "alice")

	err := api.Rename(context.Background(), "a", "taken")
	var apiErr *TmuxAPIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("error %v is not a *TmuxAPIError", err)
	}
	if apiErr.Status != http.StatusConflict {
		t.Errorf("Status = %d, want 409", apiErr.Status)
	}
	if apiErr.Gone() {
		t.Error("a 409 reported Gone()")
	}
}

// tmux-api rejects a name its own regex would not accept, so the syncer checks
// first: a bad name is a bug on this side, not a request worth making.
func TestTmuxAPIRefusesInvalidNames(t *testing.T) {
	f := newFakeTmuxAPI(t)
	api := NewTmuxAPI(f.URL, "alice")

	for _, name := range []string{"", "has space", "has/slash", strings.Repeat("x", 33), "dots.are.out"} {
		if err := api.Rename(context.Background(), "ok-name", name); err == nil {
			t.Errorf("Rename to %q was allowed", name)
		}
	}
	if calls := f.seenCalls(); len(calls) != 0 {
		t.Errorf("an invalid name still reached the API: %v", calls)
	}
}

// The syncer knows its OS user; tmux-api authenticates by the Authentik
// username. /etc/ttyd-user-map is the mapping both sides already agree on.
func TestAuthUserForOSUser(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "ttyd-user-map")
	content := `# Generated from roster.yaml by roster_engine.py — DO NOT EDIT BY HAND.
# <authentik_user>=<os_user>; consumed by t3-dispatch.
alice=wizard
bob.smith=bob
ancaelena98=carol

bad-line-without-equals
=nobody
someone=withextras:and:colons
`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write map: %v", err)
	}

	cases := []struct {
		osUser string
		want   string
		found  bool
	}{
		{"wizard", "alice", true},
		{"bob", "bob.smith", true},
		{"carol", "ancaelena98", true},
		{"withextras", "someone", true}, // the ":..." suffix is not part of the OS user
		{"nobody", "", false},
		{"stranger", "", false},
	}
	for _, c := range cases {
		got, ok := AuthUserForOSUser(path, c.osUser)
		if ok != c.found || got != c.want {
			t.Errorf("AuthUserForOSUser(%q) = (%q, %v), want (%q, %v)", c.osUser, got, ok, c.want, c.found)
		}
	}

	if _, ok := AuthUserForOSUser(filepath.Join(dir, "missing"), "wizard"); ok {
		t.Error("a missing map file reported a mapping")
	}
}
