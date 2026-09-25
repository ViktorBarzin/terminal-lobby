package skillscan

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// Layout says where a user's skill files live.
//
// Most users keep each skill as a real directory in ~/.claude/skills, the one
// place Claude Code reads. A user whose skills are shared between harnesses keeps
// the real directory in ~/.agents/skills instead, which Codex reads directly,
// with ~/.claude/skills/<name> a relative link to it: the layout the skills CLI
// makes when it installs for more than one harness. Which layout a user has is
// the machine's policy, which skills-api reads; this package only acts on it.
type Layout int

const (
	// InClaude: ~/.claude/skills/<name> is the skill. A link there points at a
	// directory some other tool owns, so it is dropped and never followed.
	InClaude Layout = iota
	// InAgents: ~/.agents/skills/<name> is the skill and ~/.claude/skills/<name>
	// links to it. Installing writes the pair, and removing or deleting takes it.
	InAgents
)

// AgentsRoot is where an InAgents user's skills live.
func AgentsRoot(home string) string { return filepath.Join(home, ".agents", "skills") }

// agentsLink is what ~/.claude/skills/<name> points at in the InAgents layout:
// relative, so the pair survives a moved home, and the same text the skills CLI
// writes.
func agentsLink(name string) string {
	return filepath.Join("..", "..", ".agents", "skills", name)
}

// linksToOwn reports whether ~/.claude/skills/<name> is a link to this home's
// own ~/.agents/skills/<name>. In the InAgents layout that link is the skill; any
// other link is still someone else's directory.
func linksToOwn(home, name string) bool {
	target, err := os.Readlink(filepath.Join(Root(home), name))
	if err != nil {
		return false
	}
	if !filepath.IsAbs(target) {
		target = filepath.Join(Root(home), target)
	}
	return filepath.Clean(target) == filepath.Join(AgentsRoot(home), name)
}

// lstatOrAbsent is os.Lstat with "not there" as a plain false rather than an
// error, so callers can ask about both halves of a pair without two error checks.
func lstatOrAbsent(path string) (fs.FileInfo, bool, error) {
	fi, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, false, nil
	}
	return fi, err == nil, err
}

func isLink(fi fs.FileInfo) bool { return fi.Mode()&os.ModeSymlink != 0 }

// ScanIn is Scan for a user on layout l. In the InAgents layout a link to the
// user's own ~/.agents/skills/<name> is an ordinary skill, so it is not reported
// as a link; a link anywhere else still is.
func ScanIn(home string, l Layout) ([]Skill, error) { return scan(home, l) }

// UnpackIn is Unpack for a user on layout l. In the InAgents layout the skill
// lands in ~/.agents/skills/<name> and ~/.claude/skills/<name> becomes a link to
// it; replacing backs the old pair up first, and a loose copy left in
// ~/.claude/skills from before the layout is backed up and turned into the link.
func UnpackIn(l Layout, home, name, from string, blobs []Blob, hash string, replace bool, at time.Time) (string, error) {
	return unpackIn(l, home, name, from, blobs, hash, replace, at, DefaultLimits)
}

// RemoveIn is Remove for a user on layout l: in the InAgents layout the backup
// holds the ~/.agents/skills directory and both halves of the pair go.
func RemoveIn(l Layout, home, name string, at time.Time) (string, error) {
	backup, err := backupIn(l, home, name, at)
	if err != nil {
		return "", err
	}
	return backup, forgetState(home, name)
}

// backupIn moves a skill out of the way, as Backup does. In the InAgents layout
// it moves the pair: the ~/.agents/skills entry goes into the backup and the
// ~/.claude/skills link is dropped. A link pointing anywhere else is handled
// exactly as Backup handles one.
func backupIn(l Layout, home, name string, at time.Time) (string, error) {
	if l != InAgents {
		return Backup(home, name, at)
	}
	if err := ValidName(name); err != nil {
		return "", err
	}
	entry := filepath.Join(Root(home), name)
	own := filepath.Join(AgentsRoot(home), name)
	efi, hasEntry, err := lstatOrAbsent(entry)
	if err != nil {
		return "", err
	}
	ofi, hasOwn, err := lstatOrAbsent(own)
	if err != nil {
		return "", err
	}
	if !hasEntry && !hasOwn {
		return "", &fs.PathError{Op: "lstat", Path: entry, Err: fs.ErrNotExist}
	}
	dir := filepath.Join(Root(home), ".backup")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}

	// aside moves one path into its own backup. A link is copied through and
	// dropped, so whatever it points at stays where it is.
	var first string
	aside := func(path string, fi fs.FileInfo) error {
		dest, err := freeBackupPath(dir, name, at)
		if err != nil {
			return err
		}
		if isLink(fi) {
			if err := copyWith(path, dest, DefaultLimits); err != nil {
				return err
			}
			if err := os.Remove(path); err != nil {
				return err
			}
		} else if err := os.Rename(path, dest); err != nil {
			return err
		}
		if first == "" {
			first = dest
		}
		return nil
	}

	if hasEntry && isLink(efi) && !linksToOwn(home, name) {
		// Someone else's directory behind the link: only the link goes.
		b, err := Backup(home, name, at)
		if err != nil {
			return "", err
		}
		first = b
		hasEntry = false
	}
	if hasOwn {
		if err := aside(own, ofi); err != nil {
			return first, err
		}
	}
	if hasEntry {
		if isLink(efi) {
			if err := os.Remove(entry); err != nil {
				return first, err
			}
		} else if err := aside(entry, efi); err != nil { // a loose copy from before the layout
			return first, err
		}
	}
	return first, nil
}

// DeleteIn is Delete for a user on layout l. In the InAgents layout the skill
// itself goes, both halves of the pair, unless ~/.agents/skills/<name> is a link
// too (a skill kept in a repo checkout), in which case that link goes and its
// target is left alone. A ~/.claude/skills link to anywhere else loses only the
// link, as in Delete.
func DeleteIn(l Layout, home, name string) (DeleteResult, error) {
	var res DeleteResult
	if l != InAgents {
		return Delete(home, name)
	}
	if err := ValidName(name); err != nil {
		return res, err
	}
	entry := filepath.Join(Root(home), name)
	own := filepath.Join(AgentsRoot(home), name)
	efi, hasEntry, err := lstatOrAbsent(entry)
	if err != nil {
		return res, err
	}
	if hasEntry && isLink(efi) && !linksToOwn(home, name) {
		return Delete(home, name)
	}
	ofi, hasOwn, err := lstatOrAbsent(own)
	if err != nil {
		return res, err
	}
	if !hasEntry && !hasOwn {
		return res, &fs.PathError{Op: "lstat", Path: entry, Err: fs.ErrNotExist}
	}

	if hasOwn {
		if isLink(ofi) {
			res.WasSymlink = true
			if target, err := os.Readlink(own); err == nil {
				if !filepath.IsAbs(target) {
					target = filepath.Join(AgentsRoot(home), target)
				}
				res.Target = filepath.Clean(target)
			}
			if err := os.Remove(own); err != nil {
				return res, err
			}
		} else {
			size, err := treeSize(own)
			if err != nil {
				return res, err
			}
			if err := os.RemoveAll(own); err != nil {
				return res, err
			}
			res.Bytes += size
		}
	}
	if hasEntry {
		if isLink(efi) {
			if err := os.Remove(entry); err != nil {
				return res, err
			}
		} else {
			size, err := treeSize(entry)
			if err != nil {
				return res, err
			}
			if err := os.RemoveAll(entry); err != nil {
				return res, err
			}
			res.Bytes += size
		}
	}
	return res, purgeAndForget(home, name, &res)
}
