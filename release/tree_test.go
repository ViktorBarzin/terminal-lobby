package release

import (
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// hostLike lays out a small tree with the shapes npm ci produces: nested
// directories, an executable entry point, and node_modules/.bin links that
// point back into the tree.
func hostLike(t *testing.T) string {
	t.Helper()
	src := t.TempDir()
	page(t, src, "host.mjs", "import './lib/a.mjs';\n")
	page(t, src, "lib/a.mjs", "export const a = 1;\n")
	page(t, src, "node_modules/pkg/cli.js", "#!/usr/bin/env node\n")
	if err := os.Chmod(filepath.Join(src, "node_modules/pkg/cli.js"), 0o775); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(src, "node_modules/.bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../pkg/cli.js", filepath.Join(src, "node_modules/.bin/pkg")); err != nil {
		t.Fatal(err)
	}
	return src
}

func TestStageTreeCopiesEveryFileAtItsPath(t *testing.T) {
	src := hostLike(t)
	dst := filepath.Join(t.TempDir(), "usr/lib/terminal-lobby/tl-browser-host")
	n, err := StageTree(src, dst)
	if err != nil {
		t.Fatal(err)
	}
	if n != 4 {
		t.Errorf("staged %d entries, want 4 (three files and one link)", n)
	}
	b, err := os.ReadFile(filepath.Join(dst, "lib/a.mjs"))
	if err != nil || string(b) != "export const a = 1;\n" {
		t.Errorf("lib/a.mjs = %q, %v", b, err)
	}
}

// The package ships with fixed modes rather than whatever umask the build ran
// under: 0755 where any execute bit was set, 0644 otherwise. A group-writable
// file in /usr/lib is writable by every member of that group on the box.
func TestStageTreeNormalisesModes(t *testing.T) {
	src := hostLike(t)
	if err := os.Chmod(filepath.Join(src, "host.mjs"), 0o664); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(t.TempDir(), "out")
	if _, err := StageTree(src, dst); err != nil {
		t.Fatal(err)
	}
	for rel, want := range map[string]os.FileMode{
		"host.mjs":                0o644,
		"node_modules/pkg/cli.js": 0o755,
		"lib":                     0o755,
	} {
		fi, err := os.Stat(filepath.Join(dst, rel))
		if err != nil {
			t.Fatal(err)
		}
		if got := fi.Mode().Perm(); got != want {
			t.Errorf("%s has mode %o, want %o", rel, got, want)
		}
	}
}

// npm's .bin entries are links. They stay links, with the same relative
// target, so they resolve inside the installed tree.
func TestStageTreeKeepsRelativeLinks(t *testing.T) {
	src := hostLike(t)
	dst := filepath.Join(t.TempDir(), "out")
	if _, err := StageTree(src, dst); err != nil {
		t.Fatal(err)
	}
	target, err := os.Readlink(filepath.Join(dst, "node_modules/.bin/pkg"))
	if err != nil {
		t.Fatal(err)
	}
	if target != "../pkg/cli.js" {
		t.Errorf("link target %q, want ../pkg/cli.js", target)
	}
}

// A link that leaves the tree would make the package ship a path into
// somewhere it does not own, resolved on whichever box installs it.
func TestStageTreeRefusesLinksThatLeaveTheTree(t *testing.T) {
	for name, target := range map[string]string{
		"absolute": "/etc/passwd",
		"escaping": "../../../etc/passwd",
	} {
		t.Run(name, func(t *testing.T) {
			src := hostLike(t)
			if err := os.Symlink(target, filepath.Join(src, "lib/bad")); err != nil {
				t.Fatal(err)
			}
			_, err := StageTree(src, filepath.Join(t.TempDir(), "out"))
			if err == nil || !strings.Contains(err.Error(), "lib/bad") {
				t.Errorf("want an error naming lib/bad, got %v", err)
			}
		})
	}
}

// Anything that is not a file, a directory or a link has no place in a
// package, and a socket left behind by a test run is the likely one.
func TestStageTreeRefusesSpecialFiles(t *testing.T) {
	src := hostLike(t)
	sock := filepath.Join(src, "lib/s.sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Skipf("cannot create a unix socket here: %v", err)
	}
	defer l.Close()
	_, err = StageTree(src, filepath.Join(t.TempDir(), "out"))
	if err == nil || !strings.Contains(err.Error(), "lib/s.sock") {
		t.Errorf("want an error naming lib/s.sock, got %v", err)
	}
}

func TestStageTreeRefusesAMissingSource(t *testing.T) {
	if _, err := StageTree(filepath.Join(t.TempDir(), "nope"), filepath.Join(t.TempDir(), "out")); err == nil {
		t.Error("staging a tree that does not exist succeeded")
	}
}
