package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"terminal-lobby/skillscan"
)

// withPolicy points the service at a temp policy directory, with body as
// osUser's agents file (none at all when body is empty).
func withPolicy(t *testing.T, osUser, body string) {
	t.Helper()
	dir := t.TempDir()
	old := policyDir
	policyDir = dir
	t.Cleanup(func() { policyDir = old })
	if body == "" {
		return
	}
	if err := os.MkdirAll(filepath.Join(dir, osUser), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, osUser, "agents"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestTheHarnessListComesFromTheUpdatersPolicyFile(t *testing.T) {
	cases := []struct {
		name, body string
		want       []string
		layout     skillscan.Layout
	}{
		{"no file", "", []string{"claude-code"}, skillscan.InClaude},
		{"claude-code alone", "claude-code\n", []string{"claude-code"}, skillscan.InClaude},
		{"both, around comments and blanks", "# harnesses\nclaude-code\n\n  codex\n", []string{"claude-code", "codex"}, skillscan.InAgents},
		{"a malformed name is dropped", "claude-code\ncodex; rm -rf /\nCodex\n", []string{"claude-code"}, skillscan.InClaude},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			withPolicy(t, "alice", c.body)
			if got := harnesses("alice"); !reflect.DeepEqual(got, c.want) {
				t.Errorf("harnesses = %v, want %v", got, c.want)
			}
			if got := layoutFor("alice"); got != c.layout {
				t.Errorf("layoutFor = %v, want %v", got, c.layout)
			}
		})
	}
}

func TestInstallingFromASourceTargetsEveryHarnessInThePolicy(t *testing.T) {
	fakeGitHub(t, []string{"skills/a/SKILL.md"}, map[string]string{}, 200)
	log := withStubInstaller(t)
	withPolicy(t, "alice", "claude-code\ncodex\n")

	out, err := installFromSource(t.TempDir(), "alice", "mattpocock", "skills", "skills", []string{"a"})
	if err != nil {
		t.Fatalf("install: %v (%s)", err, out)
	}
	want := "ARGV=-y skills@latest add mattpocock/skills -s a -a claude-code -a codex -g -y"
	if argv := readLog(t, log); !strings.Contains(argv, want) {
		t.Errorf("argv = %q\nwant it to contain %q", argv, want)
	}
}

// The whole path for a user on the shared layout, through perform: a skill
// installed from a peer lands in ~/.agents/skills with a link beside it, lists
// as an ordinary skill of theirs, and a delete takes both halves.
func TestAnAgentsUsersSkillLivesInAgentsSkillsEndToEnd(t *testing.T) {
	withPolicy(t, "alice", "claude-code\ncodex\n")
	home := t.TempDir()
	src := filepath.Join(t.TempDir(), "tdd")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "SKILL.md"), []byte("---\ndescription: t\n---\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	blobs, st, err := skillscan.Pack(src)
	if err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 9, 25, 18, 0, 0, 0, time.UTC).Format(time.RFC3339)

	if res := perform(opUnpack, "alice", home, request{Name: "tdd", From: "bob", Blobs: blobs, Hash: st.Hash, At: at}); res.Status != 200 {
		t.Fatalf("unpack: %d %s", res.Status, res.Error)
	}
	if fi, err := os.Lstat(filepath.Join(skillscan.AgentsRoot(home), "tdd")); err != nil || !fi.IsDir() {
		t.Fatalf("want the skill in ~/.agents/skills (err %v)", err)
	}
	if fi, err := os.Lstat(filepath.Join(skillscan.Root(home), "tdd")); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("want ~/.claude/skills/tdd to be a link (err %v)", err)
	}

	res := perform(opInventory, "alice", home, request{})
	if res.Status != 200 || len(res.Skills) != 1 || res.Skills[0].Symlink {
		t.Fatalf("inventory = %d %+v, want one ordinary (non-link) skill", res.Status, res.Skills)
	}

	if res := perform(opDelete, "alice", home, request{Name: "tdd"}); res.Status != 200 || res.Deleted == nil || res.Deleted.WasSymlink {
		t.Fatalf("delete = %d %+v", res.Status, res.Deleted)
	}
	for _, p := range []string{filepath.Join(skillscan.AgentsRoot(home), "tdd"), filepath.Join(skillscan.Root(home), "tdd")} {
		if _, err := os.Lstat(p); !os.IsNotExist(err) {
			t.Errorf("%s should be gone after delete", p)
		}
	}
}

// A user without a policy file keeps the original layout: the copy is a real
// directory in ~/.claude/skills and ~/.agents is never touched.
func TestAUserWithoutAPolicyKeepsTheClaudeLayout(t *testing.T) {
	withPolicy(t, "emo", "")
	home := t.TempDir()
	src := filepath.Join(t.TempDir(), "tdd")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "SKILL.md"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	blobs, st, err := skillscan.Pack(src)
	if err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 9, 25, 18, 0, 0, 0, time.UTC).Format(time.RFC3339)
	if res := perform(opUnpack, "emo", home, request{Name: "tdd", From: "bob", Blobs: blobs, Hash: st.Hash, At: at}); res.Status != 200 {
		t.Fatalf("unpack: %d %s", res.Status, res.Error)
	}
	if fi, err := os.Lstat(filepath.Join(skillscan.Root(home), "tdd")); err != nil || !fi.IsDir() {
		t.Fatalf("want a real directory in ~/.claude/skills (err %v)", err)
	}
	if _, err := os.Lstat(skillscan.AgentsRoot(home)); !os.IsNotExist(err) {
		t.Error("~/.agents/skills should not exist for this user")
	}
}
