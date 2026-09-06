package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
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

// Everything above drives handleRegister in-process with a RemoteAddr the test
// assigns, which proves the decision and not the plumbing. IsLoopback reads
// r.RemoteAddr, so the refusal only holds if that field still carries the peer
// address by the time the handler sees it, through the two wrappers main()
// puts in front of the mux. This serves the real chain over a real listener on
// every interface and dials it twice: once from the box's own LAN address,
// once from loopback.
func TestRegisterOverARealConnection(t *testing.T) {
	withUserMap(t, "qa.tester=qauser\n")
	root := withStore(t)
	lan := nonLoopbackIP(t)

	mux := http.NewServeMux()
	mux.HandleFunc("/register", handleRegister)
	ln, err := net.Listen("tcp", "0.0.0.0:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	srv := &http.Server{Handler: timing.Wrap(withPublicAssets(mux))}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	port := strconv.Itoa(ln.Addr().(*net.TCPAddr).Port)

	post := func(t *testing.T, host string, hdr http.Header) *http.Response {
		t.Helper()
		src := filepath.Join(t.TempDir(), "shot.png")
		if err := os.WriteFile(src, realPNG(t), 0o644); err != nil {
			t.Fatal(err)
		}
		form := url.Values{"user": {"qauser"}, "session": {"s1"}, "path": {src}}
		req, err := http.NewRequest(http.MethodPost,
			"http://"+net.JoinHostPort(host, port)+"/register",
			strings.NewReader(form.Encode()))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		for k, v := range hdr {
			req.Header[k] = v
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("POST from %s: %v", host, err)
		}
		t.Cleanup(func() { resp.Body.Close() })
		return resp
	}

	// No secret configured yet, which is every install until an operator sets
	// one, so this is the refusal the box gives today.
	if resp := post(t, lan, nil); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("headerless POST from %s: status %d, want 401", lan, resp.StatusCode)
	}
	if names := storedNames(t, root, "qauser", "s1"); len(names) != 0 {
		t.Fatalf("refused connection still wrote %v", names)
	}
	if resp := post(t, "127.0.0.1", nil); resp.StatusCode != http.StatusOK {
		t.Fatalf("headerless POST from loopback: status %d, want 200", resp.StatusCode)
	}
	if names := storedNames(t, root, "qauser", "s1"); len(names) != 1 {
		t.Fatalf("loopback register stored %v, want one file", names)
	}

	// And with a secret configured, an identity header off the network is
	// worth nothing without it.
	old := actAsGate.Config
	actAsGate.Config = authuser.Config{ProxySecret: "s3cret"}
	t.Cleanup(func() { actAsGate.Config = old })

	ident := http.Header{authHeader: {"qa.tester"}}
	if resp := post(t, lan, ident); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("identity without the secret from %s: status %d, want 401", lan, resp.StatusCode)
	}
	withSecret := http.Header{authHeader: {"qa.tester"}, authuser.SecretHeader: {"s3cret"}}
	if resp := post(t, lan, withSecret); resp.StatusCode != http.StatusOK {
		t.Fatalf("identity with the secret from %s: status %d, want 200", lan, resp.StatusCode)
	}
}

// nonLoopbackIP is the address a caller on the network would reach this box
// on. A machine with none cannot host the test, so it skips rather than
// passing on a check it never made.
func nonLoopbackIP(t *testing.T) string {
	t.Helper()
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		t.Fatalf("InterfaceAddrs: %v", err)
	}
	for _, a := range addrs {
		n, ok := a.(*net.IPNet)
		if !ok || n.IP.IsLoopback() || n.IP.To4() == nil {
			continue
		}
		return n.IP.String()
	}
	t.Skip("no non-loopback IPv4 address on this host")
	return ""
}
