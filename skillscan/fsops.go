package skillscan

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
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
// A symlinked entry (emo's provisioned skills point into ~/.agents/skills) is
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

// Remove backs a skill up, drops it, forgets its provenance, and clears its
// enabled state. The row disappears from the panel; the bytes do not disappear
// from the disk.
//
// Clearing the enabled state matters: a skill removed while switched off would
// otherwise leave "<name>@skills-dir": false behind, and installing it again
// later would come back silently disabled from a marker nobody would think to
// look for.
func Remove(home, name string, at time.Time) (string, error) {
	backup, err := Backup(home, name, at)
	if err != nil {
		return "", err
	}
	if err := ClearEnabled(home, name+"@skills-dir"); err != nil {
		return backup, err
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

// ErrExists says the name is taken by a skill this call will not touch. The
// caller shows the diff and asks.
var ErrExists = errors.New("a skill of that name is already installed")

// --- the packed hand-off ------------------------------------------------------
//
// Peer homes are 0700, so no single process can both read the owner's skill and
// write the recipient's: the recipient cannot enter the owner's home, and the
// owner cannot write into the recipient's. An install is therefore two steps
// under two identities — Pack as the owner, Unpack as the recipient — with the
// skill in between as a value the caller can carry. skills-api runs each half
// in a privileged child; nothing depends on one home being readable by another.

// Blob is one file of a packed skill. Exactly one of Body and Link is set.
type Blob struct {
	Rel  string `json:"rel"`
	Exec bool   `json:"exec,omitempty"`
	Link string `json:"link,omitempty"`
	Body []byte `json:"body,omitempty"`
}

// Pack reads a skill into its copyable set, along with the Stat the recipient
// checks it against.
func Pack(dir string) ([]Blob, Stat, error) {
	st, err := Inspect(dir)
	if err != nil {
		return nil, Stat{}, err
	}
	set, err := walk(dir, DefaultLimits)
	if err != nil {
		return nil, Stat{}, err
	}
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return nil, Stat{}, err
	}
	out := make([]Blob, 0, len(set))
	for _, e := range set {
		b := Blob{Rel: e.rel, Exec: e.exec, Link: e.link}
		if e.link == "" {
			if b.Body, err = os.ReadFile(filepath.Join(real, filepath.FromSlash(e.rel))); err != nil {
				return nil, Stat{}, err
			}
		}
		out = append(out, b)
	}
	return out, st, nil
}

// Unpack writes a packed skill into home as name and records that it came from
// `from`.
//
// Every blob is validated before anything is written: the set must describe a
// skill, no path may leave the skill directory or name an excluded one, and what
// lands must hash to the value the owner reported — that hash becomes the
// recorded provenance, so if it were not the hash of the actual bytes then every
// later "update available" comparison would be against a fiction.
//
// replace decides what happens when the name is taken: without it the existing
// skill is untouched and ErrExists comes back; with it, the old copy is backed
// up first and its path returned.
func Unpack(home, name, from string, blobs []Blob, hash string, replace bool, at time.Time) (string, error) {
	return unpackWith(home, name, from, blobs, hash, replace, at, DefaultLimits)
}

func unpackWith(home, name, from string, blobs []Blob, hash string, replace bool, at time.Time, lim Limits) (backup string, err error) {
	if err := ValidName(name); err != nil {
		return "", err
	}
	if err := validBlobs(blobs, lim); err != nil {
		return "", err
	}
	root := Root(home)
	if err := os.MkdirAll(root, 0o755); err != nil {
		return "", err
	}
	dst := filepath.Join(root, name)

	// Assemble first, verify, and only then displace anything that is there: a
	// refused install must not have cost the caller their existing skill.
	stage := staging(dst)
	if err := os.RemoveAll(stage); err != nil {
		return "", err
	}
	defer os.RemoveAll(stage)
	if err := os.MkdirAll(stage, 0o755); err != nil {
		return "", err
	}
	for _, b := range blobs {
		to := filepath.Join(stage, filepath.FromSlash(b.Rel))
		if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
			return "", err
		}
		if b.Link != "" {
			if err := os.Symlink(filepath.FromSlash(b.Link), to); err != nil {
				return "", err
			}
			continue
		}
		mode := os.FileMode(0o644)
		if b.Exec {
			mode = 0o755
		}
		if err := os.WriteFile(to, b.Body, mode); err != nil {
			return "", err
		}
		if err := os.Chmod(to, mode); err != nil {
			return "", err
		}
	}
	got, err := Hash(stage)
	if err != nil {
		return "", err
	}
	if got != hash {
		return "", fmt.Errorf("packed skill hashes to %s, not the declared %s", got, hash)
	}

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
	if err := os.Rename(stage, dst); err != nil {
		return backup, err
	}
	man, err := LoadManifest(home)
	if err != nil {
		return backup, err
	}
	man.Record(name, from, hash, at)
	return backup, man.Save(home)
}

// validBlobs rejects anything that does not describe a skill, before a single
// byte is written. The paths arrive over HTTP from another user's account, so
// they are treated as input, not as facts.
func validBlobs(blobs []Blob, lim Limits) error {
	if len(blobs) == 0 {
		return errors.New("no files to install")
	}
	if len(blobs) > lim.MaxFiles {
		return fmt.Errorf("skill has more than %d files", lim.MaxFiles)
	}
	var total int64
	skillMd, seen := false, map[string]bool{}
	for _, b := range blobs {
		if err := validRel(b.Rel); err != nil {
			return err
		}
		if seen[b.Rel] {
			return fmt.Errorf("duplicate path %q", b.Rel)
		}
		seen[b.Rel] = true
		if b.Rel == "SKILL.md" {
			skillMd = true
		}
		if b.Link != "" {
			if len(b.Body) > 0 {
				return fmt.Errorf("%q is both a symlink and a file", b.Rel)
			}
			if err := validLink(b.Rel, b.Link); err != nil {
				return err
			}
			continue
		}
		total += int64(len(b.Body))
		if total > lim.MaxBytes {
			return fmt.Errorf("skill is larger than %d bytes", lim.MaxBytes)
		}
	}
	if !skillMd {
		return errors.New("no SKILL.md: that is not a skill")
	}
	return nil
}

// validRel accepts a clean, relative, in-tree path naming no excluded directory.
func validRel(rel string) error {
	if rel == "" || strings.HasPrefix(rel, "/") || filepath.IsAbs(rel) {
		return fmt.Errorf("invalid path %q", rel)
	}
	if rel != path.Clean(rel) {
		return fmt.Errorf("invalid path %q", rel)
	}
	for _, part := range strings.Split(rel, "/") {
		if part == "" || part == "." || part == ".." || excluded[part] {
			return fmt.Errorf("invalid path %q", rel)
		}
	}
	return nil
}

// validLink accepts only a relative target that stays inside the skill.
func validLink(rel, target string) error {
	if filepath.IsAbs(target) || strings.HasPrefix(target, "/") {
		return fmt.Errorf("symlink %q points outside the skill", rel)
	}
	resolved := path.Join(path.Dir(rel), target)
	if resolved == ".." || strings.HasPrefix(resolved, "../") {
		return fmt.Errorf("symlink %q points outside the skill", rel)
	}
	return nil
}
