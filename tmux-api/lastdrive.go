package main

import (
	"log"
	"strconv"
)

// Last driven — when a human last had hands on a session.
//
// The session list used to show tmux's #{session_activity} as "last active", but
// tmux bumps that on ANY attach, a read-only one included (measured 2026-08-18:
// `tmux attach -r` on an idle session moved it by 1s). So merely opening a
// session to WATCH it reset the number, which contradicts what Watch mode is
// for: a viewer consumes the session and leaves it as it found it — it does not
// take the grid, and it should not move the clock either.
//
// This derives the number from the client list instead, which already
// distinguishes driving from merely attached (driven.go), and keeps it in the
// session's own @last_drive option: it lives and dies with the session, survives
// a tmux-api restart, and anything else reading the session's options sees the
// same answer. It also catches a driver who never went through the lobby at all
// — `sudo -u <user> tmux attach` shows up in the client list like any other
// read-write client, where an attach-time hook in the API would have missed it.

// lastDriveOption is where the stamp lives, beside @title and @claude_state.
const lastDriveOption = "@last_drive"

// driveStaleAfter is how long a stamp may lag before it is rewritten. The list
// is rebuilt every 5s and a `set-option` per driven session per poll would be
// pure churn; within this window "just now" reads the same to a human.
const driveStaleAfter int64 = 30

// driveStamp is one session's @last_drive that needs writing.
type driveStamp struct {
	Name string
	At   int64
}

// drivesToStamp decides which sessions need their stamp written, given the live
// list (Driven + LastDrive + Created already populated) and the current time.
// Pure: the tmux calls live in stampDrives.
//
// Three rules, in the order they matter:
//
//   - a session with a read-write client attached is stamped `now`, so the
//     number tracks the driver for as long as they stay;
//   - a session with no stamp at all is seeded from its CREATION time, because
//     creating a session attaches read-write, so that is a truthful lower bound
//     — and it means nothing ever renders an empty timer, including every
//     session that predates this option;
//   - anything else is left alone. In particular a session being WATCHED keeps
//     the stamp it had, however long the watching lasts. That is the whole point.
func drivesToStamp(sessions []Session, now, staleAfter int64) []driveStamp {
	var out []driveStamp
	for _, s := range sessions {
		switch {
		case s.Driven && (s.LastDrive == 0 || now-s.LastDrive >= staleAfter):
			out = append(out, driveStamp{Name: s.Name, At: now})
		case !s.Driven && s.LastDrive == 0 && s.Created > 0:
			out = append(out, driveStamp{Name: s.Name, At: s.Created})
		}
	}
	return out
}

// stampDrives writes the stamps drivesToStamp asked for and updates the list in
// place, so the response being built already carries the new value rather than
// showing the old one until the next poll.
//
// Best-effort by design: a failed write leaves the previous stamp, which reads
// slightly stale rather than wrong, and must never take the session list down.
// The tmux seam is a var so the handler's tests stay pure units.
var setDriveOption = func(osUser, session string, at int64) error {
	return gridInjector.SetOption(osUser, session, lastDriveOption, strconv.FormatInt(at, 10))
}

func stampDrives(osUser string, sessions []Session, now int64) {
	stamps := drivesToStamp(sessions, now, driveStaleAfter)
	if len(stamps) == 0 {
		return
	}
	at := map[string]int64{}
	for _, s := range stamps {
		if err := setDriveOption(osUser, s.Name, s.At); err != nil {
			log.Printf("stamp %s %s/%s: %v", lastDriveOption, osUser, s.Name, err)
			continue
		}
		at[s.Name] = s.At
	}
	for i := range sessions {
		if v, ok := at[sessions[i].Name]; ok {
			sessions[i].LastDrive = v
		}
	}
}
