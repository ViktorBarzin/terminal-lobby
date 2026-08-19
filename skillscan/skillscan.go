// Package skillscan reads and moves Claude Code skills between the OS users on
// one box.
//
// A skill is a directory under ~/.claude/skills containing a SKILL.md, loaded by
// that user's Claude sessions at start. This package is the whole filesystem
// contract behind the lobby's Skills settings group: what a user has, what a
// peer has, whether two copies of the same name agree, and the copy that makes
// one of them yours. It holds no HTTP and no privilege logic — skills-api owns
// those — so every operation here takes a home directory and runs with whatever
// credentials the caller already has.
//
// Two decisions are worth knowing before reading further.
//
// The hash covers content, relative path, and the executable bit, and nothing
// else. Users on this box have different umasks — the same file is 0664 in
// wizard's home and 0644 in bob's — so hashing the full mode would report every
// shared skill as divergent. Copy normalises modes to 0644/0755 for the same
// reason: a copied skill hashes identically to its source, which is what makes
// "update available" mean the owner changed something rather than that two
// umasks differ.
//
// Excluded paths (.git, node_modules, __pycache__) are excluded everywhere —
// hash, inspect, and copy — so a skill that happens to carry a checkout, as
// claudeception does, still compares and copies as its authored content.
package skillscan

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Limits bound one skill's copyable set. A skill is prose and a few scripts; a
// tree past these is something else that happens to live in the directory, and
// refusing is better than copying it into someone's home.
type Limits struct {
	MaxBytes int64
	MaxFiles int
}

// DefaultLimits are what every exported entry point uses.
var DefaultLimits = Limits{MaxBytes: 5 << 20, MaxFiles: 500}

// excluded directory names, skipped at any depth.
var excluded = map[string]bool{
	".git":         true,
	"node_modules": true,
	"__pycache__":  true,
}

// Root is where a user's skills live. The one place this path is spelled.
func Root(home string) string { return filepath.Join(home, ".claude", "skills") }

// Skill is one skill as the settings panel shows it.
type Skill struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Files       int    `json:"files"`
	Executable  int    `json:"executable"`
	Bytes       int64  `json:"bytes"`
	Hash        string `json:"hash"`
	Enabled     bool   `json:"enabled"`
	// Symlink reports that the ~/.claude/skills entry points elsewhere — bob's
	// provisioned skills point into ~/.agents/skills, and one of wizard's points
	// into a repo. Such a skill is read and copied through the link.
	Symlink bool `json:"symlink,omitempty"`
	// Provenance, present only for a skill installed from another user.
	From        string `json:"from,omitempty"`
	SourceHash  string `json:"sourceHash,omitempty"`
	InstalledAt string `json:"installedAt,omitempty"`
	// LocallyModified reports that this copy no longer matches the hash recorded
	// when it was installed — someone edited it here.
	LocallyModified bool `json:"locallyModified,omitempty"`
}

// Stat is what one skill directory says about itself.
type Stat struct {
	Files       int
	Executable  int
	Bytes       int64
	Hash        string
	Description string
}

var nameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

// ValidName gates every name that reaches the filesystem. Lowercase because
// that is what skill directories are, and bounded because the name arrives from
// an HTTP client: a name that passes cannot traverse, cannot hide, and cannot
// name one of this package's own dot-directories.
func ValidName(name string) error {
	if !nameRe.MatchString(name) {
		return fmt.Errorf("invalid skill name %q", name)
	}
	if name == "." || name == ".." || strings.Contains(name, "/") {
		return fmt.Errorf("invalid skill name %q", name)
	}
	return nil
}

// entry is one member of a skill's copyable set.
type entry struct {
	rel  string // slash-separated, relative to the skill root
	exec bool
	size int64
	link string // symlink target, relative and in-tree; "" for a regular file
}

// walk returns the copyable set of dir, sorted by path, with dir's own symlink
// (if any) already followed. A symlink inside the tree survives only when it
// resolves back inside the tree: a link out of the skill is skipped rather than
// followed, so a copy can never reach a file the skill does not contain.
func walk(dir string, lim Limits) ([]entry, error) {
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(real)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%s is not a directory", dir)
	}

	var out []entry
	var bytesSeen int64
	err = filepath.WalkDir(real, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(real, p)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			if excluded[d.Name()] {
				return fs.SkipDir
			}
			return nil
		}
		if excluded[d.Name()] {
			return nil
		}
		if d.Type()&fs.ModeSymlink != 0 {
			target, err := os.Readlink(p)
			if err != nil {
				return nil // unreadable link: not part of the skill
			}
			abs := target
			if !filepath.IsAbs(abs) {
				abs = filepath.Join(filepath.Dir(p), target)
			}
			resolved, err := filepath.EvalSymlinks(abs)
			if err != nil {
				return nil // dangling: nothing to carry
			}
			if !within(real, resolved) {
				return nil // points out of the skill — skipped, never followed
			}
			out = append(out, entry{rel: rel, link: filepath.ToSlash(target)})
			return nil
		}
		if !d.Type().IsRegular() {
			return nil // sockets, devices, fifos are not skill content
		}
		fi, err := d.Info()
		if err != nil {
			return err
		}
		bytesSeen += fi.Size()
		out = append(out, entry{rel: rel, exec: fi.Mode().Perm()&0o111 != 0, size: fi.Size()})
		if len(out) > lim.MaxFiles {
			return fmt.Errorf("skill has more than %d files", lim.MaxFiles)
		}
		if bytesSeen > lim.MaxBytes {
			return fmt.Errorf("skill is larger than %d bytes", lim.MaxBytes)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].rel < out[j].rel })
	return out, nil
}

