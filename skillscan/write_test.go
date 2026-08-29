package skillscan

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// skillAt lays down one skill and returns the home it lives under.
func skillAt(t *testing.T, name, body string) string {
	t.Helper()
	home := t.TempDir()
	dir := filepath.Join(Root(home), name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	skillMd := filepath.Join(dir, "SKILL.md")
	if err := os.WriteFile(skillMd, []byte(body), 0o664); err != nil {
		t.Fatal(err)
	}
	// WriteFile respects the umask, so the mode it lands with depends on who is
	// running the test: 0664 under the devvm's 002, 0644 on a CI runner's 022.
	// Chmod establishes the precondition explicitly, so a test about PRESERVING
	// a mode is not silently handed a different one to preserve.
	if err := os.Chmod(skillMd, 0o664); err != nil {
		t.Fatal(err)
	}
	return home
}

func TestWriteSkillMdReplacesTheFile(t *testing.T) {
	home := skillAt(t, "tidy", "---\nname: tidy\n---\nold\n")
	before, err := Inspect(filepath.Join(Root(home), "tidy"))
	if err != nil {
		t.Fatal(err)
	}

	st, err := WriteSkillMd(home, "tidy", []byte("---\nname: tidy\ndescription: Keeps things tidy\n---\nnew\n"))
	if err != nil {
		t.Fatalf("write: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(Root(home), "tidy", "SKILL.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), "new") {
		t.Errorf("file still reads %q", got)
	}
	if st.Hash == before.Hash {
		t.Error("hash did not move, so the panel would still call this skill unchanged")
	}
	if st.Description != "Keeps things tidy" {
		t.Errorf("description = %q, want the one in the new frontmatter", st.Description)
	}
	if st.Files != 1 {
		t.Errorf("Files = %d, want 1", st.Files)
	}
}

func TestWriteSkillMdKeepsTheModeAndTheOtherFiles(t *testing.T) {
	home := skillAt(t, "tidy", "old\n")
	dir := filepath.Join(Root(home), "tidy")
	if err := os.WriteFile(filepath.Join(dir, "run.sh"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	if _, err := WriteSkillMd(home, "tidy", []byte("new\n")); err != nil {
		t.Fatal(err)
	}

	fi, err := os.Stat(filepath.Join(dir, "SKILL.md"))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o664 {
		t.Errorf("mode = %v, want the 0664 it already had", fi.Mode().Perm())
	}
	script, err := os.Stat(filepath.Join(dir, "run.sh"))
	if err != nil {
		t.Fatalf("the script next to it is gone: %v", err)
	}
	if script.Mode().Perm() != 0o755 {
		t.Errorf("run.sh mode = %v, want 0755 left alone", script.Mode().Perm())
	}
}

func TestWriteSkillMdLeavesNoStagingFile(t *testing.T) {
	home := skillAt(t, "tidy", "old\n")
	if _, err := WriteSkillMd(home, "tidy", []byte("new\n")); err != nil {
		t.Fatal(err)
	}
	ents, err := os.ReadDir(filepath.Join(Root(home), "tidy"))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range ents {
		if e.Name() != "SKILL.md" {
			t.Errorf("left %q behind", e.Name())
		}
	}
}

func TestWriteSkillMdWritesThroughASymlinkedSkill(t *testing.T) {
	home := t.TempDir()
	real := filepath.Join(home, "code", "tidy")
	if err := os.MkdirAll(real, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(real, "SKILL.md"), []byte("old\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(Root(home), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, filepath.Join(Root(home), "tidy")); err != nil {
		t.Fatal(err)
	}

	if _, err := WriteSkillMd(home, "tidy", []byte("new\n")); err != nil {
		t.Fatalf("write through the link: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(real, "SKILL.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "new\n" {
		t.Errorf("the link target still reads %q", got)
	}
	if fi, err := os.Lstat(filepath.Join(Root(home), "tidy")); err != nil {
		t.Fatal(err)
	} else if fi.Mode()&fs.ModeSymlink == 0 {
		t.Error("the skill is no longer a link — the write replaced it")
	}
}

func TestWriteSkillMdWritesAMissingSkillMd(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(Root(home), "tidy"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := WriteSkillMd(home, "tidy", []byte("first\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := os.Stat(filepath.Join(Root(home), "tidy", "SKILL.md")); err != nil {
		t.Errorf("SKILL.md was not created: %v", err)
	}
}

func TestWriteSkillMdRefusals(t *testing.T) {
	big := strings.Repeat("x", int(DefaultLimits.MaxBytes)+1)
	cases := []struct {
		what, name, body, want string
	}{
		{"empty body", "tidy", "", "cannot be empty"},
		{"oversize body", "tidy", big, "larger than"},
		{"traversal", "../../etc", "hi", "name"},
		{"unknown skill", "absent", "hi", "no such file"},
	}
	for _, c := range cases {
		t.Run(c.what, func(t *testing.T) {
			home := skillAt(t, "tidy", "old\n")
			_, err := WriteSkillMd(home, c.name, []byte(c.body))
			if err == nil {
				t.Fatal("no error")
			}
			if !strings.Contains(err.Error(), c.want) {
				t.Errorf("error = %q, want it to mention %q", err, c.want)
			}
			// The refusal must not have touched what was there.
			got, _ := os.ReadFile(filepath.Join(Root(home), "tidy", "SKILL.md"))
			if string(got) != "old\n" {
				t.Errorf("the existing file changed to %q", got)
			}
		})
	}
}

func TestWriteSkillMdUnknownSkillIsNotExist(t *testing.T) {
	home := skillAt(t, "tidy", "old\n")
	_, err := WriteSkillMd(home, "absent", []byte("hi"))
	if !os.IsNotExist(err) {
		t.Errorf("error = %v, want one that os.IsNotExist recognises so the handler answers 404", err)
	}
}
