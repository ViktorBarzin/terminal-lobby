package skillscan

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// --- ~/.claude/settings.json : enabledPlugins --------------------------------
//
// Switching a skill or plugin off is Claude Code's own mechanism: the key
// `enabledPlugins` in the user's settings.json, mapping "<name>@skills-dir" or
// "<plugin>@<marketplace>" to a bool. Verified against Claude Code 2.1.235,
// which writes exactly that for `claude plugin disable`.
//
// Two properties matter more than brevity here. The file is the user's live
// config — hooks, env, a pinned model, permissions — so a write preserves every
// key it does not own, byte for byte, in its original order; marshalling a Go
// map would reorder the whole file alphabetically. And a file we cannot parse is
// left exactly as it is: refusing beats rewriting somebody's settings from a
// half-understood parse.

func settingsPath(home string) string { return filepath.Join(home, ".claude", "settings.json") }

// enabled answers whether an id is switched on. Absent means on: that is how
// Claude Code treats a skill directory nobody has disabled.
type enabled map[string]bool

func (e enabled) on(id string) bool {
	v, ok := e[id]
	return !ok || v
}

func enabledMap(home string) (enabled, error) {
	body, err := os.ReadFile(settingsPath(home))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return enabled{}, nil
		}
		return nil, err
	}
	var doc struct {
		EnabledPlugins map[string]bool `json:"enabledPlugins"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, fmt.Errorf("%s: %w", settingsPath(home), err)
	}
	if doc.EnabledPlugins == nil {
		return enabled{}, nil
	}
	return doc.EnabledPlugins, nil
}

// kv is one key of a JSON object with its value's original bytes.
type kv struct {
	key string
	raw json.RawMessage
}

// objectInOrder decodes a JSON object into its keys in file order, keeping each
// value's original bytes so re-emitting is lossless.
func objectInOrder(raw []byte) ([]kv, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return nil, fmt.Errorf("expected a JSON object")
	}
	var out []kv
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key, ok := tok.(string)
		if !ok {
			return nil, fmt.Errorf("expected an object key")
		}
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, err
		}
		out = append(out, kv{key: key, raw: value})
	}
	if _, err := dec.Token(); err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	return out, nil
}

// SetEnabled switches one id on or off in the user's settings.json, creating the
// file if this user has none.
func SetEnabled(home, id string, on bool) error {
	if id == "" || strings.ContainsAny(id, "\n\"") {
		return fmt.Errorf("invalid plugin id %q", id)
	}
	path := settingsPath(home)
	mode := os.FileMode(0o644)
	body, err := os.ReadFile(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		body = []byte("{}")
	case err != nil:
		return err
	default:
		if fi, err := os.Stat(path); err == nil {
			mode = fi.Mode().Perm() // the provisioner keeps this file 0600; keep it that way
		}
	}
	top, err := objectInOrder(body)
	if err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}

	plugins := []kv{}
	found := false
	for _, e := range top {
		if e.key != "enabledPlugins" {
			continue
		}
		found = true
		if plugins, err = objectInOrder(e.raw); err != nil {
			return fmt.Errorf("%s: enabledPlugins: %w", path, err)
		}
	}
	value := json.RawMessage("false")
	if on {
		value = json.RawMessage("true")
	}
	replaced := false
	for i := range plugins {
		if plugins[i].key == id {
			plugins[i].raw, replaced = value, true
		}
	}
	if !replaced {
		plugins = append(plugins, kv{key: id, raw: value})
	}
	rendered := renderEnabledPlugins(plugins)
	if found {
		for i := range top {
			if top[i].key == "enabledPlugins" {
				top[i].raw = rendered
			}
		}
	} else {
		top = append(top, kv{key: "enabledPlugins", raw: rendered})
	}

	return writeTopLevel(path, top, mode)
}

// writeTopLevel re-emits a settings document from its keys in original order,
// each value's own bytes untouched, and refuses to write anything that is not
// valid JSON.
func writeTopLevel(path string, top []kv, mode os.FileMode) error {
	var buf bytes.Buffer
	buf.WriteString("{\n")
	for i, e := range top {
		key, err := json.Marshal(e.key)
		if err != nil {
			return err
		}
		fmt.Fprintf(&buf, "  %s: %s", key, e.raw)
		if i < len(top)-1 {
			buf.WriteString(",")
		}
		buf.WriteString("\n")
	}
	buf.WriteString("}\n")
	if !json.Valid(buf.Bytes()) {
		return fmt.Errorf("%s: refusing to write invalid JSON", path)
	}
	return writeFileAtomic(path, buf.Bytes(), mode)
}

// ClearEnabled removes an id from enabledPlugins entirely, rather than setting it
// to a value. Remove uses it: a leftover "false" would silently disable the skill
// if it were ever installed again, from a marker nobody would think to look for.
// Clearing something that is not there, or in a home with no settings file, is a
// no-op rather than an error.
func ClearEnabled(home, id string) error {
	path := settingsPath(home)
	body, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	mode := os.FileMode(0o644)
	if fi, err := os.Stat(path); err == nil {
		mode = fi.Mode().Perm()
	}
	top, err := objectInOrder(body)
	if err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	var plugins []kv
	found := false
	for _, e := range top {
		if e.key != "enabledPlugins" {
			continue
		}
		found = true
		if plugins, err = objectInOrder(e.raw); err != nil {
			return fmt.Errorf("%s: enabledPlugins: %w", path, err)
		}
	}
	if !found {
		return nil
	}
	kept := make([]kv, 0, len(plugins))
	for _, e := range plugins {
		if e.key != id {
			kept = append(kept, e)
		}
	}
	if len(kept) == len(plugins) {
		return nil // nothing to do; do not rewrite the file for no reason
	}
	for i := range top {
		if top[i].key == "enabledPlugins" {
			top[i].raw = renderEnabledPlugins(kept)
		}
	}
	return writeTopLevel(path, top, mode)
}

func renderEnabledPlugins(plugins []kv) json.RawMessage {
	if len(plugins) == 0 {
		return json.RawMessage("{}")
	}
	var buf bytes.Buffer
	buf.WriteString("{\n")
	for i, e := range plugins {
		key, _ := json.Marshal(e.key)
		fmt.Fprintf(&buf, "    %s: %s", key, e.raw)
		if i < len(plugins)-1 {
			buf.WriteString(",")
		}
		buf.WriteString("\n")
	}
	buf.WriteString("  }")
	return buf.Bytes()
}

// writeFileAtomic replaces a file's contents without ever leaving a truncated
// one behind, and without widening its mode.
func writeFileAtomic(path string, body []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".tmp*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(body); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), mode); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// --- <skills>/.manager.json : provenance -------------------------------------

// Provenance records where an installed skill came from and what it looked like
// at the time, which is what lets the panel distinguish "the owner changed it"
// from "you changed it".
type Provenance struct {
	From        string `json:"from"`
	SourceHash  string `json:"sourceHash"`
	InstalledAt string `json:"installedAt"`
}

// Manifest is the manager's own bookkeeping, kept beside the skills rather than
// inside any of them so no skill's content is altered by installing it.
type Manifest struct {
	Version   int                   `json:"version"`
	Installed map[string]Provenance `json:"installed"`
}

func manifestPath(home string) string { return filepath.Join(Root(home), ".manager.json") }

// LoadManifest reads the manifest. No file is an empty manifest, not an error:
// a user who has installed nothing has nothing recorded.
func LoadManifest(home string) (*Manifest, error) {
	m := &Manifest{Version: 1, Installed: map[string]Provenance{}}
	body, err := os.ReadFile(manifestPath(home))
	if errors.Is(err, fs.ErrNotExist) {
		return m, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(body, m); err != nil {
		return nil, fmt.Errorf("%s: %w", manifestPath(home), err)
	}
	if m.Installed == nil {
		m.Installed = map[string]Provenance{}
	}
	if m.Version == 0 {
		m.Version = 1
	}
	return m, nil
}

func (m *Manifest) Record(name, from, sourceHash string, at time.Time) {
	if m.Installed == nil {
		m.Installed = map[string]Provenance{}
	}
	m.Installed[name] = Provenance{
		From:        from,
		SourceHash:  sourceHash,
		InstalledAt: at.UTC().Format(time.RFC3339),
	}
}

func (m *Manifest) Forget(name string) { delete(m.Installed, name) }

func (m *Manifest) Save(home string) error {
	if err := os.MkdirAll(Root(home), 0o755); err != nil {
		return err
	}
	body, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(manifestPath(home), append(body, '\n'), 0o644)
}

// --- marketplace plugins -----------------------------------------------------

// Plugin is a marketplace-installed bundle. It may ship several skills under its
// own namespace, so the unit that switches on and off is the plugin, not the
// skills inside it.
type Plugin struct {
	ID      string `json:"id"` // "<name>@<marketplace>"
	Name    string `json:"name"`
	Market  string `json:"marketplace"`
	Version string `json:"version"`
	Enabled bool   `json:"enabled"`
	Latest  string `json:"latest,omitempty"`
	Stale   bool   `json:"stale,omitempty"`
}

// Plugins lists what this user has installed from marketplaces, with a stale
// marker where the marketplace checkout advertises something newer. A user with
// no plugins directory has no plugins — not an error.
func Plugins(home string) ([]Plugin, error) {
	body, err := os.ReadFile(filepath.Join(home, ".claude", "plugins", "installed_plugins.json"))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var doc struct {
		Plugins map[string][]struct {
			Scope   string `json:"scope"`
			Version string `json:"version"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, err
	}
	on, err := enabledMap(home)
	if err != nil {
		return nil, err
	}

	latest := map[string]map[string]string{} // marketplace -> plugin -> version
	out := make([]Plugin, 0, len(doc.Plugins))
	for id, installs := range doc.Plugins {
		name, market, ok := strings.Cut(id, "@")
		if !ok || name == "" || market == "" {
			continue
		}
		p := Plugin{ID: id, Name: name, Market: market, Enabled: on.on(id)}
		if len(installs) > 0 {
			p.Version = installs[0].Version
			for _, in := range installs {
				if in.Scope == "user" {
					p.Version = in.Version
					break
				}
			}
		}
		if _, seen := latest[market]; !seen {
			latest[market] = marketplaceVersions(home, market)
		}
		p.Latest = latest[market][name]
		p.Stale = staleVersion(p.Version, p.Latest)
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// marketplaceVersions reads what a marketplace checkout advertises per plugin.
// Three shapes are in use in the marketplace this fleet tracks, and each says
// "latest" differently:
//
//   - an explicit "version" on the entry (gopls-lsp);
//   - an in-repo source, "./plugins/<name>", whose version lives in that
//     directory's own plugin.json (code-simplifier);
//   - a pinned commit under source.sha, which is what an installed
//     url-sourced plugin records as its version.
//
// A url source with no sha (superpowers today) advertises nothing a checkout can
// read, so that plugin simply carries no version to compare against: no stale
// badge, and Update still works, because it re-runs the CLI's own fetch.
func marketplaceVersions(home, market string) map[string]string {
	checkout := filepath.Join(home, ".claude", "plugins", "marketplaces", market)
	body, err := os.ReadFile(filepath.Join(checkout, ".claude-plugin", "marketplace.json"))
	if err != nil {
		return map[string]string{}
	}
	var doc struct {
		Plugins []struct {
			Name    string          `json:"name"`
			Version string          `json:"version"`
			Source  json.RawMessage `json:"source"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return map[string]string{}
	}
	out := make(map[string]string, len(doc.Plugins))
	for _, p := range doc.Plugins {
		v := p.Version
		if v == "" && len(p.Source) > 0 {
			var local string
			var src struct {
				Sha string `json:"sha"`
			}
			switch {
			case json.Unmarshal(p.Source, &local) == nil && strings.HasPrefix(local, "./"):
				v = pluginJSONVersion(filepath.Join(checkout, filepath.FromSlash(local)))
			case json.Unmarshal(p.Source, &src) == nil:
				v = src.Sha
			}
		}
		if v != "" {
			out[p.Name] = v
		}
	}
	return out
}

// pluginJSONVersion reads a vendored plugin's own declared version.
func pluginJSONVersion(dir string) string {
	body, err := os.ReadFile(filepath.Join(dir, ".claude-plugin", "plugin.json"))
	if err != nil {
		return ""
	}
	var doc struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return ""
	}
	return doc.Version
}

// staleVersion compares an installed version against what the marketplace
// advertises. Commit-sourced plugins record a short sha where the manifest
// carries the full one, so a prefix match either way counts as current.
func staleVersion(installed, latest string) bool {
	if installed == "" || latest == "" || installed == latest {
		return false
	}
	return !strings.HasPrefix(latest, installed) && !strings.HasPrefix(installed, latest)
}

// --- comparing two copies ----------------------------------------------------

// Verdict is how a peer's skill stands against the caller's own.
type Verdict string

const (
	// Absent: the caller has nothing by that name — a plain install.
	Absent Verdict = "absent"
	// Same: byte-identical content; there is nothing to do.
	Same Verdict = "same"
	// Differs: same name, different content — show the diff, offer Replace.
	Differs Verdict = "differs"
)

// Compare classifies theirs against mine. Both are skill directory paths.
func Compare(mine, theirs string) (Verdict, error) {
	theirHash, err := Hash(theirs)
	if err != nil {
		return "", err
	}
	myHash, err := Hash(mine)
	if errors.Is(err, fs.ErrNotExist) {
		return Absent, nil
	}
	if err != nil {
		// Anything unreadable on our side is treated as "not comparable", which
		// the panel shows as a collision rather than silently overwriting.
		return Differs, nil
	}
	if myHash == theirHash {
		return Same, nil
	}
	return Differs, nil
}

// Diff renders the SKILL.md difference between two skills, mine first, in the
// familiar -/+ shape. Empty when the files agree.
//
// SKILL.md alone because it is the file that says what a skill does and the one
// worth reading before taking somebody's scripts; the panel reports the rest of
// the tree as counts.
func Diff(mine, theirs string) (string, error) {
	a, err := readSkillMd(mine)
	if err != nil {
		return "", err
	}
	b, err := readSkillMd(theirs)
	if err != nil {
		return "", err
	}
	return DiffText(a, b), nil
}

// DiffText is Diff over two SKILL.md bodies already in hand. skills-api reads
// each side through a separate privileged child, so it holds the text rather
// than two directories it could open itself.
func DiffText(mine, theirs string) string {
	mine = strings.ReplaceAll(mine, "\r\n", "\n")
	theirs = strings.ReplaceAll(theirs, "\r\n", "\n")
	if mine == theirs {
		return ""
	}
	return unified(strings.Split(mine, "\n"), strings.Split(theirs, "\n"), maxDiffLines)
}

// maxDiffLines bounds a diff so one rewritten skill cannot flood a response.
const maxDiffLines = 200

func readSkillMd(dir string) (string, error) {
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return "", err
	}
	body, err := os.ReadFile(filepath.Join(real, "SKILL.md"))
	if err != nil {
		return "", err
	}
	return strings.ReplaceAll(string(body), "\r\n", "\n"), nil
}

// unified emits a -/+/context listing over the longest common subsequence,
// truncated at max lines so one rewritten skill cannot flood a response.
func unified(a, b []string, max int) string {
	lcs := make([][]int, len(a)+1)
	for i := range lcs {
		lcs[i] = make([]int, len(b)+1)
	}
	for i := len(a) - 1; i >= 0; i-- {
		for j := len(b) - 1; j >= 0; j-- {
			if a[i] == b[j] {
				lcs[i][j] = lcs[i+1][j+1] + 1
			} else if lcs[i+1][j] >= lcs[i][j+1] {
				lcs[i][j] = lcs[i+1][j]
			} else {
				lcs[i][j] = lcs[i][j+1]
			}
		}
	}
	var out []string
	i, j := 0, 0
	for i < len(a) && j < len(b) {
		switch {
		case a[i] == b[j]:
			out = append(out, " "+a[i])
			i, j = i+1, j+1
		case lcs[i+1][j] >= lcs[i][j+1]:
			out = append(out, "-"+a[i])
			i++
		default:
			out = append(out, "+"+b[j])
			j++
		}
	}
	for ; i < len(a); i++ {
		out = append(out, "-"+a[i])
	}
	for ; j < len(b); j++ {
		out = append(out, "+"+b[j])
	}
	if len(out) > max {
		out = append(out[:max], fmt.Sprintf("… %d more lines", len(out)-max))
	}
	return strings.Join(out, "\n")
}
