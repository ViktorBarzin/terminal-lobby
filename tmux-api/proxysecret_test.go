package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"terminal-lobby/authuser"
)

// tmux-api binds 0.0.0.0:7684 when the proxy lives elsewhere, and the identity
// header is written by whoever sends the request. TL_PROXY_SECRET is what makes
// that header worth something: a request carrying a valid identity and no
// secret has to be refused once one is configured, and every request has to
// keep working while none is, or the upgrade takes the lobby down before an
// operator can set it.
//
// The check itself lives once, in authuser. This pins that a real service's
// resolve path actually runs it, in both states.
func TestProxySecretGatesTheServiceResolvePath(t *testing.T) {
	admin, _ := actAsFixture(t)

	rec := httptest.NewRecorder()
	if got := resolveOSUser(rec, projectsReq(http.MethodGet, "/sessions", "", "adminauth")); got != admin {
		t.Fatalf("no secret configured: resolved %q, want %q (status %d)", got, admin, rec.Code)
	}

	old := actAsGate
	next := *actAsGate
	next.Config.ProxySecret = "s3cret"
	actAsGate = &next
	t.Cleanup(func() { actAsGate = old })

	rec = httptest.NewRecorder()
	if got := resolveOSUser(rec, projectsReq(http.MethodGet, "/sessions", "", "adminauth")); got != "" {
		t.Fatalf("secret configured, none sent: resolved %q, want a refusal", got)
	}
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("secret configured, none sent: status %d, want 401", rec.Code)
	}

	req := projectsReq(http.MethodGet, "/sessions", "", "adminauth")
	req.Header.Set(authuser.SecretHeader, "wrong")
	rec = httptest.NewRecorder()
	if got := resolveOSUser(rec, req); got != "" || rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong secret: resolved %q status %d, want a 401", got, rec.Code)
	}

	req = projectsReq(http.MethodGet, "/sessions", "", "adminauth")
	req.Header.Set(authuser.SecretHeader, "s3cret")
	rec = httptest.NewRecorder()
	if got := resolveOSUser(rec, req); got != admin {
		t.Fatalf("correct secret: resolved %q, want %q (status %d)", got, admin, rec.Code)
	}
}
