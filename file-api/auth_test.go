package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"os/user"
	"path/filepath"
	"reflect"
	"testing"
)

// withUserMap points resolveOSUser's map file (mapPath — a var for exactly
// this seam) at a fixture so the real X-Authentik-Username → OS-user path runs
// hermetically. Mirrors the tmux-api test helper.
func withUserMap(t *testing.T, content string) {
	t.Helper()
	f := filepath.Join(t.TempDir(), "user-map")
	if err := os.WriteFile(f, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	old := mapPath
	mapPath = f
	t.Cleanup(func() { mapPath = old })
}

// TestLoadUserMapParsing pins the ported parser: "<auth>=<os>[:<cwd>]" per
// line, comments/blanks/malformed lines ignored, whitespace around '='
// trimmed, the optional :cwd stripped. (Real map lines carry no spaces around
// the ':'; the parser cuts at the first ':' without re-trimming, matching
// tmux-api verbatim, so the fixture uses the on-disk format.)
func TestLoadUserMapParsing(t *testing.T) {
	withUserMap(t, `
# a comment
alice=alice_os
  bob = bob_os

carol=carol_os:/srv/carol
malformed-no-equals
=missing-lhs
missing-rhs=
`)
	got := loadUserMap()
	want := map[string]string{
		"alice": "alice_os",
		"bob":   "bob_os",
		"carol": "carol_os",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("loadUserMap: got %#v, want %#v", got, want)
	}
}

// Missing map file yields an empty map, not a panic.
func TestLoadUserMapMissingFile(t *testing.T) {
	old := mapPath
	mapPath = filepath.Join(t.TempDir(), "does-not-exist")
	t.Cleanup(func() { mapPath = old })
	if got := loadUserMap(); len(got) != 0 {
		t.Fatalf("missing map file: got %#v, want empty", got)
	}
}

// No X-Authentik-Username header → 401 and empty return.
func TestResolveOSUserMissingHeader(t *testing.T) {
	rec := httptest.NewRecorder()
	if got := resolveOSUser(rec, httptest.NewRequest(http.MethodGet, "/files/read", nil)); got != "" {
		t.Fatalf("resolveOSUser returned %q, want empty", got)
	}
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("missing header: got %d, want 401", rec.Code)
	}
}

// Header present but not in the map → 403.
func TestResolveOSUserUnmapped(t *testing.T) {
	withUserMap(t, "alice=alice_os\n")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/files/read", nil)
	req.Header.Set(authHeader, "stranger")
	if got := resolveOSUser(rec, req); got != "" {
		t.Fatalf("resolveOSUser returned %q, want empty", got)
	}
	if rec.Code != http.StatusForbidden {
		t.Fatalf("unmapped user: got %d, want 403", rec.Code)
	}
}

// Mapped to an OS user that does not exist on this host → 500 (user.Lookup
// gate; this service execs file ops as the user in production, like tmux-api).
func TestResolveOSUserUnknownOSUser(t *testing.T) {
	withUserMap(t, "alice=nonexistent_user_zzq_9182\n")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/files/read", nil)
	req.Header.Set(authHeader, "alice")
	if got := resolveOSUser(rec, req); got != "" {
		t.Fatalf("resolveOSUser returned %q, want empty", got)
	}
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("mapped-but-missing OS user: got %d, want 500", rec.Code)
	}
}

// Happy path: a mapped, real OS user is returned, and the @domain suffix on
// the Authentik identity is stripped before the map lookup.
func TestResolveOSUserHappyAndDomainStrip(t *testing.T) {
	me, err := user.Current()
	if err != nil {
		t.Fatalf("user.Current: %v", err)
	}
	withUserMap(t, "alice="+me.Username+"\n")
	for _, header := range []string{"alice", "alice@corp.example.com"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/files/read", nil)
		req.Header.Set(authHeader, header)
		got := resolveOSUser(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("header %q: unexpected status %d (%s)", header, rec.Code, rec.Body.String())
		}
		if got != me.Username {
			t.Fatalf("header %q: resolveOSUser = %q, want %q", header, got, me.Username)
		}
	}
}

// userHome pins the /home/<osUser> containment root against the homeBase seam.
func TestUserHome(t *testing.T) {
	old := homeBase
	homeBase = "/home"
	t.Cleanup(func() { homeBase = old })
	if got := userHome("alice_os"); got != "/home/alice_os" {
		t.Fatalf("userHome: got %q, want /home/alice_os", got)
	}
}
