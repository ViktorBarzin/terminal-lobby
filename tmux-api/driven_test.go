package main

import (
	"strings"
	"testing"
)

// "Attached" and "being driven" are different questions, and Watch mode turns
// on the difference: a session with two watchers and nobody typing is attached
// twice over and driven by no one. markDriven answers the second question, so
// the lobby can join a new device as a viewer only when someone is actually
// driving.
func TestMarkDrivenSeparatesDrivingFromMerelyAttached(t *testing.T) {
	cases := []struct {
		name    string
		clients string
		want    map[string]bool
	}{
		{
			name:    "nobody attached at all",
			clients: "",
			want:    map[string]bool{"work": false, "idle": false},
		},
		{
			name:    "one read-write client is driving",
			clients: "work\tattached,focused,UTF-8\t1788093053\n",
			want:    map[string]bool{"work": true, "idle": false},
		},
		{
			name:    "a lone watcher is NOT driving",
			clients: "work\tattached,focused,ignore-size,read-only,UTF-8\t1788093053\n",
			want:    map[string]bool{"work": false, "idle": false},
		},
		{
			name: "several watchers are still not driving",
			clients: "work\tattached,read-only,UTF-8\t1788093053\n" +
				"work\tattached,ignore-size,read-only,UTF-8\t1788093053\n",
			want: map[string]bool{"work": false, "idle": false},
		},
		{
			name: "a watcher alongside a driver counts as driven",
			clients: "work\tattached,ignore-size,read-only,UTF-8\t1788093053\n" +
				"work\tattached,focused,UTF-8\t1788093053\n",
			want: map[string]bool{"work": true, "idle": false},
		},
		{
			name: "each session is judged on its own clients",
			clients: "work\tattached,focused,UTF-8\t1788093053\n" +
				"idle\tattached,read-only,UTF-8\t1788093053\n",
			want: map[string]bool{"work": true, "idle": false},
		},
		{
			name:    "a malformed row is ignored rather than guessed at",
			clients: "no-flags-column\n\n   \nwork\tattached,UTF-8\t1788093053\n",
			want:    map[string]bool{"work": true, "idle": false},
		},
		{
			name: "a session name is matched exactly, not by prefix",
			// tmux resolves absent names by prefix elsewhere; this must not.
			clients: "work-2\tattached,focused,UTF-8\t1788093053\n",
			want:    map[string]bool{"work": false, "idle": false},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sessions := []Session{{Name: "work"}, {Name: "idle"}}
			markDriven(sessions, parseClients([]byte(tc.clients)))
			for _, s := range sessions {
				if s.Driven != tc.want[s.Name] {
					t.Errorf("%s: driven = %v, want %v", s.Name, s.Driven, tc.want[s.Name])
				}
			}
		})
	}
}

// A session name can contain a space only outside the API's NAME_RE, but the
// parse must still not smear one client's flags onto another session. The
// fields are tab-delimited precisely so a space in a name carries no meaning.
func TestMarkDrivenKeepsASessionNameContainingASpaceIntact(t *testing.T) {
	sessions := []Session{{Name: "my work"}}
	markDriven(sessions, parseClients([]byte("my work\tattached,focused,UTF-8\t1788093053\n")))
	if !sessions[0].Driven {
		t.Errorf("a session name containing a space was not matched")
	}
}

// The activity half of the same client list. It used to come from a second
// `list-clients` fork with its own format string, issued milliseconds after
// the first, once per subscribed user per five-second tick.
func TestLatestActivityKeepsTheNewestKeystrokePerSession(t *testing.T) {
	clients := parseClients([]byte(
		"work\tattached,UTF-8\t100\t50\n" +
			"work\tattached,read-only,UTF-8\t400\t50\n" + // a watcher's client counts too
			"idle\tattached,UTF-8\t250\t50\n"))
	got := latestActivity(clients)
	if got["work"] != 400 {
		t.Errorf("work = %d, want the newest (400)", got["work"])
	}
	if got["idle"] != 250 {
		t.Errorf("idle = %d, want 250", got["idle"])
	}
}

// Attaching is not typing. tmux stamps client_activity at attach and only moves
// it on a real key, so a client that has never been typed into reports the two
// timestamps equal — and the lobby holds an attached client for every session
// you have visited today (frontend-v2 store/keepalive.ts). Counting those as
// keystrokes made opening the app look like typing into a dozen sessions at
// once. Measured against tmux 3.4 on 2026-09-06:
//
//	at attach       created/activity = 1788687997 1788687997
//	after 6s idle   created/activity = 1788687997 1788687997
//	after a keypress                 = 1788687997 1788688005
func TestLatestActivityIgnoresAClientThatOnlyAttached(t *testing.T) {
	clients := parseClients([]byte(
		"fresh\tattached,UTF-8\t500\t500\n" + // attached, never typed into
			"typed\tattached,UTF-8\t600\t500\n")) // attached, then typed into
	got := latestActivity(clients)
	if _, ok := got["fresh"]; ok {
		t.Errorf("a client that only attached was read as a keystroke: %d", got["fresh"])
	}
	if got["typed"] != 600 {
		t.Errorf("typed = %d, want 600", got["typed"])
	}
}

