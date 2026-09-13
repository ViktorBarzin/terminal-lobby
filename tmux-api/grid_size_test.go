package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// POST /sessions/{name}/grid, through the REAL route (handleSessionByName) with
// the user map pointed at a fixture, as the copy-mode suite does. The four tmux
// seams are package vars, so these stay pure units: nothing here starts a tmux
// server.

type gridCall struct {
	osUser, name string
	cols, rows   int
	// promotions already issued when this call arrived, so a test can say that
	// promoting the preload client happens IN FRONT of the sizing work.
	promotedFirst int
}

// promoteCall is one `refresh-client -f '!ignore-size'`.
type promoteCall struct{ osUser, client string }

// switchCall is one `switch-client -c <client> -t =<session>:`, which is how
// an UNPINNED session's window follows the device that just claimed it.
type switchCall struct{ osUser, client, session string }

// gridWorld is the tmux the handler runs against: the raw list-clients output
// the session answers with, what the client registry holds, and what its
// writing seams do.
type gridWorld struct {
	exists     bool
	clients    string // clientsListFmt columns, one client per line
	records    map[string]clientRecord
	window     string // what the window measures before the claim
	sized      bool
	sizeErr    error
	promoteErr error
	switchErr  error
}

// stubGridWorld swaps the handler's seams and hands back what the writing ones
// received.
func stubGridWorld(t *testing.T, w gridWorld) (*[]gridCall, *[]promoteCall, *[]switchCall) {
	t.Helper()
	var calls []gridCall
	var promotions []promoteCall
	var switches []switchCall

	oldExists, oldClients, oldSize, oldPromote := sessionExists, sessionClients, sizeGrid, promoteClient
	oldRead, oldSwitch, oldWindow := readClientRecord, switchClient, windowGrid
	sessionExists = func(string, string) bool { return w.exists }
	sessionClients = func(string, string) []client { return parseClients([]byte(w.clients)) }
	sizeGrid = func(osUser, name string, cols, rows int) (bool, error) {
		calls = append(calls, gridCall{osUser, name, cols, rows, len(promotions)})
		return w.sized, w.sizeErr
	}
	promoteClient = func(osUser, clientName string) error {
		promotions = append(promotions, promoteCall{osUser, clientName})
		return w.promoteErr
	}
	readClientRecord = func(id string) (clientRecord, bool) {
		rec, ok := w.records[id]
		return rec, ok
	}
	switchClient = func(osUser, clientName, session string) error {
		switches = append(switches, switchCall{osUser, clientName, session})
		return w.switchErr
	}
	windowGrid = func(string, string) string {
		if w.window == "" {
			return "80x24"
		}
		return w.window
	}
	t.Cleanup(func() {
		sessionExists, sessionClients, sizeGrid, promoteClient = oldExists, oldClients, oldSize, oldPromote
		readClientRecord, switchClient, windowGrid = oldRead, oldSwitch, oldWindow
	})
	return &calls, &promotions, &switches
}

// An ordinary read-write client, which is what `driven: true` used to mean
// before the seam handed back the whole client list.
const gridDriverRow = "work\tattached,focused,UTF-8\t1788093053\t1788093053\t/dev/pts/3\n"

// stubGridSizing is stubGridWorld for the cases that only care whether somebody
// is driving. `sized` and `err` are what SizeGrid answers.
func stubGridSizing(t *testing.T, exists, driven, sized bool, err error) *[]gridCall {
	t.Helper()
	clients := ""
	if driven {
		clients = gridDriverRow
	}
	calls, _, _ := stubGridWorld(t, gridWorld{exists: exists, clients: clients, sized: sized, sizeErr: err})
	return calls
}

