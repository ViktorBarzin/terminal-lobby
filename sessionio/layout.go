package sessionio

import (
	"fmt"
	"path/filepath"
	"strings"
)

// SessionInfo is what a tmux session name resolves to: the Claude conversation
// running inside it. Transcript is always absolute; CWD and ClaudeID are known
// at registration time and are empty on a read-back, which recovers only the
// path (the stamp is all tmux holds).
type SessionInfo struct {
	TmuxSession string
	CWD         string
	ClaudeID    string
	Transcript  string
}

// ProjectsRoot is a user's Claude transcript root, /home/<user>/.claude/projects.
// homeBase is "/home" everywhere real and a temp dir in tests.
func ProjectsRoot(homeBase, osUser string) string {
	return filepath.Join(homeBase, osUser, ".claude", "projects")
}

// TranscriptPath mirrors Claude Code's layout:
// <root>/<cwd-with-slashes-as-dashes>/<session-id>.jsonl
// e.g. /home/wizard/code/terminal-lobby -> -home-wizard-code-terminal-lobby.
func TranscriptPath(root, cwd, claudeID string) string {
	slug := strings.ReplaceAll(cwd, "/", "-")
	return filepath.Join(root, slug, claudeID+".jsonl")
}

// WithinProjects reports whether path is a transcript inside root. Guards both
// what is stamped and what is read back.
func WithinProjects(root, path string) bool {
	if filepath.Ext(path) != ".jsonl" {
		return false
	}
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// SessionMap resolves a tmux session name to its Claude transcript. The
// SessionStart hook supplies the mapping; TMUX ITSELF STORES IT, as a session
// option, because the two lifetimes that matter both belong to tmux and neither
// belongs to any one process:
//
//   - It must outlive the reader. Every deploy restarts session-events, and
//     while the mapping lived in a Go map each restart answered
//     "404 session not registered" for every Claude already running — the hook
//     only fires at SessionStart, so nothing re-registered a session that was
//     started hours ago and the Text view stayed empty for the rest of its life.
//   - It must NOT outlive the tmux session. Kill a Claude session, start a
//     plain shell under the same name, and a process-lifetime map went on
//     serving the dead conversation. Options die with the session that holds
//     them, so the reused name simply reads back unstamped.
//
// The same reasoning already put @claude_state in tmux (ADR-0001), and it is
// also why the T3 binding index (index.go) is a SEPARATE, durable store: a
// resurrectable session needs one fact to survive the session's death.
//
// The store is writable by the session's own OS user, so a stamp read back is
// untrusted input: only a .jsonl under that user's own projects root is opened.
type SessionMap struct {
	osUser       string
	projectsRoot string // /home/<osUser>/.claude/projects (overridable for tests)
	opts         Options
}

// NewSessionMap binds a map to one OS user's tmux server and projects root.
func NewSessionMap(osUser, projectsRoot string, opts Options) *SessionMap {
	return &SessionMap{osUser: osUser, projectsRoot: projectsRoot, opts: opts}
}

// Root is the projects root this map admits transcripts from.
func (s *SessionMap) Root() string { return s.projectsRoot }

// Put records the mapping by stamping the tmux session. It fails when the
// session cannot be stamped — the caller must not report success then, or the
// hook believes the session is watchable when nothing can resolve it.
func (s *SessionMap) Put(info SessionInfo) error {
	path := TranscriptPath(s.projectsRoot, info.CWD, info.ClaudeID)
	if !WithinProjects(s.projectsRoot, path) {
		return fmt.Errorf("transcript %q escapes %s", path, s.projectsRoot)
	}
	return s.opts.SetOption(s.osUser, info.TmuxSession, OptionTranscript, path)
}

// Get resolves a live tmux session to its transcript. ok=false when the session
// is gone, was never registered, or carries a stamp outside the projects root.
func (s *SessionMap) Get(tmux string) (SessionInfo, bool) {
	path, ok := s.opts.Option(s.osUser, tmux, OptionTranscript)
	if !ok || path == "" || !WithinProjects(s.projectsRoot, path) {
		return SessionInfo{}, false
	}
	return SessionInfo{TmuxSession: tmux, Transcript: path}, true
}

// ClaudeIDFromTranscript recovers the Claude session uuid from a transcript
// path — the file's base name without .jsonl. It is the inverse of the
// TranscriptPath layout for the one component that matters: the uuid is the
// shared identity between a lobby Session and a T3 Thread, and a session
// adopted mid-flight is only known by its stamp.
func ClaudeIDFromTranscript(path string) string {
	return strings.TrimSuffix(filepath.Base(path), ".jsonl")
}
