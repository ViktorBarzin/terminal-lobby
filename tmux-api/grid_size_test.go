package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
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

// latestCall is one `switch-client`, the unpinned half of the same request.
type latestCall struct{ osUser, session, client string }

// gridWorld is the tmux the handler runs against: the raw list-clients output
// the session answers with, and what its three writing seams do.
type gridWorld struct {
	exists     bool
	clients    string // clientsListFmt columns, one client per line
	sized      bool
	sizeErr    error
	promoteErr error
	latestErr  error
}

// stubGridWorld swaps the handler's five seams and hands back what the three
// writing ones received.
func stubGridWorld(t *testing.T, w gridWorld) (*[]gridCall, *[]promoteCall, *[]latestCall) {
	t.Helper()
	var calls []gridCall
	var promotions []promoteCall
	var latests []latestCall

	oldExists, oldClients, oldSize := sessionExists, sessionClients, sizeGrid
	oldPromote, oldLatest := promoteClient, makeLatest
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
	makeLatest = func(osUser, session, clientName string) error {
		latests = append(latests, latestCall{osUser, session, clientName})
		return w.latestErr
	}
	t.Cleanup(func() {
		sessionExists, sessionClients, sizeGrid = oldExists, oldClients, oldSize
		promoteClient, makeLatest = oldPromote, oldLatest
	})
	return &calls, &promotions, &latests
}

// An ordinary read-write client, which is what `driven: true` used to mean
// before the seam handed back the whole client list. 200x50, which is the size
// the requests below claim, so it reads as the client that is asking.
const gridDriverRow = "work\tattached,focused,UTF-8\t1788093053\t1788093053\t/dev/pts/3\t200\t50\n"

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

// --- an unpinned session, which is most of them ----------------------------

// THE CLAIM HAS TO REACH AN UNPINNED SESSION TOO, and `resize-window` is not
// how, because it pins whatever it touches.
//
// A pin is laid down by the first read-only attach and by nothing else, so a
// session nobody has ever watched is unpinned — 18 of the 20 sessions running
// on this box on 2026-09-19. For those `SizeGrid` deliberately does nothing and
// tmux is left to size the window from its `latest` client, which tmux moves on
// a keystroke or an attach and on nothing else. Reading a session is neither,
// so the reason this endpoint exists — the window following the device being
// read — was missing for the majority of sessions. Measured that day: a desktop
// reading `gridbug` in a 147x40 terminal sat in a 60x19 window for as long as a
// second client held it, and the two claims the browser sent both came back 204
// with nothing moved.
//
// `switch-client` is how you say "this client is the one being used" in tmux's
// own terms, and it is what tmux does for itself when somebody types.
func TestSizeGridPointsAnUnpinnedWindowAtTheClientBeingRead(t *testing.T) {
	const (
		// The desktop asking, and a phone holding the window at its own size.
		desktopRow  = "work\tattached,focused,UTF-8\t1788093053\t1788093053\t/dev/pts/3\t200\t50\n"
		phoneRow    = "work\tattached,UTF-8\t1788093060\t1788093060\t/dev/pts/8\t60\t20\n"
		watcherRow  = "work\tattached,ignore-size,read-only,UTF-8\t1788093060\t1788093060\t/dev/pts/9\t200\t50\n"
		namelessRow = "work\tattached,UTF-8\t1788093053\t1788093053\t\t200\t50\n"
	)

	osSelf, _ := twoLocalUsers(t)

	cases := []struct {
		name  string
		world gridWorld

		wantCode   int
		wantLatest []string // the client names switch-client was pointed at
	}{
		{
			name:     "an unpinned window follows the client that asked",
			world:    gridWorld{exists: true, clients: desktopRow + phoneRow, sized: false},
			wantCode: http.StatusNoContent, wantLatest: []string{"/dev/pts/3"},
		},
		{
			// A pinned window ignores `latest` entirely — that is what the pin
			// means — so the resize is the whole of the work and a
			// switch-client would be a fork that changes nothing.
			name:     "a pinned session is resized, and nothing else",
			world:    gridWorld{exists: true, clients: desktopRow + phoneRow, sized: true},
			wantCode: http.StatusNoContent,
		},
		{
			// The caller's own client has not reported its new size yet, so
			// nothing here is the client that asked. Saying nothing is right:
			// the resize on its way is itself a tmux event, and guessing would
			// hand the window to somebody else's device.
			name:     "no client is this size, so nothing moves",
			world:    gridWorld{exists: true, clients: phoneRow, sized: false},
			wantCode: http.StatusNoContent,
		},
		{
			// A watcher never moves the window. It is ignore-size in tmux's
			// eyes too, so making it latest would leave the window where it
			// was — but a size it happens to share with the caller must not be
			// what picks it.
			name:     "a watcher of the same size is not the one picked",
			world:    gridWorld{exists: true, clients: watcherRow + desktopRow, sized: false},
			wantCode: http.StatusNoContent, wantLatest: []string{"/dev/pts/3"},
		},
		{
			name:     "a watcher alone cannot claim the grid at all",
			world:    gridWorld{exists: true, clients: watcherRow, sized: false},
			wantCode: http.StatusConflict,
		},
		{
			// -c needs a name, the same way -t does for the promotion.
			name:     "a client tmux did not name is left alone",
			world:    gridWorld{exists: true, clients: namelessRow, sized: false},
			wantCode: http.StatusNoContent,
		},
		{
			// The request has already done everything it can, and a client
			// that went away between the list and the call is not a 500.
			name: "switch-client failing does not fail the request",
			world: gridWorld{exists: true, clients: desktopRow, sized: false,
				latestErr: fmt.Errorf("no such client")},
			wantCode: http.StatusNoContent, wantLatest: []string{"/dev/pts/3"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			withUserMap(t, "alice="+osSelf+"\n")
			_, _, latests := stubGridWorld(t, tc.world)

			w := httptest.NewRecorder()
			handleSessionByName(w, sessionReq(http.MethodPost, "/sessions/work/grid",
				`{"cols":200,"rows":50}`, "alice"))

			if w.Code != tc.wantCode {
				t.Errorf("status = %d, want %d (body %q)", w.Code, tc.wantCode, w.Body.String())
			}
			if len(*latests) != len(tc.wantLatest) {
				t.Fatalf("switch-client called %d time(s), want %d: %+v",
					len(*latests), len(tc.wantLatest), *latests)
			}
			for i, want := range tc.wantLatest {
				got := (*latests)[i]
				if got.client != want {
					t.Errorf("switch-client %d targeted %q, want %q", i, got.client, want)
				}
				if got.session != "work" {
					t.Errorf("switch-client %d named session %q, want \"work\"", i, got.session)
				}
				if got.osUser != osSelf {
					t.Errorf("switch-client %d ran as %q, want the mapped user %q", i, got.osUser, osSelf)
				}
			}
		})
	}
}

