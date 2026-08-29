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
			clients: "work attached,focused,UTF-8\n",
			want:    map[string]bool{"work": true, "idle": false},
		},
		{
			name:    "a lone watcher is NOT driving",
			clients: "work attached,focused,ignore-size,read-only,UTF-8\n",
			want:    map[string]bool{"work": false, "idle": false},
		},
		{
			name: "several watchers are still not driving",
			clients: "work attached,read-only,UTF-8\n" +
				"work attached,ignore-size,read-only,UTF-8\n",
			want: map[string]bool{"work": false, "idle": false},
		},
		{
			name: "a watcher alongside a driver counts as driven",
			clients: "work attached,ignore-size,read-only,UTF-8\n" +
				"work attached,focused,UTF-8\n",
			want: map[string]bool{"work": true, "idle": false},
		},
		{
			name: "each session is judged on its own clients",
			clients: "work attached,focused,UTF-8\n" +
				"idle attached,read-only,UTF-8\n",
			want: map[string]bool{"work": true, "idle": false},
		},
		{
			name:    "a malformed row is ignored rather than guessed at",
			clients: "no-flags-column\n\n   \nwork attached,UTF-8\n",
			want:    map[string]bool{"work": true, "idle": false},
		},
		{
			name: "a session name is matched exactly, not by prefix",
			// tmux resolves absent names by prefix elsewhere; this must not.
			clients: "work-2 attached,focused,UTF-8\n",
			want:    map[string]bool{"work": false, "idle": false},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sessions := []Session{{Name: "work"}, {Name: "idle"}}
			markDriven(sessions, []byte(tc.clients))
			for _, s := range sessions {
				if s.Driven != tc.want[s.Name] {
					t.Errorf("%s: driven = %v, want %v", s.Name, s.Driven, tc.want[s.Name])
				}
			}
		})
	}
}

// A session name can contain a space only outside the API's NAME_RE, but the
// parse must still not smear one client's flags onto another session.
func TestMarkDrivenSplitsOnTheLastFieldNotTheFirstSpace(t *testing.T) {
	sessions := []Session{{Name: "my work"}}
	markDriven(sessions, []byte("my work attached,focused,UTF-8\n"))
	if !sessions[0].Driven {
		t.Errorf("a session name containing a space was not matched")
	}
}
