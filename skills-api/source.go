package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"terminal-lobby/skillscan"
)

// Installing a skill or plugin from outside this box.
// See docs/adr/0012-installing-from-a-source-runs-its-installer-as-you.md.
//
// The shape is: one read-only look at the repo decides what is installable and
// whether it is a skill repo, a plugin marketplace, or both; then the ecosystem's
// own installer runs AS THE CALLER to bring it in. Discovery executes nothing.
// The install executes third-party code by design — that is what installing this
// way means, and the ADR says so — so the boundary that matters here is argv:
// a source is parsed into an owner and a repo that match a strict charset, and
// every value is passed as its own argument. Nothing is ever interpolated into a
// shell string.

// Test seams. Production never reassigns these.
var (
	githubAPI = "https://api.github.com"
	githubRaw = "https://raw.githubusercontent.com"
	npxBinary = "/usr/bin/npx"
)

// skillsCLI is the installer for skills. Deliberately @latest (ADR-0012): upstream
// fixes and new source types arrive without a bump, at the cost of the code that
// runs as the caller being whatever the registry serves that moment.
const skillsCLI = "skills@latest"

// installTimeout bounds one install. Measured with a warm npm cache: 3s to list a
// 22-skill repo, 4s to install one skill. A cold cache is dominated by the npm
// download, which is why this is minutes rather than seconds.
const installTimeout = 5 * time.Minute

// inspectTimeout bounds the read-only look at a repo.
const inspectTimeout = 45 * time.Second

// maxDescriptions caps how many SKILL.md files one inspection reads for their
// description. The tree call is one request; descriptions are one each, so a repo
// with hundreds of skills would otherwise turn a click into hundreds of fetches.
// Beyond the cap the names are still listed, without their descriptions.
const maxDescriptions = 60

// knownOwners are the GitHub owners this box already installs from. Being on this
// list is a NOTE in the panel, never a gate — the owner of a repo is weak evidence
// about the code in it (ADR-0012).
var knownOwners = map[string]bool{
	"vercel-labs":    true,
	"mattpocock":     true,
	"anthropics":     true,
	"obra":           true,
	"michael-denyer": true,
	"viktorbarzin":   true,
}

var (
	ownerRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,38}$`)
	repoRe  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`)
)

// normalizeSource turns what a person pastes into an owner and a repo, or refuses.
//
// It accepts the forms people actually paste — owner/repo, the https URL with or
// without .git, an scp-style git@ URL — and nothing else. The charset is the
// boundary: shell metacharacters, whitespace, traversal and non-ASCII all fail it,
// which is what keeps a "source" from becoming a command.
func normalizeSource(in string) (string, string, error) {
	s := strings.TrimSpace(in)
	if s == "" {
		return "", "", fmt.Errorf("give a GitHub repository, as owner/repo")
	}
	for _, prefix := range []string{
		"https://github.com/", "http://github.com/", "github.com/", "git@github.com:",
	} {
		if strings.HasPrefix(s, prefix) {
			s = strings.TrimPrefix(s, prefix)
			break
		}
	}
	s = strings.TrimSuffix(s, ".git")
	s = strings.TrimSuffix(s, "/")

	owner, repo, ok := strings.Cut(s, "/")
	if !ok || !ownerRe.MatchString(owner) || !repoRe.MatchString(repo) {
		return "", "", fmt.Errorf("%q is not a GitHub owner/repo", in)
	}
	return owner, repo, nil
}

// sourceSkill is one installable skill found in a repo.
type sourceSkill struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	Description string `json:"description,omitempty"`
}

// sourcePlugin is one plugin a repo's marketplace manifest offers.
type sourcePlugin struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// sourceInfo is what one read-only look concluded.
type sourceInfo struct {
	Owner string `json:"owner"`
	Repo  string `json:"repo"`
	// Ref is the tree's sha, recorded so provenance names a commit.
	Ref         string         `json:"ref,omitempty"`
	Skills      []sourceSkill  `json:"skills,omitempty"`
	Marketplace string         `json:"marketplace,omitempty"`
	Plugins     []sourcePlugin `json:"plugins,omitempty"`
	KnownOwner  bool           `json:"knownOwner"`
}

// githubToken reads the caller's own GitHub token out of ~/.git-credentials.
//
// With it the tree API allows 5,000 requests/hour for them alone; without it the
// limit is 60/hour PER IP, shared by everyone on this box. Absent is fine — the
// request simply goes out unauthenticated.
func githubToken(home string) string {
	f, err := os.Open(filepath.Join(home, ".git-credentials"))
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		u, err := url.Parse(strings.TrimSpace(sc.Text()))
		if err != nil || u.Host != "github.com" {
			continue
		}
		if pw, ok := u.User.Password(); ok && pw != "" {
			return pw
		}
	}
	return ""
}

