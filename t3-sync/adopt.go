package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"terminal-lobby/sessionio"
)

// Adoption: making a tmux session that is already running visible in T3 as a
// thread. The session keeps running throughout — adoption creates a view, never
// a second Claude (CONTEXT.md).
//
// The sequence, from the design:
//
//	read the session's name, cwd and transcript uuid
//	project.create if no workspace root matches   (decision 8)
//	thread.create with the tmux name as the title (decision 7)
//	stamp @t3_thread on the session, and record the binding durably
//	thread.turn.start with the sentinel            (decision 11)
//	  → T3 spawns the bridge, which swallows the sentinel and replays

// tmuxSource is the syncer's view of the user's tmux server: read the sessions,
// read and write their options. *sessionio.Injector satisfies it.
//
// Deliberately narrow. The syncer never kills, renames or types into a session
// directly — those go through tmux-api (tmuxapi.go), which is the lobby's own
// writer of record and the only thing that knows how to tell the rest of the
// lobby what happened. An interface that cannot express a kill cannot let one
// slip in by accident.
type tmuxSource interface {
	ListSessions(osUser string) ([]sessionio.TmuxSession, error)
	Option(osUser, session, name string) (string, bool)
	SetOption(osUser, session, name, value string) error
}

// Candidate is a tmux session the reconciler is considering adopting.
type Candidate struct {
	// TmuxName is the session, and becomes the thread's title.
	TmuxName string
	// CWD is where it is working — the input to workspace filing.
	CWD string
	// ClaudeID is the Claude session uuid, read from the transcript the
	// @claude_transcript stamp points at (sessionio.ClaudeIDFromTranscript).
	ClaudeID string
	// Transcript is that stamp.
	Transcript string
	// ThreadID is the @t3_thread stamp, "" when nothing has adopted it yet.
	ThreadID string
}

// Adopter turns candidates into threads.
type Adopter struct {
	Cfg      Config
	Client   *Client
	Tmux     tmuxSource
	Bindings *sessionio.Index
}

// Candidates lists the user's live sessions that should be mirrored: every one
// running a Claude, minus the ignore list.
//
// A session qualifies by carrying @claude_transcript — that stamp is what
// "a Claude is running here" means, and it is why a plain shell simply does not
// appear until one starts (decision 4).
//
// The stamp is checked against the user's own projects root before it is
// believed. tmux options are writable by the session's own OS user, so the
// value is untrusted input on the way in, and this syncer reads whatever file
// it names.
func (a *Adopter) Candidates() ([]Candidate, error) {
	sessions, err := a.Tmux.ListSessions(a.Cfg.OSUser)
	if err != nil {
		return nil, fmt.Errorf("list sessions: %w", err)
	}
	var out []Candidate
	for _, s := range sessions {
		if Ignored(s.Name, a.Cfg.IgnorePrefixes) {
			continue
		}
		stamp, ok := a.Tmux.Option(a.Cfg.OSUser, s.Name, sessionio.OptionTranscript)
		if !ok || stamp == "" {
			continue // a plain shell
		}
		if !sessionio.WithinProjects(a.Cfg.ProjectsRoot, stamp) {
			// Not a transcript of this user's, whatever it is. Worth a line: the
			// only ways here are a bug and a deliberate stamp.
			log.Printf("session %s stamps %s outside %s; ignoring it", s.Name, stamp, a.Cfg.ProjectsRoot)
			continue
		}
		claudeID := sessionio.ClaudeIDFromTranscript(stamp)
		if claudeID == "" {
			continue
		}
		thread, _ := a.Tmux.Option(a.Cfg.OSUser, s.Name, sessionio.OptionThread)
		out = append(out, Candidate{
			TmuxName:   s.Name,
			CWD:        candidateCWD(stamp, s.Dir),
			ClaudeID:   claudeID,
			Transcript: stamp,
			ThreadID:   thread,
		})
	}
	return out, nil
}

// candidateCWD is where the conversation is actually happening.
//
// The transcript's own `cwd` wins over tmux's session_path, which is only where
// a NEW window in that session would start: `claude` is routinely run from a
// subdirectory, and filing the thread by the wrong one puts it in the wrong T3
// project (decision 8). tmux's answer is the fallback for a transcript that has
// not been written to yet.
func candidateCWD(transcript, tmuxDir string) string {
	if cwd := transcriptCWD(transcript); cwd != "" {
		return cwd
	}
	return tmuxDir
}

// transcriptFirstLines bounds how far into a transcript the cwd is looked for.
// It is on the first line of every transcript Claude Code writes; a handful of
// lines of slack covers a leading record type that carries none, and stops this
// from reading a 2.5 MB file once per session per tick.
const transcriptFirstLines = 16

