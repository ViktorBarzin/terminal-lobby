package main

import (
	"fmt"
	"log"
	"os/exec"
	"path/filepath"
	"strings"
)

const setfaclWrapper = "/usr/local/bin/tmux-user-setfacl"

// coownOp is a single ACL action to run against a project directory.
type coownOp struct {
	Action string // "grant" | "revoke"
	Dir    string
	Users  []string
	// Owner is the OS user whose home holds Dir. Root's authority to write an
	// ACL on the tree comes from them, so it travels to the wrapper as an
	// explicit argument and the wrapper re-derives their home from getent
	// before it touches anything.
	Owner string
}

// pathStrictlyUnder reports whether path sits below dir — never equal to it,
// never reached through "..". Both are compared lexically after Clean, so the
// caller passes paths it has already resolved.
func pathStrictlyUnder(path, dir string) bool {
	if path == "" || dir == "" || !filepath.IsAbs(path) || !filepath.IsAbs(dir) {
		return false
	}
	rel, err := filepath.Rel(filepath.Clean(dir), filepath.Clean(path))
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return false
	}
	return true
}

// coownDirOwner returns the candidate whose home directory strictly contains
// dir, or "" when none does. The candidates are the people already attached to
// the project, so a directory under a stranger's home has no owner and the op
// refuses instead of running unbound.
func coownDirOwner(dir string, candidates []string, homeOf func(string) string) string {
	if dir == "" {
		return ""
	}
	for _, c := range candidates {
		if c == "" {
			continue
		}
		if pathStrictlyUnder(dir, homeOf(c)) {
			return c
		}
	}
	return ""
}

// coownCandidates lists the users who could own the tree behind a project dir:
// its members, plus whoever created it (a creator who has since left the
// member list still owns their own home).
func coownCandidates(p GlobalProject) []string {
	out := memberUsers(p)
	if p.CreatedBy != "" {
		out = append(out, p.CreatedBy)
	}
	return out
}

// coownOwnerFunc resolves the owning user for a directory among a project's
// own people, against the real passwd database.
func coownOwnerFunc(p GlobalProject) func(string) string {
	cands := coownCandidates(p)
	return func(dir string) string { return coownDirOwner(dir, cands, homeOfUser) }
}

// coownOpsForPatch computes the ACL ops when a project's co-ownership flag or
// directory changes under PATCH. Pure (no exec) so the decision is unit-tested;
// the actual setfacl runs async via runCoownAsync. ownerOf binds each dir —
// old and new can sit under different homes — to the user who owns it.
func coownOpsForPatch(wasCoOwned bool, oldDir string, nowCoOwned bool, newDir string, members []string, ownerOf func(string) string) []coownOp {
	var ops []coownOp
	grant := func(dir string) { ops = append(ops, coownOp{"grant", dir, members, ownerOf(dir)}) }
	revoke := func(dir string) { ops = append(ops, coownOp{"revoke", dir, members, ownerOf(dir)}) }
	switch {
	case !wasCoOwned && nowCoOwned:
		if newDir != "" {
			grant(newDir)
		}
	case wasCoOwned && !nowCoOwned:
		if oldDir != "" {
			revoke(oldDir)
		}
	case wasCoOwned && nowCoOwned && oldDir != newDir:
		if oldDir != "" {
			revoke(oldDir)
		}
		if newDir != "" {
			grant(newDir)
		}
	}
	return ops
}

// coownArgs builds the sudo argv for an op, or refuses it. The directory must
// sit strictly under the owner's home: without that binding a member can point
// a project at another user's private directory, flip co-ownership on, and have
// root grant them an ACL over it.
func coownArgs(op coownOp, homeOf func(string) string) ([]string, error) {
	if op.Dir == "" {
		return nil, fmt.Errorf("no directory")
	}
	if len(op.Users) == 0 {
		return nil, fmt.Errorf("no users")
	}
	if op.Owner == "" {
		return nil, fmt.Errorf("no owner for %q", op.Dir)
	}
	home := homeOf(op.Owner)
	if home == "" {
		return nil, fmt.Errorf("no home for owner %q", op.Owner)
	}
	if !pathStrictlyUnder(op.Dir, home) {
		return nil, fmt.Errorf("%q is not strictly under %s's home %q", op.Dir, op.Owner, home)
	}
	return []string{"-n", setfaclWrapper, op.Action, op.Dir, strings.Join(op.Users, ","), op.Owner}, nil
}