// inspectSource looks at a repo once, read-only, and reports what can be
// installed from it. Nothing is executed: this is the step that answers "is this
// indeed a skill" before the installer runs.
func inspectSource(home, owner, repo string) (sourceInfo, error) {
	ctx, cancel := context.WithTimeout(context.Background(), inspectTimeout)
	defer cancel()

	info := sourceInfo{Owner: owner, Repo: repo, KnownOwner: knownOwners[strings.ToLower(owner)]}
	token := githubToken(home)

	tree, sha, err := fetchTree(ctx, owner, repo, token)
	if err != nil {
		return info, err
	}
	info.Ref = sha

	var hasManifest bool
	for _, p := range tree {
		switch {
		case p == manifestPath:
			hasManifest = true
		case p == "SKILL.md":
			// A repo whose root IS the skill takes the repo's name, which is what
			// the CLI installs it as.
			info.Skills = append(info.Skills, sourceSkill{Name: repo, Path: p})
		case strings.HasSuffix(p, "/SKILL.md"):
			info.Skills = append(info.Skills, sourceSkill{
				Name: path.Base(path.Dir(p)),
				Path: p,
			})
		}
	}
	sort.Slice(info.Skills, func(i, j int) bool { return info.Skills[i].Name < info.Skills[j].Name })

	if hasManifest {
		if name, plugins, err := fetchManifest(ctx, owner, repo, token); err == nil {
			info.Marketplace, info.Plugins = name, plugins
		}
	}
	if len(info.Skills) == 0 && info.Marketplace == "" {
		return info, fmt.Errorf("%s/%s has no skills and no plugin manifest", owner, repo)
	}
	describeSkills(ctx, owner, repo, token, info.Skills)
	return info, nil
}

const manifestPath = ".claude-plugin/marketplace.json"

// fetchTree lists a repo's files in one call, and separates the two failures that
// look alike from the outside: a repo that is not there, and this box having used
// up the shared unauthenticated quota.
func fetchTree(ctx context.Context, owner, repo, token string) ([]string, string, error) {
	u := fmt.Sprintf("%s/repos/%s/%s/git/trees/HEAD?recursive=1", githubAPI, owner, repo)
	res, body, err := httpGet(ctx, u, token)
	if err != nil {
		return nil, "", fmt.Errorf("could not reach GitHub: %w", err)
	}
	switch {
	case res.StatusCode == http.StatusNotFound:
		return nil, "", fmt.Errorf("no such repository: %s/%s", owner, repo)
	case res.StatusCode == http.StatusForbidden || res.StatusCode == http.StatusTooManyRequests:
		if res.Header.Get("X-RateLimit-Remaining") == "0" {
			if token == "" {
				return nil, "", fmt.Errorf("GitHub rate limit reached — 60 requests/hour is shared by everyone on this box; a token in ~/.git-credentials raises it")
			}
			return nil, "", fmt.Errorf("GitHub rate limit reached for your token")
		}
		return nil, "", fmt.Errorf("GitHub refused the request for %s/%s", owner, repo)
	case res.StatusCode != http.StatusOK:
		return nil, "", fmt.Errorf("GitHub answered %d for %s/%s", res.StatusCode, owner, repo)
	}
	var doc struct {
		Sha  string `json:"sha"`
		Tree []struct {
			Path string `json:"path"`
			Type string `json:"type"`
		} `json:"tree"`
		Truncated bool `json:"truncated"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, "", fmt.Errorf("could not read GitHub's answer: %w", err)
	}
	paths := make([]string, 0, len(doc.Tree))
	for _, e := range doc.Tree {
		paths = append(paths, e.Path)
	}
	return paths, doc.Sha, nil
}

// fetchManifest reads a marketplace manifest for its name and the plugins it
// offers. The name matters beyond display: it is the half after the @ that
// `claude plugin install <plugin>@<marketplace>` needs.
func fetchManifest(ctx context.Context, owner, repo, token string) (string, []sourcePlugin, error) {
	_, body, err := httpGet(ctx, rawURL(owner, repo, manifestPath), token)
	if err != nil {
		return "", nil, err
	}
	var doc struct {
		Name    string `json:"name"`
		Plugins []struct {
			Name        string `json:"name"`
			Description string `json:"description"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return "", nil, err
	}
	out := make([]sourcePlugin, 0, len(doc.Plugins))
	for _, p := range doc.Plugins {
		if p.Name != "" {
			out = append(out, sourcePlugin{Name: p.Name, Description: p.Description})
		}
	}
	return doc.Name, out, nil
}

