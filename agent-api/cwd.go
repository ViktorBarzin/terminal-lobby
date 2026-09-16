package main

// Where a conversation may be started.
//
// A caller chooses the working directory, and the choice is bounded to
// /home/<osUser>/code. The design doc is explicit that this is an affordance
// rather than a boundary — the session runs as that OS user and can read
// whatever that user can read, from any cwd — so the value here is that a
// caller cannot casually park a conversation in a home directory, a mounted
// share or /etc by getting one field wrong.
//
// Being an affordance is not a reason to implement it loosely. A comparison
// that a traversal or a symlink defeats is worse than none, because it reads
// like a control in the OpenAPI document and in this file.

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// codeRoot is the one directory tree a conversation may be started in.
func codeRoot(homeBase, osUser string) string {
	return filepath.Join(homeBase, osUser, "code")
}

// resolveCWD validates a requested working directory and returns the resolved
// absolute path to hand tmux, or an error naming what is wrong with it.
//
// Three rules, in this order, and the order is the point:
//
//  1. The request must be an absolute path with no NUL. A relative path is
//     refused outright rather than joined against anything — there is no
//     sensible base for one here, and "code" resolving against this process's
//     own cwd would be a different directory on every deploy.
//  2. BOTH the path and the root are resolved through their symlinks before
//     they are compared. Resolving only the path breaks a home whose ~/code is
//     a link; resolving neither accepts a link planted inside the root that
//     points at /etc, which is the whole attack this function exists to stop.
//  3. The resolved path must be the root or inside it, tested with
//     filepath.Rel rather than a string prefix. /home/wizard/codex shares nine
//     characters with /home/wizard/code and is a different directory.
//
// A path that does not resolve is REFUSED, which is where this deliberately
// differs from sessionio.PathWithin. That function guards a transcript stamp,
// where the file legitimately does not exist yet; this one is about to become
// a tmux session's -c, and a directory that is not there cannot be one. The
// same check rejects a regular file, for the same reason.
func resolveCWD(homeBase, osUser, requested string) (string, error) {
	cwd := strings.TrimSpace(requested)
	if cwd == "" {
		return "", fmt.Errorf("cwd is required")
	}
	if strings.ContainsRune(cwd, 0) {
		return "", fmt.Errorf("cwd contains a NUL byte")
	}
	if !filepath.IsAbs(cwd) {
		return "", fmt.Errorf("cwd %q must be an absolute path", requested)
	}

	root := codeRoot(homeBase, osUser)
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", fmt.Errorf("cwd must be inside %s, which does not exist on this host", root)
	}

	real, err := filepath.EvalSymlinks(filepath.Clean(cwd))
	if err != nil {
		// "or is not reachable" because the two are indistinguishable from
		// here and both happen: another account's home is mode 0750, so a
		// path inside it that plainly exists still cannot be resolved by this
		// process. Saying only "does not exist" sends an operator looking for
		// a directory that is right where they left it.
		return "", fmt.Errorf("cwd %q does not exist or is not reachable by this account", requested)
	}
	info, err := os.Stat(real)
	if err != nil || !info.IsDir() {
		return "", fmt.Errorf("cwd %q is not a directory", requested)
	}

	rel, err := filepath.Rel(realRoot, real)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("cwd %q is outside %s", requested, root)
	}
	return real, nil
}
