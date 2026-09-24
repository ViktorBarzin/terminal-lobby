package sessionio

import (
	"context"
	"sync"
)

// sessionLocks makes the requests that drive one session's plan approval or
// permission mode take turns: two devices answering the same dialog must not
// interleave one's paste with the other's digit, and two mode walks must not
// each read the other's presses as their own. The design asked for a lock per
// session (docs/plans/2026-09-24-text-composer-redesign.md, contract 3).
//
// Each key holds a one-slot channel rather than a mutex, so a request whose
// reader has gone stops waiting when its context ends. Keys are the tmux
// socket, the user and the session, so the stand-ins of one test run do not
// share a lock. An entry is a few dozen bytes and there is one per session
// ever driven, so the map is left to grow rather than cleaned up.
var sessionLocks sync.Map // string -> chan struct{}

// lockSession waits for the session's turn and returns the release.
func (in *Injector) lockSession(ctx context.Context, osUser, session string) (func(), error) {
	v, _ := sessionLocks.LoadOrStore(in.socket+"\x00"+osUser+"\x00"+session, make(chan struct{}, 1))
	turn := v.(chan struct{})
	select {
	case turn <- struct{}{}:
		return func() { <-turn }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
