package skillscan

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// WriteSkillMd replaces one skill's SKILL.md with body, and reports what the
// skill looks like afterwards.
//
// The write lands through a temporary file in the same directory and a rename,
// so a session reading the skill sees either the old file or the new one and
// never a half-written one. Nothing else in the directory is touched: a skill's
// scripts, its references and their modes survive an edit of its text.
//
// The skill has to exist already — this edits, it does not create. A skill that
// is a symlink is written through to its target, which is where its author keeps
// it; the link itself stays a link.
func WriteSkillMd(home, name string, body []byte) (Stat, error) {
	if err := ValidName(name); err != nil {
		return Stat{}, err
	}
	if len(body) == 0 {
		return Stat{}, errors.New("a skill file cannot be empty")
	}
	if int64(len(body)) > DefaultLimits.MaxBytes {
		return Stat{}, fmt.Errorf("a skill file larger than %d bytes is more than this edits", DefaultLimits.MaxBytes)
	}
	dir := filepath.Join(Root(home), name)
	// Stat, not Lstat: a symlinked skill is a normal way to keep one under
	// version control elsewhere in the account, and it should be editable.
	if fi, err := os.Stat(dir); err != nil {
		return Stat{}, err
	} else if !fi.IsDir() {
		return Stat{}, fmt.Errorf("%s is not a skill directory", name)
	}

	dst := filepath.Join(dir, "SKILL.md")
	// A doc is not executable, so the existing mode is honoured except for that
	// bit — the umask a skill arrived under is the author's business, and it is
	// part of what the hash covers.
	mode := fs.FileMode(0o644)
	if fi, err := os.Stat(dst); err == nil {
		mode = fi.Mode().Perm() &^ 0o111
	}
	tmp := staging(dst)
	if err := os.WriteFile(tmp, body, mode); err != nil {
		return Stat{}, err
	}
	// A no-op once the rename below has consumed it; the point is the failure
	// paths, which must not leave a half-written file in a skill directory.
	defer os.Remove(tmp)
	if err := os.Chmod(tmp, mode); err != nil { // WriteFile respects the umask
		return Stat{}, err
	}
	if err := os.Rename(tmp, dst); err != nil {
		return Stat{}, err
	}
	return Inspect(dir)
}
