package skillscan

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Permanent removal.
//
// Remove and Delete are deliberately different operations. Remove backs the
// skill up first, so it is recoverable and is what the panel offers by default.
// Delete is the one that means it: the skill, every backup of it, its enabled
// state and its provenance all go, and the bytes are reclaimed.
//
// One thing Delete does not do is follow a symlink. emo's provisioned skills
// point into ~/.agents/skills and one of wizard's points into a repo checkout —
// deleting the entry drops the link, and what it pointed at belongs to whatever
// put it there. The result says which happened so the panel can too.

// DeleteResult reports what a permanent delete actually did.
type DeleteResult struct {
	// WasSymlink: the entry was a link, so only the link was removed.
	WasSymlink bool `json:"wasSymlink,omitempty"`
	// Target is what that link pointed at, left untouched.
	Target string `json:"target,omitempty"`
	// PurgedBackups counts the earlier copies under .backup/ that went with it.
	PurgedBackups int `json:"purgedBackups"`
	// Bytes reclaimed, across the skill and its backups.
	Bytes int64 `json:"bytes"`
}

// Delete removes a skill for good.
func Delete(home, name string) (DeleteResult, error) {
	var res DeleteResult
	if err := ValidName(name); err != nil {
		return res, err
	}
	root := Root(home)
	entry := filepath.Join(root, name)
	fi, err := os.Lstat(entry)
	if err != nil {
		return res, err
	}

	if fi.Mode()&os.ModeSymlink != 0 {
		res.WasSymlink = true
		if target, err := os.Readlink(entry); err == nil {
			if !filepath.IsAbs(target) {
				target = filepath.Join(root, target)
			}
			res.Target = filepath.Clean(target)
		}
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

	purged, freed, err := purgeBackups(root, name)
	if err != nil {
		return res, err
	}
	res.PurgedBackups, res.Bytes = purged, res.Bytes+freed

	if err := ClearEnabled(home, name+"@skills-dir"); err != nil {
		return res, err
	}
	man, err := LoadManifest(home)
	if err != nil {
		return res, err
	}
	if _, ok := man.Installed[name]; !ok {
		return res, nil
	}
	man.Forget(name)
	return res, man.Save(home)
}

// purgeBackups drops every .backup/<name>-<stamp> directory for one skill.
//
// It matches on the exact "<name>-" prefix rather than a glob, because a glob on
// "cave*" would also take "caveman"'s history.
func purgeBackups(root, name string) (count int, freed int64, err error) {
	dir := filepath.Join(root, ".backup")
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return 0, 0, nil
	}
	if err != nil {
		return 0, 0, err
	}
	prefix := name + "-"
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), prefix) {
			continue
		}
		// Everything after the prefix is a timestamp this package wrote.
		if !backupStampRe.MatchString(strings.TrimPrefix(e.Name(), prefix)) {
			continue
		}
		p := filepath.Join(dir, e.Name())
		if size, err := treeSize(p); err == nil {
			freed += size
		}
		if err := os.RemoveAll(p); err != nil {
			return count, freed, err
		}
		count++
	}
	return count, freed, nil
}

// backupStampRe matches what freeBackupPath appends: 20260819T091200Z, with an
// optional -2, -3 … for a same-second collision.
var backupStampRe = regexp.MustCompile(`^\d{8}T\d{6}Z(-\d+)?$`)

// treeSize adds up the regular files under a path, following no symlinks.
func treeSize(path string) (int64, error) {
	var total int64
	err := filepath.WalkDir(path, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type().IsRegular() {
			if fi, err := d.Info(); err == nil {
				total += fi.Size()
			}
		}
		return nil
	})
	return total, err
}

// pluginIDRe is "<name>@<marketplace>", the id Claude Code uses. Both halves are
// used as path segments below, so neither may contain anything but this charset.
var pluginIDRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}@[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`)

// PurgeOrphanedPlugin reclaims what a plugin uninstall leaves behind.
//
// `claude plugin uninstall` drops the installed_plugins entry and the
// enabledPlugins key, then leaves the files in place with a .orphaned_at marker
// (measured on Claude Code 2.1.235); `claude plugin prune` does not take them,
// since it only handles auto-installed dependencies. So a removal that is meant
// to be permanent reclaims them here.
//
// Only a version directory carrying that marker is removed — an unmarked one may
// still be in use — and the path is rebuilt from a validated id rather than taken
// from anything a caller supplies.
func PurgeOrphanedPlugin(home, id string) (int64, error) {
	if !pluginIDRe.MatchString(id) {
		return 0, fmt.Errorf("invalid plugin id %q", id)
	}
	name, market, _ := strings.Cut(id, "@")
	dir := filepath.Join(home, ".claude", "plugins", "cache", market, name)
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	var freed int64
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		version := filepath.Join(dir, e.Name())
		if _, err := os.Stat(filepath.Join(version, ".orphaned_at")); err != nil {
			continue // still in use, or never orphaned
		}
		if size, err := treeSize(version); err == nil {
			freed += size
		}
		if err := os.RemoveAll(version); err != nil {
			return freed, err
		}
	}
	// Leave the now-empty parent: the CLI recreates it on the next install and
	// removing it races that.
	return freed, nil
}
