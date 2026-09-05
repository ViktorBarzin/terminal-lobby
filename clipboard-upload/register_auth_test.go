package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"terminal-lobby/authuser"
)

// /register accepts a self-reported "user" field when the request carries no
// identity header, because the box's own tools (show-image, the clipboard
// helper) have no proxy in front of them. Nothing enforced that such a caller
// was actually local, and with TL_BIND widened for an ingress that lives
// elsewhere, "no proxy in front of it" describes every host that can route to
// port 7683. TL-3: name any mapped user, write into that user's store.
//
// These pin the whole decision: the local tools keep working, a remote caller
// must present identity, and the proxy secret gates it once one is configured.

// registerReq builds a form POST to /register naming an existing image on disk.
func registerReq(t *testing.T, remoteAddr string, form url.Values) *http.Request {
	t.Helper()
	src := filepath.Join(t.TempDir(), "shot.png")
	if err := os.WriteFile(src, realPNG(t), 0o644); err != nil {
		t.Fatal(err)
	}
	form.Set("path", src)
	r := httptest.NewRequest(http.MethodPost, "/register", strings.NewReader(form.Encode()))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	r.RemoteAddr = remoteAddr
	return r
}

func TestRegisterRefusesHeaderlessRequestFromTheNetwork(t *testing.T) {
	withUserMap(t, "qa.tester=qauser\n")
	root := withStore(t)

	r := registerReq(t, "10.0.20.9:44321", url.Values{"user": {"qauser"}, "session": {"s1"}})
	w := httptest.NewRecorder()
	handleRegister(w, r)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("headerless request from the LAN: status %d, want 401", w.Code)
	}
	if names := storedNames(t, root, "qauser", "s1"); len(names) != 0 {
		t.Fatalf("refused request still wrote %v", names)
	}
}

func TestRegisterStillServesTheBoxsOwnTools(t *testing.T) {
	withUserMap(t, "qa.tester=qauser\n")
	root := withStore(t)

	r := registerReq(t, "127.0.0.1:44321", url.Values{"user": {"qauser"}, "session": {"s1"}})
	w := httptest.NewRecorder()
	handleRegister(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("local tool: status %d, want 200 (body %q)", w.Code, w.Body.String())
	}
	if names := storedNames(t, root, "qauser", "s1"); len(names) != 1 {
		t.Fatalf("local register stored %v, want one file", names)
	}
}

// The identity branch has to be selected by the CONFIGURED header name. This
// build read the compiled default, so on a box whose proxy sends
// X-Authentik-Username every /register took the headerless branch.
func TestRegisterReadsTheConfiguredHeaderName(t *testing.T) {
	withUserMap(t, "qa.tester=qauser\n")
	withStore(t)
	old := actAsGate.Config
	actAsGate.Config = authuser.Config{AuthHeader: "X-Authentik-Username"}
	t.Cleanup(func() { actAsGate.Config = old })

	// A remote caller, so only the identity branch can produce a 200.
	r := registerReq(t, "10.0.20.9:44321", url.Values{"session": {"s1"}})
	r.Header.Set("X-Authentik-Username", "qa.tester")
	w := httptest.NewRecorder()
	handleRegister(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("configured header: status %d, want 200 (body %q)", w.Code, w.Body.String())
	}
}

// With a secret configured, a remote caller's identity header is worth nothing
// on its own — that is the whole point of TL_PROXY_SECRET.
func TestRegisterRequiresTheProxySecretWhenConfigured(t *testing.T) {
	withUserMap(t, "qa.tester=qauser\n")
	withStore(t)
	old := actAsGate.Config
	actAsGate.Config = authuser.Config{ProxySecret: "s3cret"}
	t.Cleanup(func() { actAsGate.Config = old })

	form := url.Values{"session": {"s1"}}
	r := registerReq(t, "10.0.20.9:44321", form)
	r.Header.Set(authHeader, "qa.tester")
	w := httptest.NewRecorder()
	handleRegister(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("identity without the secret: status %d, want 401", w.Code)
	}

	r = registerReq(t, "10.0.20.9:44321", form)
	r.Header.Set(authHeader, "qa.tester")
	r.Header.Set(authuser.SecretHeader, "s3cret")
	w = httptest.NewRecorder()
	handleRegister(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("identity with the secret: status %d, want 200 (body %q)", w.Code, w.Body.String())
	}
}
