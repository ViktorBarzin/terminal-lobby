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

	"terminal-lobby/authuser"
)

// withAdmins points the act-as gate at a fixture admin list, the same seam
// shape as withUserMap. Production reads /etc/ttyd-admins, written by the
// hourly reconcile from roster.yaml's `tier: admin`.
func withAdmins(t *testing.T, content string) {
	t.Helper()
	f := filepath.Join(t.TempDir(), "ttyd-admins")
	if err := os.WriteFile(f, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	old := actAsGate
	actAsGate = &authuser.Gate{AdminsPath: f}
	t.Cleanup(func() { actAsGate = old })
}

// actAsFixture wires a two-user map plus an admin list naming the first user,
// and returns (admin, other). Both are real accounts on this host so
// resolveOSUser's user.Lookup gate passes without depending on deploy state.
func actAsFixture(t *testing.T) (string, string) {
	t.Helper()
	admin, other := twoLocalUsers(t)
	withUserMap(t, fmt.Sprintf("adminauth=%s\notherauth=%s\n", admin, other))
	withAdmins(t, admin+"\n")
	return admin, other
}

// The regression that matters most: every request the lobby has ever made
// carries no ?as=, and must resolve exactly as it did before this feature.
func TestResolveOSUserIgnoresAbsentActAs(t *testing.T) {
	admin, other := actAsFixture(t)
	for auth, want := range map[string]string{"adminauth": admin, "otherauth": other} {
		rec := httptest.NewRecorder()
		got := resolveOSUser(rec, projectsReq(http.MethodGet, "/sessions", "", auth))
		if got != want {
			t.Fatalf("%s with no ?as=: resolved %q, want %q", auth, got, want)
		}
		if rec.Code != http.StatusOK {
			t.Fatalf("%s with no ?as=: wrote status %d", auth, rec.Code)
		}
	}
}

func TestAdminActsAsAnotherMappedUser(t *testing.T) {
	_, other := actAsFixture(t)
	rec := httptest.NewRecorder()
	got := resolveOSUser(rec, projectsReq(http.MethodGet, "/sessions?as="+other, "", "adminauth"))
	if got != other {
		t.Fatalf("admin ?as=%s resolved %q, want %s", other, got, other)
	}
}

func TestNonAdminActAsIsRefused(t *testing.T) {
	admin, _ := actAsFixture(t)
	rec := httptest.NewRecorder()
	got := resolveOSUser(rec, projectsReq(http.MethodGet, "/sessions?as="+admin, "", "otherauth"))
	if got != "" {
		t.Fatalf("non-admin ?as=%s resolved %q, want refusal", admin, got)
	}
	if rec.Code != http.StatusForbidden {
		t.Fatalf("non-admin ?as=: status %d, want 403", rec.Code)
	}
}

// "Unmapped" means absent from /etc/ttyd-user-map, whether or not the account
// exists on the box — being a real Unix user is not authorization. The targets
// below are chosen to be outside the fixture map (twoLocalUsers can hand back
// root, so it cannot be one of them).
func TestAdminActAsUnmappedUserIsRefused(t *testing.T) {
	admin, other := actAsFixture(t)
	for _, target := range []string{"daemon", "nosuchuser", "../wizard"} {
		if target == admin || target == other {
			t.Fatalf("fixture collision: %q is mapped, pick another target", target)
		}
		rec := httptest.NewRecorder()
		if got := resolveOSUser(rec, projectsReq(http.MethodGet, "/sessions?as="+target, "", "adminauth")); got != "" {
			t.Fatalf("admin ?as=%s resolved %q, want refusal", target, got)
		}
		if rec.Code != http.StatusForbidden {
			t.Fatalf("admin ?as=%s: status %d, want 403", target, rec.Code)
		}
	}
}

// Acting as yourself is a no-op, not a privilege — a non-admin whose client
// always sends the parameter must not be locked out of their own lobby.
func TestActingAsYourselfNeedsNoPrivilege(t *testing.T) {
	_, other := actAsFixture(t)
	rec := httptest.NewRecorder()
	got := resolveOSUser(rec, projectsReq(http.MethodGet, "/sessions?as="+other, "", "otherauth"))
	if got != other {
		t.Fatalf("self ?as= resolved %q, want %s", got, other)
	}
}

// With no admin list on the box nobody may act as anyone: the feature is
// unavailable rather than open.
func TestActAsFailsClosedWithoutAnAdminList(t *testing.T) {
	admin, other := twoLocalUsers(t)
	withUserMap(t, fmt.Sprintf("adminauth=%s\notherauth=%s\n", admin, other))
	old := actAsGate
	actAsGate = &authuser.Gate{AdminsPath: filepath.Join(t.TempDir(), "absent")}
	t.Cleanup(func() { actAsGate = old })

	rec := httptest.NewRecorder()
	if got := resolveOSUser(rec, projectsReq(http.MethodGet, "/sessions?as="+other, "", "adminauth")); got != "" {
		t.Fatalf("resolved %q with no admin list, want refusal", got)
	}
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status %d, want 403", rec.Code)
	}
}

