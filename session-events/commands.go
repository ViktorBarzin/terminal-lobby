package main

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// What a session can be told to run with a leading slash: the CLI's skills and
// custom commands, the ones this user and this project actually have.
//
// The built-in commands are NOT here. They are the same for everybody and the
// frontend ships them, so the composer can still offer /help and /clear when
// this endpoint is unreachable. What varies per user is what this finds.
//
// The names are the ones the CLI itself invokes, which is why they come from
// the DIRECTORY (or the file) rather than from a frontmatter `name` — a skill
// whose frontmatter disagrees with its directory still runs under the
// directory's name, and offering the other one would type something that does
// nothing.
type Command struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	// "skill" | "command" | "project" | "plugin" — what the composer groups by.
	Source string `json:"source"`
}

// Discover walks the places the CLI reads, for one user's home and one session's
// working directory. Either may be missing or unreadable; that yields fewer
// entries, never an error — an unreachable catalogue must not cost the composer
// its built-ins.
func Discover(home, cwd string) []Command {
	found := map[string]Command{}
	add := func(c Command) {
		if c.Name != "" {
			found[c.Name] = c
		}
	}

	for _, c := range skillsIn(filepath.Join(home, ".claude", "skills"), "", "skill") {
		add(c)
	}
	for _, c := range commandsIn(filepath.Join(home, ".claude", "commands"), "", "command") {
		add(c)
	}
	// Enabled plugins ship both kinds under their own namespace.
	for _, p := range enabledPlugins(home) {
		for _, c := range skillsIn(filepath.Join(p.dir, "skills"), p.name+":", "plugin") {
			add(c)
		}
		for _, c := range commandsIn(filepath.Join(p.dir, "commands"), p.name+":", "plugin") {
			add(c)
		}
	}
	// The project goes on LAST: where a name collides, the session's own
	// directory is the one the CLI would run.
	if cwd != "" {
		for _, c := range skillsIn(filepath.Join(cwd, ".claude", "skills"), "", "project") {
			add(c)
		}
		for _, c := range commandsIn(filepath.Join(cwd, ".claude", "commands"), "", "project") {
			add(c)
		}
	}

	out := make([]Command, 0, len(found))
	for _, c := range found {
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// skillsIn reads <root>/<name>/SKILL.md. A directory without that file is not a
// skill, whatever else it holds.
func skillsIn(root, prefix, source string) []Command {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	var out []Command
	for _, e := range entries {
		if !e.IsDir() && e.Type()&os.ModeSymlink == 0 {
			continue
		}
		body, err := os.ReadFile(filepath.Join(root, e.Name(), "SKILL.md"))
		if err != nil {
			continue
		}
		out = append(out, Command{
			Name:        "/" + prefix + e.Name(),
			Description: describe(body),
			Source:      source,
		})
	}
	return out
}

// commandsIn reads <root>/**/*.md. A subdirectory namespaces with a colon, the
// way the CLI spells `~/.claude/commands/git/sync.md` as `/git:sync`.
func commandsIn(root, prefix, source string) []Command {
	var out []Command
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".md") {
			return nil //nolint:nilerr // an unreadable corner yields fewer entries
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return nil
		}
		name := strings.TrimSuffix(filepath.ToSlash(rel), ".md")
		body, err := os.ReadFile(p)
		if err != nil {
			return nil
		}
		out = append(out, Command{
			Name:        "/" + prefix + strings.ReplaceAll(name, "/", ":"),
			Description: describe(body),
			Source:      source,
		})
		return nil
	})
	return out
}

type plugin struct{ name, dir string }