func TestSizeGridEndpoint(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)

	cases := []struct {
		name string
		// the world the handler runs in
		exists, driven, sized bool
		sizeErr               error
		// the request
		method, path, body, auth string
		// what should come back
		wantCode  int
		wantCalls []gridCall
	}{
		{
			name:   "a pinned session is pointed at the client that asked",
			exists: true, driven: true, sized: true,
			method: http.MethodPost, path: "/sessions/work/grid", auth: "alice",
			body: `{"cols":231,"rows":62}`, wantCode: http.StatusNoContent,
			wantCalls: []gridCall{{osUser: "", name: "work", cols: 231, rows: 62}},
		},
		{
			// The majority case. An unpinned session is left to tmux, and the
			// caller has nothing to do differently, so it reads the same 204.
			name:   "an unpinned session answers the same 204",
			exists: true, driven: true, sized: false,
			method: http.MethodPost, path: "/sessions/work/grid", auth: "alice",
			body: `{"cols":231,"rows":62}`, wantCode: http.StatusNoContent,
			wantCalls: []gridCall{{osUser: "", name: "work", cols: 231, rows: 62}},
		},
		{
			// The one thing the server CAN tell about a watcher: with no
			// read-write client attached, nobody is driving, and a pin exists
			// precisely so a lone watcher does not take the size.
			name:   "nobody driving means nobody may claim the grid",
			exists: true, driven: false, sized: true,
			method: http.MethodPost, path: "/sessions/work/grid", auth: "alice",
			body: `{"cols":80,"rows":24}`, wantCode: http.StatusConflict,
		},
		{
			name: "unknown session", exists: false, driven: true,
			method: http.MethodPost, path: "/sessions/nope/grid", auth: "alice",
			body: `{"cols":231,"rows":62}`, wantCode: http.StatusNotFound,
		},
		{
			name: "tmux failed", exists: true, driven: true,
			sizeErr: fmt.Errorf("boom"),
			method:  http.MethodPost, path: "/sessions/work/grid", auth: "alice",
			body: `{"cols":231,"rows":62}`, wantCode: http.StatusInternalServerError,
			wantCalls: []gridCall{{osUser: "", name: "work", cols: 231, rows: 62}},
		},

		// --- the grid itself ------------------------------------------------
		// A browser mid-layout reports 0, and xterm fitting against a
		// display:none host computes ~13x7. Neither is a size anybody is
		// reading, and neither should reach tmux.
		{
			name: "zero columns", exists: true, driven: true,
			method: http.MethodPost, path: "/sessions/work/grid", auth: "alice",
			body: `{"cols":0,"rows":62}`, wantCode: http.StatusBadRequest,
		},
		{
			name: "zero rows", exists: true, driven: true,
			method: http.MethodPost, path: "/sessions/work/grid", auth: "alice",
			body: `{"cols":231,"rows":0}`, wantCode: http.StatusBadRequest,
		},
		{
			name: "negative", exists: true, driven: true,
			method: http.MethodPost, path: "/sessions/work/grid", auth: "alice",
			body: `{"cols":-1,"rows":62}`, wantCode: http.StatusBadRequest,
		},
		{
			name: "absurdly wide", exists: true, driven: true,
			method: http.MethodPost, path: "/sessions/work/grid", auth: "alice",
			body: `{"cols":99999,"rows":62}`, wantCode: http.StatusBadRequest,
		},
		{
			name:   "a missing field is a zero, which is out of range",
			exists: true, driven: true,
			method: http.MethodPost, path: "/sessions/work/grid", auth: "alice",
			body: `{"cols":231}`, wantCode: http.StatusBadRequest,
		},
		{
			name: "garbage body", exists: true, driven: true,
			method: http.MethodPost, path: "/sessions/work/grid", auth: "alice",
			body: `{nope`, wantCode: http.StatusBadRequest,
		},

		// --- the guards every session endpoint has ---------------------------
		{
			name: "rejects GET", exists: true, driven: true,
			method: http.MethodGet, path: "/sessions/work/grid", auth: "alice",
			wantCode: http.StatusMethodNotAllowed,
		},
		{
			name: "without auth header", exists: true, driven: true,
			method: http.MethodPost, path: "/sessions/work/grid", auth: "",
			body: `{"cols":231,"rows":62}`, wantCode: http.StatusUnauthorized,
		},
		{
			name: "unmapped user", exists: true, driven: true,
			method: http.MethodPost, path: "/sessions/work/grid", auth: "stranger",
			body: `{"cols":231,"rows":62}`, wantCode: http.StatusForbidden,
		},
		{
			name: "invalid session name", exists: true, driven: true,
			method: http.MethodPost, path: "/sessions/we%7Cird/grid", auth: "alice",
			body: `{"cols":231,"rows":62}`, wantCode: http.StatusBadRequest,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			withUserMap(t, "alice="+osSelf+"\n")
			calls := stubGridSizing(t, tc.exists, tc.driven, tc.sized, tc.sizeErr)

			w := httptest.NewRecorder()
			handleSessionByName(w, sessionReq(tc.method, tc.path, tc.body, tc.auth))

			if w.Code != tc.wantCode {
				t.Errorf("status = %d, want %d (body %q)", w.Code, tc.wantCode, w.Body.String())
			}
			if len(*calls) != len(tc.wantCalls) {
				t.Fatalf("SizeGrid called %d time(s), want %d: %+v", len(*calls), len(tc.wantCalls), *calls)
			}
			for i, want := range tc.wantCalls {
				got := (*calls)[i]
				if got.name != want.name || got.cols != want.cols || got.rows != want.rows {
					t.Errorf("SizeGrid call %d = %+v, want name=%s %dx%d",
						i, got, want.name, want.cols, want.rows)
				}
				if got.osUser != osSelf {
					t.Errorf("SizeGrid call %d ran as %q, want the mapped user %q", i, got.osUser, osSelf)
				}
			}
		})
	}
}

