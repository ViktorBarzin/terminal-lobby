package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/user"
	"path/filepath"
	"testing"

	"terminal-lobby/authuser"
)

// The Text view's cross-user reader is deliberately not built yet: this
// service reads /home/<user>/.claude/projects directly, other homes are 0750,
// and its tail polls every 200 ms — so it needs a persistent streaming child
// rather than the per-operation sudo re-exec file-api uses.
//
// What it must NOT do in the meantime is ignore ?as= and serve the CALLER's
// own transcripts under the target's name. These tests pin the refusal.

func actAsEnv(t *testing.T) (mapPath string, admin, other string) {
	t.Helper()
	me, err := user.Current()
	if err != nil {
		t.Fatalf("user.Current: %v", err)
	}
	admin = me.Username
	other = "root"
	if admin == "root" {
		other = "nobody"
	}
	if _, err := user.Lookup(other); err != nil {
		t.Skipf("no second local account: %v", err)
	}

	dir := t.TempDir()
	mapPath = filepath.Join(dir, "user-map")
	if err := os.WriteFile(mapPath, []byte(fmt.Sprintf("adminauth=%s\notherauth=%s\n", admin, other)), 0o644); err != nil {
		t.Fatal(err)
	}
	adminsPath := filepath.Join(dir, "ttyd-admins")
	if err := os.WriteFile(adminsPath, []byte(admin+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	old := actAsGate
	actAsGate = &authuser.Gate{AdminsPath: adminsPath}
	t.Cleanup(func() { actAsGate = old })
	return mapPath, admin, other
}

// reached records whether the wrapped handler ran, and as whom.
func probeHandler(seen *string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*seen = osUserFrom(r.Context())
		w.WriteHeader(http.StatusOK)
	})
}

func TestActAsIsRefusedRatherThanServingTheCallersOwnTranscripts(t *testing.T) {
	mapPath, _, other := actAsEnv(t)
	var seen string
	h := authMiddleware(mapPath, probeHandler(&seen))

	req := httptest.NewRequest(http.MethodGet, "/events/main?as="+other, nil)
	req.Header.Set(authHeader, "adminauth")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if seen != "" {
		t.Fatalf("handler ran as %q; an act-as request must not reach it while "+
			"the cross-user reader is unbuilt — it would serve the caller's own transcripts", seen)
	}
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("status %d, want 501 (a clear 'not available here', not wrong data)", rec.Code)
	}
}

// A non-admin asking is refused for the ordinary reason, and distinguishably.
func TestSessionEventsNonAdminActAsIsForbidden(t *testing.T) {
	mapPath, admin, _ := actAsEnv(t)
	var seen string
	h := authMiddleware(mapPath, probeHandler(&seen))

	req := httptest.NewRequest(http.MethodGet, "/events/main?as="+admin, nil)
	req.Header.Set(authHeader, "otherauth")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if seen != "" {
		t.Fatalf("handler ran as %q for a refused act-as", seen)
	}
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status %d, want 403", rec.Code)
	}
}

// Ordinary requests, and a request naming yourself, are untouched.
func TestSessionEventsWithoutActAsIsUnchanged(t *testing.T) {
	mapPath, _, other := actAsEnv(t)
	for _, target := range []string{"", other} {
		var seen string
		h := authMiddleware(mapPath, probeHandler(&seen))
		url := "/events/main"
		if target != "" {
			url += "?as=" + target
		}
		req := httptest.NewRequest(http.MethodGet, url, nil)
		req.Header.Set(authHeader, "otherauth")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("?as=%q: status %d, want 200", target, rec.Code)
		}
		if seen != other {
			t.Fatalf("?as=%q: handler ran as %q, want %s", target, seen, other)
		}
	}
}
