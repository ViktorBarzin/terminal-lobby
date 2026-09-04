package main

// Carrying a rename into everything keyed by a session's NAME.
//
// A tmux session's identity is its name, and six different places record that
// name independently: the per-user layout, the global project store's
// (owner, name) refs, the share store's grants, the image directory under
// /var/lib/clipboard-store, the killed-assignment memory, and the titles store.
//
// Only the layout followed a rename before session titles, which was a
// reasonable place to stop while renaming was a rare, deliberate act. Deriving
// names from titles briefly made it the ordinary consequence of retitling, and
// the gaps stopped being edge cases: a retitle would drop a session out of
// every other member's sidebar, revoke its guests without telling either side,
// and strand its pictures.
//
// ADR-0019 made a session's name a minted id that never moves, so renaming is
// a rare, deliberate act again. Two callers are left, and both need all six
// stores carried: the one-time migration that gives every pre-ADR session an id
// (migrate_ids.go), and POST /sessions/{name}/rename.
//
// Everything here is best-effort and logged rather than fatal. The tmux rename
// has already landed by the time any of this runs, so returning an error would
// report failure for something that did happen, and stopping at the first
// problem would leave the remaining stores stale as well. Design:
// docs/plans/2026-08-16-session-titles-design.md.

import (
	"errors"
	"log"
	"os"
	"path/filepath"
)

// sessionImageRoot is clipboard-upload's per-(user, session) image store. A var
// as a test seam, like tmuxBinary; production never reassigns it.
//
// tmux-api and clipboard-upload run as the same service user and the store is
// owned by it, so moving a session's images is a plain rename here rather than
// a call into the other service.
var sessionImageRoot = "/var/lib/clipboard-store"

// carryRenameAcrossStores moves every record of oldName to newName for one
// user. Safe to call when the session appears in none of them.
func carryRenameAcrossStores(osUser, oldName, newName string) {
	if err := layoutStoreInstance.renameSession(osUser, oldName, newName); err != nil {
		log.Printf("layout rename %s→%s for %s failed: %v", oldName, newName, osUser, err)
	}
	if err := titleStoreInstance.rename(osUser, oldName, newName); err != nil {
		log.Printf("title memory rename %s→%s for %s failed: %v", oldName, newName, osUser, err)
	}
	if err := assignmentStoreInstance.rename(osUser, oldName, newName); err != nil {
		log.Printf("assignment memory rename %s→%s for %s failed: %v", oldName, newName, osUser, err)
	}
	renameProjectRefs(osUser, oldName, newName)
	renameShares(osUser, oldName, newName)
	renameImageDir(osUser, oldName, newName)
}

// renameProjectRefs updates the global project store's (owner, name) session
// refs. Scoped to THIS owner: session names are unique only within one user's
// tmux server, so another user's identically-named session is a different
// session and must not move.
func renameProjectRefs(osUser, oldName, newName string) {
	err := projectStoreInstance.update(func(ps *ProjectSet) error {
		changed := false
		for i := range ps.Projects {
			for j := range ps.Projects[i].Sessions {
				ref := &ps.Projects[i].Sessions[j]
				if ref.Owner == osUser && ref.Name == oldName {
					ref.Name = newName
					changed = true
				}
			}
		}
		if !changed {
			return errNoProjectChange
		}
		return nil
	})
	if err != nil && !errors.Is(err, errNoProjectChange) {
		log.Printf("project refs rename %s→%s for %s failed: %v", oldName, newName, osUser, err)
	}
}

// renameShares updates the grants that let named guests attach this session.
// Without it a retitle silently revokes access, which looks to the guest like
// the session was un-shared and to the owner like nothing happened.
func renameShares(osUser, oldName, newName string) {
	err := shareStoreInstance.update(func(ss *ShareSet) error {
		changed := false
		for i := range ss.Shares {
			if ss.Shares[i].Owner == osUser && ss.Shares[i].Name == oldName {
				ss.Shares[i].Name = newName
				changed = true
			}
		}
		if !changed {
			return errNoShareChange
		}
		return nil
	})
	if err != nil && !errors.Is(err, errNoShareChange) {
		log.Printf("shares rename %s→%s for %s failed: %v", oldName, newName, osUser, err)
	}
}

// errNoShareChange aborts a shareStore.update without saving — this session was
// never shared, so there is nothing to rewrite.
var errNoShareChange = errors.New("no share change")

// renameImageDir moves the session's images.
//
// A destination that already exists is left ALONE rather than merged: another
// session held that name and its pictures are its own. That leaves the images
// under the old name, which is the same outcome as before this function
// existed — recoverable, where a merge would not be.
func renameImageDir(osUser, oldName, newName string) {
	from := filepath.Join(sessionImageRoot, osUser, oldName)
	to := filepath.Join(sessionImageRoot, osUser, newName)
	if _, err := os.Stat(from); err != nil {
		return // no images for this session, which is the common case
	}
	if _, err := os.Stat(to); err == nil {
		log.Printf("image store: %s already exists for %s; leaving %s's images where they are",
			newName, osUser, oldName)
		return
	}
	if err := os.Rename(from, to); err != nil {
		log.Printf("image store rename %s→%s for %s failed: %v", oldName, newName, osUser, err)
	}
}
