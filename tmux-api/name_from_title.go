package main

// The tmux session name follows the title again (ADR-0022).
//
// ADR-0019 made a name an opaque minted id and put everything readable in
// @title. That is right for every surface the lobby draws, and wrong for the
// ones it does not: `tmux ls`, the status bar's #S, the terminal window title,
// and choose-tree all show a name, and a box full of 12-character ids is not
// something a person can work in. Viktor asked for the name back on
// 2026-09-06.
//
// So a title landing renames the session, and this is the whole of that rule.
// The costs ADR-0019 named are real and are met rather than denied:
//
//   - the six stores keyed by name are carried by carryRenameAcrossStores,
//     which stayed in the tree for the migration and is now an ordinary caller
//     again, and it repins the grid hooks tmux itself holds;
//   - the selection follows by tmux session id, which a rename does not change
//     (frontend-v2 `followRenamedSelection`), and both retitle paths refresh
//     immediately rather than waiting out a poll;
//   - a collision suffixes rather than merging, because tmux refuses a
//     duplicate name outright;
//   - machine-made sessions are left alone (reservedName), since another
//     service recognises them by prefix.
//
// The one thing that cannot be fully closed is the phantom-session trap: a tab
// holding `?arg=<old name>` reconnects through `tmux new-session -A` and would
// create the old name as an empty session. followRenamedSelection is what
// narrows it, by moving the selection (and so the iframe's args) before a
// reconnect happens.

import (
	"log"
	"strconv"
	"strings"

	"terminal-lobby/slug"
	"terminal-lobby/telemetry"
)

// derivedNameFor answers what a session should be called, given what it is
// called now, what it is titled, and which names are already in use.
//
// Returns ok=false when nothing should move: an unusable title, a reserved
// name, or a name this title already produced. `taken` is every live name for
// the user; the session's own name in it is not a collision with itself.
//
// Pure, so the rule is testable without a tmux server.
func derivedNameFor(name, title string, taken map[string]bool) (string, bool) {
	if reservedName(name) {
		return "", false
	}
	base := slug.FromTitle(title)
	if base == "" {
		// A CJK or emoji-only title, or no title. There is nothing to derive
		// from, and a name invented anyway would say less than the id does.
		return "", false
	}
	if isDerivedFrom(name, base) {
		return "", false
	}
	free := make(map[string]bool, len(taken))
	for n := range taken {
		if n != name {
			free[n] = true
		}
	}
	next := slug.Free(base, free)
	if next == name {
		return "", false
	}
	return next, true
}

// isDerivedFrom reports whether name is already what base produces, either
// exactly or as one of Free's `base-N` variants.
//
// The variant check is what makes this a fixed point. Without it a session that
// lost the base name to a sibling would be renamed on every poll: `deploy-2`
// re-derives `deploy`, finds it taken, and asks for `deploy-3`, then `deploy-4`.
func isDerivedFrom(name, base string) bool {
	if name == base {
		return true
	}
	rest, ok := strings.CutPrefix(name, base+"-")
	if !ok {
		return false
	}
	n, err := strconv.Atoi(rest)
	return err == nil && n > 1
}

// renameToDerivedName renames a session to match its title, reading the live
// session list to find what names are taken.
//
// NOT for a caller already inside the listing: userSessions runs the auto-title
// pass, so calling it from there re-enters. Those callers hold the names
// already and pass them to renameToDerivedNameAmong.
func renameToDerivedName(osUser, name, title, client string) string {
	return renameToDerivedNameAmong(osUser, name, title, client, liveNames(osUser))
}

// renameToDerivedNameAmong renames a session to match its title and carries the
// rename into everything keyed by the old name. Returns the name the session
// has when it returns, which is the old one whenever nothing moved.
//
// Best-effort by design, like the cascade it calls: the title has already
// landed, so a rename that will not happen costs a readable `tmux ls` and
// nothing else. `client` names the path for the telemetry, matching the values
// session.renamed already carries.
func renameToDerivedNameAmong(osUser, name, title, client string, taken map[string]bool) string {
	newName, ok := derivedNameFor(name, title, taken)
	if !ok {
		return name
	}
	out, err := tmuxCmd(osUser, "rename-session", "-t", exactSession(name), newName).CombinedOutput()
	if err != nil {
		// A duplicate here is a race with another session claiming the name
		// between the listing and now. tmux refusing it is the backstop that
		// makes the race harmless, so it is logged like any other failure and
		// the next retitle tries again.
		log.Printf("name from title: renaming %s/%s to %s failed: %v: %s",
			osUser, name, newName, err, strings.TrimSpace(string(out)))
		return name
	}
	carryRenameAcrossStores(osUser, name, newName)
	sessionsCacheInstance.invalidate(osUser)
	events.Emit("session.renamed", osUser, telemetry.Attrs{
		"tl.from": name, "tl.to": newName, "tl.client": client,
	})
	return newName
}

// liveNames is every session name this user is running, which is what a
// collision is measured against.
func liveNames(osUser string) map[string]bool {
	taken := map[string]bool{}
	for _, s := range userSessions(osUser) {
		taken[s.Name] = true
	}
	return taken
}

// backfillDerivedNames gives a readable name to a session that was titled
// before this rule existed.
//
// The rename fires when a title LANDS, so a session already carrying one is
// never reached by it: nothing retitles a conversation that has been running
// for a week. Measured on the box the day ADR-0022 landed — 29 of wizard's
// sessions were titled and every one still read as a minted id in `tmux ls`,
// which is the whole complaint.
//
// Restricted to MINTED IDS on purpose. The retitle path renames whatever the
// old name was, because a person asking for a new title is asking for it; this
// pass acts on a title nobody just touched, so it may only replace a name that
// says nothing. A shell somebody called `beads` keeps that name whatever its
// title says.
//
// Runs on every listing rather than once at start: it is a fixed point, so a
// pass with nothing to do costs one map build and a comparison per session, and
// running continuously also catches a session restored under an id.
func backfillDerivedNames(osUser string, sessions []Session) {
	taken := make(map[string]bool, len(sessions))
	for i := range sessions {
		taken[sessions[i].Name] = true
	}
	for i := range sessions {
		s := &sessions[i]
		if s.Title == "" || !isMintedName(s.Name) {
			continue
		}
		origin := s.Name
		s.Name = renameToDerivedNameAmong(osUser, origin, s.Title, "backfill", taken)
		if s.Name != origin {
			delete(taken, origin)
			taken[s.Name] = true
		}
	}
}
