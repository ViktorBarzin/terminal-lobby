package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"testing"
)

// procFixture lays down a /proc/net/tcp table holding one socket: a client at
// 127.0.0.1:50000 connected to 127.0.0.1:7685, owned by uid.
func procFixture(t *testing.T, uid int) {
	t.Helper()
	p := filepath.Join(t.TempDir(), "tcp")
	body := "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n" +
		fmt.Sprintf("   0: 0100007F:C350 0100007F:1E05 01 00000000:00000000 00:00000000 00000000 %5d        0 123456 1 0000000000000000 20 0 0 10 -1\n", uid) +
		// A decoy: same client port, a different peer, someone else's uid.
		"   1: 0100007F:C350 0A000001:0050 01 00000000:00000000 00:00000000 00000000     0        0 123457 1 0000000000000000 20 0 0 10 -1\n"
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	old := procNetTCP
	procNetTCP = []string{p}
	t.Cleanup(func() { procNetTCP = old })
}

// hookReq is a request shaped like the one claude-se-hook sends: loopback, with
// the connection's own local address on the context the way net/http sets it.
func hookReq(body string) *http.Request {
	r := httptest.NewRequest("POST", "/hooks/session-start", strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:50000"
	local := &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 7685}
	return r.WithContext(context.WithValue(r.Context(), http.LocalAddrContextKey, local))
}

func TestPeerUserNamesTheAccountThatOpenedTheSocket(t *testing.T) {
	procFixture(t, os.Getuid())
	me, err := user.Current()
	if err != nil {
		t.Skip("no user database")
	}

	got, err := peerUser(hookReq(""))
	if err != nil {
		t.Fatalf("peerUser: %v", err)
	}
	if got != me.Username {
		t.Fatalf("peer user = %q, want %q", got, me.Username)
	}
}

// TL-19. The hook says which OS user it is for, and until now that string alone
// selected whose registry entry and whose tmux server got touched — from any
// shell on the box, since loopback is not an account.
func TestPeerOwnsClaimRefusesAnotherUsersName(t *testing.T) {
	procFixture(t, os.Getuid())
	reached := false
	h := peerOwnsClaim(func(w http.ResponseWriter, r *http.Request) { reached = true; w.WriteHeader(204) })

	w := httptest.NewRecorder()
	h(w, hookReq(`{"user":"someone-else","session_id":"s1","tmux_session":"demo"}`))
	if w.Code != http.StatusForbidden || reached {
		t.Fatalf("a claim for another account: code=%d reached=%v, want 403", w.Code, reached)
	}
}

func TestPeerOwnsClaimPassesTheBodyThrough(t *testing.T) {
	procFixture(t, os.Getuid())
	me, err := user.Current()
	if err != nil {
		t.Skip("no user database")
	}
	body := `{"user":"` + me.Username + `","session_id":"s1","tmux_session":"demo"}`

	var seen string
	h := peerOwnsClaim(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		seen = string(b)
		w.WriteHeader(204)
	})
	w := httptest.NewRecorder()
	h(w, hookReq(body))
	if w.Code != 204 {
		t.Fatalf("own account: code=%d (%s), want 204", w.Code, w.Body.String())
	}
	if seen != body {
		t.Fatalf("handler read %q, want the whole body %q", seen, body)
	}
}

// Fail closed: a peer the socket tables cannot name is refused, not waved
// through on the strength of what it wrote in the body.
func TestPeerOwnsClaimRefusesAnUnidentifiablePeer(t *testing.T) {
	procFixture(t, os.Getuid())
	reached := false
	h := peerOwnsClaim(func(w http.ResponseWriter, r *http.Request) { reached = true; w.WriteHeader(204) })

	r := httptest.NewRequest("POST", "/hooks/session-start",
		strings.NewReader(`{"user":"anyone","session_id":"s1","tmux_session":"demo"}`))
	r.RemoteAddr = "127.0.0.1:59999" // no such socket in the table
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != http.StatusForbidden || reached {
		t.Fatalf("unknown peer: code=%d reached=%v, want 403", w.Code, reached)
	}
}

func TestParseProcAddr(t *testing.T) {
	for _, tc := range []struct {
		in   string
		ip   string
		port int
	}{
		{"0100007F:1E05", "127.0.0.1", 7685},
		{"00000000000000000000000001000000:1E05", "::1", 7685},
	} {
		ip, port, ok := parseProcAddr(tc.in)
		if !ok || !ip.Equal(net.ParseIP(tc.ip)) || port != tc.port {
			t.Fatalf("parseProcAddr(%q) = %v %d %v, want %s %d", tc.in, ip, port, ok, tc.ip, tc.port)
		}
	}
	if _, _, ok := parseProcAddr("nonsense"); ok {
		t.Fatal("garbage parsed as an address")
	}
}

// The tests above feed peerUID a fixture, which proves the parsing and nothing
// about the format the kernel actually writes. This one drives a real listener
// over a real loopback socket and reads the real /proc/net/tcp.
func TestPeerOwnsClaimOverARealConnection(t *testing.T) {
	if _, err := os.ReadFile("/proc/net/tcp"); err != nil {
		t.Skip("no /proc/net/tcp here:", err)
	}
	me, err := user.Current()
	if err != nil {
		t.Skip("no user database")
	}

	srv := httptest.NewServer(peerOwnsClaim(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		w.WriteHeader(204)
		_ = b
	}))
	defer srv.Close()

	post := func(u string) int {
		resp, err := http.Post(srv.URL+"/hooks/session-start", "application/json",
			strings.NewReader(`{"user":"`+u+`","session_id":"s1","tmux_session":"demo"}`))
		if err != nil {
			t.Fatalf("post: %v", err)
		}
		defer resp.Body.Close()
		return resp.StatusCode
	}

	if code := post(me.Username); code != 204 {
		t.Fatalf("hook from %s claiming %s: got %d, want 204", me.Username, me.Username, code)
	}
	if code := post("nobody-else"); code != http.StatusForbidden {
		t.Fatalf("hook from %s claiming nobody-else: got %d, want 403", me.Username, code)
	}
}