// A watcher that never typed does not hide the driver who did.
func TestLatestActivityPrefersTheClientThatTyped(t *testing.T) {
	clients := parseClients([]byte(
		"work\tattached,UTF-8\t600\t500\n" + // typed at 600
			"work\tattached,read-only,UTF-8\t900\t900\n")) // attached at 900, silent
	if got := latestActivity(clients)["work"]; got != 600 {
		t.Errorf("work = %d, want 600 — the only real keystroke", got)
	}
}

// A tmux too old to report client_created, or a row it could not stamp, leaves
// created at zero. That must fail OPEN — treat the activity as real — rather
// than silently dropping every session's reading.
func TestLatestActivityFailsOpenWithoutACreatedStamp(t *testing.T) {
	clients := parseClients([]byte("work\tattached,UTF-8\t600\n"))
	if got := latestActivity(clients)["work"]; got != 600 {
		t.Errorf("work = %d, want 600", got)
	}
}

// A row tmux could not stamp keeps its client — losing the timestamp makes the
// gate fail open, which is the direction that never silences a notification.
func TestParseClientsKeepsAClientWhoseActivityWillNotParse(t *testing.T) {
	clients := parseClients([]byte("work\tattached,UTF-8\t\n"))
	if len(clients) != 1 || clients[0].Session != "work" {
		t.Fatalf("got %+v", clients)
	}
	if clients[0].Activity != 0 {
		t.Errorf("activity = %d, want 0", clients[0].Activity)
	}
}

func TestParseClientsDropsARowWithNoFlagsColumn(t *testing.T) {
	if got := parseClients([]byte("no-tabs-here\n\n")); len(got) != 0 {
		t.Fatalf("got %+v, want none", got)
	}
}

// --- preload clients ------------------------------------------------------

// A PRELOAD client is what hovering a sidebar card leaves attached: read-write,
// so the click can promote it instead of attaching a second time, and carrying
// tmux's ignore-size flag so it cannot move the window of a session nobody has
// opened yet (ADR-0026).
//
// Watch mode's clients carry ignore-size too — tmux's `attach -r` is an alias
// for `-f read-only,ignore-size` — so read-only is the whole of what tells the
// two apart. The flag lists here are what tmux 3.4 prints for #{client_flags}.
func TestHasPreloadFlagsTellsAHoverApartFromADriverAndAWatcher(t *testing.T) {
	cases := []struct {
		name  string
		flags string
		want  bool
	}{
		{"a hover's preload attach", "attached,focused,ignore-size,UTF-8", true},
		{"a preload that never took focus", "attached,ignore-size,UTF-8", true},
		{"a watcher carries ignore-size AND read-only", "attached,focused,ignore-size,read-only,UTF-8", false},
		{"attach -r, the same pair without focus", "attached,ignore-size,read-only,UTF-8", false},
		{"an ordinary driving client", "attached,focused,UTF-8", false},
		{"a read-only client not ignoring size", "attached,read-only,UTF-8", false},
		{"a promoted preload reads as an ordinary driver", "attached,focused,UTF-8", false},
		// The flags alone cannot tell a hover from a reconnected driver, which
		// is why the driven mark asks isPreloadClient the wider question below.
		{"no flags at all", "", false},
		{"not attached", "ignore-size,UTF-8", false},
		// Whole comma-separated tokens are compared, not substrings, so a flag
		// that merely contains one of these names is not mistaken for it. tmux
		// 3.4 prints no such flag; this is what keeps a later one harmless.
		{"a longer flag that only contains the name", "attached,ignore-size-ish,UTF-8", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := hasPreloadFlags(tc.flags); got != tc.want {
				t.Errorf("hasPreloadFlags(%q) = %v, want %v", tc.flags, got, tc.want)
			}
		})
	}
}