// coownOwnerForOp settles whose authority a wrapper call runs under, and the
// two directions do not get the same answer.
//
// A grant keeps the owner resolved from the project's own people. Nobody
// involved owning the tree means the grant must not run at all.
//
// A revoke resolves the owner from the dir's own containing home across every
// mapped OS user instead. A revoke exists to take back an ACL that is already
// on disk, including one written before this binding did — the wrapper used to
// accept any /home/<x>/<y> — and a tree nobody on the project owns is exactly
// where such a grant sits. Refusing that revoke would leave the access in place
// with no way left in the tool to remove it, the same reason the wrapper does
// not inode-cap a revoke. The wrapper's own gates still stand in front of root:
// the dir must be canonical and real, and the owner and every grantee must be
// in /etc/ttyd-user-map.
func coownOwnerForOp(op coownOp, mapped []string, homeOf func(string) string) string {
	if op.Action != "revoke" {
		return op.Owner
	}
	if o := coownDirOwner(op.Dir, mapped, homeOf); o != "" {
		return o
	}
	return op.Owner
}

// runCoownAsync invokes the root setfacl wrapper in the background (a large tree
// must not block the HTTP request) and logs the outcome. Fire-and-forget: a
// failed grant leaves the co-ownership flag set but unapplied — the user can
// re-toggle to retry (trust-based v1). A REVOKE is louder in both directions,
// refused or failed, because either way a removed member still holds access to
// the tree.
func runCoownAsync(op coownOp) {
	op.Owner = coownOwnerForOp(op, mappedOSUsers(), homeOfUser)
	csv := strings.Join(op.Users, ",")
	args, err := coownArgs(op, homeOfUser)
	if err != nil {
		if op.Action == "revoke" {
			log.Printf("co-ownership REVOKE FAILED %s [%s]: refused: %v — those users may still hold ACL access",
				op.Dir, csv, err)
			return
		}
		log.Printf("co-ownership %s refused: %v", op.Action, err)
		return
	}
	go func() {
		out, err := exec.Command(sudoBinary, args...).CombinedOutput()
		if err != nil {
			if op.Action == "revoke" {
				log.Printf("co-ownership REVOKE FAILED %s [%s]: %v: %s — those users may still hold ACL access",
					op.Dir, csv, err, strings.TrimSpace(string(out)))
				return
			}
			log.Printf("co-ownership %s %s [%s] failed: %v: %s", op.Action, op.Dir, csv, err, strings.TrimSpace(string(out)))
			return
		}
		log.Printf("co-ownership %s %s [%s]: ok", op.Action, op.Dir, csv)
	}()
}

// callerOwnsDir reports whether osUser may name dir as a project directory: it
// must sit strictly under their own home, and still do so once the symlinks
// that already exist are resolved. Binding the directory at the moment it is
// SET is what keeps a member from aiming a project at someone else's tree; the
// root wrapper re-checks the same thing with realpath before it acts.
func callerOwnsDir(dir, osUser string) bool {
	home := homeOfUser(osUser)
	if !pathStrictlyUnder(dir, home) {
		return false
	}
	realDir, dirErr := filepath.EvalSymlinks(dir)
	realHome, homeErr := filepath.EvalSymlinks(home)
	if dirErr != nil || homeErr != nil {
		// Nothing on disk to resolve yet (a dir the user has not created).
		// The lexical check above stands; the wrapper requires the path to
		// exist and be canonical before any ACL is written.
		return true
	}
	return pathStrictlyUnder(realDir, realHome)
}

// memberUsers returns a project's member OS users.
func memberUsers(p GlobalProject) []string {
	out := make([]string, 0, len(p.Members))
	for _, m := range p.Members {
		out = append(out, m.OSUser)
	}
	return out
}
