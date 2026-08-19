package skillscan

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// Copy installs src as dst: the copyable set only, with modes normalised to
// 0644/0755 so the result hashes identically to its source whatever the two
// users' umasks are.
//
// It refuses an existing destination. Replacing a skill is two decisions — back
// the old one up, then write the new one — and the caller makes both, so a copy
// can never be the thing that lost somebody's edits.
func Copy(src, dst string) error { return copyWith(src, dst, DefaultLimits) }

func copyWith(src, dst string, lim Limits) error {
	if _, err := os.Lstat(dst); err == nil {
		return fmt.Errorf("%s already exists", dst)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	set, err := walk(src, lim)
	if err != nil {
		return err
	}
	if !hasSkillMd(set) {
		return fmt.Errorf("%s has no SKILL.md", src)
	}
	real, err := filepath.EvalSymlinks(src)
	if err != nil {
		return err
	}

	// Assemble beside the destination and rename, so a session scanning the
	// directory sees either no skill or a whole one, never half of one.
	stage := staging(dst)
	if err := os.RemoveAll(stage); err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	if err := os.MkdirAll(stage, 0o755); err != nil {
		return err
	}
	for _, e := range set {
		to := filepath.Join(stage, filepath.FromSlash(e.rel))
		if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
			return err
		}
		if e.link != "" {
			if err := os.Symlink(filepath.FromSlash(e.link), to); err != nil {
				return err
			}
			continue
		}
		body, err := os.ReadFile(filepath.Join(real, filepath.FromSlash(e.rel)))
		if err != nil {
			return err
		}
		mode := os.FileMode(0o644)
		if e.exec {
			mode = 0o755
		}
		if err := os.WriteFile(to, body, mode); err != nil {
			return err
		}
		if err := os.Chmod(to, mode); err != nil { // WriteFile respects the umask; this does not
			return err
		}
	}
	return os.Rename(stage, dst)
}

// stamp is the backup suffix: UTC, second resolution, sortable, filename-safe.
func stamp(at time.Time) string { return at.UTC().Format("20060102T150405Z") }

// Backup moves a skill out of the way and returns where it went. Nothing in this
// package deletes a skill outright — Remove is Backup plus forgetting it — so a
// replace or a remove is always recoverable from
// ~/.claude/skills/.backup/<name>-<timestamp>/.
//
// A symlinked entry (bob's provisioned skills point into ~/.agents/skills) is
// backed up by copying what it resolves to and dropping the link: the target
// belongs to whatever put it there and is left untouched.
func Backup(home, name string, at time.Time) (string, error) {
	if err := ValidName(name); err != nil {
		return "", err
	}
	root := Root(home)
	from := filepath.Join(root, name)
	fi, err := os.Lstat(from)
	if err != nil {
		return "", err
	}
	dir := filepath.Join(root, ".backup")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	dest, err := freeBackupPath(dir, name, at)
	if err != nil {
		return "", err
	}

	if fi.Mode()&os.ModeSymlink != 0 {
		if err := copyWith(from, dest, DefaultLimits); err != nil {
			return "", err
		}
		if err := os.Remove(from); err != nil {
			return "", err
		}
		return dest, nil
	}
	if err := os.Rename(from, dest); err != nil {
		return "", err
	}
	return dest, nil
}

// freeBackupPath picks <name>-<stamp>, then -2, -3 … so two backups in the same
// second cannot overwrite each other.
func freeBackupPath(dir, name string, at time.Time) (string, error) {
	base := filepath.Join(dir, name+"-"+stamp(at))
	for n := 1; n < 100; n++ {
		p := base
		if n > 1 {
			p = fmt.Sprintf("%s-%d", base, n)
		}
		if _, err := os.Lstat(p); errors.Is(err, fs.ErrNotExist) {
			return p, nil
		} else if err != nil {
			return "", err
		}
	}
	return "", fmt.Errorf("too many backups of %s at %s", name, stamp(at))
}

// Remove backs a skill up, drops it, and forgets its provenance. The row
// disappears from the panel; the bytes do not disappear from the disk.
func Remove(home, name string, at time.Time) (string, error) {
	backup, err := Backup(home, name, at)
	if err != nil {
		return "", err
	}
	man, err := LoadManifest(home)
	if err != nil {
		return backup, err
	}
	if _, ok := man.Installed[name]; !ok {
		return backup, nil
	}
	man.Forget(name)
	return backup, man.Save(home)
}

// Install copies a peer's skill into home and records where it came from.
//
// replace decides what happens when the name is taken: without it an existing
// skill is left alone and ErrExists comes back, with it the existing one is
// backed up first. The returned path is that backup, or "" when nothing was
// displaced.
func Install(home, name, from, src string, replace bool, at time.Time) (backup string, err error) {
	if err := ValidName(name); err != nil {
		return "", err
	}
	st, err := Inspect(src)
	if err != nil {
		return "", err
	}
	dst := filepath.Join(Root(home), name)
	if _, err := os.Lstat(dst); err == nil {
		if !replace {
			return "", ErrExists
		}
		if backup, err = Backup(home, name, at); err != nil {
			return "", err
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	if err := os.MkdirAll(Root(home), 0o755); err != nil {
		return backup, err
	}
	if err := Copy(src, dst); err != nil {
		return backup, err
	}
	man, err := LoadManifest(home)
	if err != nil {
		return backup, err
	}
	man.Record(name, from, st.Hash, at)
	return backup, man.Save(home)
}

// ErrExists says the name is taken by a skill this call will not touch. The
// caller shows the diff and asks.
var ErrExists = errors.New("a skill of that name is already installed")