// The flags are half the question. A PROMOTED client goes back to carrying
// them: `terminal/attach.ts` reopens its socket with the args captured at mount
// and arg5 stays `pre` for the life of that mount, so a few seconds of lost
// Wi-Fi re-attaches a session the user is typing into with `-f ignore-size`,
// and nothing promotes it again — TerminalNative claims the grid from safeFit
// and from focusin, and a same-size reconnect under an already-focused terminal
// fires neither.
//
// A keystroke is what a hover can never produce, so it is what separates them.
// Measured on tmux 3.4 on this box, 2026-09-11, on a client attached with
// `-f ignore-size`: attach and three idle seconds both leave
// created/activity = 1789166777/1789166777, a pty RESIZE leaves them there too
// (which matters — a hidden preload's xterm reports its size at attach), and
// one keypress moves activity to 1789166785.
func TestIsPreloadClientNeedsTheFlagsAndNoKeystroke(t *testing.T) {
	cases := []struct {
		name string
		row  string
		want bool
	}{
		{
			"a hover, attached and never typed into",
			"work\tattached,focused,ignore-size,UTF-8\t1789166777\t1789166777\t/dev/pts/7\n",
			true,
		},
		{
			"a driver whose socket reconnected, still carrying ignore-size",
			"work\tattached,focused,ignore-size,UTF-8\t1789166785\t1789166777\t/dev/pts/7\n",
			false,
		},
		{
			"a watcher is not a preload however much they type",
			"work\tattached,ignore-size,read-only,UTF-8\t1789166785\t1789166777\t/dev/pts/9\n",
			false,
		},
		{
			"an ordinary driver",
			"work\tattached,focused,UTF-8\t1789166785\t1789166777\t/dev/pts/3\n",
			false,
		},
		{
			// No stamps at all: the flags are the only evidence, and they say
			// hover.
			"neither stamp reported",
			"work\tattached,ignore-size,UTF-8\n",
			true,
		},
		{
			// A tmux that reports activity but no created stamp fails OPEN —
			// the activity is taken at face value, so this reads as typed into
			// and counts as a driver. Same direction latestActivity has always
			// failed, and the direction that never hands a live desktop's grid
			// to a phone.
			"activity with no created stamp",
			"work\tattached,ignore-size,UTF-8\t1789166785\n",
			false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cs := parseClients([]byte(tc.row))
			if len(cs) != 1 {
				t.Fatalf("parsed %d clients, want 1", len(cs))
			}
			if got := isPreloadClient(cs[0]); got != tc.want {
				t.Errorf("isPreloadClient(%+v) = %v, want %v", cs[0], got, tc.want)
			}
		})
	}
}

// The consequence, through the mark itself: a session someone is typing into
// reads as driven even while its client still carries ignore-size.
//
// Without this, the lobby said driven:false for a session with hands on it the
// moment its socket blipped, @last_drive stopped advancing so the card's timer
// froze, and the same user opening that session on their phone was told nobody
// was driving — so the phone attached read-write and took the grid from the
// desktop. That is the outcome markDriven exists to prevent.
func TestMarkDrivenCountsADriverWhoseSocketReconnected(t *testing.T) {
	sessions := []Session{{Name: "work"}}
	markDriven(sessions, parseClients([]byte(
		"work\tattached,focused,ignore-size,UTF-8\t1789166785\t1789166777\t/dev/pts/7\n")))
	if !sessions[0].Driven {
		t.Errorf("a reconnected client that has been typed into read as a hover")
	}
}

// And the clock that hangs off it keeps moving, which is the half a user sees.
func TestAReconnectedDriverKeepsItsDriveClockAdvancing(t *testing.T) {
	const now, longAgo = int64(2000), int64(1000)
	sessions := []Session{
		{Name: "hovered", LastDrive: longAgo, Created: longAgo},
		{Name: "reconnected", LastDrive: longAgo, Created: longAgo},
	}
	markDriven(sessions, parseClients([]byte(
		"hovered\tattached,focused,ignore-size,UTF-8\t1789166777\t1789166777\t/dev/pts/7\n"+
			"reconnected\tattached,focused,ignore-size,UTF-8\t1789166785\t1789166777\t/dev/pts/8\n")))

	stamps := drivesToStamp(sessions, now, driveStaleAfter)
	if len(stamps) != 1 || stamps[0].Name != "reconnected" || stamps[0].At != now {
		t.Fatalf("stamps = %+v, want only reconnected at %d", stamps, now)
	}
}