// enabledPlugins reads ~/.claude/settings.json for the plugins switched ON, and
// resolves each to its newest cached version. A plugin present in the cache but
// not enabled is not offered: typing it would not run.
func enabledPlugins(home string) []plugin {
	var settings struct {
		EnabledPlugins map[string]bool `json:"enabledPlugins"`
	}
	body, err := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
	if err != nil || json.Unmarshal(body, &settings) != nil {
		return nil
	}
	var out []plugin
	for key, on := range settings.EnabledPlugins {
		if !on {
			continue
		}
		name, market, ok := strings.Cut(key, "@")
		if !ok || name == "" || market == "" {
			continue
		}
		dir := newestVersion(filepath.Join(home, ".claude", "plugins", "cache", market, name))
		if dir != "" {
			out = append(out, plugin{name: name, dir: dir})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out
}

// newestVersion picks the highest-numbered subdirectory, so a cache holding both
// 1.0.0 and 10.0.0 resolves to 10.0.0 rather than to whichever sorts later as a
// string. A non-numeric name compares below any numeric one.
func newestVersion(dir string) string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	best, bestKey := "", []int(nil)
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		k := versionKey(e.Name())
		if best == "" || lessVersion(bestKey, k) {
			best, bestKey = filepath.Join(dir, e.Name()), k
		}
	}
	return best
}

func versionKey(s string) []int {
	var out []int
	for _, part := range strings.Split(s, ".") {
		n, err := strconv.Atoi(strings.TrimLeft(part, "v"))
		if err != nil {
			return nil
		}
		out = append(out, n)
	}
	return out
}

func lessVersion(a, b []int) bool {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return len(a) < len(b)
}

// describe pulls a one-line description out of a skill or command file.
//
// The frontmatter is YAML, but only one key is wanted and the files in this
// fleet spell it three ways: plain, quoted, and — most of them — as a `|` block
// spanning several lines. A menu row is one line, so a block folds into one.
// Without frontmatter at all, the first line of prose stands in: such a command
// still runs, and offering it with nothing beside it is worse than offering the
// line its author wrote.
func describe(body []byte) string {
	text := strings.ReplaceAll(string(body), "\r\n", "\n")
	if !strings.HasPrefix(text, "---\n") {
		return firstProseLine(text)
	}
	end := strings.Index(text[4:], "\n---")
	if end < 0 {
		return ""
	}
	lines := strings.Split(text[4:4+end], "\n")
	for i, line := range lines {
		rest, ok := strings.CutPrefix(line, "description:")
		if !ok {
			continue
		}
		rest = strings.TrimSpace(rest)
		if rest == "|" || rest == ">" || rest == "|-" || rest == ">-" {
			return foldBlock(lines[i+1:])
		}
		return unquote(rest)
	}
	return ""
}

// foldBlock joins an indented YAML block scalar into one line, stopping at the
// first line that is no longer part of it (the next key).
func foldBlock(lines []string) string {
	var parts []string
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		if !strings.HasPrefix(line, " ") && !strings.HasPrefix(line, "\t") {
			break // dedented: this is the next frontmatter key
		}
		parts = append(parts, strings.TrimSpace(line))
	}
	return strings.Join(parts, " ")
}

func unquote(s string) string {
	for _, q := range []string{`"`, `'`} {
		if len(s) >= 2 && strings.HasPrefix(s, q) && strings.HasSuffix(s, q) {
			return s[1 : len(s)-1]
		}
	}
	return s
}

func firstProseLine(text string) string {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		return line
	}
	return ""
}

// catalogue is what GET /commands/{session} answers: the slash commands this
// session can be told to run that are NOT built into the CLI.
//
// Registration is required, the same as every other per-session route — the
// session's own working directory is half the answer, and only a registered
// session has one.
func (rg *registry) catalogue(osUser, session string) ([]Command, bool) {
	us := rg.user(osUser)
	us.mu.Lock()
	info, ok := us.sm.Get(session)
	us.mu.Unlock()
	if !ok {
		return nil, false
	}
	// Another user's skills and commands live inside their 0750 home, so the
	// discovery walk has to run as them. An unreachable catalogue costs the
	// composer only its non-built-in entries, so a failure here is logged and
	// answered as "none" rather than failing the request.
	if us.priv != nil {
		cmds, err := us.priv.Catalogue(info.CWD)
		if err != nil {
			log.Printf("catalogue: %s/%s: %v", osUser, session, err)
			return nil, true
		}
		return cmds, true
	}
	return Discover(filepath.Join(rg.homeBase, osUser), info.CWD), true
}
