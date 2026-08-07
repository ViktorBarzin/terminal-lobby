package main

import (
	"fmt"
	"path/filepath"
	"strings"
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

// transcriptPath mirrors Claude Code's layout: <root>/<cwd-with-slashes-as-dashes>/<session-id>.jsonl
// e.g. /home/wizard/code/terminal-lobby -> -home-wizard-code-terminal-lobby.
func transcriptPath(root, cwd, claudeID string) string {
	slug := strings.ReplaceAll(cwd, "/", "-")
	return filepath.Join(root, slug, claudeID+".jsonl")
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