// A read-only client never counts towards "somebody is driving this", which is
// the same reading markDriven does of the same flag list.
func TestIsReadOnlyReadsTheClientFlags(t *testing.T) {
	cases := []struct {
		flags string
		want  bool
	}{
		{"attached,UTF-8", false},
		{"attached,read-only,UTF-8", true},
		{"attached,focused,read-only", true},
		{"", false},
	}
	for _, tc := range cases {
		if got := isReadOnly(tc.flags); got != tc.want {
			t.Errorf("isReadOnly(%q) = %v, want %v", tc.flags, got, tc.want)
		}
	}
}

// --- promoting a preload client -------------------------------------------

// Hovering a card attaches a real tmux client with the ignore-size flag, so the
// terminal is drawn before the click and the window it belongs to does not
// move (ADR-0026). The click lands here: this endpoint already means "the
// client being read says what size it is", so it is where that client stops
// ignoring size. Measured on tmux 3.4, 2026-09-11: a 200x50 client attached
// with `-f ignore-size` left an 80x39 window alone, and
// `refresh-client -f '!ignore-size'` moved the window to 200x49.
func TestSizeGridPromotesThePreloadClient(t *testing.T) {
	// tmux 3.4 flag lists, with #{client_name} in the last column.
	const (
		preloadRow  = "work\tattached,ignore-size,UTF-8\t1788093060\t1788093060\t/dev/pts/7\n"
		watcherRow  = "work\tattached,ignore-size,read-only,UTF-8\t1788093060\t1788093060\t/dev/pts/9\n"
		namelessRow = "work\tattached,ignore-size,UTF-8\t1788093060\t1788093060\n"
		// The same flags after a keystroke: a socket that dropped and came back
		// re-attaches with ignore-size, because attach.ts reuses the args it
		// captured at mount. The driven mark reads that client as a driver
		// (driven.go); promotion still has to reach it, or its window stops
		// following it for the rest of the mount.
		reconnectedRow = "work\tattached,focused,ignore-size,UTF-8\t1788093068\t1788093060\t/dev/pts/5\n"
	)

	osSelf, _ := twoLocalUsers(t)

	cases := []struct {
		name  string
		world gridWorld
		body  string
		path  string

		wantCode     int
		wantPromoted []string // client names, in order
		wantSized    bool
	}{
		{
			name:     "a hover's preload client is promoted, then sized",
			world:    gridWorld{exists: true, clients: preloadRow, sized: true},
			wantCode: http.StatusNoContent, wantPromoted: []string{"/dev/pts/7"}, wantSized: true,
		},
		{
			name:     "an ordinary open promotes nothing",
			world:    gridWorld{exists: true, clients: gridDriverRow, sized: true},
			wantCode: http.StatusNoContent, wantSized: true,
		},
		{
			// Not a hover at all: a driver whose socket reconnected. The flags
			// are what tmux gates the window on, so this client is the one
			// whose window is not following it, and the request in hand is it
			// asking for its grid back.
			name:     "a driver still carrying ignore-size after a reconnect is promoted",
			world:    gridWorld{exists: true, clients: reconnectedRow, sized: true},
			wantCode: http.StatusNoContent, wantPromoted: []string{"/dev/pts/5"}, wantSized: true,
		},
		{
			// A pin exists so a read-only client cannot move the window, and
			// tmux's `attach -r` carries ignore-size too. Promoting one would
			// hand a watcher the grid.
			name:     "a watcher is never promoted, and still cannot claim the grid",
			world:    gridWorld{exists: true, clients: watcherRow, sized: true},
			wantCode: http.StatusConflict,
		},
		{
			name:     "with a watcher attached alongside, only the preload is promoted",
			world:    gridWorld{exists: true, clients: watcherRow + preloadRow, sized: true},
			wantCode: http.StatusNoContent, wantPromoted: []string{"/dev/pts/7"}, wantSized: true,
		},
		{
			name:     "nobody attached at all",
			world:    gridWorld{exists: true, clients: "", sized: true},
			wantCode: http.StatusConflict,
		},
		{
			// The sizing work is the point of the request; the promotion is a
			// convenience in front of it, so a failed refresh-client is logged
			// and the request carries on, as a failed pin already does.
			name:     "refresh-client failing does not fail the request",
			world:    gridWorld{exists: true, clients: preloadRow, sized: true, promoteErr: fmt.Errorf("no such client")},
			wantCode: http.StatusNoContent, wantPromoted: []string{"/dev/pts/7"}, wantSized: true,
		},
		{
			// -t needs a name. Without one there is nothing to promote, and the
			// client still counts as read-write, so the size lands as before.
			name:     "a preload client tmux did not name is left alone",
			world:    gridWorld{exists: true, clients: namelessRow, sized: true},
			wantCode: http.StatusNoContent, wantSized: true,
		},
		{
			name:  "an out-of-range grid promotes nothing",
			world: gridWorld{exists: true, clients: preloadRow, sized: true},
			body:  `{"cols":0,"rows":62}`, wantCode: http.StatusBadRequest,
		},
		{
			name:  "a session this user does not have promotes nothing",
			world: gridWorld{exists: false, clients: preloadRow, sized: true},
			path:  "/sessions/nope/grid", wantCode: http.StatusNotFound,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			withUserMap(t, "alice="+osSelf+"\n")
			calls, promotions, _ := stubGridWorld(t, tc.world)

			body, path := tc.body, tc.path
			if body == "" {
				body = `{"cols":200,"rows":50}`
			}
			if path == "" {
				path = "/sessions/work/grid"
			}

			w := httptest.NewRecorder()
			handleSessionByName(w, sessionReq(http.MethodPost, path, body, "alice"))

			if w.Code != tc.wantCode {
				t.Errorf("status = %d, want %d (body %q)", w.Code, tc.wantCode, w.Body.String())
			}
			if len(*promotions) != len(tc.wantPromoted) {
				t.Fatalf("refresh-client called %d time(s), want %d: %+v",
					len(*promotions), len(tc.wantPromoted), *promotions)
			}
			for i, want := range tc.wantPromoted {
				if (*promotions)[i].client != want {
					t.Errorf("promotion %d targeted %q, want %q", i, (*promotions)[i].client, want)
				}
				if (*promotions)[i].osUser != osSelf {
					t.Errorf("promotion %d ran as %q, want the mapped user %q", i, (*promotions)[i].osUser, osSelf)
				}
			}
			if sized := len(*calls) > 0; sized != tc.wantSized {
				t.Fatalf("SizeGrid called %d time(s), want sized = %v", len(*calls), tc.wantSized)
			}
			// One step IN FRONT of the sizing work: the client has stopped
			// ignoring size by the time tmux is told what the size is.
			if tc.wantSized && (*calls)[0].promotedFirst != len(tc.wantPromoted) {
				t.Errorf("%d promotion(s) had happened when SizeGrid ran, want %d",
					(*calls)[0].promotedFirst, len(tc.wantPromoted))
			}
		})
	}
}

