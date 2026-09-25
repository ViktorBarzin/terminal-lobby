package skillscan

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The InAgents layout: a skill's real directory is ~/.agents/skills/<name>,
// which Codex reads directly, and ~/.claude/skills/<name> is a relative link to
// it. For a user on that layout the link is the skill, so installing writes the
// pair and removing or deleting takes the pair. These pin that, and pin that the
// default layout (InClaude) is untouched by it.

var at = time.Date(2026, 9, 25, 18, 0, 0, 0, time.UTC)

// agentsSkill makes home look like the skills CLI left it: the real directory
// under ~/.agents/skills and the relative link under ~/.claude/skills.
func agentsSkill(t *testing.T, home, name string, files map[string]string) {
	t.Helper()
	skill(t, AgentsRoot(home), name, files)
	if err := os.MkdirAll(Root(home), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("..", "..", ".agents", "skills", name), filepath.Join(Root(home), name)); err != nil {
		t.Fatal(err)
	}
}

func packOf(t *testing.T, dir string) ([]Blob, string) {
	t.Helper()
	blobs, st, err := Pack(dir)
	if err != nil {
		t.Fatal(err)
	}
	return blobs, st.Hash
}

func gone(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Lstat(path); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("%s should be gone (lstat err = %v)", path, err)
	}
}

func readBody(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestUnpackInAgentsWritesTheSkillThereAndLinksIt(t *testing.T) {
	src := skill(t, t.TempDir(), "tdd", map[string]string{"SKILL.md": "red green\n", "x:run.sh": "echo\n"})
	blobs, hash := packOf(t, src)
	home := t.TempDir()

	if _, err := UnpackIn(InAgents, home, "tdd", "emo", blobs, hash, false, at); err != nil {
		t.Fatal(err)
	}
	own := filepath.Join(AgentsRoot(home), "tdd")
	if fi, err := os.Lstat(own); err != nil || !fi.IsDir() {
		t.Fatalf("want a real directory at %s (err %v)", own, err)
	}
	link, err := os.Readlink(filepath.Join(Root(home), "tdd"))
	if err != nil {
		t.Fatalf("want ~/.claude/skills/tdd to be a link: %v", err)
	}
	if link != filepath.Join("..", "..", ".agents", "skills", "tdd") {
		t.Errorf("link = %q, want the relative ../../.agents/skills/tdd the skills CLI writes", link)
	}
	if got := readBody(t, filepath.Join(Root(home), "tdd", "SKILL.md")); got != "red green\n" {
		t.Errorf("reading through the link gave %q", got)
	}
	man, _ := LoadManifest(home)
	if p := man.Installed["tdd"]; p.From != "emo" || p.SourceHash != hash {
		t.Errorf("provenance = %+v, want from emo with the source hash", p)
	}
}

func TestUnpackInAgentsReplacesAfterBackingTheOldCopyUp(t *testing.T) {
	home := t.TempDir()
	agentsSkill(t, home, "tdd", map[string]string{"SKILL.md": "old\n"})
	blobs, hash := packOf(t, skill(t, t.TempDir(), "tdd", map[string]string{"SKILL.md": "new\n"}))

	if _, err := UnpackIn(InAgents, home, "tdd", "emo", blobs, hash, false, at); !errors.Is(err, ErrExists) {
		t.Fatalf("without replace, err = %v, want ErrExists", err)
	}
	if got := readBody(t, filepath.Join(AgentsRoot(home), "tdd", "SKILL.md")); got != "old\n" {
		t.Fatalf("a refused install changed the skill to %q", got)
	}

	backup, err := UnpackIn(InAgents, home, "tdd", "emo", blobs, hash, true, at)
	if err != nil {
		t.Fatal(err)
	}
	if got := readBody(t, filepath.Join(backup, "SKILL.md")); got != "old\n" {
		t.Errorf("backup holds %q, want the old text", got)
	}
	if got := readBody(t, filepath.Join(Root(home), "tdd", "SKILL.md")); got != "new\n" {
		t.Errorf("after replace the skill reads %q", got)
	}
	if fi, err := os.Lstat(filepath.Join(Root(home), "tdd")); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Error("after replace ~/.claude/skills/tdd should still be a link")
	}
}

func TestUnpackInAgentsTurnsALooseCopyIntoTheSharedPair(t *testing.T) {
	home := t.TempDir()
	skill(t, Root(home), "handoff", map[string]string{"SKILL.md": "loose\n"}) // a pre-layout copy
	blobs, hash := packOf(t, skill(t, t.TempDir(), "handoff", map[string]string{"SKILL.md": "shared\n"}))

	backup, err := UnpackIn(InAgents, home, "handoff", "emo", blobs, hash, true, at)
	if err != nil {
		t.Fatal(err)
	}
	if got := readBody(t, filepath.Join(backup, "SKILL.md")); got != "loose\n" {
		t.Errorf("backup holds %q, want the loose copy", got)
	}
	if got := readBody(t, filepath.Join(AgentsRoot(home), "handoff", "SKILL.md")); got != "shared\n" {
		t.Errorf("~/.agents copy reads %q", got)
	}
	if fi, err := os.Lstat(filepath.Join(Root(home), "handoff")); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Error("the loose copy should have become a link")
	}
}

