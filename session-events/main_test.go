package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestSystemdSocketCount(t *testing.T) {
	const self = 4242
	for _, tc := range []struct {
		name    string
		env     map[string]string
		want    int
		wantErr bool
	}{
		{"no socket passed", map[string]string{}, 0, false},
		{"one socket for this process", map[string]string{"LISTEN_PID": "4242", "LISTEN_FDS": "1"}, 1, false},
		{"two sockets", map[string]string{"LISTEN_PID": "4242", "LISTEN_FDS": "2"}, 2, false},
		// The variables are inherited by every child of the process systemd
		// started, and only the one whose pid they name owns the descriptors.
		{"meant for another process", map[string]string{"LISTEN_PID": "1", "LISTEN_FDS": "1"}, 0, false},
		{"no pid", map[string]string{"LISTEN_FDS": "1"}, 0, false},
		{"unparseable count", map[string]string{"LISTEN_PID": "4242", "LISTEN_FDS": "x"}, 0, true},
		{"negative count", map[string]string{"LISTEN_PID": "4242", "LISTEN_FDS": "-1"}, 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := systemdSocketCount(func(k string) string { return tc.env[k] }, self)
			if (err != nil) != tc.wantErr || got != tc.want {
				t.Fatalf("systemdSocketCount = %d, %v; want %d, error %v", got, err, tc.want, tc.wantErr)
			}
		})
	}
}

// A dev run, the container and the tests start the binary by hand, with no
// socket from systemd, and must bind -addr as they always have.
func TestListenBindsTheAddressWhenSystemdPassedNothing(t *testing.T) {
	t.Setenv("LISTEN_PID", "")
	t.Setenv("LISTEN_FDS", "")
	l, inherited, err := listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	if inherited {
		t.Fatal("listen reported a socket from systemd when none was passed")
	}
	if a := l.Addr().(*net.TCPAddr); !a.IP.Equal(net.ParseIP("127.0.0.1")) || a.Port == 0 {
		t.Fatalf("listening on %v, want a port on 127.0.0.1", a)
	}
}

// The helper half of TestServesTheSocketSystemdPassed. It runs only in the
// child that test starts, which holds the socket at descriptor 3 the way
// systemd hands it over.
func TestHelperSocketActivatedServer(t *testing.T) {
	if os.Getenv("TL_TEST_SOCKET_HELPER") != "1" {
		t.Skip("helper process only")
	}
	// An address that cannot be bound: reaching net.Listen would fail the
	// test, so serving at all proves the inherited socket was used.
	l, inherited, err := listen("192.0.2.1:1")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	if !inherited {
		t.Fatal("the socket systemd passed was not used")
	}
	ctx, cancel := context.WithCancel(context.Background())
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Children of session-events (tmux, the privop reader) must not see
		// variables that name a descriptor they do not hold.
		io.WriteString(w, "served env="+os.Getenv("LISTEN_PID")+os.Getenv("LISTEN_FDS"))
		cancel()
	})}
	if err := serveUntil(ctx, srv, l, time.Second); err != nil {
		t.Fatalf("serveUntil: %v", err)
	}
}

// systemd passes the socket it holds as descriptor 3 and names the process
// that owns it in LISTEN_PID. The child here gets exactly that: a shell
// exports its own pid, then execs the test binary, which keeps the pid and the
// descriptor.
func TestServesTheSocketSystemdPassed(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("no sh")
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f, err := l.(*net.TCPListener).File()
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	// Only the child accepts from here on. The socket stays bound through the
	// descriptor it holds, as it does through systemd's.
	l.Close()

	cmd := exec.Command("sh", "-c", `export LISTEN_PID=$$ LISTEN_FDS=1; exec "$0" "$@"`,
		os.Args[0], "-test.run=^TestHelperSocketActivatedServer$", "-test.v")
	cmd.Env = append(os.Environ(), "TL_TEST_SOCKET_HELPER=1")
	cmd.ExtraFiles = []*os.File{f}
	var out strings.Builder
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	f.Close()

	resp, err := (&http.Client{Timeout: 10 * time.Second}).Get("http://" + addr + "/")
	if err != nil {
		cmd.Process.Kill()
		cmd.Wait()
		t.Fatalf("GET through the passed socket: %v\nchild said:\n%s", err, out.String())
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err := cmd.Wait(); err != nil {
		t.Fatalf("helper failed: %v\n%s", err, out.String())
	}
	if string(body) != "served env=" {
		t.Fatalf("body = %q, want the request served with LISTEN_* cleared", body)
	}
}

// F11. Shutdown stops accepting at once, but the requests already inside get
// the grace to finish, and main must not return under them: an events batch
// cut halfway is resent by the mod and lands twice.
func TestServeUntilWaitsForTheRequestInFlight(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	inside := make(chan struct{})
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(inside)
		time.Sleep(300 * time.Millisecond)
		io.WriteString(w, "whole")
	})}
	served := make(chan error, 1)
	go func() { served <- serveUntil(ctx, srv, l, 3*time.Second) }()

	got := make(chan string, 1)
	go func() {
		resp, err := http.Get("http://" + l.Addr().String() + "/")
		if err != nil {
			got <- "error: " + err.Error()
			return
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		got <- string(b)
	}()
	<-inside
	cancel()
	select {
	case err := <-served:
		t.Fatalf("serveUntil returned (%v) while a request was still being answered", err)
	case <-time.After(100 * time.Millisecond):
	}
	if err := <-served; err != nil {
		t.Fatalf("serveUntil: %v", err)
	}
	select {
	case body := <-got:
		if body != "whole" {
			t.Fatalf("the request in flight got %q, want its whole answer", body)
		}
	default:
		t.Fatal("serveUntil returned before the request in flight was answered")
	}
}

