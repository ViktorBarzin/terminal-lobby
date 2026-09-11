package main

import (
	"strconv"
	"strings"
)

// clientsListFmt asks tmux, in ONE call, everything the session list wants to
// know about attached clients: which session each one is on, whether it is
// read-only, when its user last typed, and when the client attached.
//
// Two readers used to fork `list-clients` separately, milliseconds apart, for
// the two halves of this — the driven mark and the activity gate. They are one
// question about one client list, so they are one call.
//
// client_created is here to tell an attach apart from a keystroke: tmux stamps
// client_activity when the client is created and moves it only on real input,
// so the two being equal means "attached, never typed into". See latestActivity.
//
// client_name is last, and is what `refresh-client -t` takes: promoting a
// preload client needs to name one, and reading it here keeps that to the same
// fork rather than a second list-clients (grid_size.go).
//
// Tab-delimited because a session name may contain spaces (possible outside the
// API's NAME_RE) while neither a name nor a flag list can contain a tab, so no
// odd name can smear its client onto the wrong session.
const clientsListFmt = "#{client_session}\t#{client_flags}\t#{client_activity}\t#{client_created}\t#{client_name}"

// client is one row of clientsListFmt.
type client struct {
	Session  string
	Flags    string
	Activity int64  // unix seconds; 0 when tmux did not report one
	Created  int64  // unix seconds the client attached; 0 when not reported
	Name     string // tmux's own name for the client (a pty path); "" when not reported
}

// parseClients reads the output of `list-clients -F clientsListFmt`. A row
// missing its flags column is a tmux hiccup rather than a client, and is
// dropped; a row whose activity or created stamp will not parse keeps the
// client and loses only that timestamp, which is the direction that fails open.
// A row with no name column keeps the client too, and loses only the name.
func parseClients(out []byte) []client {
	var cs []client
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimRight(line, "\r")
		session, rest, ok := strings.Cut(line, "\t")
		if !ok || session == "" {
			continue
		}
		flags, rest, _ := strings.Cut(rest, "\t")
		act, rest, _ := strings.Cut(rest, "\t")
		created, name, _ := strings.Cut(rest, "\t")
		c := client{Session: session, Flags: flags, Name: name}
		if v, err := strconv.ParseInt(act, 10, 64); err == nil {
			c.Activity = v
		}
		if v, err := strconv.ParseInt(created, 10, 64); err == nil {
			c.Created = v
		}
		cs = append(cs, c)
	}
	return cs
}

// hasClientFlag reads tmux's comma-separated #{client_flags} list, one whole
// flag at a time. Whole tokens rather than a substring search, so a flag whose
// name merely contains another's is never mistaken for it.
func hasClientFlag(flags, want string) bool {
	for _, f := range strings.Split(flags, ",") {
		if f == want {
			return true
		}
	}
	return false
}

// hasPreloadFlags reports whether a client carries the flags a HOVER's attach
// leaves behind: read-write, so the click can promote it instead of attaching a
// second time, and carrying tmux's ignore-size flag so it does not take the
// window size from whoever is already reading the session (ADR-0026). Measured
// on tmux 3.4 here, 2026-09-11: with an 80x40 client attached, a 200x50 preload
// left the window at 80x39; alone on the session it sizes the window like any
// other client, which is tmux's own rule — a flagged client is ignored only
// while an unflagged one is attached.
//
// Read-only is the whole of what tells a preload from a Watch-mode client,
// because tmux's `attach -r` is an alias for `-f read-only,ignore-size` and so
// a watcher carries ignore-size too.
//
// This is the FLAGS half of the question, and it is what POST
// /sessions/{name}/grid promotes on (grid_size.go): the flags decide whether
// tmux lets that client move the window, whoever is behind it. The driven mark
// asks the narrower question below.
func hasPreloadFlags(flags string) bool {
	return hasClientFlag(flags, "attached") &&
		hasClientFlag(flags, "ignore-size") &&
		!isReadOnly(flags)
}

