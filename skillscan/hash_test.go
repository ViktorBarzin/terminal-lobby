package skillscan

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// skill writes a skill directory and returns its path. files maps a relative
// path to its content; a path prefixed "x:" is written executable.
func skill(t *testing.T, root, name string, files map[string]string) string {
	t.Helper()
	dir := filepath.Join(root, name)
	for rel, body := range files {
		mode := os.FileMode(0o644)
		if strings.HasPrefix(rel, "x:") {
			rel, mode = strings.TrimPrefix(rel, "x:"), 0o755
		}
		p := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), mode); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func mustHash(t *testing.T, dir string) string {
	t.Helper()
	h, err := Hash(dir)
	if err != nil {
		t.Fatalf("Hash(%s): %v", dir, err)
	}
	if !strings.HasPrefix(h, "sha256:") {
		t.Fatalf("hash %q lacks its algorithm prefix", h)
	}
	return h
}

func TestHashIsStableAcrossNonExecutableModeDifferences(t *testing.T) {
	// The load-bearing case: wizard's files are 664 and bob's are 644 for the
	// same content, because their umasks differ. Hashing the full mode would
	// report every shared skill as divergent, so only the executable bit counts.
	root := t.TempDir()
	a := skill(t, root, "a", map[string]string{"SKILL.md": "---\nname: a\n---\nbody\n"})
	b := skill(t, root, "b", map[string]string{"SKILL.md": "---\nname: a\n---\nbody\n"})
	if err := os.Chmod(filepath.Join(a, "SKILL.md"), 0o664); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(b, "SKILL.md"), 0o600); err != nil {
		t.Fatal(err)
	}
	if mustHash(t, a) != mustHash(t, b) {
		t.Fatal("hash changed with the group/other permission bits; it must not")
	}
}

func TestHashTracksContentPathAndExecutableBit(t *testing.T) {
	root := t.TempDir()
	base := map[string]string{"SKILL.md": "body\n", "x:run.sh": "echo hi\n"}
	a := skill(t, root, "a", base)
	want := mustHash(t, a)

	cases := []struct {
		name  string
		files map[string]string
		mut   func(dir string)
	}{
		{name: "content differs", files: map[string]string{"SKILL.md": "other\n", "x:run.sh": "echo hi\n"}},
		{name: "path differs", files: map[string]string{"SKILL.md": "body\n", "x:go.sh": "echo hi\n"}},
		{
			name:  "executable bit dropped",
			files: base,
			mut:   func(dir string) { _ = os.Chmod(filepath.Join(dir, "run.sh"), 0o644) },
		},
		{name: "extra file", files: map[string]string{"SKILL.md": "body\n", "x:run.sh": "echo hi\n", "NOTES.md": "n\n"}},
	}
	for i, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := skill(t, root, string(rune('c'+i)), c.files)
			if c.mut != nil {
				c.mut(dir)
			}
			if got := mustHash(t, dir); got == want {
				t.Fatalf("%s: hash did not change", c.name)
			}
		})
	}
}

func TestHashIgnoresExcludedDirectories(t *testing.T) {
	// claudeception carries its own nested .git; a checkout's noise must not
	// make an otherwise identical skill look different.
	root := t.TempDir()
	a := skill(t, root, "a", map[string]string{"SKILL.md": "body\n"})
	b := skill(t, root, "b", map[string]string{
		"SKILL.md":                "body\n",
		".git/HEAD":               "ref: refs/heads/main\n",
		"node_modules/x/index.js": "0\n",
		"__pycache__/m.pyc":       "\x00\x01",
	})
	if mustHash(t, a) != mustHash(t, b) {
		t.Fatal("excluded directories leaked into the hash")
	}
}

func TestInspectReportsWhatTheRowNeeds(t *testing.T) {
	root := t.TempDir()
	dir := skill(t, root, "diagnose", map[string]string{
		"SKILL.md":       "---\nname: diagnose\ndescription: Diagnosis loop for hard bugs.\n---\n\nbody\n",
		"x:scripts/a.sh": "echo a\n",
		"x:scripts/b.sh": "echo b\n",
		".git/HEAD":      "ref: x\n",
	})
	st, err := Inspect(dir)
	if err != nil {
		t.Fatal(err)
	}
	if st.Files != 3 {
		t.Errorf("Files = %d, want 3 (the excluded .git must not count)", st.Files)
	}
	if st.Executable != 2 {
		t.Errorf("Executable = %d, want 2", st.Executable)
	}
	if st.Description != "Diagnosis loop for hard bugs." {
		t.Errorf("Description = %q", st.Description)
	}
	if st.Bytes == 0 || st.Hash == "" {
		t.Errorf("Bytes/Hash not filled: %+v", st)
	}
}

func TestInspectRejectsADirectoryWithoutSkillMd(t *testing.T) {
	root := t.TempDir()
	dir := skill(t, root, "notaskill", map[string]string{"README.md": "hi\n"})
	if _, err := Inspect(dir); err == nil {
		t.Fatal("a directory without SKILL.md is not a skill; Inspect must say so")
	}
}

func TestInspectRefusesOversizedTrees(t *testing.T) {
	root := t.TempDir()
	dir := skill(t, root, "big", map[string]string{
		"SKILL.md": "body\n",
		"blob.bin": strings.Repeat("x", 1024),
	})
	small := Limits{MaxBytes: 512, MaxFiles: 500}
	if _, err := inspect(dir, small); err == nil {
		t.Fatal("want an error past MaxBytes")
	}
	if _, err := inspect(dir, Limits{MaxBytes: 1 << 20, MaxFiles: 1}); err == nil {
		t.Fatal("want an error past MaxFiles")
	}
}

func TestDescriptionFoldsABlockScalar(t *testing.T) {
	// Most skills in this fleet spell description as a `|` block over several
	// lines; a row is one line, so it folds.
	body := "---\nname: x\ndescription: |\n  First line here.\n  Second line here.\nmetadata: y\n---\nprose\n"
	if got := description([]byte(body)); got != "First line here. Second line here." {
		t.Fatalf("description = %q", got)
	}
	quoted := "---\nname: x\ndescription: \"Quoted one.\"\n---\n"
	if got := description([]byte(quoted)); got != "Quoted one." {
		t.Fatalf("quoted description = %q", got)
	}
	none := "no frontmatter at all\n"
	if got := description([]byte(none)); got != "" {
		t.Fatalf("want no description without frontmatter, got %q", got)
	}
}