// The client a request speaks for is picked by the one thing it says about
// itself: the size it just reported.
//
// TWO CLIENTS OF THE SAME USER ARE INDISTINGUISHABLE HERE — one identity
// header, and no way to say which tmux client an HTTP request belongs to (the
// comment at the top of grid_size.go says so). The size closes that gap well
// enough to act on: a client matching it either IS the caller, or is a second
// device measuring exactly the same grid, and pointing the window at that one
// produces the size the caller asked for anyway.
func TestReadingClientNameFindsTheClientThatAsked(t *testing.T) {
	const (
		desktop = "work\tattached,focused,UTF-8\t1\t1\t/dev/pts/3\t200\t50\n"
		phone   = "work\tattached,UTF-8\t1\t1\t/dev/pts/8\t60\t20\n"
		watcher = "work\tattached,ignore-size,read-only,UTF-8\t1\t1\t/dev/pts/9\t200\t50\n"
		preload = "work\tattached,ignore-size,UTF-8\t1\t1\t/dev/pts/7\t200\t50\n"
		unnamed = "work\tattached,UTF-8\t1\t1\t\t200\t50\n"
		unsized = "work\tattached,UTF-8\t1\t1\t/dev/pts/4\n"
	)
	cases := []struct {
		name       string
		clients    string
		cols, rows int
		want       string
	}{
		{"no clients", "", 200, 50, ""},
		{"the one that matches", desktop + phone, 200, 50, "/dev/pts/3"},
		{"the other one", desktop + phone, 60, 20, "/dev/pts/8"},
		{"nothing of that size", desktop + phone, 120, 30, ""},
		{"a watcher is skipped", watcher, 200, 50, ""},
		{"a watcher is skipped in company", watcher + desktop, 200, 50, "/dev/pts/3"},
		{
			// Promoted a few lines earlier in the same request, so its flags
			// still read ignore-size where tmux has already cleared them. It
			// is the client being read, and it is eligible.
			"a just-promoted preload", preload, 200, 50, "/dev/pts/7",
		},
		{"a client tmux did not name", unnamed, 200, 50, ""},
		{
			// A tmux that answered without the size columns reports 0x0, and
			// no real client is 0x0, so nothing matches and nothing moves.
			"a tmux that did not report a size", unsized, 200, 50, "",
		},
		{"and a claim of 0x0 matches it no better", unsized, 0, 0, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := readingClientName(parseClients([]byte(tc.clients)), tc.cols, tc.rows)
			if got != tc.want {
				t.Errorf("readingClientName(%dx%d) = %q, want %q", tc.cols, tc.rows, got, tc.want)
			}
		})
	}
}
