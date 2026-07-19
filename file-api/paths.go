package main

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Path-validation sentinels. Handlers (pathHTTPError) map these to status
// codes: the two below → 400, a wrapped fs.ErrNotExist → 404, anything else
// (a home that won't resolve, a permission error) → 500.
var (
	errNotAbsolute = errors.New("path must be an absolute path")
	errOutsideHome = errors.New("path resolves outside the home directory")
)

// resolveWithin validates that `requested` (an absolute path supplied by the
// client) resolves to a location inside the user's home directory, and returns
// the realpath-resolved absolute path to operate on. It is the single choke
// point every file operation passes through, layering FOUR independent
// traversal defenses (mirroring clipboard-upload's /img handler, extended for
// arbitrary in-home paths):
//
//  1. SHAPE — `requested` must be a non-empty ABSOLUTE path. Relative or empty
//     input is rejected before anything touches the filesystem; every real
//     caller passes an absolute path (list dir / read path / write path).
//
//  2. LEXICAL CONTAINMENT — filepath.Clean folds out every "." / ".." segment,
//     then the cleaned path must equal home or sit under home+"/". This rejects
//     "/etc/passwd" (absolute, outside home) and "/home/u/../../etc/shadow"
//     (climbs out) purely lexically, before any disk access. A sibling that
//     merely shares a textual prefix ("/home/alice-evil" vs "/home/alice") is
//     rejected too — the separator-terminated prefix in within() sees to that.
//
//  3. SYMLINK RESOLUTION (realpath) — filepath.EvalSymlinks resolves EVERY
//     symlink component so an in-home symlink that points OUT of home is
//     unmasked. Read/list resolves the whole target (a missing target surfaces
//     fs.ErrNotExist → the caller's 404). Write resolves the leaf when it
//     already exists (so writing THROUGH an in-home symlink that escapes is
//     caught) and otherwise resolves the parent dir, keeping the new leaf name.
//
//  4. RESOLVED CONTAINMENT — the realpath'd result must STILL sit inside the
//     realpath'd home. Home itself is resolved too (it may be a symlink — e.g.
//     /home -> /var/home, or a temp dir under /var -> /private/var on macOS),
//     so the final comparison is real-path against real-path. This is the
//     backstop a symlink escape that slipped past layer 2 dies on.
//
// mustExist selects read semantics (the target itself must exist and is fully
// resolved) vs write semantics (only the parent dir must exist; the leaf may be
// new — but a leaf that IS a symlink is resolved and re-checked so it can never
// be written through to escape home).
func resolveWithin(home, requested string, mustExist bool) (string, error) {
	// Layer 1 — shape.
	if requested == "" || !filepath.IsAbs(requested) {
		return "", errNotAbsolute
	}

	home = filepath.Clean(home)

	// Layer 2 — lexical containment against the nominal home.
	clean := filepath.Clean(requested)
	if !within(home, clean) {
		return "", errOutsideHome
	}

	// The home root must resolve; a missing home is an operator/deploy problem,
	// not a client error — surface it (handlers turn a non-ENOENT into 500).
	realHome, err := filepath.EvalSymlinks(home)
	if err != nil {
		return "", err
	}

	// Layer 3 — realpath.
	var resolved string
	if mustExist {
		resolved, err = filepath.EvalSymlinks(clean)
		if err != nil {
			return "", err // fs.ErrNotExist → 404; other errors → 500
		}
	} else {
		// Write: resolve the leaf if it already exists (unmask a leaf symlink
		// that escapes home), else resolve the parent and keep the new leaf.
		if r, e := filepath.EvalSymlinks(clean); e == nil {
			resolved = r
		} else if errors.Is(e, fs.ErrNotExist) {
			parent, e2 := filepath.EvalSymlinks(filepath.Dir(clean))
			if e2 != nil {
				return "", e2 // missing parent dir → fs.ErrNotExist → 404
			}
			resolved = filepath.Join(parent, filepath.Base(clean))
		} else {
			return "", e
		}
	}

	// Layer 4 — resolved containment against the real home.
	if !within(realHome, resolved) {
		return "", errOutsideHome
	}
	return resolved, nil
}

// within reports whether path is root itself or lies under root+"/". The
// separator-terminated prefix stops "/home/alice-evil" from matching root
// "/home/alice".
func within(root, path string) bool {
	if path == root {
		return true
	}
	return strings.HasPrefix(path, root+string(os.PathSeparator))
}
