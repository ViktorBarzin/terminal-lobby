package sessionio

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf16"
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
// <root>/<TranscriptSlug(cwd)>/<session-id>.jsonl.
func TranscriptPath(root, cwd, claudeID string) string {
	return filepath.Join(root, TranscriptSlug(cwd), claudeID+".jsonl")
}

// transcriptSlugMax is Claude Code's cap on a project directory name. Past it
// the slug is truncated and a hash of the ORIGINAL path is appended, so two
// long siblings do not share one directory.
const transcriptSlugMax = 200

// TranscriptSlug is the directory name Claude Code files a cwd's transcripts
// under.
//
// It rewrites EVERY character outside [A-Za-z0-9] to '-', not just '/'. That
// distinction is the whole reason this is its own function: a cwd with a dot in
// it — every worktree under .worktrees/, which is the standing workflow in this
// repo — slugs to a name with a doubled dash, and deriving it with a
// slashes-only replacement produced a path nothing ever writes. Nothing errors
// in that state: the tail simply reads a file that is not there and mirrors
// silence.
//
// Transcribed from claude 2.1.233's own implementation:
//
//	slug = cwd.replace(/[^a-zA-Z0-9]/g, "-")
//	slug.length <= 200 ? slug : slug.slice(0,200) + "-" + hash(cwd)
//	hash(s)  = |Σ h = h*31 + charCode| as int32, base 36
//
// Verified against the 51 real directories under ~/.claude/projects: none
// contains a character outside [A-Za-z0-9-], and the four carrying a doubled
// dash are exactly the four whose cwd has a leading-dot component.
func TranscriptSlug(cwd string) string {
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

// transcriptSlugHash reproduces the hash Claude Code appends to a truncated
// slug: a 32-bit h = h*31 + code accumulator over the path's UTF-16 code units,
// absolute value, base 36.
//
// The absolute value is taken in 64 bits because -2^31 has no int32 negation,
// and JavaScript's Math.abs — working in doubles — answers 2147483648 there.
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

// TranscriptCWD reads the working directory out of a transcript's opening
// records, or "" when it cannot.
//
// It is the answer to "where is this conversation actually happening", and it
// beats tmux's session_path, which is only where a NEW window in that session
// would start: `claude` is routinely run from a subdirectory, and a binding
// filed by the wrong one resurrects the session in the wrong place and files
// the thread under the wrong T3 workspace.
//
// Only the first few lines are read. The cwd is on the first line of every
// transcript Claude Code writes, and a handful of lines of slack covers a
// leading record type that carries none — enough that this never reads a 2.5 MB
// file to answer a question the first line already answered.
func TranscriptCWD(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for i := 0; i < transcriptFirstLines && sc.Scan(); i++ {
		rec, ok := DecodeRecord(sc.Bytes())
		if ok && rec.CWD != "" {
			return rec.CWD
		}
	}
	return ""
}

// transcriptFirstLines bounds how far into a transcript TranscriptCWD looks.
const transcriptFirstLines = 16

// transcriptTailBytes is how much of a transcript's end TranscriptModel reads.
// Enough to hold several assistant records and small enough that doing it once
// per session per adoption is nothing.
const transcriptTailBytes = 64 * 1024

// TranscriptModel is the model the session's Claude last answered with, or ""
// when the transcript says nothing.
//
// It is read from the END rather than the start: a session's model can be
// changed mid-conversation, and what a reader wants to know is what it is
// running now. The read is bounded to the last transcriptTailBytes, so a 2.5 MB
// transcript costs one seek and one 64 KiB read.
//
// The first line of the window is dropped: a seek lands mid-record, and half a
// JSON object decodes to nothing anyway — this only makes that deliberate.
func TranscriptModel(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return ""
	}
	start, partial := int64(0), false
	if info.Size() > transcriptTailBytes {
		start, partial = info.Size()-transcriptTailBytes, true
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return ""
	}
	raw, err := io.ReadAll(f)
	if err != nil {
		return ""
	}
	lines := strings.Split(string(raw), "\n")
	if partial && len(lines) > 0 {
		lines = lines[1:]
	}
	for i := len(lines) - 1; i >= 0; i-- {
		rec, ok := DecodeRecord([]byte(lines[i]))
		if ok && rec.Message.Model != "" {
			return rec.Message.Model
		}
	}
	return ""
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
//
// info.Transcript is the path the HARNESS reports it is writing, and it wins
// when it is there. Deriving the path from the cwd instead assumes Claude Code
// files a session under the directory it is working in; it files it under the
// directory it was STARTED in. An agent that cds — into a worktree, into a
// sub-project — and then re-registers therefore stamped a file that was never
// written, and the Text view tailed nothing for the rest of that session.
// Measured 2026-08-28: 2 of 16 live sessions on this box were in that state.
//
// The cwd derivation stays as the fallback, for a hook older than the field.
func (s *SessionMap) Put(info SessionInfo) error {
	path := info.Transcript
	if path == "" {
		path = TranscriptPath(s.projectsRoot, info.CWD, info.ClaudeID)
	}
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
