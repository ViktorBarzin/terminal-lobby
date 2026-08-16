package main

import (
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf16"
)

type sessionInfo struct {
	TmuxSession string
	CWD         string
	ClaudeID    string
	Transcript  string
}

// tmuxOptions is the durable store behind sessionMap: a tmux session option,
// read and written as the session's own OS user. Faked in tests.
type tmuxOptions interface {
	// Option reads a session option; "" when unset, ok=false when the session
	// could not be read at all.
	Option(osUser, session, name string) (string, bool)
	SetOption(osUser, session, name, value string) error
}

// transcriptOption is the tmux session option holding the absolute path of the
// Claude transcript being written by the session's Claude.
const transcriptOption = "@claude_transcript"

// sessionMap resolves a tmux session name to its Claude transcript. The
// SessionStart hook supplies the mapping; TMUX ITSELF STORES IT, as a session
// option, because the two lifetimes that matter both belong to tmux and neither
// belongs to this process:
//
//   - It must outlive session-events. Every deploy restarts the service, and
//     while the mapping lived in a Go map each restart answered
//     "404 session not registered" for every Claude already running — the hook
//     only fires at SessionStart, so nothing re-registered a session that was
//     started hours ago and the Text view stayed empty for the rest of its life.
//   - It must NOT outlive the tmux session. Kill a Claude session, start a
//     plain shell under the same name, and a process-lifetime map went on
//     serving the dead conversation. Options die with the session that holds
//     them, so the reused name simply reads back unstamped.
//
// The same reasoning already put @claude_state in tmux (ADR-0001).
//
// The store is writable by the session's own OS user, so a stamp read back is
// untrusted input: only a .jsonl under that user's own projects root is opened.
type sessionMap struct {
	osUser       string
	projectsRoot string // /home/<osUser>/.claude/projects (overridable for tests)
	opts         tmuxOptions
}

func newSessionMap(osUser, projectsRoot string, opts tmuxOptions) *sessionMap {
	return &sessionMap{osUser: osUser, projectsRoot: projectsRoot, opts: opts}
}

// transcriptPath mirrors Claude Code's layout: <root>/<slug of cwd>/<session-id>.jsonl
// e.g. /home/wizard/code/terminal-lobby -> -home-wizard-code-terminal-lobby.
func transcriptPath(root, cwd, claudeID string) string {
	return filepath.Join(root, transcriptSlug(cwd), claudeID+".jsonl")
}

// transcriptSlug is the directory name Claude Code files a cwd's transcripts
// under. It rewrites EVERY character outside [A-Za-z0-9] to '-', not just '/'.
//
// That distinction is the whole point of this function. A cwd containing a dot
// — every worktree under .worktrees/, which is the standing workflow here —
// slugs to a name with a DOUBLED dash, so a slashes-only replacement produced
// a path nothing ever writes. Nothing errors in that state: the tail opens a
// file that is not there and mirrors silence, which is why the Text view was
// simply empty for worktree sessions rather than visibly broken.
//
// Transcribed from claude 2.1.233's own implementation:
//
//	slug = cwd.replace(/[^a-zA-Z0-9]/g, "-")
//	slug.length <= 200 ? slug : slug.slice(0,200) + "-" + hash(cwd)
//	hash(s) = |Σ h = h*31 + utf16unit| as int32, base 36
//
// Verified against the real directories under ~/.claude/projects: none holds a
// character outside [A-Za-z0-9-], and the ones carrying a doubled dash are
// exactly those whose cwd has a leading-dot component.
func transcriptSlug(cwd string) string {
	var b strings.Builder
	b.Grow(len(cwd))
	for i := 0; i < len(cwd); i++ {
		c := cwd[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
			b.WriteByte(c)
		default:
			// A byte at a time, deliberately: JavaScript's replace works on
			// UTF-16 code units, so a multi-byte rune becomes several dashes
			// there too. Counting runes here would produce a shorter name.
			b.WriteByte('-')
		}
	}
	slug := b.String()
	if len(slug) <= transcriptSlugMax {
		return slug
	}
	return slug[:transcriptSlugMax] + "-" + transcriptSlugHash(cwd)
}

// transcriptSlugMax is Claude Code's cap on a project directory name; past it
// the name is truncated and disambiguated with a hash of the full cwd.
const transcriptSlugMax = 200

func transcriptSlugHash(cwd string) string {
	var h int32
	for _, unit := range utf16.Encode([]rune(cwd)) {
		h = h*31 + int32(unit)
	}
	n := int64(h)
	if n < 0 {
		n = -n
	}
	return strconv.FormatInt(n, 36)
}

// withinProjects reports whether path is a transcript inside root. Guards both
// what is stamped and what is read back.
func withinProjects(root, path string) bool {
	if filepath.Ext(path) != ".jsonl" {
		return false
	}
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// put records the mapping by stamping the tmux session. It fails when the
// session cannot be stamped — the caller must not report success then, or the
// hook believes the session is watchable when nothing can resolve it.
func (s *sessionMap) put(info sessionInfo) error {
	path := transcriptPath(s.projectsRoot, info.CWD, info.ClaudeID)
	if !withinProjects(s.projectsRoot, path) {
		return fmt.Errorf("transcript %q escapes %s", path, s.projectsRoot)
	}
	return s.opts.SetOption(s.osUser, info.TmuxSession, transcriptOption, path)
}

func (s *sessionMap) get(tmux string) (sessionInfo, bool) {
	path, ok := s.opts.Option(s.osUser, tmux, transcriptOption)
	if !ok || path == "" || !withinProjects(s.projectsRoot, path) {
		return sessionInfo{}, false
	}
	return sessionInfo{TmuxSession: tmux, Transcript: path}, true
}

type sessionStartBody struct {
	User        string `json:"user"`
	SessionID   string `json:"session_id"`
	CWD         string `json:"cwd"`
	TmuxSession string `json:"tmux_session"`
}
