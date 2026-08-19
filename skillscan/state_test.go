package skillscan

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// --- settings.json: enabledPlugins ------------------------------------------

func TestSetEnabledPreservesEverythingElseAndTheKeyOrder(t *testing.T) {
	// This is the user's live settings.json: hooks, env, permissions, a pinned
	// model. Rewriting it as sorted keys would churn a config nobody asked us to
	// touch, so the writer keeps the original order and only edits its own key.
	home := t.TempDir()
	original := `{
  "env": {
    "MEMORY_API_KEY": "secret",
    "CLAUDE_CODE_EFFORT_LEVEL": "max"
  },
  "model": "opus[1m]",
  "enabledPlugins": {
    "superpowers@claude-plugins-official": true,
    "context7@claude-plugins-official": true
  },
  "hooks": {
    "Stop": [{"hooks": [{"type": "command", "command": "x"}]}]
  }
}
`
	path := filepath.Join(home, ".claude", "settings.json")
	write(t, path, original)

	if err := SetEnabled(home, "superpowers@claude-plugins-official", false); err != nil {
		t.Fatal(err)
	}
	if err := SetEnabled(home, "diagnose@skills-dir", false); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(got)

	keys := []string{`"env"`, `"model"`, `"enabledPlugins"`, `"hooks"`}
	at := -1
	for _, k := range keys {
		i := strings.Index(text, k)
		if i < 0 {
			t.Fatalf("key %s disappeared:\n%s", k, text)
		}
		if i < at {
			t.Fatalf("key %s moved; the original order must hold:\n%s", k, text)
		}
		at = i
	}
	if !strings.Contains(text, `"MEMORY_API_KEY": "secret"`) {
		t.Errorf("nested values were not preserved:\n%s", text)
	}

	var parsed struct {
		EnabledPlugins map[string]bool `json:"enabledPlugins"`
		Model          string          `json:"model"`
	}
	if err := json.Unmarshal(got, &parsed); err != nil {
		t.Fatalf("result is not valid JSON: %v\n%s", err, text)
	}
	if parsed.Model != "opus[1m]" {
		t.Errorf("model = %q", parsed.Model)
	}
	if on, ok := parsed.EnabledPlugins["superpowers@claude-plugins-official"]; !ok || on {
		t.Errorf("superpowers should be present and false, got %v %v", on, ok)
	}
	if on, ok := parsed.EnabledPlugins["context7@claude-plugins-official"]; !ok || !on {
		t.Errorf("context7 should be untouched and true, got %v %v", on, ok)
	}
	if on, ok := parsed.EnabledPlugins["diagnose@skills-dir"]; !ok || on {
		t.Errorf("a new key should be appended as false, got %v %v", on, ok)
	}
}