// The name the promotion points -t at comes from the same client list the
// driven mark reads, not from a second fork.
func TestPreloadClientNameFindsTheHoversClient(t *testing.T) {
	cases := []struct {
		name    string
		clients string
		want    string
	}{
		{"no clients", "", ""},
		{"only a driver", gridDriverRow, ""},
		{
			"only a watcher",
			"work\tattached,ignore-size,read-only,UTF-8\t1\t1\t/dev/pts/9\n",
			"",
		},
		{
			"a preload among the rest",
			gridDriverRow + "work\tattached,ignore-size,UTF-8\t1\t1\t/dev/pts/7\n",
			"/dev/pts/7",
		},
		{
			"a preload tmux did not name",
			"work\tattached,ignore-size,UTF-8\t1\t1\n",
			"",
		},
		{
			// Typed into, so the driven mark calls it a driver — and it is
			// still the client carrying ignore-size, so this is still the name
			// promotion needs.
			"a driver still carrying ignore-size after a reconnect",
			"work\tattached,focused,ignore-size,UTF-8\t9\t1\t/dev/pts/5\n",
			"/dev/pts/5",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := preloadClientName(parseClients([]byte(tc.clients))); got != tc.want {
				t.Errorf("preloadClientName = %q, want %q", got, tc.want)
			}
		})
	}
}

