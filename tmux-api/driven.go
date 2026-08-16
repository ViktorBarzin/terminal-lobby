package main

import "strings"

// drivenListFmt asks tmux which session each client is on and what kind of
// client it is. Session name first and flags LAST, split from the right: a
// session name may contain spaces (possible outside the API's NAME_RE) while
// the flags field never can, so splitting off the tail keeps an odd name intact
// instead of smearing its client onto the wrong session.
const drivenListFmt = "#{client_session} #{client_flags}"

// markDriven sets Driven on every session that has at least one READ-WRITE
// client attached.
//
// "Attached" and "being driven" are different questions, and Watch mode is
// built on the difference: a session with two watchers and nobody typing is
// attached twice over and driven by nobody. The lobby uses this to join a new
// device as a viewer only when someone is actually driving — so that opening a
// session on your phone never takes the grid from the desktop you left it on.
//
// A courtesy default, not an access decision: the server still resolves the
// real mode at attach time, and a stale answer here only means the toggle
// starts on the wrong side, one click from right.
func markDriven(sessions []Session, clientList []byte) {
	driving := map[string]bool{}
	for _, line := range strings.Split(string(clientList), "\n") {
		line = strings.TrimRight(line, "\r")
		i := strings.LastIndex(line, " ")
		if i <= 0 {
			continue // no flags column — a tmux hiccup, not a driver
		}
		session, flags := line[:i], line[i+1:]
		if strings.Contains(flags, "read-only") {
			continue
		}
		driving[session] = true
	}
	for i := range sessions {
		sessions[i].Driven = driving[sessions[i].Name]
	}
}
