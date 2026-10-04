package release

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// The units RestartSteps is exercised against: one service whose port a
// socket holds, and one that binds its own.
var socketUnits = []Unit{
	{Name: "session-events", Socket: "session-events.socket", Files: []string{
		"/usr/local/bin/session-events",
		"/etc/systemd/system/session-events.service",
		"/etc/systemd/system/session-events.socket",
	}},
	{Name: "tmux-api", Files: []string{"/usr/local/bin/tmux-api"}},
}

func active(up bool) func(string) bool { return func(string) bool { return up } }

// The switchover is the only order that works. The old service holds the port
// until it is stopped, so the socket cannot bind before that, and the new
// service must find the socket listening when it starts.
var switchover = []Step{
	{"stop", "session-events"},
	{"restart", "session-events.socket"},
	{"start", "session-events"},
}

func TestRestartSteps(t *testing.T) {
	for _, tc := range []struct {
		name    string
		changed []string
		up      bool
		want    []Step
	}{
		{
			// Every later release: the socket keeps the port and only the
			// process behind it changes.
			name:    "a new binary restarts the service and leaves the socket alone",
			changed: []string{"/usr/local/bin/session-events"},
			up:      true,
			want:    []Step{{"restart", "session-events"}},
		},
		{
			name:    "a changed service file is the same",
			changed: []string{"/etc/systemd/system/session-events.service"},
			up:      true,
			want:    []Step{{"restart", "session-events"}},
		},
		{
			// The first install of the socket: the previous version's process
			// holds the port, and the socket postinst tried to start failed.
			name: "the first install switches over",
			changed: []string{
				"/etc/systemd/system/session-events.service",
				"/etc/systemd/system/session-events.socket",
				"/usr/local/bin/session-events",
			},
			up:   false,
			want: switchover,
		},
		{
			// A changed ListenStream takes effect only when the socket is
			// rebound. That is the one release that unbinds the port.
			name:    "a changed socket file rebinds it",
			changed: []string{"/etc/systemd/system/session-events.socket"},
			up:      true,
			want:    switchover,
		},
		{
			name:    "a socket that is down comes up when nothing changed",
			changed: nil,
			up:      false,
			want:    switchover,
		},
		{
			name:    "a socket that is down comes up beside another unit's restart",
			changed: []string{"/usr/local/bin/tmux-api"},
			up:      false,
			want:    append([]Step{{"restart", "tmux-api"}}, switchover...),
		},
		{
			name:    "nothing changed and the socket is up: nothing happens",
			changed: nil,
			up:      true,
			want:    nil,
		},
		{
			name:    "a unit with no socket restarts as before",
			changed: []string{"/usr/local/bin/tmux-api"},
			up:      true,
			want:    []Step{{"restart", "tmux-api"}},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := RestartSteps(socketUnits, tc.changed, nil, active(tc.up))
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("RestartSteps = %v\nwant           %v", got, tc.want)
			}
		})
	}
}

// The property the socket exists for: while the socket is up, no release that
// leaves the socket's own file alone stops the service or touches the socket,
// so the port is never unbound and never answered by nothing. Checked over
// every combination of the socket units' other files, alone, beside each
// other watched file, and beside all of them.
func TestALiveSocketIsNeverTouchedUnlessItsFileChanged(t *testing.T) {
	var mine, others []string
	for _, u := range Package.Units {
		for _, f := range u.Files {
			switch {
			case strings.HasSuffix(f, ".socket"):
			case u.Socket != "":
				mine = append(mine, f)
			default:
				others = append(others, f)
			}
		}
	}
	if len(mine) == 0 {
		t.Fatal("no unit has a socket; this test is reading the wrong manifest")
	}
	extras := [][]string{nil, others}
	for _, f := range others {
		extras = append(extras, []string{f})
	}
	for mask := 0; mask < 1<<len(mine); mask++ {
		for _, extra := range extras {
			changed := append([]string(nil), extra...)
			for i, f := range mine {
				if mask&(1<<i) != 0 {
					changed = append(changed, f)
				}
			}
			for _, s := range RestartSteps(Package.Units, changed, nil, active(true)) {
				if strings.HasSuffix(s.Unit, ".socket") || s.Verb != "restart" {
					t.Fatalf("changed %v: step %v would unbind a port a socket holds", changed, s)
				}
			}
		}
	}
}

// session-events is the service the socket was added for (the mod's commands
// arrive over 7685). Every half of the arrangement has to be in the package:
// the unit file shipped, watched, enabled, and named on the unit.
func TestSessionEventsPortIsHeldBySystemd(t *testing.T) {
	const sock = "session-events.socket"
	dest := SocketPath(sock)
	var shipped, watched, named, enabled bool
	for _, f := range Package.Files {
		if f.Dest == dest && f.Src == "devvm/"+sock && !f.Unmanaged {
			shipped = true
		}
	}
	for _, u := range Package.Units {
		if u.Name != "session-events" {
			continue
		}
		named = u.Socket == sock
		for _, f := range u.Files {
			watched = watched || f == dest
		}
	}
	enableAt := map[string]int{}
	for i, e := range Package.Enable {
		enableAt[e] = i
	}
	si, sok := enableAt[sock]
	vi, vok := enableAt["session-events"]
	// Socket first: postinst enables in this order, and a service started
	// before its socket on a fresh box would pull the socket in anyway, but
	// the order states which one owns the port.
	enabled = sok && vok && si < vi
	for what, ok := range map[string]bool{
		"shipped from devvm/ at " + dest:     shipped,
		"watched by the session-events unit": watched,
		"named as the unit's Socket":         named,
		"enabled, before the service":        enabled,
	} {
		if !ok {
			t.Errorf("%s is not %s", sock, what)
		}
	}
}

