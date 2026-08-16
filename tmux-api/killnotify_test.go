package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// --- the kill-notify ------------------------------------------------------
//
// killSession is the only place in the system that knows a session was
// destroyed on purpose, so the notify it fires is the whole basis of "kill
// crosses, exit does not" (design decision 3). These tests pin both halves:
// discovery (which user has a syncer, on which port) and delivery (what goes on
// the wire) — plus the property that matters more than either, which is that a
// syncer that is absent, down, wedged or angry never turns a successful kill
// into a failed one.

// withSyncEnvDir points syncEnvDir at a scratch directory, so a test can put a
// fake /etc/tl-t3-sync/<user>.env in front of the discovery path without root
// and without touching the real one. Same seam shape as withUserMap.
func withSyncEnvDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	old := syncEnvDir
	syncEnvDir = dir
	t.Cleanup(func() { syncEnvDir = old })
	return dir
}

func writeSyncEnv(t *testing.T, dir, osUser, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, osUser+".env"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// notifySpy stands in for a user's tl-t3-sync: it records every notice it is
// handed and answers with `status`.
type notifySpy struct {
	*httptest.Server
	got chan killNotice
	req chan *http.Request
}

func newNotifySpy(t *testing.T, status int) *notifySpy {
	t.Helper()
	// Buffered: a spy is often asserted on once but may be hit more than once
	// (a retry, a stray goroutine from a sibling test's client) and the handler
	// must never block on a reader that has gone away.
	spy := &notifySpy{got: make(chan killNotice, 4), req: make(chan *http.Request, 4)}
	spy.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var n killNotice
		_ = json.NewDecoder(r.Body).Decode(&n)
		select {
		case spy.got <- n:
			spy.req <- r
		default:
		}
		w.WriteHeader(status)
	}))
	t.Cleanup(spy.Close)
	return spy
}

// pointAt writes the env file that makes syncNotifyURL resolve osUser to this
// spy. The spy's URL is http://127.0.0.1:<port>, which is exactly the shape the
// real syncer listens on.
func (s *notifySpy) pointAt(t *testing.T, dir, osUser string) {
	t.Helper()
	_, port := hostPort(t, s.URL)
	writeSyncEnv(t, dir, osUser, "TL_T3_SYNC_NOTIFY_PORT="+port+"\n")
}

func hostPort(t *testing.T, rawURL string) (string, string) {
	t.Helper()
	// httptest hands back http://127.0.0.1:<port>; split off the port without
	// pulling net/url in for one field.
	i := len("http://")
	rest := rawURL[i:]
	for j := len(rest) - 1; j >= 0; j-- {
		if rest[j] == ':' {
			return rest[:j], rest[j+1:]
		}
	}
	t.Fatalf("no port in %q", rawURL)
	return "", ""
}

func (s *notifySpy) await(t *testing.T) killNotice {
	t.Helper()
	select {
	case n := <-s.got:
		return n
	case <-time.After(3 * time.Second):
		t.Fatal("no kill notice arrived")
		return killNotice{}
	}
}

func (s *notifySpy) awaitNothing(t *testing.T) {
	t.Helper()
	select {
	case n := <-s.got:
		t.Fatalf("unexpected kill notice: %+v", n)
	case <-time.After(300 * time.Millisecond):
	}
}

