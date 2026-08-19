package skillscan

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Deleting is not Removing. Remove keeps a backup, so the bytes survive; Delete
// is the permanent one — the skill, its backups, its enabled state and its
// provenance all go. These pin the difference, because getting it wrong in
// either direction is bad: a Delete that leaves copies is not permanent, and a
// Remove that does not is unrecoverable.

func TestDeleteLeavesNothingBehind(t *testing.T) {
	home := t.TempDir()
	root := Root(home)
	skill(t, root, "caveman", map[string]string{"SKILL.md": "c\n", "x:run.sh": "echo\n"})
	at := time.Date(2026, 8, 19, 9, 12, 0, 0, time.UTC)

	// A history of this skill: two earlier backups and a disabled marker.
	if _, err := Backup(home, "caveman", at); err != nil {
		t.Fatal(err)
	}
	skill(t, root, "caveman", map[string]string{"SKILL.md": "c2\n"})
	if _, err := Backup(home, "caveman", at.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	skill(t, root, "caveman", map[string]string{"SKILL.md": "c3\n"})
	if err := SetEnabled(home, "caveman@skills-dir", false); err != nil {
		t.Fatal(err)
	}
	man, _ := LoadManifest(home)
	man.Record("caveman", "emo", "sha256:x", at)
	if err := man.Save(home); err != nil {
		t.Fatal(err)
	}

	res, err := Delete(home, "caveman")
	if err != nil {
		t.Fatal(err)
	}
	if res.PurgedBackups != 2 {
		t.Errorf("PurgedBackups = %d, want 2", res.PurgedBackups)
	}
	if res.Bytes == 0 {
		t.Error("want the reclaimed byte count")
	}
	if _, err := os.Stat(filepath.Join(root, "caveman")); !os.IsNotExist(err) {
		t.Error("the skill is still there")
	}
	left, _ := os.ReadDir(filepath.Join(root, ".backup"))
	for _, e := range left {
		if strings.HasPrefix(e.Name(), "caveman-") {
			t.Errorf("a backup survived a permanent delete: %s", e.Name())
		}
	}
	if body, _ := os.ReadFile(filepath.Join(home, ".claude", "settings.json")); strings.Contains(string(body), "caveman") {
		t.Errorf("the disabled marker survived:\n%s", body)
	}
	again, _ := LoadManifest(home)
	if _, ok := again.Installed["caveman"]; ok {
		t.Error("provenance survived")
	}
}

func TestDeleteKeepsAnotherSkillsBackups(t *testing.T) {
	home := t.TempDir()
	root := Root(home)
	at := time.Now().UTC()
	for _, n := range []string{"caveman", "cave"} {
		skill(t, root, n, map[string]string{"SKILL.md": n + "\n"})
		if _, err := Backup(home, n, at); err != nil {
			t.Fatal(err)
		}
		skill(t, root, n, map[string]string{"SKILL.md": n + "2\n"})
	}
	if _, err := Delete(home, "cave"); err != nil {
		t.Fatal(err)
	}
	// "cave" is a prefix of "caveman": a sloppy glob would take both.
	left, _ := os.ReadDir(filepath.Join(root, ".backup"))
	var names []string
	for _, e := range left {
		names = append(names, e.Name())
	}
	if len(names) != 1 || !strings.HasPrefix(names[0], "caveman-") {
		t.Fatalf("backups left = %v, want only caveman's", names)
	}
	if _, err := os.Stat(filepath.Join(root, "caveman")); err != nil {
		t.Error("the other skill should be untouched")
	}
}

func TestDeleteOfASymlinkedSkillLeavesItsTargetAlone(t *testing.T) {
	// emo's provisioned skills point into ~/.agents/skills, and one of wizard's
	// points into a repo checkout. Deleting the entry drops the link; deleting
	// what it points at is not this feature's business.
	home := t.TempDir()
	root := Root(home)
	target := skill(t, home, "elsewhere", map[string]string{"SKILL.md": "vendored\n"})
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(root, "caveman")); err != nil {
		t.Fatal(err)
	}
	res, err := Delete(home, "caveman")
	if err != nil {
		t.Fatal(err)
	}
	if !res.WasSymlink || res.Target != target {
		t.Errorf("want the target reported so the panel can say so: %+v", res)
	}
	if _, err := os.Lstat(filepath.Join(root, "caveman")); !os.IsNotExist(err) {
		t.Error("the link should be gone")
	}
	if _, err := os.Stat(filepath.Join(target, "SKILL.md")); err != nil {
		t.Error("the target must survive")
	}
}

func TestDeleteRefusesWhatIsNotThere(t *testing.T) {
	home := t.TempDir()
	if _, err := Delete(home, "nope"); err == nil {
		t.Fatal("want an error for a skill that does not exist")
	}
	for _, bad := range []string{"", "../etc", "a/b", ".backup"} {
		if _, err := Delete(home, bad); err == nil {
			t.Errorf("Delete(%q) must be refused", bad)
		}
	}
}

// --- the orphaned plugin cache ------------------------------------------------

func TestPurgeOrphanedPluginTakesOnlyMarkedVersions(t *testing.T) {
	// `claude plugin uninstall` drops the installed_plugins entry and the
	// enabledPlugins key, then leaves the files behind with a .orphaned_at
	// marker (measured on 2.1.235). Reclaiming them is what makes the removal
	// permanent, and the marker is the only thing that says it is safe.
	home := t.TempDir()
	cache := filepath.Join(home, ".claude", "plugins", "cache", "official", "demo")
	for _, v := range []string{"1.0.0", "2.0.0"} {
		if err := os.MkdirAll(filepath.Join(cache, v), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(cache, v, "big.bin"), make([]byte, 1024), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// only 1.0.0 is orphaned
	if err := os.WriteFile(filepath.Join(cache, "1.0.0", ".orphaned_at"), []byte("1787175597158"), 0o644); err != nil {
		t.Fatal(err)
	}

	freed, err := PurgeOrphanedPlugin(home, "demo@official")
	if err != nil {
		t.Fatal(err)
	}
	if freed < 1024 {
		t.Errorf("freed = %d, want at least the 1KB file", freed)
	}
	if _, err := os.Stat(filepath.Join(cache, "1.0.0")); !os.IsNotExist(err) {
		t.Error("the orphaned version should be gone")
	}
	if _, err := os.Stat(filepath.Join(cache, "2.0.0", "big.bin")); err != nil {
		t.Error("an unmarked version must be left alone — it may still be in use")
	}
}

func TestPurgeOrphanedPluginRefusesAnythingButAPluginID(t *testing.T) {
	home := t.TempDir()
	for _, bad := range []string{"", "no-at-sign", "../../etc@official", "demo@../..", "a@b@c"} {
		if _, err := PurgeOrphanedPlugin(home, bad); err == nil {
			t.Errorf("PurgeOrphanedPlugin(%q) must be refused", bad)
		}
	}
	// A plugin with no cache directory at all is not an error: nothing to free.
	if freed, err := PurgeOrphanedPlugin(home, "absent@official"); err != nil || freed != 0 {
		t.Errorf("want 0 freed and no error, got %d %v", freed, err)
	}
}