// Hovering must not count as driving. An ignore-size client is read-write, so
// without this exclusion running the pointer down the sidebar would light the
// driven mark on every card it crossed — and drivesToStamp would restamp every
// one of their @last_drive clocks (ADR-0026).
func TestMarkDrivenIgnoresAPreloadClient(t *testing.T) {
	cases := []struct {
		name    string
		clients string
		want    map[string]bool
	}{
		{
			// Activity EQUAL to created is what tmux 3.4 prints for a client
			// that attached and was never typed into, which is every hover.
			name:    "a lone preload client is not driving",
			clients: "work\tattached,focused,ignore-size,UTF-8\t1788093053\t1788093053\n",
			want:    map[string]bool{"work": false, "idle": false},
		},
		{
			name: "a preload alongside a real driver is still driven",
			clients: "work\tattached,ignore-size,UTF-8\t1788093053\t1788093053\n" +
				"work\tattached,focused,UTF-8\t1788093053\t1788093053\n",
			want: map[string]bool{"work": true, "idle": false},
		},
		{
			name: "a preload alongside a watcher is driven by nobody",
			clients: "work\tattached,ignore-size,UTF-8\t1788093053\t1788093053\n" +
				"work\tattached,ignore-size,read-only,UTF-8\t1788093053\t1788093053\n",
			want: map[string]bool{"work": false, "idle": false},
		},
		{
			name: "the hover crossing one card does not light the next",
			clients: "work\tattached,ignore-size,UTF-8\t1788093053\t1788093053\n" +
				"idle\tattached,ignore-size,UTF-8\t1788093053\t1788093053\n",
			want: map[string]bool{"work": false, "idle": false},
		},
		{
			name:    "a promoted preload drives, because it no longer ignores size",
			clients: "work\tattached,focused,UTF-8\t1788093053\t1788093053\n",
			want:    map[string]bool{"work": true, "idle": false},
		},
		{
			// The same flags as the first case, one keystroke later: a socket
			// that reconnected re-attaches with ignore-size, and the person
			// typing into it is driving.
			name:    "a reconnected driver still carrying ignore-size IS driving",
			clients: "work\tattached,focused,ignore-size,UTF-8\t1788093060\t1788093053\n",
			want:    map[string]bool{"work": true, "idle": false},
		},
		{
			// A watcher's keys go nowhere, so a read-only client never drives
			// however its stamps read.
			name:    "a watcher who pressed a key is still not driving",
			clients: "work\tattached,ignore-size,read-only,UTF-8\t1788093060\t1788093053\n",
			want:    map[string]bool{"work": false, "idle": false},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sessions := []Session{{Name: "work"}, {Name: "idle"}}
			markDriven(sessions, parseClients([]byte(tc.clients)))
			for _, s := range sessions {
				if s.Driven != tc.want[s.Name] {
					t.Errorf("%s: driven = %v, want %v", s.Name, s.Driven, tc.want[s.Name])
				}
			}
		})
	}
}

// The consequence the exclusion exists for, through the function that writes
// the clock: a session whose only client is a hover's preload keeps the stamp
// it had. A session with a real driver is stamped `now`, as before.
func TestAPreloadedSessionDoesNotRestampItsDriveClock(t *testing.T) {
	const now, longAgo = int64(2000), int64(1000)
	sessions := []Session{
		{Name: "hovered", LastDrive: longAgo, Created: longAgo},
		{Name: "driven", LastDrive: longAgo, Created: longAgo},
	}
	markDriven(sessions, parseClients([]byte(
		"hovered\tattached,focused,ignore-size,UTF-8\t1788093053\t1788093053\n"+
			"driven\tattached,focused,UTF-8\t1788093053\t1788093053\n")))

	stamps := drivesToStamp(sessions, now, driveStaleAfter)
	if len(stamps) != 1 || stamps[0].Name != "driven" || stamps[0].At != now {
		t.Fatalf("stamps = %+v, want only driven at %d", stamps, now)
	}
}

// #{client_name} is what refresh-client's -t takes, and it rides the same
// list-clients call the driven mark already makes. A row without it — a tmux
// that did not report one — keeps the client and loses only the name.
func TestParseClientsReadsTheClientName(t *testing.T) {
	cases := []struct {
		name     string
		line     string
		wantName string
		wantAct  int64
		wantCrea int64
	}{
		{
			name:     "the full row",
			line:     "work\tattached,ignore-size,UTF-8\t600\t500\t/dev/pts/7\n",
			wantName: "/dev/pts/7", wantAct: 600, wantCrea: 500,
		},
		{
			name:     "no name column, as the older format printed",
			line:     "work\tattached,UTF-8\t600\t500\n",
			wantName: "", wantAct: 600, wantCrea: 500,
		},
		{
			name:     "flags only",
			line:     "work\tattached,UTF-8\n",
			wantName: "", wantAct: 0, wantCrea: 0,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := parseClients([]byte(tc.line))
			if len(got) != 1 {
				t.Fatalf("parsed %d clients, want 1: %+v", len(got), got)
			}
			if got[0].Name != tc.wantName {
				t.Errorf("name = %q, want %q", got[0].Name, tc.wantName)
			}
			if got[0].Activity != tc.wantAct || got[0].Created != tc.wantCrea {
				t.Errorf("activity/created = %d/%d, want %d/%d",
					got[0].Activity, got[0].Created, tc.wantAct, tc.wantCrea)
			}
		})
	}
}

// The format string has to ASK for the name, or the parser above never sees one.
func TestClientsListFmtAsksForTheClientName(t *testing.T) {
	if !strings.Contains(clientsListFmt, "#{client_name}") {
		t.Errorf("clientsListFmt = %q, wants a #{client_name} column", clientsListFmt)
	}
}
