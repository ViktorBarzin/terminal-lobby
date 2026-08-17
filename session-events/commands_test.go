package main

import (
	"os"
	"path/filepath"
	"testing"
)

// A skills/commands tree, written as a map of relative path → contents.
func tree(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for rel, body := range files {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func byName(cmds []Command) map[string]Command {
	m := map[string]Command{}
	for _, c := range cmds {
		m[c.Name] = c
	}
	return m
}

// A skill is a directory with a SKILL.md; typing its name with a slash is how
// the CLI runs it, so that is what the composer has to offer.
func TestDiscoverSkills(t *testing.T) {
	home := tree(t, map[string]string{
		".claude/skills/doc-tone/SKILL.md":     "---\nname: doc-tone\ndescription: A tone-only revision pass\n---\n\nbody\n",
		".claude/skills/publish-page/SKILL.md": "---\nname: publish-page\ndescription: Publish a page\n---\n",
	})
	got := byName(Discover(home, ""))
	if len(got) != 2 {
		t.Fatalf("discovered %d, want 2: %v", len(got), got)
	}
	if c := got["/doc-tone"]; c.Description != "A tone-only revision pass" || c.Source != "skill" {
		t.Errorf("/doc-tone = %+v", c)
	}
}

// The directory name is what the CLI invokes, so a frontmatter `name` that
// disagrees with it must not be what we offer — typing it would not run.
func TestSkillNameComesFromTheDirectory(t *testing.T) {
	home := tree(t, map[string]string{
		".claude/skills/on-disk/SKILL.md": "---\nname: something-else\ndescription: d\n---\n",
		// No frontmatter name at all — one real skill here is written this way.
		".claude/skills/nameless/SKILL.md": "---\ndescription: still offered\n---\n",
	})
	got := byName(Discover(home, ""))
	if _, ok := got["/on-disk"]; !ok {
		t.Errorf("want /on-disk, got %v", keys(got))
	}
	if c, ok := got["/nameless"]; !ok || c.Description != "still offered" {
		t.Errorf("want /nameless with its description, got %+v", c)
	}
}

// `description: |` is the common shape in this fleet's skills. A menu row is one
// line, so the block folds into one.
func TestBlockScalarDescriptionFoldsToOneLine(t *testing.T) {
	home := tree(t, map[string]string{
		".claude/skills/file-issue/SKILL.md": "---\nname: file-issue\ndescription: |\n" +
			"  File a GitHub Issue on the infra repo.\n" +
			"  Use when: (1) User says \"file an issue\",\n" +
			"  (2) User says \"request a feature\".\n" +
			"allowed-tools: Bash\n---\n\nbody\n",
	})
	got := byName(Discover(home, ""))
	want := `File a GitHub Issue on the infra repo. Use when: (1) User says "file an issue", (2) User says "request a feature".`
	if c := got["/file-issue"]; c.Description != want {
		t.Errorf("description =\n %q\nwant\n %q", c.Description, want)
	}
}

func TestQuotedAndFoldedDescriptions(t *testing.T) {
	home := tree(t, map[string]string{
		".claude/skills/q/SKILL.md": "---\nname: q\ndescription: \"quoted: with a colon\"\n---\n",
		".claude/skills/f/SKILL.md": "---\nname: f\ndescription: >\n  folded over\n  two lines\n---\n",
		".claude/skills/s/SKILL.md": "---\nname: s\ndescription: 'single quoted'\n---\n",
	})
	got := byName(Discover(home, ""))
	for name, want := range map[string]string{
		"/q": "quoted: with a colon",
		"/f": "folded over two lines",
		"/s": "single quoted",
	} {
		if got[name].Description != want {
			t.Errorf("%s description = %q, want %q", name, got[name].Description, want)
		}
	}
}

// Personal commands are plain .md files, and a subdirectory namespaces them
// with a colon the same way the CLI does.
func TestDiscoverCommands(t *testing.T) {
	home := tree(t, map[string]string{
		".claude/commands/deploy.md":   "---\ndescription: Ship it\n---\nrun the deploy\n",
		".claude/commands/git/sync.md": "---\ndescription: Sync the fork\n---\n",
		".claude/commands/notes.txt":   "not a command",
	})
	got := byName(Discover(home, ""))
	if c, ok := got["/deploy"]; !ok || c.Description != "Ship it" || c.Source != "command" {
		t.Errorf("/deploy = %+v (all: %v)", c, keys(got))
	}
	if _, ok := got["/git:sync"]; !ok {
		t.Errorf("want /git:sync, got %v", keys(got))
	}
	if _, ok := got["/notes"]; ok {
		t.Error("a .txt is not a command")
	}
}

// A command with no frontmatter still runs, so it is still offered — its first
// line of prose stands in for a description.
func TestCommandWithoutFrontmatter(t *testing.T) {
	home := tree(t, map[string]string{
		".claude/commands/bare.md": "Run the thing and report back.\n\nMore detail here.\n",
	})
	if c := byName(Discover(home, ""))["/bare"]; c.Description != "Run the thing and report back." {
		t.Errorf("/bare = %+v", c)
	}
}

// The session's own directory contributes too, and shadows a personal entry of
// the same name — that is the one the CLI would run.
func TestProjectEntriesShadowPersonalOnes(t *testing.T) {
	home := tree(t, map[string]string{
		".claude/commands/review.md":        "---\ndescription: personal\n---\n",
		".claude/skills/only-home/SKILL.md": "---\ndescription: home\n---\n",
	})
	cwd := tree(t, map[string]string{
		".claude/commands/review.md":        "---\ndescription: project\n---\n",
		".claude/skills/only-proj/SKILL.md": "---\ndescription: proj\n---\n",
	})
	got := byName(Discover(home, cwd))
	if c := got["/review"]; c.Description != "project" || c.Source != "project" {
		t.Errorf("/review = %+v, want the project one", c)
	}
	for _, want := range []string{"/only-home", "/only-proj"} {
		if _, ok := got[want]; !ok {
			t.Errorf("want %s, got %v", want, keys(got))
		}
	}
}

// Only the plugins the user has switched ON, and namespaced the way the CLI
// spells them.
func TestDiscoverEnabledPluginsOnly(t *testing.T) {
	home := tree(t, map[string]string{
		"settings.json": `{"enabledPlugins":{"superpowers@official":true,"off-one@official":false}}`,
		".claude/plugins/cache/official/superpowers/5.1.0/skills/brainstorming/SKILL.md": "---\ndescription: Before creative work\n---\n",
		".claude/plugins/cache/official/superpowers/5.1.0/commands/plan.md":              "---\ndescription: Write a plan\n---\n",
		".claude/plugins/cache/official/off-one/1.0.0/skills/nope/SKILL.md":              "---\ndescription: disabled\n---\n",
	})
	// settings.json lives at ~/.claude/settings.json.
	if err := os.Rename(filepath.Join(home, "settings.json"), filepath.Join(home, ".claude", "settings.json")); err != nil {
		t.Fatal(err)
	}
	got := byName(Discover(home, ""))
	if c, ok := got["/superpowers:brainstorming"]; !ok || c.Source != "plugin" {
		t.Errorf("want /superpowers:brainstorming, got %v", keys(got))
	}
	if _, ok := got["/superpowers:plan"]; !ok {
		t.Errorf("want /superpowers:plan, got %v", keys(got))
	}
	if _, ok := got["/off-one:nope"]; ok {
		t.Error("a disabled plugin must not be offered")
	}
}

// Several versions of a plugin can be cached at once; only the newest is live.
func TestNewestPluginVersionWins(t *testing.T) {
	home := tree(t, map[string]string{
		".claude/settings.json":                              `{"enabledPlugins":{"p@m":true}}`,
		".claude/plugins/cache/m/p/1.0.0/skills/s/SKILL.md":  "---\ndescription: old\n---\n",
		".claude/plugins/cache/m/p/10.0.0/skills/s/SKILL.md": "---\ndescription: new\n---\n",
	})
	if c := byName(Discover(home, ""))["/p:s"]; c.Description != "new" {
		t.Errorf("/p:s = %+v, want the 10.0.0 one", c)
	}
}

// Nothing here is required to exist. A user with no skills, no commands and no
// settings file gets an empty list, not an error.
func TestMissingTreesAreEmptyNotAnError(t *testing.T) {
	if got := Discover(t.TempDir(), t.TempDir()); len(got) != 0 {
		t.Errorf("want none, got %v", got)
	}
	if got := Discover("/nonexistent/nope", ""); len(got) != 0 {
		t.Errorf("want none, got %v", got)
	}
}

// The composer renders these in order, so the order is part of the contract.
func TestSortedByName(t *testing.T) {
	home := tree(t, map[string]string{
		".claude/skills/zebra/SKILL.md": "---\ndescription: z\n---\n",
		".claude/skills/alpha/SKILL.md": "---\ndescription: a\n---\n",
		".claude/commands/mid.md":       "---\ndescription: m\n---\n",
	})
	got := Discover(home, "")
	want := []string{"/alpha", "/mid", "/zebra"}
	for i, w := range want {
		if i >= len(got) || got[i].Name != w {
			t.Fatalf("order = %v, want %v", names(got), want)
		}
	}
}

// A skill directory holding no SKILL.md is not a skill — leaving it in would
// offer a command that does not exist.
func TestDirectoryWithoutSkillFileIsSkipped(t *testing.T) {
	home := tree(t, map[string]string{
		".claude/skills/real/SKILL.md":   "---\ndescription: d\n---\n",
		".claude/skills/empty/README.md": "just notes",
	})
	if got := byName(Discover(home, "")); len(got) != 1 {
		t.Errorf("got %v, want only /real", keys(got))
	}
}

func keys(m map[string]Command) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func names(c []Command) []string {
	out := make([]string, len(c))
	for i := range c {
		out[i] = c[i].Name
	}
	return out
}
