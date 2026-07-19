package main

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// tempHome creates <tmp>/alice as a user home and returns its path plus the
// realpath-resolved form (t.TempDir may itself sit under a symlink — e.g.
// /var -> /private/var on macOS — so tests compare against the resolved home).
func tempHome(t *testing.T) (home, realHome string) {
	t.Helper()
	home = filepath.Join(t.TempDir(), "alice")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	rh, err := filepath.EvalSymlinks(home)
	if err != nil {
		t.Fatal(err)
	}
	return home, rh
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// --- Layer acceptance: a legit in-home path resolves and is returned. -------

func TestResolveWithinAcceptsLegitInHomePath(t *testing.T) {
	home, realHome := tempHome(t)
	target := filepath.Join(home, "projects", "notes.md")
	writeFile(t, target, "# hi")

	got, err := resolveWithin(home, target, true)
	if err != nil {
		t.Fatalf("legit in-home path rejected: %v", err)
	}
	want := filepath.Join(realHome, "projects", "notes.md")
	if got != want {
		t.Fatalf("resolved path: got %q, want %q", got, want)
	}
}

// Listing the home directory itself (path == home) must be accepted.
func TestResolveWithinAcceptsHomeItself(t *testing.T) {
	home, realHome := tempHome(t)
	got, err := resolveWithin(home, home, true)
	if err != nil {
		t.Fatalf("home dir itself rejected: %v", err)
	}
	if got != realHome {
		t.Fatalf("resolved home: got %q, want %q", got, realHome)
	}
}

// --- Defense 1 (shape): relative / empty input is rejected. -----------------

func TestResolveWithinRejectsRelativeAndEmpty(t *testing.T) {
	home, _ := tempHome(t)
	for _, in := range []string{"", "relative/path", "notes.md", "./x", "../x"} {
		if _, err := resolveWithin(home, in, true); !errors.Is(err, errNotAbsolute) {
			t.Fatalf("resolveWithin(%q): got err %v, want errNotAbsolute", in, err)
		}
	}
}

// --- Defense 2 (lexical): ../ climb-out is rejected before touching disk. ----

func TestResolveWithinRejectsDotDotEscape(t *testing.T) {
	home, _ := tempHome(t)
	for _, in := range []string{
		home + "/../../etc/passwd",
		home + "/../" + filepath.Base(home) + "-evil/secret",
		home + "/sub/../../../etc/shadow",
		filepath.Dir(home) + "/bob/data", // sibling user, lexically outside
	} {
		if _, err := resolveWithin(home, in, true); !errors.Is(err, errOutsideHome) {
			t.Fatalf("resolveWithin(%q): got err %v, want errOutsideHome", in, err)
		}
	}
}

// A path that shares a textual prefix with home but is a different directory
// ("/tmp/x/alice-evil" vs home "/tmp/x/alice") must NOT be treated as inside.
func TestResolveWithinRejectsSiblingPrefixMatch(t *testing.T) {
	home, _ := tempHome(t)
	sibling := home + "-evil"
	writeFile(t, filepath.Join(sibling, "secret"), "nope")
	if _, err := resolveWithin(home, filepath.Join(sibling, "secret"), true); !errors.Is(err, errOutsideHome) {
		t.Fatalf("sibling-prefix path: got err %v, want errOutsideHome", err)
	}
}

// --- Defense 3 (absolute outside): /etc/passwd is rejected. -----------------

func TestResolveWithinRejectsAbsoluteOutsideHome(t *testing.T) {
	home, _ := tempHome(t)
	for _, in := range []string{"/etc/passwd", "/", "/root/.ssh/id_rsa", "/var/lib/secret"} {
		if _, err := resolveWithin(home, in, true); !errors.Is(err, errOutsideHome) {
			t.Fatalf("resolveWithin(%q): got err %v, want errOutsideHome", in, err)
		}
	}
}

// --- Defense 4 (realpath): an in-home symlink pointing OUT is rejected. ------

func TestResolveWithinRejectsSymlinkEscapeRead(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink semantics differ on windows")
	}
	home, _ := tempHome(t)
	outside := t.TempDir() // a DIFFERENT temp root, outside home
	writeFile(t, filepath.Join(outside, "secret"), "top-secret")

	// ~/escape -> <outside>  (a directory symlink that climbs out of home)
	if err := os.Symlink(outside, filepath.Join(home, "escape")); err != nil {
		t.Fatal(err)
	}
	probe := filepath.Join(home, "escape", "secret") // lexically inside home!
	if _, err := resolveWithin(home, probe, true); !errors.Is(err, errOutsideHome) {
		t.Fatalf("symlink-escape read %q: got err %v, want errOutsideHome", probe, err)
	}

	// A leaf symlink straight to an outside file must also be rejected.
	if err := os.Symlink(filepath.Join(outside, "secret"), filepath.Join(home, "leaf")); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveWithin(home, filepath.Join(home, "leaf"), true); !errors.Is(err, errOutsideHome) {
		t.Fatalf("leaf symlink escape: got err %v, want errOutsideHome", err)
	}
}