func TestSetEnabledCreatesTheFileWhenAbsent(t *testing.T) {
	home := t.TempDir()
	if err := SetEnabled(home, "tdd@skills-dir", false); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		EnabledPlugins map[string]bool `json:"enabledPlugins"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed.EnabledPlugins["tdd@skills-dir"] {
		t.Fatal("want tdd@skills-dir disabled")
	}
}

func TestSetEnabledRefusesToTouchAMalformedFile(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, ".claude", "settings.json")
	write(t, path, "{ this is not json")
	if err := SetEnabled(home, "tdd@skills-dir", false); err == nil {
		t.Fatal("want an error rather than a rewrite that loses the user's file")
	}
	body, _ := os.ReadFile(path)
	if string(body) != "{ this is not json" {
		t.Fatal("the original file must be left exactly as it was")
	}
}

// --- .manager.json ----------------------------------------------------------

func TestManifestRoundTripsAndOmitsNothing(t *testing.T) {
	home := t.TempDir()
	at := time.Date(2026, 8, 19, 9, 12, 0, 0, time.UTC)

	m, err := LoadManifest(home)
	if err != nil {
		t.Fatalf("a missing manifest is an empty manifest, not an error: %v", err)
	}
	m.Record("diagnose", "emo", "sha256:abc", at)
	if err := m.Save(home); err != nil {
		t.Fatal(err)
	}

	again, err := LoadManifest(home)
	if err != nil {
		t.Fatal(err)
	}
	p, ok := again.Installed["diagnose"]
	if !ok {
		t.Fatal("provenance did not survive the round trip")
	}
	if p.From != "emo" || p.SourceHash != "sha256:abc" || p.InstalledAt != "2026-08-19T09:12:00Z" {
		t.Fatalf("provenance = %+v", p)
	}
	again.Forget("diagnose")
	if err := again.Save(home); err != nil {
		t.Fatal(err)
	}
	final, _ := LoadManifest(home)
	if _, ok := final.Installed["diagnose"]; ok {
		t.Fatal("Forget did not remove the entry")
	}
}

func TestManifestLivesBesideTheSkillsAndNotInsideOne(t *testing.T) {
	home := t.TempDir()
	m, _ := LoadManifest(home)
	m.Record("x", "emo", "sha256:1", time.Now().UTC())
	if err := m.Save(home); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(Root(home), ".manager.json")); err != nil {
		t.Fatalf("expected the manifest at <skills>/.manager.json: %v", err)
	}
}

// --- Scan -------------------------------------------------------------------

func TestScanClassifiesOwnInstalledDisabledAndModified(t *testing.T) {
	home := t.TempDir()
	root := Root(home)
	skill(t, root, "grilling", map[string]string{"SKILL.md": "---\nname: grilling\ndescription: Grill.\n---\n"})
	installed := skill(t, root, "diagnose", map[string]string{"SKILL.md": "---\nname: diagnose\n---\nv1\n"})
	skill(t, root, "caveman", map[string]string{"SKILL.md": "---\nname: caveman\n---\n"})
	drifted := skill(t, root, "teach", map[string]string{"SKILL.md": "---\nname: teach\n---\nedited\n"})
	// not a skill: no SKILL.md
	skill(t, root, "notaskill", map[string]string{"README.md": "x\n"})

	at := time.Date(2026, 8, 19, 9, 12, 0, 0, time.UTC)
	m, _ := LoadManifest(home)
	m.Record("diagnose", "emo", mustHash(t, installed), at)
	m.Record("teach", "emo", "sha256:stale-on-purpose", at)
	if err := m.Save(home); err != nil {
		t.Fatal(err)
	}
	if err := SetEnabled(home, "caveman@skills-dir", false); err != nil {
		t.Fatal(err)
	}

	got, err := Scan(home)
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]Skill{}
	for _, s := range got {
		by[s.Name] = s
	}
	if _, ok := by["notaskill"]; ok {
		t.Error("a directory without SKILL.md is not a skill")
	}
	if len(got) != 4 {
		t.Fatalf("scanned %d skills, want 4: %+v", len(got), got)
	}
	if s := by["grilling"]; s.From != "" || !s.Enabled || s.Description != "Grill." {
		t.Errorf("own skill misread: %+v", s)
	}
	if s := by["diagnose"]; s.From != "emo" || s.LocallyModified {
		t.Errorf("installed-and-unchanged misread: %+v", s)
	}
	if s := by["caveman"]; s.Enabled {
		t.Errorf("caveman is disabled in settings.json: %+v", s)
	}
	if s := by["teach"]; !s.LocallyModified {
		t.Errorf("a copy whose content no longer matches its recorded source hash is locally modified: %+v", s)
	}
	_ = drifted
	// Sorted by name, so the panel does not reshuffle between polls.
	for i := 1; i < len(got); i++ {
		if got[i-1].Name > got[i].Name {
			t.Fatalf("not sorted: %s before %s", got[i-1].Name, got[i].Name)
		}
	}
}

func TestScanOfAMissingHomeIsEmptyNotAnError(t *testing.T) {
	got, err := Scan(filepath.Join(t.TempDir(), "nobody"))
	if err != nil {
		t.Fatalf("want no error, got %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("want no skills, got %d", len(got))
	}
}

// --- Plugins ----------------------------------------------------------------

func TestPluginsReadInstalledStateAndSpotAStaleVersion(t *testing.T) {
	home := t.TempDir()
	write(t, filepath.Join(home, ".claude", "plugins", "installed_plugins.json"), `{
  "version": 2,
  "plugins": {
    "superpowers@official": [{"scope": "user", "version": "5.1.0", "installPath": "/x"}],
    "context7@official":    [{"scope": "user", "version": "61c059", "installPath": "/y"}]
  }
}`)
	write(t, filepath.Join(home, ".claude", "settings.json"), `{"enabledPlugins": {
  "superpowers@official": true,
  "context7@official": false
}}`)
	write(t, filepath.Join(home, ".claude", "plugins", "marketplaces", "official", ".claude-plugin", "marketplace.json"), `{
  "name": "official",
  "plugins": [
    {"name": "superpowers", "version": "5.3.0", "source": "./plugins/superpowers"},
    {"name": "context7", "source": {"source": "url", "url": "x", "sha": "61c059"}}
  ]
}`)

	got, err := Plugins(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 plugins, got %d: %+v", len(got), got)
	}
	by := map[string]Plugin{}
	for _, p := range got {
		by[p.Name] = p
	}
	sp := by["superpowers"]
	if sp.ID != "superpowers@official" || sp.Version != "5.1.0" || !sp.Enabled {
		t.Errorf("superpowers misread: %+v", sp)
	}
	if sp.Latest != "5.3.0" || !sp.Stale {
		t.Errorf("want superpowers flagged stale at 5.3.0: %+v", sp)
	}
	c7 := by["context7"]
	if c7.Enabled {
		t.Errorf("context7 is disabled: %+v", c7)
	}
	if c7.Stale {
		t.Errorf("context7's installed version matches the marketplace sha; not stale: %+v", c7)
	}
}

func TestPluginsIsEmptyWithoutAClaudeDirectory(t *testing.T) {
	got, err := Plugins(t.TempDir())
	if err != nil {
		t.Fatalf("want no error, got %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("want none, got %+v", got)
	}
}

// --- diff -------------------------------------------------------------------

func TestDiffShowsChangedLinesWithContext(t *testing.T) {
	root := t.TempDir()
	mine := skill(t, root, "mine", map[string]string{"SKILL.md": "alpha\nbeta\ngamma\n"})
	theirs := skill(t, root, "theirs", map[string]string{"SKILL.md": "alpha\nBETA\ngamma\ndelta\n"})
	d, err := Diff(mine, theirs)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"-beta", "+BETA", "+delta"} {
		if !strings.Contains(d, want) {
			t.Errorf("diff missing %q:\n%s", want, d)
		}
	}
	if strings.Contains(d, "-alpha") {
		t.Errorf("unchanged lines must not be marked:\n%s", d)
	}
	same, err := Diff(mine, mine)
	if err != nil {
		t.Fatal(err)
	}
	if same != "" {
		t.Errorf("identical skills produce no diff, got:\n%s", same)
	}
}

func TestCompareClassifiesAPeerSkillAgainstMine(t *testing.T) {
	home := t.TempDir()
	root := Root(home)
	skill(t, root, "tdd", map[string]string{"SKILL.md": "mine\n"})
	skill(t, root, "file-issue", map[string]string{"SKILL.md": "shared\n"})
	peer := t.TempDir()
	skill(t, peer, "tdd", map[string]string{"SKILL.md": "theirs\n"})
	skill(t, peer, "file-issue", map[string]string{"SKILL.md": "shared\n"})
	skill(t, peer, "diagnose", map[string]string{"SKILL.md": "new\n"})

	for name, want := range map[string]Verdict{
		"tdd":        Differs,
		"file-issue": Same,
		"diagnose":   Absent,
	} {
		got, err := Compare(filepath.Join(root, name), filepath.Join(peer, name))
		if err != nil {
			t.Fatalf("Compare(%s): %v", name, err)
		}
		if got != want {
			t.Errorf("Compare(%s) = %s, want %s", name, got, want)
		}
	}
}

func TestPluginsReadAVendoredEntrysOwnPluginJSON(t *testing.T) {
	// Most entries in the marketplace this fleet tracks are in-repo, carrying no
	// version on the entry — the version lives in the plugin directory itself.
	home := t.TempDir()
	write(t, filepath.Join(home, ".claude", "plugins", "installed_plugins.json"),
		`{"plugins": {"code-simplifier@official": [{"scope": "user", "version": "1.0.0"}]}}`)
	mkt := filepath.Join(home, ".claude", "plugins", "marketplaces", "official")
	write(t, filepath.Join(mkt, ".claude-plugin", "marketplace.json"),
		`{"name":"official","plugins":[{"name":"code-simplifier","source":"./plugins/code-simplifier"}]}`)
	write(t, filepath.Join(mkt, "plugins", "code-simplifier", ".claude-plugin", "plugin.json"),
		`{"name":"code-simplifier","version":"2.0.0"}`)

	got, err := Plugins(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Latest != "2.0.0" || !got[0].Stale {
		t.Fatalf("want latest 2.0.0 and stale, got %+v", got)
	}
}

func TestPluginsLeaveAnUnknowableLatestEmpty(t *testing.T) {
	// A url source with no sha advertises nothing a checkout can read, so there is
	// no honest comparison to draw and no badge to show.
	home := t.TempDir()
	write(t, filepath.Join(home, ".claude", "plugins", "installed_plugins.json"),
		`{"plugins": {"superpowers@official": [{"scope": "user", "version": "5.1.0"}]}}`)
	write(t, filepath.Join(home, ".claude", "plugins", "marketplaces", "official", ".claude-plugin", "marketplace.json"),
		`{"name":"official","plugins":[{"name":"superpowers","source":{"source":"url","url":"https://x/y.git"}}]}`)

	got, err := Plugins(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Latest != "" || got[0].Stale {
		t.Fatalf("want no latest and not stale, got %+v", got)
	}
}
