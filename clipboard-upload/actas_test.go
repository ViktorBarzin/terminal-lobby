package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// withAdmins points the act-as gate at a fixture admin list. Production reads
// /etc/ttyd-admins, written by the hourly reconcile from roster.yaml.
func withAdmins(t *testing.T, content string) {
	t.Helper()
	f := filepath.Join(t.TempDir(), "ttyd-admins")
	if err := os.WriteFile(f, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	old := actAsGate
	// Copy rather than replace: the gate also carries the map path and the
	// mode, which withUserMap and TestMain have already set.
	next := *actAsGate
	next.AdminsPath = f
	actAsGate = &next
	t.Cleanup(func() { actAsGate = old })
}

// This service never execs as the user — it only needs a directory name under
// /var/lib/clipboard-store — so the fixture users need not exist on the host.
func actAsFixture(t *testing.T) {
	t.Helper()
	withUserMap(t, "adminauth=wizard\notherauth=bob\n")
	withAdmins(t, "wizard\n")
}

func actAsReq(target, auth string) *http.Request {
	url := "/list?session=main"
	if target != "" {
		url += "&as=" + target
	}
	r := httptest.NewRequest(http.MethodGet, url, nil)
	r.Header.Set(authHeader, auth)
	return r
}

func TestGalleryIgnoresAbsentActAs(t *testing.T) {
	actAsFixture(t)
	for auth, want := range map[string]string{"adminauth": "wizard", "otherauth": "bob"} {
		rec := httptest.NewRecorder()
		if got := resolveOSUser(rec, actAsReq("", auth)); got != want {
			t.Fatalf("%s with no ?as=: resolved %q, want %q", auth, got, want)
		}
	}
}

// The gallery is per-(user, session) under a service-owned store, so acting as
// bob simply reads bob's directory — no privilege drop needed, unlike files.
func TestGalleryAdminActsAsAnotherMappedUser(t *testing.T) {
	actAsFixture(t)
	rec := httptest.NewRecorder()
	if got := resolveOSUser(rec, actAsReq("bob", "adminauth")); got != "bob" {
		t.Fatalf("admin ?as=bob resolved %q", got)
	}
}

func TestGalleryNonAdminActAsIsRefused(t *testing.T) {
	actAsFixture(t)
	rec := httptest.NewRecorder()
	if got := resolveOSUser(rec, actAsReq("wizard", "otherauth")); got != "" {
		t.Fatalf("non-admin ?as=wizard resolved %q, want refusal", got)
	}
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status %d, want 403", rec.Code)
	}
}

func TestGalleryAdminActAsUnmappedUserIsRefused(t *testing.T) {
	actAsFixture(t)
	for _, target := range []string{"root", "nosuchuser", "../wizard"} {
		rec := httptest.NewRecorder()
		if got := resolveOSUser(rec, actAsReq(target, "adminauth")); got != "" {
			t.Fatalf("admin ?as=%s resolved %q, want refusal", target, got)
		}
		if rec.Code != http.StatusForbidden {
			t.Fatalf("admin ?as=%s: status %d, want 403", target, rec.Code)
		}
	}
}

// /register is a localhost callback that self-reports its user and carries no
// Authentik header at all. It must stay unaffected — the act-as branch only
// runs once a header-derived caller exists.
func TestGalleryUnauthenticatedPathIsUnchanged(t *testing.T) {
	actAsFixture(t)
	rec := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/list?session=main&as=bob", nil)
	if got := resolveOSUser(rec, r); got != "" {
		t.Fatalf("headerless request resolved %q, want empty", got)
	}
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("headerless request: status %d, want 401", rec.Code)
	}
}