// transcriptCWD reads the working directory out of a transcript's opening
// records, or "" when it cannot.
func transcriptCWD(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for i := 0; i < transcriptFirstLines && sc.Scan(); i++ {
		rec, ok := sessionio.DecodeRecord(sc.Bytes())
		if ok && rec.CWD != "" {
			return rec.CWD
		}
	}
	return ""
}

// Adopt files a candidate under a T3 workspace, creates its thread, records the
// binding on both sides, and dispatches the warm-up turn.
//
// The ordering constraint is real: the warm-up turn makes T3 spawn the bridge,
// and the bridge resolves its target through the binding. Writing the binding
// afterwards is a race the bridge loses.
func (a *Adopter) Adopt(ctx context.Context, c Candidate) (string, error) {
	if c.ClaudeID == "" || c.TmuxName == "" {
		return "", fmt.Errorf("adopt: incomplete candidate %+v", c)
	}
	snap, err := a.Client.Snapshot(ctx)
	if err != nil {
		return "", fmt.Errorf("adopt %s: %w", c.TmuxName, err)
	}
	projectID, err := a.FileUnderWorkspace(ctx, snap, c)
	if err != nil {
		return "", fmt.Errorf("adopt %s: %w", c.TmuxName, err)
	}

	threadID, err := newUUID()
	if err != nil {
		return "", fmt.Errorf("adopt %s: %w", c.TmuxName, err)
	}
	create, err := json.Marshal(threadCreate{
		ThreadID:  threadID,
		ProjectID: projectID,
		Title:     c.TmuxName,
		ModelSelection: ModelSelection{
			InstanceID: InstanceBridged,
			Model:      a.Cfg.Model,
		},
		RuntimeMode: a.Cfg.RuntimeMode,
		// Both are NullOr rather than optional in T3's schema, so the keys are
		// required and the values are null: this thread is not a worktree.
		Branch:       nil,
		WorktreePath: nil,
	})
	if err != nil {
		return "", fmt.Errorf("adopt %s: %w", c.TmuxName, err)
	}
	if _, err := a.Client.Dispatch(ctx, VerbThreadCreate, create); err != nil {
		return "", fmt.Errorf("adopt %s: %w", c.TmuxName, err)
	}

	// Both bindings, before the warm-up turn. The tmux option dies with the
	// session, which is what makes a reused name safe; the index outlives it,
	// which is what makes resurrection possible. Neither is optional, but a
	// failure to stamp is not worth abandoning an adoption that has already
	// created the thread — the index alone is enough for the bridge.
	if err := a.Tmux.SetOption(a.Cfg.OSUser, c.TmuxName, sessionio.OptionThread, threadID); err != nil {
		log.Printf("adopt %s: stamping %s failed: %v", c.TmuxName, sessionio.OptionThread, err)
	}
	if err := a.Bindings.Put(c.ClaudeID, sessionio.Binding{
		TmuxName: c.TmuxName,
		CWD:      c.CWD,
		ThreadID: threadID,
	}); err != nil {
		return "", fmt.Errorf("adopt %s: recording the binding: %w", c.TmuxName, err)
	}

	messageID, err := newUUID()
	if err != nil {
		return "", fmt.Errorf("adopt %s: %w", c.TmuxName, err)
	}
	turn, err := json.Marshal(turnStart{
		ThreadID: threadID,
		Message: turnMessage{
			MessageID: messageID,
			Role:      "user",
			Text:      SentinelPrompt,
			// Present and empty: T3's schema declares an array, and a nil slice
			// would marshal to null.
			Attachments: []json.RawMessage{},
		},
		RuntimeMode: a.Cfg.RuntimeMode,
	})
	if err != nil {
		return "", fmt.Errorf("adopt %s: %w", c.TmuxName, err)
	}
	if _, err := a.Client.Dispatch(ctx, VerbTurnStart, turn); err != nil {
		// The thread exists and is bound; only the warm-up failed. Saying so
		// leaves the retry to the next pass, which finds the thread already
		// there and does nothing — the cost is a thread that stays empty until
		// someone types in it.
		return threadID, fmt.Errorf("adopt %s: warm-up turn: %w", c.TmuxName, err)
	}
	return threadID, nil
}

// threadCreate is the thread.create payload (T3's ThreadCreateCommand, minus
// the envelope fields Client.Dispatch adds).
type threadCreate struct {
	ThreadID       string         `json:"threadId"`
	ProjectID      string         `json:"projectId"`
	Title          string         `json:"title"`
	ModelSelection ModelSelection `json:"modelSelection"`
	RuntimeMode    string         `json:"runtimeMode"`
	Branch         *string        `json:"branch"`
	WorktreePath   *string        `json:"worktreePath"`
}

