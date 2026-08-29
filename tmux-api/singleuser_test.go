package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os/user"
	"testing"

	"terminal-lobby/authuser"
)

// Single-user is the default for a fresh install and the only mode the
// container runs, and until this existed no service-level test exercised it —
// every hermetic TestMain pins the gate to multi-user. That gap is why a data
// race in Gate.self() and the /home/<self> containment path both went unnoticed.
//
// withSingleUser swaps the gate for the duration of one test.
func withSingleUser(t *testing.T) string {
	t.Helper()
	me, err := user.Current()
	if err != nil {
		t.Fatalf("user.Current: %v", err)
	}
	old := actAsGate
	actAsGate = &authuser.Gate{
		AdminsPath: t.TempDir() + "/no-admins",
		MapPath:    t.TempDir() + "/no-user-map",
		Config:     authuser.Config{MultiUser: "off"},
	}
	t.Cleanup(func() { actAsGate = old })
	return me.Username
}

func singleUserReq(method, path, authUser string) *http.Request {
	r := httptest.NewRequest(method, path, nil)
	if authUser != "" {
		r.Header.Set(authHeader, authUser)
	}
	return r
}

// Whatever the proxy says the username is, the account is the one this process
// runs as. No user map is consulted, so a stale map cannot influence it.
func TestSingleUserResolvesEveryIdentityToTheInvokingUser(t *testing.T) {
	me := withSingleUser(t)
	for _, sent := range []string{"alice", "someone.else", "alice@example.com"} {
		rec := httptest.NewRecorder()
		got := resolveOSUser(rec, singleUserReq(http.MethodGet, "/sessions", sent))
		if got != me {
			t.Fatalf("identity %q resolved to %q, want %q (status %d)", sent, got, me, rec.Code)
		}
	}
}

// The header still has to be there: its presence is what says the request came
// through a proxy rather than straight at the port.
func TestSingleUserStillNeedsAnIdentityHeader(t *testing.T) {
	withSingleUser(t)
	rec := httptest.NewRecorder()
	if got := resolveOSUser(rec, singleUserReq(http.MethodGet, "/sessions", "")); got != "" {
		t.Fatalf("resolved %q with no identity header", got)
	}
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("no identity header got %d, want 401", rec.Code)
	}
}

// /whoami is what the frontend gates its features on, so the flag has to be
// right at the HTTP boundary and not merely inside the gate.
func TestSingleUserWhoamiReportsTheMode(t *testing.T) {
	me := withSingleUser(t)
	rec := httptest.NewRecorder()
	handleWhoami(rec, singleUserReq(http.MethodGet, "/whoami", "alice"))
	if rec.Code != http.StatusOK {
		t.Fatalf("whoami: %d %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("whoami is not JSON: %v", err)
	}
	if body["multiUser"] != false {
		t.Fatalf("multiUser = %v, want false", body["multiUser"])
	}
	if body["osUser"] != me {
		t.Fatalf("osUser = %v, want %q", body["osUser"], me)
	}
	if body["admin"] != false {
		t.Fatalf("admin = %v, want false — single-user has no second account", body["admin"])
	}
	if _, switched := body["realUser"]; switched {
		t.Fatal("realUser is present; nothing was acting as anyone")
	}
}

// There is no second account, so asking to be one is refused rather than
// silently ignored.
func TestSingleUserRefusesActAs(t *testing.T) {
	withSingleUser(t)
	rec := httptest.NewRecorder()
	if got := resolveOSUser(rec, singleUserReq(http.MethodGet, "/sessions?as=root", "alice")); got != "" {
		t.Fatalf("act-as resolved %q in single-user mode", got)
	}
	if rec.Code != http.StatusForbidden {
		t.Fatalf("act-as got %d, want 403", rec.Code)
	}
}

// Naming yourself is the no-op case and must behave like no parameter at all,
// so a client that always sends ?as= is not a special case.
func TestSingleUserAllowsActingAsYourself(t *testing.T) {
	me := withSingleUser(t)
	rec := httptest.NewRecorder()
	got := resolveOSUser(rec, singleUserReq(http.MethodGet, "/sessions?as="+me, "alice"))
	if got != me {
		t.Fatalf("?as=<self> resolved %q, want %q (status %d)", got, me, rec.Code)
	}
}

// The pickers must offer the one account rather than an empty list, which is
// what the frontend would otherwise render as a broken dialog.
func TestSingleUserListsOnlyTheOneAccount(t *testing.T) {
	me := withSingleUser(t)
	if got := mappedOSUsers(); len(got) != 1 || got[0] != me {
		t.Fatalf("mappedOSUsers = %v, want [%q]", got, me)
	}
	if !isMappedOSUser(me) {
		t.Fatalf("%q is not reported as a terminal account", me)
	}
	if isMappedOSUser("nobody-else") {
		t.Fatal("an account that does not exist here is reported as a target")
	}
}