// --- claiming the window for the client that asked (decisions 6, 7, 8) ----

// Rows carrying the pid column clientsListFmt now ends with.
const (
	claimDriverRow  = "work\tattached,focused,UTF-8\t1788093053\t1788093053\t/dev/pts/3\t9001\n"
	claimPreloadRow = "work\tattached,ignore-size,UTF-8\t1788093060\t1788093060\t/dev/pts/7\t9002\n"
	claimWatcherRow = "work\tattached,ignore-size,read-only,UTF-8\t1788093060\t1788093060\t/dev/pts/9\t9003\n"
	claimForeignRow = "elsewhere\tattached,focused,UTF-8\t1788093060\t1788093060\t/dev/pts/11\t9004\n"
)

const claimID = "0123456789abcdef0123456789abcdef"

// An UNPINNED session is the common case after the revert shipped, and tmux
// moves its window to whichever client is switched to it. Measured on tmux 3.4
// here 2026-09-13: `switch-client -c /dev/pts/66 -t =demo:` took a 100x30
// window to 200x50 and left window-size unset, so the session keeps following
// its clients afterwards -- which is what last-active-wins means.
func TestSizeGridSwitchesAnUnpinnedWindowToTheCallingClient(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)

	cases := []struct {
		name  string
		world gridWorld
		body  string

		wantCode      int
		wantSwitched  []string // client names switch-client targeted, in order
		wantPromoted  []string
		wantSizeCalls int
	}{
		{
			name: "the client that asked takes the window",
			world: gridWorld{
				exists: true, clients: claimDriverRow, sized: false,
				records: map[string]clientRecord{claimID: {TTY: "/dev/pts/3"}},
			},
			wantCode: http.StatusNoContent, wantSwitched: []string{"/dev/pts/3"},
			wantPromoted: []string{"/dev/pts/3"}, wantSizeCalls: 1,
		},
		{
			// Decision 7. A socket opened before this shipped sends no id, and
			// everything about it has to behave exactly as it did: promote the
			// preload, size, and never switch a client we cannot name.
			name: "no id at all falls back to today's behaviour",
			world: gridWorld{
				exists: true, clients: claimDriverRow + claimPreloadRow, sized: false,
			},
			wantCode: http.StatusNoContent, wantPromoted: []string{"/dev/pts/7"},
			wantSizeCalls: 1,
		},
		{
			name: "an id with no record behaves the same way",
			world: gridWorld{
				exists: true, clients: claimDriverRow + claimPreloadRow, sized: false,
				records: map[string]clientRecord{"ffffffffffffffffffffffffffffffff": {TTY: "/dev/pts/3"}},
			},
			wantCode: http.StatusNoContent, wantPromoted: []string{"/dev/pts/7"},
			wantSizeCalls: 1,
		},
		{
			// A record whose tty has gone: the connection died, or the file
			// outlived it. list-clients is the check, and it fails closed.
			name: "a record naming a tty nobody is attached on",
			world: gridWorld{
				exists: true, clients: claimDriverRow, sized: false,
				records: map[string]clientRecord{claimID: {TTY: "/dev/pts/99"}},
			},
			wantCode: http.StatusNoContent, wantSizeCalls: 1,
		},
		{
			// THE HARD GATE, at the handler. switch-client MOVES a client to
			// the session named, so a record resolving to a client sitting on
			// another session must never reach it.
			name: "a client attached to another session is never switched",
			world: gridWorld{
				exists: true, clients: claimDriverRow + claimForeignRow, sized: false,
				records: map[string]clientRecord{claimID: {TTY: "/dev/pts/11"}},
			},
			wantCode: http.StatusNoContent, wantSizeCalls: 1,
		},
		{
			// A watcher's own id resolves to a read-only client, and Watch
			// mode's whole promise is that it cannot take the window.
			name: "a read-only client is neither promoted nor switched",
			world: gridWorld{
				exists: true, clients: claimDriverRow + claimWatcherRow, sized: false,
				records: map[string]clientRecord{claimID: {TTY: "/dev/pts/9"}},
			},
			wantCode: http.StatusNoContent, wantSizeCalls: 1,
		},
		{
			// A PINNED session is SizeGrid's territory: it has already resized
			// the window by the time this branch is reached, and switch-client
			// would move nothing (window-size is manual).
			name: "a pinned session is sized, not switched",
			world: gridWorld{
				exists: true, clients: claimDriverRow, sized: true,
				records: map[string]clientRecord{claimID: {TTY: "/dev/pts/3"}},
			},
			wantCode: http.StatusNoContent, wantPromoted: []string{"/dev/pts/3"},
			wantSizeCalls: 1,
		},
		{
			// switch-client errors when the client has gone between the list
			// and the call ("can't find client"). setSessionGrid swallows every
			// failure anyway, so a 500 would buy nothing and cost a journal
			// line per pointer sweep.
			name: "switch-client failing does not fail the request",
			world: gridWorld{
				exists: true, clients: claimDriverRow, sized: false,
				records:   map[string]clientRecord{claimID: {TTY: "/dev/pts/3"}},
				switchErr: fmt.Errorf("can't find client"),
			},
			wantCode: http.StatusNoContent, wantSwitched: []string{"/dev/pts/3"},
			wantPromoted: []string{"/dev/pts/3"}, wantSizeCalls: 1,
		},
		{
			// Nobody driving still wins, whoever is asking: the 409 is in
			// front of every claim.
			name: "a resolved id does not get past the drive check",
			world: gridWorld{
				exists: true, clients: claimWatcherRow, sized: false,
				records: map[string]clientRecord{claimID: {TTY: "/dev/pts/9"}},
			},
			wantCode: http.StatusConflict,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			withUserMap(t, "alice="+osSelf+"\n")
			calls, promotions, switches := stubGridWorld(t, tc.world)

			body := tc.body
			if body == "" {
				body = `{"cols":200,"rows":50,"client":"` + claimID + `","reason":"input"}`
			}
			w := httptest.NewRecorder()
			handleSessionByName(w, sessionReq(http.MethodPost, "/sessions/work/grid", body, "alice"))

			if w.Code != tc.wantCode {
				t.Errorf("status = %d, want %d (body %q)", w.Code, tc.wantCode, w.Body.String())
			}
			if len(*switches) != len(tc.wantSwitched) {
				t.Fatalf("switch-client called %d time(s), want %d: %+v",
					len(*switches), len(tc.wantSwitched), *switches)
			}
			for i, want := range tc.wantSwitched {
				got := (*switches)[i]
				if got.client != want {
					t.Errorf("switch %d targeted %q, want %q", i, got.client, want)
				}
				if got.session != "work" {
					t.Errorf("switch %d named session %q, want work", i, got.session)
				}
				if got.osUser != osSelf {
					t.Errorf("switch %d ran as %q, want %q", i, got.osUser, osSelf)
				}
			}
			if len(*promotions) != len(tc.wantPromoted) {
				t.Fatalf("refresh-client called %d time(s), want %d: %+v",
					len(*promotions), len(tc.wantPromoted), *promotions)
			}
			for i, want := range tc.wantPromoted {
				if (*promotions)[i].client != want {
					t.Errorf("promotion %d targeted %q, want %q", i, (*promotions)[i].client, want)
				}
			}
			if len(*calls) != tc.wantSizeCalls {
				t.Errorf("SizeGrid called %d time(s), want %d", len(*calls), tc.wantSizeCalls)
			}
		})
	}
}

