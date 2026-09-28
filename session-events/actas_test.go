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

// An administrator acting as another user reads that user's text view, the
// same way the terminal already lets them attach to that user's sessions
// (tmux-api/shares.go). The cross-user read goes through the persistent
// per-user child (privreader.go); what these tests pin is that the request
// reaches the routes as the TARGET, never as the caller — resolving the caller
// would serve their own transcripts under the target's name.

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

func TestAdminActAsReachesTheRoutesAsTheTarget(t *testing.T) {
	mapPath, admin, other := actAsEnv(t)
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/events/main"},
		{http.MethodGet, "/commands/main"},
		{http.MethodPost, "/prompt/main"},
	} {
		var seen, real string
		h := authMiddleware(mapPath, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			seen, real = osUserFrom(r.Context()), realOSUserFrom(r.Context())
			w.WriteHeader(http.StatusOK)
		}))

		req := httptest.NewRequest(tc.method, tc.path+"?as="+other, nil)
		req.Header.Set(authHeader, "adminauth")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("%s %s: status %d, want 200", tc.method, tc.path, rec.Code)
		}
		if seen != other {
			t.Fatalf("%s %s: handler ran as %q, want the target %q", tc.method, tc.path, seen, other)
		}
		if real != admin {
			t.Fatalf("%s %s: real user %q, want the caller %q", tc.method, tc.path, real, admin)
		}
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

// A refusal from the gate is never cached, and a request it lets through
// reaches the route with no cache header of the gate's making. The picture
// routes are cached for a year, and their contract says their errors carry
// no-store; measured live on 2026-09-26, the 401 and 403 the gate writes in
// front of them went out without it.
func TestGateRefusalsAreNeverCached(t *testing.T) {
	mapPath, admin, _ := actAsEnv(t)
	cases := []struct {
		name, ident, as string
		want            int
	}{
		{"no identity", "", "", http.StatusUnauthorized},
		{"unmapped identity", "nobody-mapped", "", http.StatusForbidden},
		{"non-admin acting as another", "otherauth", admin, http.StatusForbidden},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var seen string
			h := authMiddleware(mapPath, probeHandler(&seen))
			url := "/result/main/toolu_0123456789/image/0"
			if tc.as != "" {
				url += "?as=" + tc.as
			}
			req := httptest.NewRequest(http.MethodGet, url, nil)
			if tc.ident != "" {
				req.Header.Set(authHeader, tc.ident)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("status %d, want %d", rec.Code, tc.want)
			}
			if got := rec.Header().Get("Cache-Control"); got != "no-store" {
				t.Errorf("Cache-Control %q on a refusal, want no-store", got)
			}
		})
	}

	var cc string
	h := authMiddleware(mapPath, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cc = w.Header().Get("Cache-Control")
	}))
	req := httptest.NewRequest(http.MethodGet, "/events/main", nil)
	req.Header.Set(authHeader, "otherauth")
	h.ServeHTTP(httptest.NewRecorder(), req)
	if cc != "" {
		t.Fatalf("the route saw Cache-Control %q set by the gate; it must choose its own", cc)
	}
}
