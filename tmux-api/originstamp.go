package main

// The one-shot pass that gives every session already running an origin
// (docs/plans/2026-09-06-test-session-origin-design.md).
//
// From the deploy onwards a session says who made it: the lobby's own create
// path stamps @tl_origin=user (devvm/tmux-user-attach) and the harnesses stamp
// `test`. Every session ALIVE AT THE UPGRADE says nothing, and saying nothing
// is what makes a session SYSTEM (origin.go) — so without this pass the deploy
// would sweep the whole live list into a collapsed System group at once, stop
// every one of those sessions pushing, and stop recording them. Measured on the
// box on 2026-09-06: 26 live sessions, four of them made by tooling. Stamping
// them all `user` is right for 22 of the 26 and wrong for the three strays that
// match no harness convention, which get killed by hand afterwards. The
// alternative was hiding all 26 and dragging back the ones that matter.
//
// Sessions whose NAME is reserved (qa-, t3e2e-, tlp-t, the pool prefix) are
// deliberately left unstamped: reservedName forces them system whatever the
// option says, so stamping them would write a value nothing reads and would
// read, to anyone inspecting the option later, as the lobby claiming it made a
// harness session.
//
// Same shape as migrateSessionNamesToIDs (migrate_ids.go) — one pass per user
// at start, best-effort per session, never fatal — with one difference: no
// marker file. This pass is self-limiting, because a session that carries an
// origin is skipped by the origin it carries, so a second run is a no-op with
// nothing on disk having to remember the first. A run that was interrupted or
// partly refused is simply finished by the next start.

import (
	"log"
	"strings"
)

// grandfatherSessionOrigins runs the pass for every user and returns how many
// sessions it stamped. `list` supplies each user's sessions (userSessions in
// production, a fixture in tests), matching migrateSessionNamesToIDs.
//
// Never returns an error: the service has to come up regardless, and every
// failure here is one the next start retries.
func grandfatherSessionOrigins(users []string, list func(osUser string) []Session) int {
	total := 0
	for _, u := range users {
		stamped, failed := grandfatherUserOrigins(u, list(u))
		total += stamped
		if failed > 0 {
			log.Printf("origin grandfather: %d of %s's sessions would not stamp; the next start retries them", failed, u)
		}
	}
	if total > 0 {
		log.Printf("origin grandfather: stamped %d sessions as %s", total, originUser)
	}
	return total
}

// grandfatherUserOrigins stamps one user's unattributed sessions, returning how
// many it stamped and how many it could not.
func grandfatherUserOrigins(osUser string, sessions []Session) (stamped, failed int) {
	for _, s := range sessions {
		if s.Origin != "" {
			// Somebody already said, and this pass never overrules them. A
			// harness's `test` surviving a service restart is the whole point:
			// a restart is exactly when a QA fleet's sessions are most likely
			// to still be alive.
			continue
		}
		if reservedName(s.Name) {
			continue
		}
		if msg, err := setOriginOption(osUser, s.Name, originUser); err != nil {
			log.Printf("origin grandfather: stamping %s/%s failed: %v: %s", osUser, s.Name, err, msg)
			failed++
			continue
		}
		stamped++
	}
	if stamped > 0 {
		// The body the cache is holding was built before the stamp landed, and
		// serving it for the rest of the window would show these sessions as
		// system — the flicker this pass exists to prevent.
		sessionsCacheInstance.invalidate(osUser)
	}
	return stamped, failed
}

// setOriginOption writes @tl_origin onto a live session, returning tmux's own
// message alongside the error so a caller mapping statuses can ask
// tmuxTargetMissing about it. The tmux half of both writers there are: this
// pass, which logs a failure and leaves the session for the next start, and
// POST /sessions/{name}/origin (session_mutate.go), which turns it into a
// status.
//
// exactPane, not exactSession: set-option's -t takes a pane target, and the
// leading '=' is what stops a bare name resolving by prefix onto a sibling —
// the hazard stampTitle documents, and the same one here.
func setOriginOption(osUser, name, origin string) (string, error) {
	out, err := tmuxCmd(osUser, "set-option", "-t", exactPane(name), originOption, origin).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}
