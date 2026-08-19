package skillscan

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCopyReproducesTheTreeWithNormalisedModes(t *testing.T) {
	root := t.TempDir()
	src := skill(t, root, "src", map[string]string{
		"SKILL.md":       "---\nname: s\n---\nbody\n",
		"x:scripts/a.sh": "echo a\n",
		"docs/notes.md":  "notes\n",
	})
	if err := os.Chmod(filepath.Join(src, "SKILL.md"), 0o664); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(root, "dst")
	if err := Copy(src, dst); err != nil {
		t.Fatal(err)
	}
	// Same content, and the same hash — so an install records a hash the source
	// will still produce next time it is scanned.
	if mustHash(t, src) != mustHash(t, dst) {
		t.Fatal("copy changed the hash")
	}
	for rel, wantMode := range map[string]os.FileMode{
		"SKILL.md":      0o644, // the group-write bit is not carried over
		"scripts/a.sh":  0o755, // the executable bit is
		"docs/notes.md": 0o644,
	} {
		fi, err := os.Stat(filepath.Join(dst, rel))
		if err != nil {
			t.Fatal(err)
		}
		if got := fi.Mode().Perm(); got != wantMode {
			t.Errorf("%s mode = %o, want %o", rel, got, wantMode)
		}
	}
}

func TestCopyLeavesNothingBehindWhenItFails(t *testing.T) {
	root := t.TempDir()
	src := skill(t, root, "src", map[string]string{"SKILL.md": "b\n", "blob": strings.Repeat("x", 4096)})
	dst := filepath.Join(root, "dst")
	if err := copyWith(src, dst, Limits{MaxBytes: 128, MaxFiles: 500}); err == nil {
		t.Fatal("want an error past the size cap")
	}
	if _, err := os.Stat(dst); !os.IsNotExist(err) {
		t.Fatal("a refused copy must not leave the destination behind")
	}
	entries, _ := os.ReadDir(root)
	for _, e := range entries {
		if strings.Contains(e.Name(), ".incoming") {
			t.Fatalf("staging directory %s left behind", e.Name())
		}
	}
}

func TestCopyRefusesAnExistingDestination(t *testing.T) {
	root := t.TempDir()
	src := skill(t, root, "src", map[string]string{"SKILL.md": "b\n"})
	dst := skill(t, root, "dst", map[string]string{"SKILL.md": "mine\n"})
	if err := Copy(src, dst); err == nil {
		t.Fatal("Copy must refuse to overwrite; the caller backs up first")
	}
	body, _ := os.ReadFile(filepath.Join(dst, "SKILL.md"))
	if string(body) != "mine\n" {
		t.Fatal("the existing skill was modified")
	}
}

func TestCopySkipsSymlinksPointingOutsideTheSkill(t *testing.T) {
	root := t.TempDir()
	secret := filepath.Join(root, "secret.txt")
	if err := os.WriteFile(secret, []byte("token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	src := skill(t, root, "src", map[string]string{"SKILL.md": "b\n", "docs/real.md": "r\n"})
	if err := os.Symlink(secret, filepath.Join(src, "escape.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("docs/real.md", filepath.Join(src, "inside.md")); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(root, "dst")
	if err := Copy(src, dst); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(dst, "escape.txt")); !os.IsNotExist(err) {
		t.Fatal("a symlink out of the skill directory must not be copied")
	}
	if _, err := os.Lstat(filepath.Join(dst, "inside.md")); err != nil {
		t.Fatal("an in-tree symlink should survive the copy")
	}
}

func TestCopyFollowsASymlinkedSkillDirectory(t *testing.T) {
	// emo's provisioned skills are symlinks into ~/.agents/skills, and wizard's
	// lesson-harvester points into a repo. Installing one copies the contents.
	root := t.TempDir()
	real := skill(t, root, "real", map[string]string{"SKILL.md": "b\n"})
	link := filepath.Join(root, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(root, "dst")
	if err := Copy(link, dst); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Lstat(dst)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		t.Fatal("the destination must be a real directory, not a symlink")
	}
	if mustHash(t, dst) != mustHash(t, real) {
		t.Fatal("contents differ from the symlink target")
	}
}

func TestBackupMovesTheSkillAsideUnderAStampedName(t *testing.T) {
	home := t.TempDir()
	root := Root(home)
	skill(t, root, "tdd", map[string]string{"SKILL.md": "mine\n"})
	at := time.Date(2026, 8, 19, 9, 12, 0, 0, time.UTC)

	path, err := Backup(home, "tdd", at)
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(root, ".backup", "tdd-20260819T091200Z"); path != want {
		t.Fatalf("backup path = %s, want %s", path, want)
	}
	if _, err := os.Stat(filepath.Join(root, "tdd")); !os.IsNotExist(err) {
		t.Fatal("the original should have moved, not been copied")
	}
	body, err := os.ReadFile(filepath.Join(path, "SKILL.md"))
	if err != nil || string(body) != "mine\n" {
		t.Fatalf("backup content = %q, %v", body, err)
	}
	// A second backup in the same second must not collide destructively.
	skill(t, root, "tdd", map[string]string{"SKILL.md": "second\n"})
	again, err := Backup(home, "tdd", at)
	if err != nil {
		t.Fatal(err)
	}
	if again == path {
		t.Fatal("two backups in the same second must not land on the same path")
	}
}

func TestBackupIsSkippedForASymlinkedSkill(t *testing.T) {
	// Removing emo's provisioned symlink should back up the resolved content and
	// drop the link, leaving ~/.agents/skills alone.
	home := t.TempDir()
	root := Root(home)
	target := skill(t, home, "agents-copy", map[string]string{"SKILL.md": "vendored\n"})
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "caveman")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 8, 19, 9, 12, 0, 0, time.UTC)
	path, err := Backup(home, "caveman", at)
	if err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(path, "SKILL.md"))
	if err != nil || string(body) != "vendored\n" {
		t.Fatalf("the backup should carry the resolved content, got %q %v", body, err)
	}
	if _, err := os.Lstat(link); !os.IsNotExist(err) {
		t.Fatal("the symlink should be gone")
	}
	if _, err := os.Stat(filepath.Join(target, "SKILL.md")); err != nil {
		t.Fatal("the symlink target must be left untouched")
	}
}

func TestSkillNameValidation(t *testing.T) {
	ok := []string{"tdd", "grill-with-docs", "k8s_terraform.port", "a"}
	bad := []string{"", ".", "..", "../etc", "a/b", "Caps", "-lead", strings.Repeat("a", 65), "sp ace", ".hidden"}
	for _, n := range ok {
		if err := ValidName(n); err != nil {
			t.Errorf("ValidName(%q) = %v, want ok", n, err)
		}
	}
	for _, n := range bad {
		if err := ValidName(n); err == nil {
			t.Errorf("ValidName(%q) = nil, want an error", n)
		}
	}
}