func TestTheSocketAndServiceUnitsAgree(t *testing.T) {
	sock := repoFile(t, "devvm", "session-events.socket")
	svc := repoFile(t, "devvm", "session-events.service")
	// Every interface, dual-stack, as session-events bound `-addr :7685` with
	// TL_BIND=0.0.0.0: the cluster reaches the box on 7685.
	if v := unitKey(sock, "ListenStream"); v != "7685" {
		t.Errorf("ListenStream=%q, want 7685 (every interface)", v)
	}
	if v := unitKey(sock, "BindIPv6Only"); v != "both" {
		t.Errorf("BindIPv6Only=%q, want both, so IPv4 and IPv6 share the socket whatever the sysctl says", v)
	}
	if !strings.Contains(sock, "WantedBy=sockets.target") {
		t.Error("the socket is not wanted by sockets.target; after a reboot the port would wait for the service")
	}
	for _, key := range []string{"Requires", "After"} {
		found := false
		for _, line := range strings.Split(svc, "\n") {
			if line == key+"=session-events.socket" {
				found = true
			}
		}
		if !found {
			t.Errorf("session-events.service has no %s=session-events.socket", key)
		}
	}
	// A unit that hits its start limit takes its socket down with it, which
	// frees the port: the thing the socket exists to prevent.
	if v := unitKey(svc, "StartLimitIntervalSec"); v != "0" {
		t.Errorf("StartLimitIntervalSec=%q; a crash loop would give up and unbind 7685", v)
	}
	if unitKey(svc, "RestartSec") == "" {
		t.Error("no RestartSec; with no start limit, the 100 ms default retries ten times a second")
	}
	// The flag the binary falls back to binds the same port the socket holds.
	if !strings.Contains(svc, "-addr :7685 ") {
		t.Error("ExecStart's -addr no longer names :7685, the socket's port")
	}
}

// fakeSystemctl puts a systemctl on PATH that records each call and answers
// is-active from up.
func fakeSystemctl(t *testing.T, up bool) (pathEnv, log string) {
	t.Helper()
	dir := t.TempDir()
	log = filepath.Join(dir, "calls")
	state := "1"
	if up {
		state = "0"
	}
	script := "#!/bin/sh\necho \"$*\" >> " + log + "\n[ \"$1\" = is-active ] && exit " + state + "\nexit 0\n"
	if err := os.WriteFile(filepath.Join(dir, "systemctl"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir + ":" + os.Getenv("PATH"), log
}

// runPostrm runs the shipped postrm, as tl-pkg renders it for version, with
// dpkg's arguments.
func runPostrm(t *testing.T, version string, up bool, args ...string) []string {
	t.Helper()
	if _, err := exec.LookPath("dpkg"); err != nil {
		t.Skip("no dpkg here to compare versions")
	}
	path, log := fakeSystemctl(t, up)
	cmd := exec.Command("sh", append([]string{"-e", "-c", RenderPostrm(version), "postrm"}, args...)...)
	cmd.Env = append(os.Environ(), "PATH="+path)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("postrm %v: %v\n%s", args, err, out)
	}
	b, err := os.ReadFile(log)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSpace(string(b)), "\n")
}

// A downgrade is how the revert works, and the version it lands on may
// predate the socket: its session-events binds 7685 itself, and with pid 1
// still holding the port it could never start. This version's postrm is the
// one script of its own that runs on the way down, so it lets go of the port
// before the older postinst starts the older service.
func TestPostrmReleasesTheSocketOnTheWayDown(t *testing.T) {
	for _, tc := range []struct {
		name    string
		args    []string
		release bool
	}{
		{"downgrade", []string{"upgrade", "0.50.0"}, true},
		{"removal", []string{"remove"}, true},
		{"purge", []string{"purge"}, true},
		// The common case, on every deploy: the next version ships the socket
		// too, and its port must stay bound through the upgrade.
		{"upgrade", []string{"upgrade", "0.52.0"}, false},
		{"reinstall of the same version", []string{"upgrade", "0.51.0"}, false},
		{"failed upgrade", []string{"failed-upgrade", "0.50.0"}, false},
		{"abort install", []string{"abort-install"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := runPostrm(t, "0.51.0", true, tc.args...)
			stopped := false
			for _, c := range calls {
				if c == "stop session-events.socket" {
					stopped = true
				}
			}
			if stopped != tc.release {
				t.Fatalf("postrm %v: stopped the socket = %v, want %v (calls: %q)", tc.args, stopped, tc.release, calls)
			}
		})
	}
}

// On the way down the socket's enablement goes too, while its unit file still
// exists for systemctl to read: dpkg deletes the file right after postrm. A
// version that ships the socket re-enables it in its own postinst.
func TestPostrmDisablesTheSocketOnTheWayDown(t *testing.T) {
	calls := runPostrm(t, "0.51.0", true, "upgrade", "0.50.0")
	for _, c := range calls {
		if c == "disable session-events.socket" {
			return
		}
	}
	t.Fatalf("postrm did not disable the socket on a downgrade (calls: %q)", calls)
}

func TestPostrmIsRenderedWithEverySocketAndTheVersion(t *testing.T) {
	got := RenderPostrm("1.2.3")
	for _, placeholder := range []string{"SOCKET_UNITS", "PACKAGE_VERSION"} {
		if strings.Contains(got, placeholder) {
			t.Errorf("rendered postrm still carries %s", placeholder)
		}
	}
	if !strings.Contains(got, `"1.2.3"`) {
		t.Error("rendered postrm does not compare against its own version")
	}
	for _, u := range Package.Units {
		if u.Socket != "" && !strings.Contains(got, u.Socket) {
			t.Errorf("rendered postrm does not release %s", u.Socket)
		}
	}
}
