package main

import "testing"

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
		"work\tattached,UTF-8\t100\n" +
			"work\tattached,read-only,UTF-8\t400\n" + // a watcher's client counts too
			"idle\tattached,UTF-8\t250\n"))
	got := latestActivity(clients)
	if got["work"] != 400 {
		t.Errorf("work = %d, want the newest (400)", got["work"])
	}
	if got["idle"] != 250 {
		t.Errorf("idle = %d, want 250", got["idle"])
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