// --- push subscriptions do NOT follow the switch ----------------------------

// The SPA refreshes its push registration on boot. If that followed the
// switch, an as-bob tab would enrol this browser as one of bob's devices and
// keep delivering bob's session notifications here long after the tab closed —
// state that outlives the switch, which is why this endpoint alone resolves
// the REAL caller.
func TestPushSubscriptionsResolveTheRealCallerNotTheActAsTarget(t *testing.T) {
	admin, other := actAsFixture(t)
	store := swapPushStore(t)

	body := `{"endpoint":"https://push.example/abc","keys":{"p256dh":"k","auth":"a"}}`
	req := httptest.NewRequest(http.MethodPut, "/push-subscriptions?as="+other, strings.NewReader(body))
	req.Header.Set(authHeader, "adminauth")
	rec := httptest.NewRecorder()
	handlePushSubscriptions(rec, req)
	if rec.Code != http.StatusNoContent && rec.Code != http.StatusOK {
		t.Fatalf("PUT ?as=%s: status %d body %q", other, rec.Code, rec.Body.String())
	}

	mine, err := store.list(admin)
	if err != nil {
		t.Fatalf("list(%s): %v", admin, err)
	}
	if len(mine) != 1 {
		t.Fatalf("admin has %d subscriptions, want 1 — the write followed the switch", len(mine))
	}
	theirs, err := store.list(other)
	if err != nil {
		t.Fatalf("list(%s): %v", other, err)
	}
	if len(theirs) != 0 {
		t.Fatalf("%s gained %d subscriptions from an as-tab; push must not follow", other, len(theirs))
	}
}

// --- /whoami reports both identities ----------------------------------------

// The chip and the tinted frame are driven by this: the SPA has to be able to
// tell "I am bob" from "I am wizard acting as bob" without trusting its own
// URL, so the server names both.
func TestWhoamiNamesBothIdentitiesWhileActingAs(t *testing.T) {
	admin, other := actAsFixture(t)
	rec := httptest.NewRecorder()
	handleWhoami(rec, projectsReq(http.MethodGet, "/whoami?as="+other, "", "adminauth"))
	if rec.Code != http.StatusOK {
		t.Fatalf("whoami ?as=: status %d", rec.Code)
	}
	var got struct {
		Authentik string `json:"authentik"`
		OSUser    string `json:"osUser"`
		RealUser  string `json:"realUser"`
		Admin     bool   `json:"admin"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode whoami: %v (%s)", err, rec.Body.String())
	}
	if got.OSUser != other {
		t.Fatalf("osUser = %q, want %q (the acted-as identity)", got.OSUser, other)
	}
	if got.RealUser != admin {
		t.Fatalf("realUser = %q, want %q (the actual caller)", got.RealUser, admin)
	}
	if !got.Admin {
		t.Fatal("admin = false for an admin caller; the Settings picker is gated on it")
	}
}

// Ordinary use: realUser is omitted when it equals osUser, so the SPA's
// "am I switched?" check is simply "is realUser present".
func TestWhoamiOmitsRealUserWhenNotActingAs(t *testing.T) {
	_, other := actAsFixture(t)
	rec := httptest.NewRecorder()
	handleWhoami(rec, projectsReq(http.MethodGet, "/whoami", "", "otherauth"))
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode whoami: %v", err)
	}
	if got["osUser"] != other {
		t.Fatalf("osUser = %v, want %s", got["osUser"], other)
	}
	if _, present := got["realUser"]; present {
		t.Fatalf("realUser present (%v) for an unswitched caller", got["realUser"])
	}
	if got["admin"] != false {
		t.Fatalf("admin = %v for a non-admin, want false", got["admin"])
	}
}
