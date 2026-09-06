package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TL-17. /internal/attach hangs off the same listener as the public routes, and
// TL_BIND is wide because the cluster ingress reaches this box. The endpoint's
// own comment called it "localhost-only in practice" while nothing looked at
// RemoteAddr, and the token it does check is readable from the process table of
// any attach that uses it. The peer address is what keeps it to the box.
func TestInternalAttachRefusesANonLoopbackPeer(t *testing.T) {
	withInternalToken(t, "tok")
	swapShareStore(t)

	// A SELF attach: owning the session is the authorization, so this body is
	// answered 200 on loopback. Anything short of 200 here would pass the test
	// for the wrong reason.
	body := `{"owner":"wizard","name":"demo","guest":"wizard","tty":"/dev/pts/3"}`
	for _, remote := range []string{"192.0.2.7:41000", "10.0.20.1:41000", "not-an-address"} {
		r := httptest.NewRequest("POST", "/internal/attach", strings.NewReader(body))
		r.RemoteAddr = remote
		r.Header.Set("X-Internal-Token", "tok")
		w := httptest.NewRecorder()
		handleInternalAttach(w, r)
		if w.Code != http.StatusForbidden {
			t.Fatalf("peer %s: got %d, want 403", remote, w.Code)
		}
	}
}

// The on-box caller (devvm/tmux-attach.sh) still gets through, and the token is
// still required once past the peer check.
func TestInternalAttachStillServesLoopback(t *testing.T) {
	withInternalToken(t, "tok")
	swapShareStore(t)

	r := httptest.NewRequest("POST", "/internal/attach",
		strings.NewReader(`{"owner":"wizard","name":"demo","guest":"wizard","tty":"/dev/pts/3"}`))
	r.RemoteAddr = "127.0.0.1:41000"
	r.Header.Set("X-Internal-Token", "tok")
	w := httptest.NewRecorder()
	handleInternalAttach(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("loopback self attach: got %d (%s), want 200", w.Code, w.Body.String())
	}

	r2 := httptest.NewRequest("POST", "/internal/attach",
		strings.NewReader(`{"owner":"wizard","name":"demo","guest":"bob"}`))
	r2.RemoteAddr = "127.0.0.1:41000"
	r2.Header.Set("X-Internal-Token", "wrong")
	w2 := httptest.NewRecorder()
	handleInternalAttach(w2, r2)
	if w2.Code != http.StatusForbidden {
		t.Fatalf("loopback with a bad token: got %d, want 403", w2.Code)
	}
}
