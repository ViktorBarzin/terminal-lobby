package main

import (
	"log"
	"os/exec"
	"strings"
)

const setfaclWrapper = "/usr/local/bin/tmux-user-setfacl"

// coownOp is a single ACL action to run against a project directory.
type coownOp struct {
	Action string // "grant" | "revoke"
	Dir    string
	Users  []string
}

// coownOpsForPatch computes the ACL ops when a project's co-ownership flag or
// directory changes under PATCH. Pure (no exec) so the decision is unit-tested;
// the actual setfacl runs async via runCoownAsync.
func coownOpsForPatch(wasCoOwned bool, oldDir string, nowCoOwned bool, newDir string, members []string) []coownOp {
	var ops []coownOp
	switch {
	case !wasCoOwned && nowCoOwned:
		if newDir != "" {
			ops = append(ops, coownOp{"grant", newDir, members})
		}
	case wasCoOwned && !nowCoOwned:
		if oldDir != "" {
			ops = append(ops, coownOp{"revoke", oldDir, members})
		}
	case wasCoOwned && nowCoOwned && oldDir != newDir:
		if oldDir != "" {
			ops = append(ops, coownOp{"revoke", oldDir, members})
		}
		if newDir != "" {
			ops = append(ops, coownOp{"grant", newDir, members})
		}
	}
	return ops
}

// runCoownAsync invokes the root setfacl wrapper in the background (a large tree
// must not block the HTTP request) and logs the outcome. Fire-and-forget: a
// failure leaves the co-ownership flag set but unapplied — the user can re-toggle
// to retry (trust-based v1).
func runCoownAsync(op coownOp) {
	if op.Dir == "" || len(op.Users) == 0 {
		return
	}
	csv := strings.Join(op.Users, ",")
	go func() {
		out, err := exec.Command(sudoBinary, "-n", setfaclWrapper, op.Action, op.Dir, csv).CombinedOutput()
		if err != nil {
			log.Printf("co-ownership %s %s [%s] failed: %v: %s", op.Action, op.Dir, csv, err, strings.TrimSpace(string(out)))
			return
		}
		log.Printf("co-ownership %s %s [%s]: ok", op.Action, op.Dir, csv)
	}()
}

// memberUsers returns a project's member OS users.
func memberUsers(p GlobalProject) []string {
	out := make([]string, 0, len(p.Members))
	for _, m := range p.Members {
		out = append(out, m.OSUser)
	}
	return out
}
