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
	"strconv"
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

// hookReq is a request shaped like the one a hook script sends: loopback, with
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

// procRows lays down a /proc/net/tcp table of the given rows, each a client at
// 127.0.0.1:50000 connected to 127.0.0.1:7685, in the given state and owned by
// the given uid.
func procRows(t *testing.T, rows ...[2]string) {
	t.Helper()
	body := "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
	for i, r := range rows {
		body += fmt.Sprintf("   %d: 0100007F:C350 0100007F:1E05 %s 00000000:00000000 00:00000000 00000000 %5s        0 %d 1 0000000000000000 20 0 0 10 -1\n",
			i, r[0], r[1], 123456+i)
	}
	p := filepath.Join(t.TempDir(), "tcp")
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	old := procNetTCP
	procNetTCP = []string{p}
	t.Cleanup(func() { procNetTCP = old })
}

// F7. A client that closes its socket before the server reads the request
// leaves it orphaned, and the kernel then reports it as root's: FIN_WAIT1 and
// TIME_WAIT entries show uid 0 (measured on this box, all 37 TIME_WAIT
// entries). Only a socket that is still connected says who opened it, and no
// lobby client runs as root, so root is never an answer.
func TestPeerUIDTakesOnlyAConnectedSocketThatIsNotRoots(t *testing.T) {
	me := strconv.Itoa(os.Getuid())
	if me == "0" {
		t.Skip("running as root; the fixture needs a uid that is not 0")
	}
	for _, tc := range []struct {
		name    string
		rows    [][2]string
		wantUID int
		wantErr bool
	}{
		{"established", [][2]string{{"01", me}}, os.Getuid(), false},
		{"fin_wait1, orphaned", [][2]string{{"04", "0"}}, 0, true},
		{"fin_wait1, still owned", [][2]string{{"04", me}}, 0, true},
		{"time_wait", [][2]string{{"06", "0"}}, 0, true},
		{"close_wait", [][2]string{{"08", me}}, 0, true},
		{"established but root's", [][2]string{{"01", "0"}}, 0, true},
		// A port the kernel reused while an old connection on the same four
		// endpoints sits in TIME_WAIT. Counting that row made the match look
		// ambiguous and refused the live caller.
		{"established beside a time_wait twin", [][2]string{{"06", "0"}, {"01", me}}, os.Getuid(), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			procRows(t, tc.rows...)
			uid, err := peerUID(net.ParseIP("127.0.0.1"), 50000, net.ParseIP("127.0.0.1"), 7685)
			if (err != nil) != tc.wantErr {
				t.Fatalf("peerUID = %d, %v; want error %v", uid, err, tc.wantErr)
			}
			if !tc.wantErr && uid != tc.wantUID {
				t.Fatalf("peerUID = %d, want %d", uid, tc.wantUID)
			}
		})
	}
}

// Every route that identifies its caller this way refuses root, not only the
// hook routes: the mod's hello and agent-api's internal routes go through
// peerUser as well.
func TestPeerUserRefusesRoot(t *testing.T) {
	procRows(t, [2]string{"01", "0"})
	if who, err := peerUser(hookReq("")); err == nil {
		t.Fatalf("peerUser named %q for a root-owned socket, want an error", who)
	}
}
