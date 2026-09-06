package main

import (
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
)

// delegatesToClaude reports whether this invocation is one the bridge must hand
// to the real claude binary untouched: the `--version` health probe and the
// `auth` subcommands (verified fact 3).
//
// `auth` counts only in the LEADING position. Matching it anywhere would let a
// flag value — `--model auth` — divert a whole stream-json spawn to claude,
// which would then start a second Claude on a box that is already OOM-tight.
func delegatesToClaude(argv []string) bool {
	if len(argv) > 0 && argv[0] == "auth" {
		return true
	}
	for _, a := range argv {
		if a == "--version" || a == "-v" {
			return true
		}
	}
	return false
}

// execClaude runs the real claude with this argv and returns its exit code,
// passing stdio straight through.
//
// A claude that ran and failed reports its own code. Anything else — no such
// binary, not executable — is 127, the shell's "could not run it at all", so
// T3's provider health probe reads a missing claude as a missing claude rather
// than as a claude that failed.
func execClaude(argv []string) int {
	bin, err := RealClaudePath()
	if err != nil {
		log.Printf("cannot locate the real claude binary: %v", err)
		return 127
	}
	cmd := exec.Command(bin, argv...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return ee.ExitCode()
		}
		log.Printf("claude %v: %v", argv, err)
		return 127
	}
	return 0
}

// RealClaudePath locates the genuine claude binary.
//
// TL_REAL_CLAUDE names it outright — that is what the deployment sets, and how
// a test points this at a stub. TL_T3_BRIDGE_CLAUDE is accepted as the same
// thing under CONTRACT.md's spelling. Neither is trusted blindly: a unit file
// that pointed either at the bridge would fork-bomb the box, so an environment
// naming this binary is ignored rather than obeyed.
func RealClaudePath() (string, error) {
	self, err := os.Executable()
	if err != nil {
		// The search still runs, but without knowing our own path the
		// recursion guard cannot fire — worth a line in the journal.
		log.Printf("cannot determine this binary's own path: %v", err)
	}
	for _, name := range []string{"TL_REAL_CLAUDE", "TL_T3_BRIDGE_CLAUDE"} {
		p := os.Getenv(name)
		if p == "" {
			continue
		}
		if protoSameBinary(p, self) {
			log.Printf("%s=%s is this binary; ignoring it rather than recursing", name, p)
			continue
		}
		return p, nil
	}
	home := ""
	if u, err := user.Current(); err == nil {
		home = u.HomeDir
	}
	return protoClaudeOnPath(os.Getenv("PATH"), self, home)
}

// protoClaudeOnPath finds a claude that is not `self`, then falls back to the
// home install.
//
// The guard is the point of this function. T3's provider instance points at the
// bridge, so a deployment that installs the bridge under the name `claude`
// anywhere on PATH would have the bridge find ITSELF: every --version probe
// would fork a bridge, which would fork a bridge, until the box fell over.
// Identity is device+inode (os.SameFile), because the shape this takes in
// practice is a symlink or a hard link, and neither is caught by comparing
// path strings.
//
// ~/.local/bin/claude is last rather than first: it is where claude installs
// itself on this box, but a systemd unit's PATH is not a login shell's, so the
// explicit PATH scan gets the first say.
func protoClaudeOnPath(pathList, self, home string) (string, error) {
	var shims []string
	consider := func(candidate string) (string, bool) {
		if !protoExecutable(candidate) {
			return "", false
		}
		if protoSameBinary(candidate, self) {
			shims = append(shims, candidate)
			return "", false
		}
		return candidate, true
	}

	for _, dir := range filepath.SplitList(pathList) {
		if dir == "" {
			dir = "." // POSIX: an empty PATH element means the working directory
		}
		if found, ok := consider(filepath.Join(dir, "claude")); ok {
			return found, nil
		}
	}
	if home != "" {
		if found, ok := consider(filepath.Join(home, ".local", "bin", "claude")); ok {
			return found, nil
		}
	}

	if len(shims) > 0 {
		return "", fmt.Errorf("every claude found is this binary (%s); running it would recurse", strings.Join(shims, ", "))
	}
	return "", fmt.Errorf("no claude on PATH and none at ~/.local/bin/claude")
}

// protoExecutable reports whether path is a file anyone can execute. os.Stat
// follows symlinks deliberately: a PATH shim is judged by what it points at.
func protoExecutable(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	return info.Mode().Perm()&0o111 != 0
}

// protoSameBinary reports whether two paths are the same file on disk.
func protoSameBinary(a, b string) bool {
	if b == "" {
		return false
	}
	ai, err := os.Stat(a)
	if err != nil {
		return false
	}
	bi, err := os.Stat(b)
	if err != nil {
		return false
	}
	return os.SameFile(ai, bi)
}
