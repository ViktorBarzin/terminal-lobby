package t3client

// Lobby states a T3 thread maps onto.
const (
	StateRunning  = "running"
	StateAwaiting = "awaiting"
	StateDone     = "done"
)

// LobbyState maps a T3 thread status onto the lobby's three states. A status
// T3 adds later lands on "done", the state that asks nothing of the user.
func LobbyState(t3Status string) string {
	switch t3Status {
	case "preparing", "queued", "starting", "running":
		return StateRunning
	case "waiting":
		return StateAwaiting
	default:
		return StateDone
	}
}