// typedInto reports whether a human has pressed a key in this client, rather
// than merely attached it.
//
// tmux moves client_activity on client INPUT and initialises it to the attach
// time, so activity having moved PAST created is what says somebody has hands
// on this client. Measured on tmux 3.4 on this box, 2026-09-11, against a
// client attached with `-f ignore-size`:
//
//	at attach            created/activity = 1789166777 1789166777
//	after 3s idle        created/activity = 1789166777 1789166777
//	after a pty RESIZE   created/activity = 1789166777 1789166777
//	after one keypress   created/activity = 1789166777 1789166785
//
// The resize line is what makes this usable for the preload question: a hidden
// preload's xterm reports its size as soon as it attaches, and that does not
// read as typing.
//
// A missing created stamp (0) fails open — the activity is taken at face value
// — which is the direction latestActivity has always failed.
func typedInto(c client) bool { return c.Activity > c.Created }

// isPreloadClient reports whether a client is a hover's preload that NOBODY HAS
// DRIVEN: the flags above, and not a keystroke since it attached.
//
// The flags alone are not enough, because a promoted client goes back to
// carrying them. `terminal/attach.ts` reopens its socket with the args captured
// at mount, and arg5 stays `pre` for the life of the mount (SessionView says so
// where it captures `preloadAttach`), so any ttyd reconnect — a few seconds of
// lost Wi-Fi, on a visible tab, at an unchanged size — runs `attach-session -f
// ignore-size` again for a session the user is typing into. Nothing promotes
// that client again on its own: TerminalNative claims the grid from safeFit and
// from focusin, and a same-size reconnect under an already-focused terminal
// fires neither.
//
// Judging on flags alone therefore reported driven:false for a session with
// hands on it, which is the one answer this mark exists to prevent: the phone
// picking that session up would read "nobody is driving", attach read-write and
// take the grid from the desktop. A keystroke is the evidence a hover can never
// produce, so it is what separates the two.
func isPreloadClient(c client) bool {
	return hasPreloadFlags(c.Flags) && !typedInto(c)
}

// markDriven sets Driven on every session that has at least one READ-WRITE
// client attached, not counting the ones a hover left behind.
//
// "Attached" and "being driven" are different questions, and Watch mode is
// built on the difference: a session with two watchers and nobody typing is
// attached twice over and driven by nobody. The lobby uses this to join a new
// device as a viewer only when someone is actually driving — so that opening a
// session on your phone never takes the grid from the desktop you left it on.
//
// A preload client is the third case and is excluded for the same reason: it is
// read-write, so left in it would light the mark on every card the pointer
// crossed, and stampDrives would restamp each of their @last_drive clocks. A
// hover is not a human with hands on the session; the click that promotes the
// client (grid_size.go) is, and after that promotion it reads as an ordinary
// driver here — as does a client still carrying ignore-size after a reconnect,
// once its user types (isPreloadClient says why the keystroke is the test).
//
// A courtesy default, not an access decision: the server still resolves the
// real mode at attach time, and a stale answer here only means the toggle
// starts on the wrong side, one click from right.
func markDriven(sessions []Session, clients []client) {
	driving := map[string]bool{}
	for _, c := range clients {
		if isReadOnly(c.Flags) || isPreloadClient(c) {
			continue
		}
		driving[c.Session] = true
	}
	for i := range sessions {
		sessions[i].Driven = driving[sessions[i].Name]
	}
}

// latestActivity keeps the NEWEST client_activity per session, counting only
// clients that have actually been typed into.
//
// client_activity moves on client INPUT (keystrokes through ttyd), not on pane
// output, which is what makes it usable as a "the human touched this session"
// signal. But tmux INITIALISES it to the attach time, so a client that has only
// attached carries a timestamp that looks exactly like a keystroke a moment ago.
// The lobby keeps every session you have visited mounted for a day, each holding
// an attached client, so opening the app minted a fresh false keystroke for all
// of them at once. typedInto is what tells the two apart, and the driven mark
// now reads the same predicate, so a keystroke means one thing here.
//
// A missing Created stamp (0) fails open: the activity is taken at face value,
// as it was before this distinction existed.
//
// Sessions with no typed-into client are simply absent, and the push sender
// remembers the maximum it has ever seen.
func latestActivity(clients []client) map[string]int64 {
	m := map[string]int64{}
	for _, c := range clients {
		if !typedInto(c) {
			continue // attached, never typed into
		}
		if c.Activity > m[c.Session] {
			m[c.Session] = c.Activity
		}
	}
	return m
}