func TestRemoveInAgentsTakesTheLinkAndTheSkillAndKeepsABackup(t *testing.T) {
	home := t.TempDir()
	agentsSkill(t, home, "grilling", map[string]string{"SKILL.md": "ask\n"})
	man, _ := LoadManifest(home)
	man.Record("grilling", "emo", "sha256:x", at)
	if err := man.Save(home); err != nil {
		t.Fatal(err)
	}

	backup, err := RemoveIn(InAgents, home, "grilling", at)
	if err != nil {
		t.Fatal(err)
	}
	gone(t, filepath.Join(Root(home), "grilling"))
	gone(t, filepath.Join(AgentsRoot(home), "grilling"))
	if got := readBody(t, filepath.Join(backup, "SKILL.md")); got != "ask\n" {
		t.Errorf("backup holds %q", got)
	}
	man, _ = LoadManifest(home)
	if _, ok := man.Installed["grilling"]; ok {
		t.Error("provenance should be forgotten")
	}
}

func TestRemoveInAgentsDropsALinkedEntryButNotWhatItPointsAt(t *testing.T) {
	home := t.TempDir()
	repo := skill(t, t.TempDir(), "skill", map[string]string{"SKILL.md": "harvest\n"})
	if err := os.MkdirAll(AgentsRoot(home), 0o755); err != nil {
		t.Fatal(err)
	}
	// ~/.agents/skills/lesson-harvester is itself a link into a repo checkout.
	if err := os.Symlink(repo, filepath.Join(AgentsRoot(home), "lesson-harvester")); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(Root(home), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("..", "..", ".agents", "skills", "lesson-harvester"), filepath.Join(Root(home), "lesson-harvester")); err != nil {
		t.Fatal(err)
	}

	backup, err := RemoveIn(InAgents, home, "lesson-harvester", at)
	if err != nil {
		t.Fatal(err)
	}
	gone(t, filepath.Join(Root(home), "lesson-harvester"))
	gone(t, filepath.Join(AgentsRoot(home), "lesson-harvester"))
	if got := readBody(t, filepath.Join(repo, "SKILL.md")); got != "harvest\n" {
		t.Errorf("the repo's skill was touched: %q", got)
	}
	if got := readBody(t, filepath.Join(backup, "SKILL.md")); got != "harvest\n" {
		t.Errorf("backup holds %q", got)
	}
}

func TestDeleteInAgentsTakesTheLinkTheSkillAndItsBackups(t *testing.T) {
	home := t.TempDir()
	agentsSkill(t, home, "teach", map[string]string{"SKILL.md": "v1\n"})
	if _, err := RemoveIn(InAgents, home, "teach", at); err != nil { // one earlier backup
		t.Fatal(err)
	}
	agentsSkill(t, home, "teach", map[string]string{"SKILL.md": "v2\n"})

	res, err := DeleteIn(InAgents, home, "teach")
	if err != nil {
		t.Fatal(err)
	}
	gone(t, filepath.Join(Root(home), "teach"))
	gone(t, filepath.Join(AgentsRoot(home), "teach"))
	if res.WasSymlink {
		t.Error("the skill itself went, so the result must not say only a link did")
	}
	if res.PurgedBackups != 1 || res.Bytes == 0 {
		t.Errorf("result = %+v, want 1 purged backup and bytes counted", res)
	}
}

func TestDeleteInAgentsLeavesAForeignLinksTargetAlone(t *testing.T) {
	home := t.TempDir()
	elsewhere := skill(t, t.TempDir(), "notes", map[string]string{"SKILL.md": "mine\n"})
	if err := os.MkdirAll(Root(home), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(elsewhere, filepath.Join(Root(home), "notes")); err != nil {
		t.Fatal(err)
	}

	res, err := DeleteIn(InAgents, home, "notes")
	if err != nil {
		t.Fatal(err)
	}
	if !res.WasSymlink || res.Target != elsewhere {
		t.Errorf("result = %+v, want a link-only delete naming %s", res, elsewhere)
	}
	if got := readBody(t, filepath.Join(elsewhere, "SKILL.md")); got != "mine\n" {
		t.Errorf("the target was touched: %q", got)
	}
}

func TestScanInAgentsShowsTheSharedPairAsAnOrdinarySkill(t *testing.T) {
	home := t.TempDir()
	agentsSkill(t, home, "tdd", map[string]string{"SKILL.md": "---\ndescription: t\n---\n"})
	elsewhere := skill(t, t.TempDir(), "notes", map[string]string{"SKILL.md": "n\n"})
	if err := os.Symlink(elsewhere, filepath.Join(Root(home), "notes")); err != nil {
		t.Fatal(err)
	}

	byName := func(list []Skill) map[string]Skill {
		m := map[string]Skill{}
		for _, s := range list {
			m[s.Name] = s
		}
		return m
	}
	shared, err := ScanIn(home, InAgents)
	if err != nil {
		t.Fatal(err)
	}
	if s := byName(shared); s["tdd"].Symlink || !s["notes"].Symlink {
		t.Errorf("InAgents: tdd.Symlink=%v (want false), notes.Symlink=%v (want true)", s["tdd"].Symlink, s["notes"].Symlink)
	}
	plain, err := Scan(home)
	if err != nil {
		t.Fatal(err)
	}
	if s := byName(plain); !s["tdd"].Symlink {
		t.Error("InClaude must keep reporting the link as a link")
	}
}

func TestTheDefaultLayoutStillLeavesALinksTargetAlone(t *testing.T) {
	home := t.TempDir()
	agentsSkill(t, home, "find-skills", map[string]string{"SKILL.md": "f\n"})

	if _, err := RemoveIn(InClaude, home, "find-skills", at); err != nil {
		t.Fatal(err)
	}
	gone(t, filepath.Join(Root(home), "find-skills"))
	if got := readBody(t, filepath.Join(AgentsRoot(home), "find-skills", "SKILL.md")); got != "f\n" {
		t.Errorf("InClaude must not touch ~/.agents/skills, got %q", got)
	}
}