// projectCreate is the project.create payload.
type projectCreate struct {
	ProjectID     string `json:"projectId"`
	Title         string `json:"title"`
	WorkspaceRoot string `json:"workspaceRoot"`
}

// turnStart is the thread.turn.start payload.
type turnStart struct {
	ThreadID    string      `json:"threadId"`
	Message     turnMessage `json:"message"`
	RuntimeMode string      `json:"runtimeMode,omitempty"`
}

// turnMessage is the user message a turn carries.
type turnMessage struct {
	MessageID   string            `json:"messageId"`
	Role        string            `json:"role"`
	Text        string            `json:"text"`
	Attachments []json.RawMessage `json:"attachments"`
}

// FileUnderWorkspace picks the T3 project a candidate belongs to: the longest
// workspace root that prefixes its cwd, or a new project at the git root when
// nothing matches (decision 8).
func (a *Adopter) FileUnderWorkspace(ctx context.Context, snap Snapshot, c Candidate) (string, error) {
	if id, ok := projectForPath(snap, c.CWD); ok {
		return id, nil
	}
	root := workspaceRootFor(c.CWD)
	return a.createProject(ctx, root)
}

// projectForPath returns the live project whose workspace root is the longest
// one containing dir.
//
// The comparison is by PATH COMPONENT, not by string prefix: /home/wizard/code
// contains /home/wizard/code/terminal-lobby, and does not contain
// /home/wizard/codex. A deleted project holds no root — T3's "one active
// project per root" invariant counts live ones only, so a session under a
// deleted project's directory gets a new project rather than a dead one.
func projectForPath(snap Snapshot, dir string) (string, bool) {
	dir = filepath.Clean(dir)
	best, bestLen := "", -1
	for _, p := range snap.Projects {
		if p.Deleted() || p.WorkspaceRoot == "" {
			continue
		}
		root := filepath.Clean(p.WorkspaceRoot)
		if !underRoot(root, dir) {
			continue
		}
		if len(root) > bestLen {
			best, bestLen = p.ID, len(root)
		}
	}
	return best, best != ""
}

// underRoot reports whether dir is root or is inside it.
func underRoot(root, dir string) bool {
	return dir == root || strings.HasPrefix(dir, strings.TrimSuffix(root, "/")+"/")
}

// workspaceRootFor is where a new project should be filed: the git root above
// the session's cwd, so every session in one repo lands in one T3 project, and
// the cwd itself outside a repo.
func workspaceRootFor(dir string) string {
	dir = filepath.Clean(dir)
	for cur := dir; ; {
		if _, err := os.Stat(filepath.Join(cur, ".git")); err == nil {
			return cur
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return dir
		}
		cur = parent
	}
}

// createProject creates the workspace, treating a lost race as success.
//
// Two syncer passes — or a syncer and a human in the T3 UI — creating the same
// project is the ordinary case, and T3 refuses the second with an opaque 500
// that says nothing about why (APIError.DispatchRejected). The only way to tell
// "somebody else got there first" from a real failure is to look: a fresh
// snapshot either shows a live project on that root or it does not.
func (a *Adopter) createProject(ctx context.Context, root string) (string, error) {
	projectID, err := newUUID()
	if err != nil {
		return "", err
	}
	title := filepath.Base(root)
	if title == "/" || title == "." {
		title = root
	}
	payload, err := json.Marshal(projectCreate{
		ProjectID:     projectID,
		Title:         title,
		WorkspaceRoot: root,
	})
	if err != nil {
		return "", err
	}
	if _, err := a.Client.Dispatch(ctx, VerbProjectCreate, payload); err != nil {
		var apiErr *APIError
		if !errors.As(err, &apiErr) || !apiErr.DispatchRejected() {
			return "", err
		}
		snap, snapErr := a.Client.Snapshot(ctx)
		if snapErr != nil {
			return "", fmt.Errorf("%w (and the confirming snapshot failed: %v)", err, snapErr)
		}
		if id, ok := projectForPath(snap, root); ok {
			return id, nil
		}
		return "", err
	}
	return projectID, nil
}

// SentinelPrompt is the warm-up turn's text. It MUST match the bridge's
// constant exactly — the bridge recognises this string and swallows it, and a
// drift between the two puts a stray prompt into a live session.
//
// Duplicated rather than shared because the two binaries are separate modules
// and this one string is not worth a third. CONTRACT.md pins it, and
// TestSentinelMatchesTheBridge is what keeps them from drifting.
const SentinelPrompt = "[terminal-lobby] adopting this session — mirroring its transcript into this thread."
