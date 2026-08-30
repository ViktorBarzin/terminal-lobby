package main

import (
	"strconv"
	"strings"
)

// clientsListFmt asks tmux, in ONE call, everything the session list wants to
// know about attached clients: which session each one is on, whether it is
// read-only, and when its user last typed.
//
// Two readers used to fork `list-clients` separately, milliseconds apart, for
// the two halves of this — the driven mark and the activity gate. They are one
// question about one client list, so they are one call.
//
// Tab-delimited because a session name may contain spaces (possible outside the
// API's NAME_RE) while neither a name nor a flag list can contain a tab, so no
// odd name can smear its client onto the wrong session.
const clientsListFmt = "#{client_session}\t#{client_flags}\t#{client_activity}"

// client is one row of clientsListFmt.
type client struct {
	Session  string
	Flags    string
	Activity int64 // unix seconds; 0 when tmux did not report one
}

// parseClients reads the output of `list-clients -F clientsListFmt`. A row
// missing its flags column is a tmux hiccup rather than a client, and is
// dropped; a row whose activity will not parse keeps the client and loses only
// the timestamp, which is the direction that fails open.
func parseClients(out []byte) []client {
	var cs []client
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimRight(line, "\r")
		session, rest, ok := strings.Cut(line, "\t")
		if !ok || session == "" {
			continue
		}
		flags, act, _ := strings.Cut(rest, "\t")
		c := client{Session: session, Flags: flags}
		if v, err := strconv.ParseInt(act, 10, 64); err == nil {
			c.Activity = v
		}
		cs = append(cs, c)
	}
	return cs
}

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
func markDriven(sessions []Session, clients []client) {
	driving := map[string]bool{}
	for _, c := range clients {
		if strings.Contains(c.Flags, "read-only") {
			continue
		}
		driving[c.Session] = true
	}
	for i := range sessions {
		sessions[i].Driven = driving[sessions[i].Name]
	}
}

// latestActivity keeps the NEWEST client_activity per session.
//
// client_activity moves on client INPUT (keystrokes through ttyd), not on pane
// output, which is what makes it usable as a "the human touched this session"
// signal. Sessions with no attached client are simply absent, and the push
// sender remembers the maximum it has ever seen.
func latestActivity(clients []client) map[string]int64 {
	m := map[string]int64{}
	for _, c := range clients {
		if c.Activity > m[c.Session] {
			m[c.Session] = c.Activity
		}
	}
	return m
}
