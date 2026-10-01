package release

import (
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// StageTree copies the directory src to dst for packaging, and returns how
// many files and links it wrote. It exists for a Tree, whose file list nobody
// writes down.
//
// Modes are normalised rather than preserved: 0755 for directories and for any
// file with an execute bit, 0644 for every other file. The build's umask is
// not the package's business, and a group-writable file under /usr/lib is
// writable by everyone in that group on the box.
//
// Links are kept as links when their target is relative and stays inside the
// tree, which is the shape of npm's node_modules/.bin. A link that is absolute
// or climbs out of the tree is refused, as is anything that is not a regular
// file, a directory or a link: either would make the package ship something it
// does not own.
func StageTree(src, dst string) (int, error) {
	var n int
	err := filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		out := filepath.Join(dst, rel)
		switch {
		case d.IsDir():
			if err := os.MkdirAll(out, 0o755); err != nil {
				return err
			}
			return os.Chmod(out, 0o755)
		case d.Type()&fs.ModeSymlink != 0:
			target, err := os.Readlink(path)
			if err != nil {
				return err
			}
			if filepath.IsAbs(target) || escapes(rel, target) {
				return fmt.Errorf("%s links to %s, outside the tree", rel, target)
			}
			n++
			return os.Symlink(target, out)
		case d.Type().IsRegular():
			info, err := d.Info()
			if err != nil {
				return err
			}
			mode := os.FileMode(0o644)
			if info.Mode().Perm()&0o111 != 0 {
				mode = 0o755
			}
			n++
			return copyRegular(path, out, mode)
		default:
			return fmt.Errorf("%s is neither a file, a directory nor a link", rel)
		}
	})
	return n, err
}

// escapes reports whether a relative link at rel, pointing at target, resolves
// outside the tree it sits in.
func escapes(rel, target string) bool {
	resolved := filepath.Clean(filepath.Join(filepath.Dir(rel), target))
	return resolved == ".." || strings.HasPrefix(resolved, ".."+string(filepath.Separator))
}

func copyRegular(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Chmod(mode); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