// within reports whether path is root or sits under it. Both must be resolved
// already; the separator check keeps /home/wizard-old out of /home/wizard.
func within(root, path string) bool {
	if path == root {
		return true
	}
	return strings.HasPrefix(path, root+string(os.PathSeparator))
}

// hasSkillMd reports whether the set contains the file that makes a directory a
// skill.
func hasSkillMd(set []entry) bool {
	for _, e := range set {
		if e.rel == "SKILL.md" {
			return true
		}
	}
	return false
}

// Hash fingerprints a skill's copyable set: relative path, executable bit, and
// content, in path order. Deliberately blind to the rest of the mode — see the
// package comment.
func Hash(dir string) (string, error) {
	set, err := walk(dir, DefaultLimits)
	if err != nil {
		return "", err
	}
	return hashSet(dir, set)
}

func hashSet(dir string, set []entry) (string, error) {
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	for _, e := range set {
		kind := "-"
		if e.link != "" {
			kind = "l"
		} else if e.exec {
			kind = "x"
		}
		// Length-prefixed so no combination of names and content can collide by
		// running two fields together.
		fmt.Fprintf(h, "%d:%s\n%s\n", len(e.rel), e.rel, kind)
		if e.link != "" {
			fmt.Fprintf(h, "%d:%s\n", len(e.link), e.link)
			continue
		}
		body, err := os.ReadFile(filepath.Join(real, filepath.FromSlash(e.rel)))
		if err != nil {
			return "", err
		}
		fmt.Fprintf(h, "%d:", len(body))
		h.Write(body)
		h.Write([]byte("\n"))
	}
	return "sha256:" + hex.EncodeToString(h.Sum(nil)), nil
}

// Inspect reads one skill directory. It fails for a directory that is not a
// skill, so callers can use it as the test for "is this a skill".
func Inspect(dir string) (Stat, error) { return inspect(dir, DefaultLimits) }

func inspect(dir string, lim Limits) (Stat, error) {
	set, err := walk(dir, lim)
	if err != nil {
		return Stat{}, err
	}
	if !hasSkillMd(set) {
		return Stat{}, fmt.Errorf("%s has no SKILL.md", dir)
	}
	st := Stat{Files: len(set)}
	for _, e := range set {
		if e.exec {
			st.Executable++
		}
		st.Bytes += e.size
	}
	if st.Hash, err = hashSet(dir, set); err != nil {
		return Stat{}, err
	}
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return Stat{}, err
	}
	if body, err := os.ReadFile(filepath.Join(real, "SKILL.md")); err == nil {
		st.Description = description(body)
	}
	return st, nil
}

// description pulls the one-line summary out of a skill's frontmatter.
//
// The frontmatter is YAML but only one key is wanted, and the files in this
// fleet spell it three ways: plain, quoted, and — most of them — as a `|` block
// over several lines. A row is one line, so a block folds into one. This
// mirrors session-events' own describe(); the two cannot share code because
// each service is its own Go module and that one reads slash-command menus
// rather than skill directories.
func description(body []byte) string {
	text := strings.ReplaceAll(string(body), "\r\n", "\n")
	if !strings.HasPrefix(text, "---\n") {
		return ""
	}
	end := strings.Index(text[4:], "\n---")
	if end < 0 {
		return ""
	}
	lines := strings.Split(text[4:4+end], "\n")
	for i, line := range lines {
		if !strings.HasPrefix(line, "description:") {
			continue
		}
		value := strings.TrimSpace(strings.TrimPrefix(line, "description:"))
		if value != "|" && value != ">" && value != "|-" && value != ">-" {
			return strings.Trim(value, `"'`)
		}
		var parts []string
		for _, cont := range lines[i+1:] {
			if strings.TrimSpace(cont) == "" {
				continue
			}
			if !strings.HasPrefix(cont, " ") && !strings.HasPrefix(cont, "\t") {
				break // dedented: the next key
			}
			parts = append(parts, strings.TrimSpace(cont))
		}
		return strings.Join(parts, " ")
	}
	return ""
}

// Scan lists one user's skills, newest state of everything the panel shows: what
// it is, whether it is switched on, where it came from, and whether the local
// copy has drifted from what was installed. A home without a skills directory
// scans empty rather than failing — a user who has never had one is not an
// error condition.
func Scan(home string) ([]Skill, error) {
	root := Root(home)
	dirents, err := os.ReadDir(root)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	enabled, err := enabledMap(home)
	if err != nil {
		return nil, err
	}
	man, err := LoadManifest(home)
	if err != nil {
		return nil, err
	}

	out := make([]Skill, 0, len(dirents))
	for _, d := range dirents {
		name := d.Name()
		if strings.HasPrefix(name, ".") {
			continue // .backup, .manager.json — ours, not skills
		}
		if !d.IsDir() && d.Type()&fs.ModeSymlink == 0 {
			continue
		}
		st, err := inspect(filepath.Join(root, name), DefaultLimits)
		if err != nil {
			continue // not a skill, or unreadable: absent from the list, not fatal
		}
		s := Skill{
			Name:        name,
			Description: st.Description,
			Files:       st.Files,
			Executable:  st.Executable,
			Bytes:       st.Bytes,
			Hash:        st.Hash,
			Enabled:     enabled.on(name + "@skills-dir"),
			Symlink:     d.Type()&fs.ModeSymlink != 0,
		}
		if p, ok := man.Installed[name]; ok {
			s.From, s.SourceHash, s.InstalledAt = p.From, p.SourceHash, p.InstalledAt
			s.LocallyModified = p.SourceHash != "" && p.SourceHash != s.Hash
		}
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// staging is the name a copy assembles under before it is renamed into place.
func staging(dst string) string {
	return dst + ".incoming-" + strconv.Itoa(os.Getpid())
}
