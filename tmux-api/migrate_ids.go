package main

// The one-time pass that gives every session already running an opaque id for a
// name (ADR-0019, docs/plans/2026-09-04-prompt-first-sessions-design.md).
//
// New sessions arrive with an id because the browser mints one before it
// attaches. Sessions that were already running when this shipped carry names
// people chose — `authentik`, `ny-reibursment` — and leaving them there would
// mean two identity models for as long as any of them lives, which on this box
// is measured in weeks. So they are renamed here, once.
//
// Nothing a person reads is lost: a session's old name becomes its @title
// before it is renamed, so `authentik` keeps reading `authentik` in the sidebar.
// A session that already has a title keeps that title.
//
// Best-effort per session, like the cascade it calls. One session that will not
// rename (it died between the list and the rename, say) must not stop the rest,
// and the marker below is only written after a pass that left nothing behind —
// so a run that was interrupted or partly refused is simply finished by the
// next start, with the sessions it already did skipped by their shape.

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"terminal-lobby/telemetry"
)

// sessionIDMarkerPath records that the pass has completed cleanly. A var as a
// test seam, like mapPath and tmuxBinary; production never reassigns it.
//
// Its own file rather than a flag inside an existing document: every store here
// is per-user, and this is one fact about the whole box.
var sessionIDMarkerPath = "/var/lib/tmux-api/session-ids-migrated"

// migrateRenameAttempts bounds the retry when tmux says the name is taken. A
// 60-bit id colliding is not an event anyone will see; the retry exists because
// tmux hands us the refusal for free, and one collision must not cost a session
// its migration.
const migrateRenameAttempts = 4

// migrateSessionNamesToIDs runs the pass for every user and returns how many
// sessions it renamed. `list` supplies each user's sessions (userSessions in
// production, a fixture in tests).
//
// Never returns an error: the service has to come up regardless, and every
// failure mode here is one the next start retries.
func migrateSessionNamesToIDs(users []string, list func(osUser string) []Session) int {
	if _, err := os.Stat(sessionIDMarkerPath); err == nil {
		return 0
	} else if !os.IsNotExist(err) {
		// Can't read the marker: do nothing rather than risk renaming a box
		// that has already been done.
		log.Printf("session-id migration: cannot read %s (%v); skipping", sessionIDMarkerPath, err)
		return 0
	}
	total, leftBehind := 0, 0
	for _, u := range users {
		renamed, failed := migrateUserSessionNames(u, list(u))
		total += renamed
		leftBehind += failed
	}
	if leftBehind > 0 {
		log.Printf("session-id migration: renamed %d, %d left for the next start", total, leftBehind)
		return total
	}
	if err := writeMigrationMarker(); err != nil {
		// The pass DID happen; only the record of it did not. The cost is
		// re-listing every user's sessions on the next start and finding
		// nothing to do, since every session it touched now has an id.
		log.Printf("session-id migration: marking it done failed: %v", err)
	}
	if total > 0 {
		log.Printf("session-id migration: renamed %d sessions to ids", total)
	}
	return total
}

func writeMigrationMarker() error {
	if err := os.MkdirAll(filepath.Dir(sessionIDMarkerPath), 0o755); err != nil {
		return err
	}
	return os.WriteFile(sessionIDMarkerPath, []byte("done\n"), 0o644)
}

// migrateUserSessionNames renames one user's named sessions to ids, returning
// how many it renamed and how many it could not.
func migrateUserSessionNames(osUser string, sessions []Session) (renamed, failed int) {
	for _, s := range sessions {
		if isMintedName(s.Name) {
			continue // already done, on an earlier run or at creation
		}
		if migrateOneSessionName(osUser, s) {
			renamed++
		} else {
			failed++
		}
	}
	return renamed, failed
}

// migrateOneSessionName gives one session an id for a name.
//
// The title is stamped FIRST, under the OLD name. The two writes cannot be made
// atomic, so the question is which half a crash between them should leave
// behind: stamping first leaves a session that still answers to `authentik` and
// now also carries it as a title, which the next start finishes. Renaming first
// would leave a session called `q4m8...` with nothing readable about it at all,
// and no way to recover what it was.
func migrateOneSessionName(osUser string, s Session) bool {
	title := s.Title
	if title == "" {
		// Nothing readable about this session but the name it is about to
		// lose, so the name becomes the title.
		title = s.Name
		if err := stampSessionTitle(osUser, s.Name, title); err != nil {
			log.Printf("session-id migration: keeping %s/%s's name as its title failed: %v", osUser, s.Name, err)
			return false
		}
	}
	// Remember the title under the name the session still has; the rename below
	// carries the entry to the new one, the titles store being one of the six
	// the cascade moves. A session titled through the API already has an entry,
	// but one whose @title arrived any other way does not — and this pass is
	// the last moment anything knows what the session used to be called.
	if err := titleStoreInstance.set(osUser, s.Name, title); err != nil {
		// The title is live on the session either way; only its survival
		// across a restore is at risk, which is not worth abandoning a
		// migration that has otherwise worked.
		log.Printf("session-id migration: remembering %s/%s's title failed: %v", osUser, s.Name, err)
	}
	newName, ok := renameToFreshID(osUser, s.Name)
	if !ok {
		return false
	}
	carryRenameAcrossStores(osUser, s.Name, newName)
	sessionsCacheInstance.invalidate(osUser)
	events.Emit("session.renamed", osUser, telemetry.Attrs{
		"tl.from": s.Name, "tl.to": newName, "tl.client": "migrate",
	})
	return true
}

// renameToFreshID renames a session to a minted id, retrying if tmux says the
// name is taken — which is the whole of collision handling, since tmux refuses
// a duplicate rather than merging two sessions.
func renameToFreshID(osUser, oldName string) (string, bool) {
	for i := 0; i < migrateRenameAttempts; i++ {
		newName := newMintedName()
		out, err := tmuxCmd(osUser, "rename-session", "-t", exactSession(oldName), newName).CombinedOutput()
		if err == nil {
			return newName, true
		}
		msg := string(out)
		if strings.Contains(msg, "duplicate session") || strings.Contains(msg, "session already exists") {
			continue
		}
		// Gone, or a server that is not answering. Either way the next start
		// finds it renamed or not there at all.
		log.Printf("session-id migration: renaming %s/%s failed: %v: %s",
			osUser, oldName, err, strings.TrimSpace(msg))
		return "", false
	}
	log.Printf("session-id migration: %s/%s collided on %d fresh ids; leaving it alone",
		osUser, oldName, migrateRenameAttempts)
	return "", false
}

// stampSessionTitle writes @title onto a live session. The tmux half of
// stampTitle, without the response writing: this path has no request to answer
// and no status to map, so a failure is a log line and a session left for the
// next start.
func stampSessionTitle(osUser, name, title string) error {
	out, err := tmuxCmd(osUser, "set-option", "-t", exactPane(name), sessionTitleOption, title).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}