func TestSyncNotifyURL(t *testing.T) {
	// One env file per case, keyed by file name so a case can also assert on
	// what happens when the file belongs to somebody else.
	cases := []struct {
		name    string
		files   map[string]string
		osUser  string
		wantURL string
		wantOK  bool
	}{
		{
			name:   "no config at all — the user has no syncer",
			osUser: "wizard",
		},
		{
			name:   "a file, but for another user",
			files:  map[string]string{"bob.env": "TL_T3_SYNC_NOTIFY_PORT=7696\n"},
			osUser: "wizard",
		},
		{
			name:   "file present, port key absent",
			files:  map[string]string{"wizard.env": "T3_PORT=3773\nTL_T3_SYNC_INTERVAL=5s\n"},
			osUser: "wizard",
		},
		{
			name:    "the ordinary case",
			files:   map[string]string{"wizard.env": "T3_PORT=3773\nTL_T3_SYNC_NOTIFY_PORT=7695\n"},
			osUser:  "wizard",
			wantURL: "http://127.0.0.1:7695/notify/kill",
			wantOK:  true,
		},
		{
			name:    "comments, blank lines and padding",
			files:   map[string]string{"wizard.env": "# the syncer's notify port\n\n  TL_T3_SYNC_NOTIFY_PORT = 7695  \n"},
			osUser:  "wizard",
			wantURL: "http://127.0.0.1:7695/notify/kill",
			wantOK:  true,
		},
		{
			name:    "double-quoted value",
			files:   map[string]string{"wizard.env": "TL_T3_SYNC_NOTIFY_PORT=\"7695\"\n"},
			osUser:  "wizard",
			wantURL: "http://127.0.0.1:7695/notify/kill",
			wantOK:  true,
		},
		{
			name:    "single-quoted value",
			files:   map[string]string{"wizard.env": "TL_T3_SYNC_NOTIFY_PORT='7695'\n"},
			osUser:  "wizard",
			wantURL: "http://127.0.0.1:7695/notify/kill",
			wantOK:  true,
		},
		{
			// systemd lets a later assignment win; the reader must agree with
			// the unit, or tmux-api and the syncer disagree about the port.
			name:    "last assignment wins",
			files:   map[string]string{"wizard.env": "TL_T3_SYNC_NOTIFY_PORT=7695\nTL_T3_SYNC_NOTIFY_PORT=7699\n"},
			osUser:  "wizard",
			wantURL: "http://127.0.0.1:7699/notify/kill",
			wantOK:  true,
		},
		{
			name:   "a key that merely ends with ours is not ours",
			files:  map[string]string{"wizard.env": "OLD_TL_T3_SYNC_NOTIFY_PORT=7695\n"},
			osUser: "wizard",
		},
		{
			name:   "empty value",
			files:  map[string]string{"wizard.env": "TL_T3_SYNC_NOTIFY_PORT=\n"},
			osUser: "wizard",
		},
		{
			name:   "not a number",
			files:  map[string]string{"wizard.env": "TL_T3_SYNC_NOTIFY_PORT=nope\n"},
			osUser: "wizard",
		},
		{
			name:   "port 0",
			files:  map[string]string{"wizard.env": "TL_T3_SYNC_NOTIFY_PORT=0\n"},
			osUser: "wizard",
		},
		{
			name:   "port out of range",
			files:  map[string]string{"wizard.env": "TL_T3_SYNC_NOTIFY_PORT=70000\n"},
			osUser: "wizard",
		},
		{
			// osUser reaches here from resolveOSUser, which has already done a
			// user.Lookup — but it composes a path, so it gets checked here too
			// rather than trusting a caller two files away.
			name:   "a user name that would escape the directory",
			files:  map[string]string{"wizard.env": "TL_T3_SYNC_NOTIFY_PORT=7695\n"},
			osUser: "../wizard",
		},
		{
			name:   "empty user",
			osUser: "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := withSyncEnvDir(t)
			for name, body := range tc.files {
				if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			gotURL, gotOK := syncNotifyURL(tc.osUser)
			if gotOK != tc.wantOK || gotURL != tc.wantURL {
				t.Fatalf("syncNotifyURL(%q) = (%q, %v), want (%q, %v)", tc.osUser, gotURL, gotOK, tc.wantURL, tc.wantOK)
			}
		})
	}
}

// A missing config DIRECTORY is the state of every box where nobody has
// enabled the syncer — it must be silent, not an error path.
func TestSyncNotifyURLMissingDir(t *testing.T) {
	old := syncEnvDir
	syncEnvDir = filepath.Join(t.TempDir(), "absent")
	t.Cleanup(func() { syncEnvDir = old })

	if url, ok := syncNotifyURL("wizard"); ok {
		t.Fatalf("syncNotifyURL with no config dir = %q, want no target", url)
	}
}

func TestPostKillNoticeWire(t *testing.T) {
	spy := newNotifySpy(t, http.StatusNoContent)
	killedAt := time.Date(2026, 8, 15, 22, 30, 0, 0, time.UTC)

	err := postKillNotice(spy.URL+killNotifyPath, killNotice{
		OSUser:   "wizard",
		Session:  "feat-header",
		KilledAt: killedAt,
		Source:   killNotifySource,
	})
	if err != nil {
		t.Fatalf("postKillNotice: %v", err)
	}

	got := spy.await(t)
	if got.OSUser != "wizard" || got.Session != "feat-header" || got.Source != killNotifySource {
		t.Fatalf("notice = %+v, want wizard/feat-header from %s", got, killNotifySource)
	}
	if !got.KilledAt.Equal(killedAt) {
		t.Fatalf("killedAt = %v, want %v", got.KilledAt, killedAt)
	}
	req := <-spy.req
	if req.Method != http.MethodPost {
		t.Fatalf("method = %s, want POST", req.Method)
	}
	if req.URL.Path != killNotifyPath {
		t.Fatalf("path = %s, want %s", req.URL.Path, killNotifyPath)
	}
	if ct := req.Header.Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content-type = %q, want application/json", ct)
	}
}