// gridClaims picks the session.grid_claimed events out of a recorder.
func gridClaims(t *testing.T, rec *recorder) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, line := range rec.lines {
		ev := decodeEvent(t, line)
		if ev["event.name"] == "session.grid_claimed" {
			out = append(out, ev)
		}
	}
	return out
}

// Decision 12. The event exists to answer two questions the journal could not
// answer before: which device took the window, and what made it. tl.conn is
// also how "is per-client resolution working in the wild" gets an answer,
// since a sudo'd attach records a tty its tmux client does not run on.
func TestGridClaimedCarriesTheClientTheSizesAndTheReason(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)

	cases := []struct {
		name     string
		world    gridWorld
		body     string
		wantAny  bool
		wantAttr map[string]string
	}{
		{
			name: "an unpinned session claimed by a resolved client",
			world: gridWorld{
				exists: true, clients: claimDriverRow, sized: false, window: "80x24",
				records: map[string]clientRecord{claimID: {TTY: "/dev/pts/3"}},
			},
			body:    `{"cols":200,"rows":50,"client":"` + claimID + `","reason":"input"}`,
			wantAny: true,
			wantAttr: map[string]string{
				"tl.session": "work", "tl.conn": claimID,
				"tl.from": "80x24", "tl.to": "200x50", "tl.reason": "input",
			},
		},
		{
			name: "a pinned session, where SizeGrid did the moving",
			world: gridWorld{
				exists: true, clients: claimDriverRow, sized: true, window: "80x24",
				records: map[string]clientRecord{claimID: {TTY: "/dev/pts/3"}},
			},
			body:    `{"cols":200,"rows":50,"client":"` + claimID + `","reason":"focus"}`,
			wantAny: true,
			wantAttr: map[string]string{
				"tl.conn": claimID, "tl.from": "80x24", "tl.to": "200x50", "tl.reason": "focus",
			},
		},
		{
			// A word this build does not know is recorded as unknown rather
			// than written through: the reason comes from a browser, and an
			// open vocabulary in a telemetry attribute is a series anybody can
			// invent.
			name: "a reason nobody has heard of",
			world: gridWorld{
				exists: true, clients: claimDriverRow, sized: true,
				records: map[string]clientRecord{claimID: {TTY: "/dev/pts/3"}},
			},
			body:     `{"cols":200,"rows":50,"client":"` + claimID + `","reason":"whatever-i-like"}`,
			wantAny:  true,
			wantAttr: map[string]string{"tl.reason": "unknown"},
		},
		{
			name: "a claim with no id at all, on a pinned session",
			world: gridWorld{
				exists: true, clients: claimDriverRow, sized: true,
			},
			body:     `{"cols":200,"rows":50}`,
			wantAny:  true,
			wantAttr: map[string]string{"tl.conn": "none", "tl.reason": "unknown"},
		},
		{
			// Nothing moved, so nothing is claimed: an unpinned session with
			// no resolvable client is exactly the pre-deploy case, and it was
			// silent then.
			name: "nothing moved, nothing claimed",
			world: gridWorld{
				exists: true, clients: claimDriverRow, sized: false,
			},
			body:    `{"cols":200,"rows":50,"reason":"fit"}`,
			wantAny: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			withUserMap(t, "alice="+osSelf+"\n")
			stubGridWorld(t, tc.world)
			rec := withTelemetry(t)

			w := httptest.NewRecorder()
			handleSessionByName(w, sessionReq(http.MethodPost, "/sessions/work/grid", tc.body, "alice"))
			if w.Code != http.StatusNoContent {
				t.Fatalf("status = %d: %s", w.Code, w.Body.String())
			}

			claims := gridClaims(t, rec)
			if !tc.wantAny {
				if len(claims) != 0 {
					t.Fatalf("emitted %d claim(s) when nothing moved: %v", len(claims), claims)
				}
				return
			}
			if len(claims) != 1 {
				t.Fatalf("emitted %d claim(s), want 1: %v", len(claims), rec.lines)
			}
			attrs := attrsOf(t, claims[0])
			for k, want := range tc.wantAttr {
				if got, _ := attrs[k].(string); got != want {
					t.Errorf("%s = %v, want %q (attrs %v)", k, attrs[k], want, attrs)
				}
			}
		})
	}
}

// The reason vocabulary is CLOSED, and it is one table so the frontend and the
// server cannot drift. Every word here is a claim site in
// frontend-v2/src/components/TerminalNative.tsx or SessionView.tsx.
func TestGridClaimReasonVocabulary(t *testing.T) {
	for _, ok := range []string{"focus", "input", "socket-open", "take-control", "fit", "visible-set"} {
		if got := gridClaimReason(ok); got != ok {
			t.Errorf("gridClaimReason(%q) = %q, want it kept", ok, got)
		}
	}
	for _, bad := range []string{"", "FOCUS", "input ", "pointer", "../x", strings.Repeat("a", 600)} {
		if got := gridClaimReason(bad); got != "unknown" {
			t.Errorf("gridClaimReason(%q) = %q, want unknown", bad, got)
		}
	}
}
