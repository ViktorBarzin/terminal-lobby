package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/user"
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

// twoLocalUsers returns two DISTINCT accounts that exist on this host, so
// resolveOSUser's user.Lookup gate passes without depending on deploy state.
// Mirrors the tmux-api test helper of the same name.
func twoLocalUsers(t *testing.T) (string, string) {
	t.Helper()
	me, err := user.Current()
	if err != nil {
		t.Fatalf("user.Current: %v", err)
	}
	other := "root"
	if me.Username == "root" {
		other = "nobody"
	}
	if _, err := user.Lookup(other); err != nil {
		t.Skipf("no second local account to test with: %v", err)
	}
	return me.Username, other
}

// actAsFixture maps two real local accounts and makes the first an admin, so
// resolveOSUser's user.Lookup gate passes without depending on deploy state.
func actAsFixture(t *testing.T) (string, string) {
	t.Helper()
	admin, other := twoLocalUsers(t)
	withUserMap(t, fmt.Sprintf("adminauth=%s\notherauth=%s\n", admin, other))
	withAdmins(t, admin+"\n")
	return admin, other
}

func actAsReq(target, auth string) *http.Request {
	url := "/files/list?dir=/tmp"
	if target != "" {
		url += "&as=" + target
	}
	r := httptest.NewRequest(http.MethodGet, url, nil)
	r.Header.Set(authHeader, auth)
	return r
}

// The regression that matters most: every file-api request the lobby has ever
// made carries no ?as=, and must resolve exactly as before.
func TestFileAPIIgnoresAbsentActAs(t *testing.T) {
	admin, other := actAsFixture(t)
	for auth, want := range map[string]string{"adminauth": admin, "otherauth": other} {
		rec := httptest.NewRecorder()
		if got := resolveOSUser(rec, actAsReq("", auth)); got != want {
			t.Fatalf("%s with no ?as=: resolved %q, want %q", auth, got, want)
		}
	}
}

func TestFileAPIAdminActsAsAnotherMappedUser(t *testing.T) {
	_, other := actAsFixture(t)
	rec := httptest.NewRecorder()
	if got := resolveOSUser(rec, actAsReq(other, "adminauth")); got != other {
		t.Fatalf("admin ?as=%s resolved %q", other, got)
	}
}

func TestFileAPINonAdminActAsIsRefused(t *testing.T) {
	admin, _ := actAsFixture(t)
	rec := httptest.NewRecorder()
	if got := resolveOSUser(rec, actAsReq(admin, "otherauth")); got != "" {
		t.Fatalf("non-admin ?as=%s resolved %q, want refusal", admin, got)
	}
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status %d, want 403", rec.Code)
	}
}

func TestFileAPIAdminActAsUnmappedUserIsRefused(t *testing.T) {
	admin, other := actAsFixture(t)
	for _, target := range []string{"daemon", "nosuchuser", "../wizard"} {
		if target == admin || target == other {
			t.Fatalf("fixture collision: %q is mapped, pick another target", target)
		}
		rec := httptest.NewRecorder()
		if got := resolveOSUser(rec, actAsReq(target, "adminauth")); got != "" {
			t.Fatalf("admin ?as=%s resolved %q, want refusal", target, got)
		}
		if rec.Code != http.StatusForbidden {
			t.Fatalf("admin ?as=%s: status %d, want 403", target, rec.Code)
		}
	}
}

// The act-as target reaches userHome() and, for a different user, the privop
// re-exec. Both take the resolved name, so the containment root must be the
// TARGET's home and not the caller's — otherwise an as-bob listing would be
// confined to wizard's tree while running as bob.
func TestFileAPIActAsResolvesToTheTargetsHome(t *testing.T) {
	_, other := actAsFixture(t)
	rec := httptest.NewRecorder()
	got := resolveOSUser(rec, actAsReq(other, "adminauth"))
	if want := filepath.Join(homeBase, other); userHome(got) != want {
		t.Fatalf("containment root %q, want %q", userHome(got), want)
	}
}