// Every one of these is a syncer the kill must survive. postKillNotice reports
// the failure so the CALLER can log it once; nothing here may block or panic.
func TestPostKillNoticeFailureModes(t *testing.T) {
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	downURL := down.URL
	down.Close() // the port is now closed: connection refused, the syncer-is-stopped case

	release := make(chan struct{})
	hung := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
	}))
	// Release before Close: httptest.Server.Close waits for in-flight handlers.
	t.Cleanup(func() { close(release); hung.CloseClientConnections(); hung.Close() })

	cases := []struct {
		name    string
		url     string
		wantErr bool
	}{
		{name: "syncer is stopped", url: downURL + killNotifyPath, wantErr: true},
		{name: "syncer answers 500", url: newNotifySpy(t, http.StatusInternalServerError).URL + killNotifyPath, wantErr: true},
		{name: "syncer answers 404 — an older build without the route", url: newNotifySpy(t, http.StatusNotFound).URL + killNotifyPath, wantErr: true},
		{name: "syncer is wedged", url: hung.URL + killNotifyPath, wantErr: true},
		{name: "unparseable target", url: "http://127.0.0.1:0.0/notify/kill", wantErr: true},
		{name: "syncer accepts", url: newNotifySpy(t, http.StatusNoContent).URL + killNotifyPath},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			start := time.Now()
			err := postKillNotice(tc.url, killNotice{OSUser: "wizard", Session: "qa-notify", KilledAt: time.Now().UTC(), Source: killNotifySource})
			if (err != nil) != tc.wantErr {
				t.Fatalf("postKillNotice err = %v, wantErr %v", err, tc.wantErr)
			}
			// The client timeout is the ceiling; anything slower means the
			// bound is not being applied.
			if elapsed := time.Since(start); elapsed > killNotifyTimeout+2*time.Second {
				t.Fatalf("postKillNotice took %v, want <= %v", elapsed, killNotifyTimeout)
			}
		})
	}
}

// --- through the real route ------------------------------------------------

// killThrough performs a DELETE against the real handler with tmux and sudo
// stubbed, and returns the recorder plus how long the request took. The
// duration is the point: the notify runs off the response path.
func killThrough(t *testing.T, session string, tmuxScript string) (*httptest.ResponseRecorder, time.Duration) {
	t.Helper()
	osSelf, _ := twoLocalUsers(t)        // caller == current user: tmuxCmd skips sudo
	withUserMap(t, "alice="+osSelf+"\n") // so the sudo stub only sees the forget
	withTempLayoutStore(t)
	withTmuxStub(t, tmuxScript)
	withSudoStub(t, "exit 0")

	rec := httptest.NewRecorder()
	start := time.Now()
	handleSessionByName(rec, sessionReq(http.MethodDelete, "/sessions/"+session, "", "alice"))
	return rec, time.Since(start)
}

func TestKillSessionNotifiesSyncer(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	dir := withSyncEnvDir(t)
	spy := newNotifySpy(t, http.StatusNoContent)
	spy.pointAt(t, dir, osSelf)

	rec, _ := killThrough(t, "qa-notify", "exit 0")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("DELETE: got %d, want %d", rec.Code, http.StatusNoContent)
	}

	got := spy.await(t)
	if got.OSUser != osSelf || got.Session != "qa-notify" {
		t.Fatalf("notice = %+v, want %s/qa-notify", got, osSelf)
	}
	if got.KilledAt.IsZero() {
		t.Fatal("notice carries no kill time")
	}
}

// The rule this whole feature is subordinate to: the kill is the user's action
// and it succeeded. A syncer that is stopped, wedged, or simply not installed
// must not change the answer they get, or how fast they get it.
func TestKillSucceedsWhateverTheSyncerDoes(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)

	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	_, downPort := hostPort(t, down.URL)
	down.Close()

	release := make(chan struct{})
	hung := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-release }))
	_, hungPort := hostPort(t, hung.URL)
	t.Cleanup(func() { close(release); hung.CloseClientConnections(); hung.Close() })

	angry := newNotifySpy(t, http.StatusInternalServerError)
	_, angryPort := hostPort(t, angry.URL)

	cases := []struct {
		name string
		env  string // contents of <user>.env; "" means no file at all
	}{
		{name: "notify endpoint is down", env: "TL_T3_SYNC_NOTIFY_PORT=" + downPort + "\n"},
		{name: "notify endpoint is wedged", env: "TL_T3_SYNC_NOTIFY_PORT=" + hungPort + "\n"},
		{name: "notify endpoint errors", env: "TL_T3_SYNC_NOTIFY_PORT=" + angryPort + "\n"},
		{name: "no syncer configured", env: ""},
		{name: "syncer config is nonsense", env: "TL_T3_SYNC_NOTIFY_PORT=banana\n"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := withSyncEnvDir(t)
			if tc.env != "" {
				writeSyncEnv(t, dir, osSelf, tc.env)
			}
			rec, elapsed := killThrough(t, "qa-notify", "exit 0")
			if rec.Code != http.StatusNoContent {
				t.Fatalf("DELETE: got %d, want %d", rec.Code, http.StatusNoContent)
			}
			// The wedged syncer holds its connection for the whole test; if the
			// notify were on the response path this would be the assertion that
			// catches it.
			if elapsed > time.Second {
				t.Fatalf("kill took %v — the notify is on the response path", elapsed)
			}
		})
	}
}

// A kill that did not happen is not a kill. tmux said the session was already
// gone, so nothing deliberate occurred and nothing may cross to T3 — otherwise
// a stale sidebar row would archive a thread whose session died on its own.
func TestFailedKillDoesNotNotify(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	dir := withSyncEnvDir(t)
	spy := newNotifySpy(t, http.StatusNoContent)
	spy.pointAt(t, dir, osSelf)

	rec, _ := killThrough(t, "gone", `echo "can't find session: gone" >&2; exit 1`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("DELETE of a dead session: got %d, want %d", rec.Code, http.StatusNotFound)
	}
	spy.awaitNothing(t)
}