// describeSkills fills in each skill's description from its own SKILL.md.
//
// These come from raw.githubusercontent rather than the API, which has no quota of
// its own to spend — so listing a big repo costs one API call and a handful of
// cheap fetches. A description that cannot be read leaves the row without one
// rather than failing the inspection.
func describeSkills(ctx context.Context, owner, repo, token string, skills []sourceSkill) {
	const workers = 8
	sem := make(chan struct{}, workers)
	var wg sync.WaitGroup
	for i := range skills {
		if i >= maxDescriptions {
			break
		}
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			_, body, err := httpGet(ctx, rawURL(owner, repo, skills[i].Path), token)
			if err != nil {
				return
			}
			skills[i].Description = skillscan.Description(body)
		}(i)
	}
	wg.Wait()
}

func rawURL(owner, repo, p string) string {
	return fmt.Sprintf("%s/%s/%s/HEAD/%s", githubRaw, owner, repo, p)
}

// httpGet performs one bounded GET, with the caller's token when they have one.
// Named httpGet, not get: the handler tests already own a `get` helper.
func httpGet(ctx context.Context, u, token string) (*http.Response, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "terminal-lobby-skills-api")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	return res, body, err
}

// installFromSource brings the chosen skills or plugins in, running as the user
// this process already is.
//
// The names are checked against what the repo actually offers before anything
// runs, so the installer is never handed a name the inspection did not find —
// the client's request cannot widen what gets installed.
func installFromSource(home, owner, repo, kind string, names []string) (string, error) {
	if len(names) == 0 {
		return "", fmt.Errorf("nothing selected to install")
	}
	info, err := inspectSource(home, owner, repo)
	if err != nil {
		return "", err
	}
	switch kind {
	case "skills":
		offered := map[string]bool{}
		for _, s := range info.Skills {
			offered[s.Name] = true
		}
		for _, n := range names {
			if !offered[n] {
				return "", fmt.Errorf("%s/%s does not offer a skill called %q", owner, repo, n)
			}
			if err := skillscan.ValidName(n); err != nil {
				return "", err
			}
		}
		return installSkills(home, owner, repo, names)
	case "plugins":
		if info.Marketplace == "" {
			return "", fmt.Errorf("%s/%s is not a plugin marketplace", owner, repo)
		}
		offered := map[string]bool{}
		for _, p := range info.Plugins {
			offered[p.Name] = true
		}
		for _, n := range names {
			if !offered[n] {
				return "", fmt.Errorf("%s does not offer a plugin called %q", info.Marketplace, n)
			}
		}
		return installPlugins(home, owner, repo, info.Marketplace, names)
	}
	return "", fmt.Errorf("unknown install kind %q", kind)
}

// installSkills runs the vercel skills CLI as this user. It writes a real
// directory to ~/.claude/skills/<name>, which is the layout the manager already
// reads, so nothing else has to move afterwards.
func installSkills(home, owner, repo string, names []string) (string, error) {
	args := []string{"-y", skillsCLI, "add", owner + "/" + repo}
	for _, n := range names {
		args = append(args, "-s", n)
	}
	args = append(args, "-a", "claude-code", "-g", "-y")
	return runAsUser(home, npxBinary, args...)
}

// installPlugins registers the marketplace and installs the chosen plugins with
// the CLI that owns that state. Adding a marketplace that is already registered is
// not an error worth failing on — it is the normal case on a second install from
// the same repo.
func installPlugins(home, owner, repo, marketplace string, names []string) (string, error) {
	var out strings.Builder
	add, err := runAsUser(home, claudeBinary(home), "plugin", "marketplace", "add", owner+"/"+repo)
	out.WriteString(add)
	if err != nil && !strings.Contains(strings.ToLower(add), "already") {
		return out.String(), fmt.Errorf("could not add the marketplace: %w", err)
	}
	for _, n := range names {
		one, err := runAsUser(home, claudeBinary(home), "plugin", "install", n+"@"+marketplace, "-y")
		out.WriteString(one)
		if err != nil {
			return out.String(), fmt.Errorf("installing %s: %w", n, err)
		}
	}
	return out.String(), nil
}

// claudeBinary is this user's own CLI, by absolute path where it exists.
func claudeBinary(home string) string {
	p := filepath.Join(home, ".local", "bin", "claude")
	if _, err := exec.LookPath(p); err == nil {
		return p
	}
	if found, err := exec.LookPath("claude"); err == nil {
		return found
	}
	return p
}

// runAsUser executes one command in this process's own identity, with HOME set
// explicitly: sudo -u leaves the caller's HOME in the environment, and both
// installers key off it to decide whose account they are writing to.
func runAsUser(home, bin string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), installTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Env = append(environWithout("HOME"), "HOME="+home)
	cmd.Dir = home
	out, err := cmd.CombinedOutput()
	text := string(out)
	if len(text) > maxOutput {
		text = text[:maxOutput] + "\n… output truncated"
	}
	if err != nil {
		return text, fmt.Errorf("%s failed: %w", filepath.Base(bin), err)
	}
	return text, nil
}