// An in-home symlink that stays INSIDE home is fine (resolves to the target).
func TestResolveWithinAcceptsInHomeSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink semantics differ on windows")
	}
	home, realHome := tempHome(t)
	real := filepath.Join(home, "real.txt")
	writeFile(t, real, "data")
	if err := os.Symlink(real, filepath.Join(home, "link.txt")); err != nil {
		t.Fatal(err)
	}
	got, err := resolveWithin(home, filepath.Join(home, "link.txt"), true)
	if err != nil {
		t.Fatalf("in-home symlink rejected: %v", err)
	}
	if want := filepath.Join(realHome, "real.txt"); got != want {
		t.Fatalf("resolved in-home symlink: got %q, want %q", got, want)
	}
}

// --- Read semantics: a missing target surfaces fs.ErrNotExist (→ 404). ------

func TestResolveWithinReadMissingIsNotExist(t *testing.T) {
	home, _ := tempHome(t)
	if _, err := resolveWithin(home, filepath.Join(home, "nope.txt"), true); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("missing read target: got err %v, want fs.ErrNotExist", err)
	}
}

// --- Write semantics: a NEW leaf under an existing dir is accepted. ---------

func TestResolveWithinWriteNewLeafAccepted(t *testing.T) {
	home, realHome := tempHome(t)
	got, err := resolveWithin(home, filepath.Join(home, "fresh.txt"), false)
	if err != nil {
		t.Fatalf("new-leaf write rejected: %v", err)
	}
	if want := filepath.Join(realHome, "fresh.txt"); got != want {
		t.Fatalf("resolved new leaf: got %q, want %q", got, want)
	}
}

// Write with a missing PARENT directory surfaces fs.ErrNotExist (→ 404).
func TestResolveWithinWriteMissingParentIsNotExist(t *testing.T) {
	home, _ := tempHome(t)
	if _, err := resolveWithin(home, filepath.Join(home, "nodir", "f.txt"), false); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("write into missing dir: got err %v, want fs.ErrNotExist", err)
	}
}

// Write THROUGH an in-home symlink that escapes home is rejected (both a
// directory symlink in the path and a leaf symlink to an outside file).
func TestResolveWithinWriteSymlinkEscapeRejected(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink semantics differ on windows")
	}
	home, _ := tempHome(t)
	outside := t.TempDir()

	if err := os.Symlink(outside, filepath.Join(home, "escape")); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveWithin(home, filepath.Join(home, "escape", "x.txt"), false); !errors.Is(err, errOutsideHome) {
		t.Fatalf("write via dir-symlink escape: got err %v, want errOutsideHome", err)
	}

	// Existing leaf symlink pointing at an outside file.
	writeFile(t, filepath.Join(outside, "victim"), "old")
	if err := os.Symlink(filepath.Join(outside, "victim"), filepath.Join(home, "leaf")); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveWithin(home, filepath.Join(home, "leaf"), false); !errors.Is(err, errOutsideHome) {
		t.Fatalf("write via leaf-symlink escape: got err %v, want errOutsideHome", err)
	}
}

// The within() prefix helper must not treat a sibling with a shared textual
// prefix as contained.
func TestWithin(t *testing.T) {
	cases := []struct {
		root, path string
		want       bool
	}{
		{"/home/alice", "/home/alice", true},
		{"/home/alice", "/home/alice/x", true},
		{"/home/alice", "/home/alice/a/b/c", true},
		{"/home/alice", "/home/alice-evil", false},
		{"/home/alice", "/home/alicex/y", false},
		{"/home/alice", "/home/bob", false},
		{"/home/alice", "/etc/passwd", false},
		{"/home/alice", "/", false},
	}
	for _, c := range cases {
		if got := within(c.root, c.path); got != c.want {
			t.Fatalf("within(%q, %q) = %v, want %v", c.root, c.path, got, c.want)
		}
	}
}