// A held poll or an SSE stream never finishes on its own, so the wait is
// bounded: a restart costs at most the grace.
func TestServeUntilGivesUpAfterTheGrace(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	inside := make(chan struct{})
	release := make(chan struct{})
	defer close(release)
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(inside)
		<-release
	})}
	served := make(chan error, 1)
	go func() { served <- serveUntil(ctx, srv, l, 200*time.Millisecond) }()
	go http.Get("http://" + l.Addr().String() + "/")
	<-inside
	start := time.Now()
	cancel()
	select {
	case <-served:
		if d := time.Since(start); d < 150*time.Millisecond {
			t.Fatalf("returned after %v, before the grace ran out", d)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("serveUntil did not return after its grace")
	}
}

// The socket systemd holds listens where its unit says, which is every
// interface, and TL_BIND cannot reach a unit file. A box whose TL_BIND keeps
// the services off the network keeps session-events off it too: connections
// that arrive on any other address are closed before anything reads them.
func TestBindAllows(t *testing.T) {
	loop4, loop6, mapped := net.ParseIP("127.0.0.1"), net.ParseIP("::1"), net.ParseIP("::ffff:127.0.0.1")
	lan, lanMapped := net.ParseIP("10.0.10.10"), net.ParseIP("::ffff:10.0.10.10")
	for _, tc := range []struct {
		host    string
		allowed []net.IP
		refused []net.IP
	}{
		// What this box runs: TL_BIND=0.0.0.0, and the cluster reaches 7685.
		{"0.0.0.0", []net.IP{loop4, loop6, lan, lanMapped}, nil},
		{"::", []net.IP{loop4, lan}, nil},
		{"", []net.IP{loop4, lan}, nil},
		// The shipped default. Both loopbacks pass: `localhost` resolves to
		// ::1 first, and a hook that reached ::1 used to be refused at connect
		// and retried on 127.0.0.1, which an accepted-then-closed connection
		// would not do.
		{"127.0.0.1", []net.IP{loop4, loop6, mapped}, []net.IP{lan, lanMapped}},
		{"localhost", []net.IP{loop4, loop6}, []net.IP{lan}},
		{"10.0.10.10", []net.IP{lan, lanMapped}, []net.IP{loop4, loop6, net.ParseIP("10.0.10.11")}},
	} {
		t.Run(tc.host, func(t *testing.T) {
			allow, err := bindAllows(tc.host)
			if err != nil {
				t.Fatal(err)
			}
			for _, ip := range tc.allowed {
				if allow != nil && !allow(ip) {
					t.Errorf("TL_BIND=%s refuses a connection to %v", tc.host, ip)
				}
			}
			for _, ip := range tc.refused {
				if allow == nil || allow(ip) {
					t.Errorf("TL_BIND=%s accepts a connection to %v", tc.host, ip)
				}
			}
		})
	}
	if _, err := bindAllows("no-such-host.invalid"); err == nil {
		t.Error("an unresolvable TL_BIND was accepted; net.Listen refuses one too")
	}
}

func TestBoundListenerClosesWhatItRefuses(t *testing.T) {
	for _, tc := range []struct {
		name  string
		allow bool
	}{{"allowed", true}, {"refused", false}} {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			l := boundListener{Listener: raw, allow: func(net.IP) bool { return tc.allow }}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				io.WriteString(w, "ok")
			})}
			go serveUntil(ctx, srv, l, time.Second)

			resp, err := (&http.Client{Timeout: 5 * time.Second}).Get("http://" + raw.Addr().String() + "/")
			if tc.allow {
				if err != nil {
					t.Fatalf("allowed connection: %v", err)
				}
				resp.Body.Close()
				return
			}
			if err == nil {
				resp.Body.Close()
				t.Fatalf("a refused connection was answered with %d", resp.StatusCode)
			}
		})
	}
}
