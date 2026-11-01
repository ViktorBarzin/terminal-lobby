package t3client

import "testing"

func TestLobbyState(t *testing.T) {
	cases := map[string]string{
		"preparing":   StateRunning,
		"queued":      StateRunning,
		"starting":    StateRunning,
		"running":     StateRunning,
		"waiting":     StateAwaiting,
		"idle":        StateDone,
		"completed":   StateDone,
		"interrupted": StateDone,
		"failed":      StateDone,
		"cancelled":   StateDone,
		"rolled_back": StateDone,
		"":            StateDone,
		"something":   StateDone,
	}
	for in, want := range cases {
		if got := LobbyState(in); got != want {
			t.Errorf("LobbyState(%q) = %q, want %q", in, got, want)
		}
	}
}
