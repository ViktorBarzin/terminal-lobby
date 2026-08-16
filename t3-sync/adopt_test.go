package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"terminal-lobby/sessionio"
)

// fakeTmux is the syncer's read-only view of a tmux server: the sessions that
// exist, their working directories, and their options.
//
// It implements tmuxSource, which is deliberately narrow — no kill, no rename,
// no send-keys. Every mutation the syncer makes to a session goes through
// tmux-api instead, and a double that cannot express a kill is a double that
// cannot let one slip into a test by accident.
type fakeTmux struct {
	mu       sync.Mutex
	sessions []sessionio.TmuxSession
	options  map[string]map[string]string // session -> option -> value
	listErr  error
}

func newFakeTmux() *fakeTmux {
	return &fakeTmux{options: map[string]map[string]string{}}
}

// start adds a live session with a working directory.
func (f *fakeTmux) start(name, dir string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sessions = append(f.sessions, sessionio.TmuxSession{Name: name, Dir: dir})
	if f.options[name] == nil {
		f.options[name] = map[string]string{}
	}
}

// vanish removes a session the way an OOM does: no notice, no trace, and the
// options go with it.
func (f *fakeTmux) vanish(name string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	kept := f.sessions[:0]
	for _, s := range f.sessions {
		if s.Name != name {
			kept = append(kept, s)
		}
	}
	f.sessions = kept
	delete(f.options, name)
}

func (f *fakeTmux) ListSessions(osUser string) ([]sessionio.TmuxSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.listErr != nil {
		return nil, f.listErr
	}
	out := make([]sessionio.TmuxSession, len(f.sessions))
	copy(out, f.sessions)
	return out, nil
}

func (f *fakeTmux) Option(osUser, session, name string) (string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	opts, ok := f.options[session]
	if !ok {
		return "", false
	}
	return opts[name], true
}

func (f *fakeTmux) SetOption(osUser, session, name, value string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	opts, ok := f.options[session]
	if !ok {
		return os.ErrNotExist
	}
	opts[name] = value
	return nil
}

// harness is one fully-wired syncer with every outside edge faked.
type harness struct {
	t          *testing.T
	cfg        Config
	tmux       *fakeTmux
	t3         *fakeT3Server
	lobby      *fakeTmuxAPI
	client     *Client
	index      *sessionio.Index
	notices    *KillNotices
	adopter    *Adopter
	reconciler *Reconciler
	root       string // the fake /home/<user>/.claude/projects
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	home := t.TempDir()
	root := sessionio.ProjectsRoot(home, "wizard")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatalf("projects root: %v", err)
	}

	t3 := newFakeT3(t)
	lobby := newFakeTmuxAPI(t)
	bin, _ := fakeT3(t)
	bearer := NewBearer("/base/dir", time.Hour)
	bearer.T3Bin = bin

	cfg := Config{
		OSUser:          "wizard",
		HomeDir:         filepath.Join(home, "wizard"),
		BaseDir:         filepath.Join(home, "wizard", ".t3"),
		Endpoint:        t3.URL,
		ProjectsRoot:    root,
		Model:           "claude-opus-5",
		RuntimeMode:     "full-access",
		InteractionMode: defaultInteractionMode,
		IgnorePrefixes:  DefaultIgnorePrefixes,
	}

	h := &harness{
		t:       t,
		cfg:     cfg,
		tmux:    newFakeTmux(),
		t3:      t3,
		lobby:   lobby,
		client:  NewClient(t3.URL, bearer),
		index:   sessionio.NewIndex(filepath.Join(t.TempDir(), "index.json")),
		notices: NewKillNotices("wizard"),
		root:    root,
	}
	h.adopter = &Adopter{Cfg: cfg, Client: h.client, Tmux: h.tmux, Bindings: h.index}
	h.reconciler = &Reconciler{
		Cfg: cfg, Client: h.client, Adopter: h.adopter, Tmux: h.tmux,
		Lobby: NewTmuxAPI(lobby.URL, "alice"), Bindings: h.index, Notices: h.notices,
	}
	return h
}

// startClaude brings up a session that looks exactly like one the SessionStart
// hook has stamped: a live tmux session, a transcript on disk, and
// @claude_transcript pointing at it.
func (h *harness) startClaude(name, cwd, claudeID string) string {
	h.t.Helper()
	path := sessionio.TranscriptPath(h.root, cwd, claudeID)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		h.t.Fatalf("transcript dir: %v", err)
	}
	record := map[string]interface{}{
		"type": "user", "uuid": "u1", "sessionId": claudeID, "cwd": cwd,
		"timestamp": "2026-08-15T12:00:00.000Z",
		"message":   map[string]interface{}{"role": "user", "content": "hello"},
	}
	raw, err := json.Marshal(record)
	if err != nil {
		h.t.Fatalf("marshal record: %v", err)
	}
	if err := os.WriteFile(path, append(raw, '\n'), 0o600); err != nil {
		h.t.Fatalf("write transcript: %v", err)
	}
	h.tmux.start(name, cwd)
	if err := h.tmux.SetOption("wizard", name, sessionio.OptionTranscript, path); err != nil {
		h.t.Fatalf("stamp transcript: %v", err)
	}
	return path
}

func candidateNames(cands []Candidate) []string {
	out := make([]string, 0, len(cands))
	for _, c := range cands {
		out = append(out, c.TmuxName)
	}
	sort.Strings(out)
	return out
}

func TestCandidatesOnlySessionsRunningAClaude(t *testing.T) {
	h := newHarness(t)
	h.startClaude("feat-header", "/home/wizard/code/terminal-lobby", "aaaaaaaa-1111-4111-8111-111111111111")
	h.startClaude("fix-dates", "/home/wizard/code/infra", "bbbbbbbb-2222-4222-8222-222222222222")
	h.tmux.start("just-a-shell", "/home/wizard") // no @claude_transcript
	h.startClaude("qa-headless-42", "/home/wizard/code/qa", "cccccccc-3333-4333-8333-333333333333")

	// A stamp pointing outside the user's own projects root is untrusted input
	// — the option store is writable by the session's own OS user.
	h.tmux.start("sneaky", "/home/wizard")
	if err := h.tmux.SetOption("wizard", "sneaky", sessionio.OptionTranscript, "/etc/shadow"); err != nil {
		t.Fatalf("stamp: %v", err)
	}

	cands, err := h.adopter.Candidates()
	if err != nil {
		t.Fatalf("Candidates: %v", err)
	}
	got := candidateNames(cands)
	want := []string{"feat-header", "fix-dates"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("Candidates() = %v, want %v", got, want)
	}
	for _, c := range cands {
		if c.ClaudeID == "" || c.Transcript == "" {
			t.Errorf("candidate %+v is missing its identity", c)
		}
	}
}

func TestCandidatesCarryTheThreadStamp(t *testing.T) {
	h := newHarness(t)
	h.startClaude("feat-header", "/home/wizard/code/terminal-lobby", "aaaaaaaa-1111-4111-8111-111111111111")
	if err := h.tmux.SetOption("wizard", "feat-header", sessionio.OptionThread, "thread-9"); err != nil {
		t.Fatalf("stamp: %v", err)
	}

	cands, err := h.adopter.Candidates()
	if err != nil {
		t.Fatalf("Candidates: %v", err)
	}
	if len(cands) != 1 || cands[0].ThreadID != "thread-9" {
		t.Fatalf("Candidates() = %+v, want the @t3_thread stamp carried through", cands)
	}
}

// No tmux server at all is an ordinary state — a user with nothing open — and
// must not read as a broken syncer.
func TestCandidatesWithNoSessions(t *testing.T) {
	h := newHarness(t)
	cands, err := h.adopter.Candidates()
	if err != nil {
		t.Fatalf("Candidates: %v", err)
	}
	if len(cands) != 0 {
		t.Errorf("Candidates() = %v, want none", cands)
	}
}

func TestIgnored(t *testing.T) {
	cases := []struct {
		name string
		want bool
	}{
		{"qa-e2e-1", true},
		{"t3e2e-probe", true},
		{"tlp-t-worktree", true},
		{"feat-header", false},
		{"qa", false}, // a prefix of the prefix is not a match
		{"", false},
		{"my-qa-run", false}, // the prefix has to be at the start
	}
	for _, c := range cases {
		if got := Ignored(c.name, DefaultIgnorePrefixes); got != c.want {
			t.Errorf("Ignored(%q) = %v, want %v", c.name, got, c.want)
		}
	}
	if Ignored("anything", nil) {
		t.Error("an empty ignore list ignored a session")
	}
}

// Filing is longest-prefix over the workspace roots T3 already has, and the
// comparison is by path component: /home/wizard/code/term must not swallow
// /home/wizard/code/terminal-lobby.
func TestFileUnderWorkspaceLongestPrefix(t *testing.T) {
	h := newHarness(t)
	snap := Snapshot{Projects: []Project{
		{ID: "p-home", WorkspaceRoot: "/home/wizard"},
		{ID: "p-code", WorkspaceRoot: "/home/wizard/code"},
		{ID: "p-lobby", WorkspaceRoot: "/home/wizard/code/terminal-lobby"},
		{ID: "p-term", WorkspaceRoot: "/home/wizard/code/term"},
		{ID: "p-dead", WorkspaceRoot: "/home/wizard/code/infra", DeletedAt: "2026-08-15T00:00:00.000Z"},
	}}

	cases := []struct {
		cwd  string
		want string
	}{
		{"/home/wizard/code/terminal-lobby", "p-lobby"},
		{"/home/wizard/code/terminal-lobby/frontend-v2", "p-lobby"},
		{"/home/wizard/code/terminal-lobbyish", "p-code"}, // not a component boundary
		{"/home/wizard/code/other", "p-code"},
		{"/home/wizard/notes", "p-home"},
		{"/home/wizard/code/term/x", "p-term"},
	}
	for _, c := range cases {
		got, err := h.adopter.FileUnderWorkspace(context.Background(), snap, Candidate{CWD: c.cwd})
		if err != nil {
			t.Fatalf("FileUnderWorkspace(%s): %v", c.cwd, err)
		}
		if got != c.want {
			t.Errorf("FileUnderWorkspace(%s) = %q, want %q", c.cwd, got, c.want)
		}
	}

	// A deleted project does not hold its root: T3's "one active project per
	// root" invariant only counts live ones, so a new project is created.
	got, err := h.adopter.FileUnderWorkspace(context.Background(), snap, Candidate{CWD: "/home/wizard/code/infra"})
	if err != nil {
		t.Fatalf("FileUnderWorkspace over a deleted project: %v", err)
	}
	if got == "p-dead" {
		t.Error("filed under a deleted project")
	}
}

// Nothing matches → create a project, and create it at the GIT ROOT rather than
// at the cwd, so every session in one repo lands in one T3 project.
func TestFileUnderWorkspaceCreatesAtTheGitRoot(t *testing.T) {
	h := newHarness(t)
	repo := filepath.Join(t.TempDir(), "myrepo")
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	deep := filepath.Join(repo, "frontend", "src")
	if err := os.MkdirAll(deep, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	id, err := h.adopter.FileUnderWorkspace(context.Background(), Snapshot{}, Candidate{CWD: deep})
	if err != nil {
		t.Fatalf("FileUnderWorkspace: %v", err)
	}
	if !isUUID(id) {
		t.Errorf("new project id %q is not a uuid", id)
	}

	sent := h.t3.dispatched(VerbProjectCreate)
	if len(sent) != 1 {
		t.Fatalf("dispatched %d project.create commands, want 1", len(sent))
	}
	if got := jsonString(sent[0]["workspaceRoot"]); got != repo {
		t.Errorf("workspaceRoot = %q, want the git root %q", got, repo)
	}
	if got := jsonString(sent[0]["title"]); got != "myrepo" {
		t.Errorf("title = %q, want the repo's directory name", got)
	}
	if got := jsonString(sent[0]["projectId"]); got != id {
		t.Errorf("projectId = %q, want the id that was returned (%q)", got, id)
	}
}

// Outside a repo there is no git root, so the cwd itself is the workspace.
func TestFileUnderWorkspaceFallsBackToTheCWD(t *testing.T) {
	h := newHarness(t)
	dir := t.TempDir()

	if _, err := h.adopter.FileUnderWorkspace(context.Background(), Snapshot{}, Candidate{CWD: dir}); err != nil {
		t.Fatalf("FileUnderWorkspace: %v", err)
	}
	sent := h.t3.dispatched(VerbProjectCreate)
	if got := jsonString(sent[0]["workspaceRoot"]); got != dir {
		t.Errorf("workspaceRoot = %q, want the cwd %q", got, dir)
	}
}

// Two syncer passes racing on one directory is the ordinary case, not an error.
// The rejection is opaque (an internal_error 500 that says nothing about why),
// so success is confirmed by re-reading the snapshot rather than by matching a
// message.
func TestFileUnderWorkspaceAcceptsALostRace(t *testing.T) {
	h := newHarness(t)
	dir := t.TempDir()
	winner := `{"snapshotSequence":2,"projects":[{"id":"p-winner","title":"x","workspaceRoot":"` + dir + `","deletedAt":null}],"threads":[],"updatedAt":"2026-08-16T00:00:00.000Z"}`
	h.t3.setDispatch(func(w http.ResponseWriter, body map[string]json.RawMessage, calls int) {
		// Somebody else created the project between our snapshot and our create.
		h.t3.setSnapshot(winner)
		writeJSON(w, http.StatusInternalServerError, dispatchRejectedJSON)
	})

	id, err := h.adopter.FileUnderWorkspace(context.Background(), Snapshot{}, Candidate{CWD: dir})
	if err != nil {
		t.Fatalf("FileUnderWorkspace after losing the race: %v", err)
	}
	if id != "p-winner" {
		t.Errorf("project id = %q, want the winner's p-winner", id)
	}
}

// A rejection that is NOT a lost race stays an error: the syncer must not
// invent a project id it never got.
func TestFileUnderWorkspaceReportsARealFailure(t *testing.T) {
	h := newHarness(t)
	h.t3.setDispatch(func(w http.ResponseWriter, body map[string]json.RawMessage, calls int) {
		writeJSON(w, http.StatusInternalServerError, dispatchRejectedJSON)
	})

	if _, err := h.adopter.FileUnderWorkspace(context.Background(), Snapshot{}, Candidate{CWD: t.TempDir()}); err == nil {
		t.Fatal("FileUnderWorkspace returned nil after a create that never landed")
	}
}

// The whole adoption, end to end: file it, create the thread, stamp both
// bindings, then warm it up.
func TestAdoptEndToEnd(t *testing.T) {
	h := newHarness(t)
	repo := filepath.Join(t.TempDir(), "terminal-lobby")
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	claudeID := "aaaaaaaa-1111-4111-8111-111111111111"
	h.startClaude("feat-header", repo, claudeID)

	cands, err := h.adopter.Candidates()
	if err != nil {
		t.Fatalf("Candidates: %v", err)
	}
	threadID, err := h.adopter.Adopt(context.Background(), cands[0])
	if err != nil {
		t.Fatalf("Adopt: %v", err)
	}
	if !isUUID(threadID) {
		t.Fatalf("thread id %q is not a uuid", threadID)
	}

	// thread.create: titled with the tmux session name (decision 7), filed
	// under the project that was just created.
	created := h.t3.dispatched(VerbThreadCreate)
	if len(created) != 1 {
		t.Fatalf("dispatched %d thread.create commands, want 1", len(created))
	}
	if got := jsonString(created[0]["title"]); got != "feat-header" {
		t.Errorf("title = %q, want the tmux session name", got)
	}
	if got := jsonString(created[0]["threadId"]); got != threadID {
		t.Errorf("threadId = %q, want %q", got, threadID)
	}
	projectID := jsonString(h.t3.dispatched(VerbProjectCreate)[0]["projectId"])
	if got := jsonString(created[0]["projectId"]); got != projectID {
		t.Errorf("projectId = %q, want the new project %q", got, projectID)
	}
	var selection ModelSelection
	if err := json.Unmarshal(created[0]["modelSelection"], &selection); err != nil {
		t.Fatalf("modelSelection: %v", err)
	}
	if selection.InstanceID != InstanceBridged {
		t.Errorf("instanceId = %q, want the bridged instance", selection.InstanceID)
	}

	// The tmux session carries the thread id for as long as it lives…
	if got, _ := h.tmux.Option("wizard", "feat-header", sessionio.OptionThread); got != threadID {
		t.Errorf("@t3_thread = %q, want %q", got, threadID)
	}
	// …and the index carries it for longer than that.
	binding, ok, err := h.index.Get(claudeID)
	if err != nil {
		t.Fatalf("index: %v", err)
	}
	if !ok {
		t.Fatal("no binding was recorded")
	}
	if binding.ThreadID != threadID || binding.TmuxName != "feat-header" || binding.CWD != repo {
		t.Errorf("binding = %+v, want the thread, the name and the cwd", binding)
	}

	// The warm-up turn is what makes T3 spawn the bridge — nothing else can
	// put content into a thread.
	warm := h.t3.dispatched(VerbTurnStart)
	if len(warm) != 1 {
		t.Fatalf("dispatched %d warm-up turns, want 1", len(warm))
	}
	var message struct {
		MessageID   string        `json:"messageId"`
		Role        string        `json:"role"`
		Text        string        `json:"text"`
		Attachments []interface{} `json:"attachments"`
	}
	if err := json.Unmarshal(warm[0]["message"], &message); err != nil {
		t.Fatalf("warm-up message: %v", err)
	}
	// The sentinel carries the conversation it is adopting: T3 mints the
	// thread's provider session id itself, so this is the only way the bridge
	// learns which running session the thread is for.
	if message.Text != SentinelFor(claudeID) {
		t.Errorf("warm-up text = %q, want the sentinel naming %s", message.Text, claudeID)
	}
	if message.Role != "user" || !isUUID(message.MessageID) || message.Attachments == nil {
		t.Errorf("warm-up message = %+v, want a user message with an id and an empty attachment list", message)
	}
	if got := jsonString(warm[0]["threadId"]); got != threadID {
		t.Errorf("warm-up threadId = %q, want %q", got, threadID)
	}
}

// The binding has to be on disk BEFORE the warm-up turn: that turn makes T3
// spawn the bridge, and the bridge resolves its target through the index.
// Writing it afterwards is a race the bridge loses.
func TestAdoptRecordsTheBindingBeforeWarmingUp(t *testing.T) {
	h := newHarness(t)
	claudeID := "aaaaaaaa-1111-4111-8111-111111111111"
	h.startClaude("feat-header", t.TempDir(), claudeID)

	var bindingAtTurnStart sessionio.Binding
	var boundAtTurnStart bool
	h.t3.setDispatch(func(w http.ResponseWriter, body map[string]json.RawMessage, calls int) {
		if jsonString(body["type"]) == VerbTurnStart {
			b, ok, err := h.index.Get(claudeID)
			if err != nil {
				t.Errorf("index read during turn.start: %v", err)
			}
			bindingAtTurnStart, boundAtTurnStart = b, ok
		}
		writeJSON(w, http.StatusOK, `{"sequence":1}`)
	})

	cands, err := h.adopter.Candidates()
	if err != nil {
		t.Fatalf("Candidates: %v", err)
	}
	threadID, err := h.adopter.Adopt(context.Background(), cands[0])
	if err != nil {
		t.Fatalf("Adopt: %v", err)
	}
	if !boundAtTurnStart {
		t.Fatal("the warm-up turn was dispatched before the binding was written")
	}
	if bindingAtTurnStart.ThreadID != threadID {
		t.Errorf("binding at turn.start = %q, want %q", bindingAtTurnStart.ThreadID, threadID)
	}
}

// The cwd that decides filing comes from the transcript when it can: tmux's
// session_path is only where a new window would start, while the transcript's
// `cwd` is where the conversation is actually happening.
func TestAdoptPrefersTheTranscriptCWD(t *testing.T) {
	h := newHarness(t)
	real := filepath.Join(t.TempDir(), "actual-workdir")
	if err := os.MkdirAll(real, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	claudeID := "aaaaaaaa-1111-4111-8111-111111111111"
	// The transcript is filed under the real cwd; tmux still reports /home.
	h.startClaude("feat-header", real, claudeID)
	h.tmux.mu.Lock()
	h.tmux.sessions[0].Dir = "/home/wizard"
	h.tmux.mu.Unlock()

	cands, err := h.adopter.Candidates()
	if err != nil {
		t.Fatalf("Candidates: %v", err)
	}
	if _, err := h.adopter.Adopt(context.Background(), cands[0]); err != nil {
		t.Fatalf("Adopt: %v", err)
	}
	sent := h.t3.dispatched(VerbProjectCreate)
	if len(sent) != 1 {
		t.Fatalf("dispatched %d project.create commands, want 1", len(sent))
	}
	if got := jsonString(sent[0]["workspaceRoot"]); got != real {
		t.Errorf("workspaceRoot = %q, want the transcript's cwd %q", got, real)
	}
}

// The sentinel is one string in two binaries. A drift puts a stray prompt into
// a live session, so it is pinned to the bridge's own source.
func TestSentinelMatchesTheBridge(t *testing.T) {
	raw, err := os.ReadFile("../t3-bridge/attach.go")
	if err != nil {
		t.Fatalf("read the bridge's attach.go: %v", err)
	}
	want := "const SentinelPrompt = " + strconv.Quote(SentinelPrompt)
	if !strings.Contains(string(raw), want) {
		t.Errorf("t3-bridge/attach.go does not declare\n\t%s\nThe two constants must be byte-identical.", want)
	}
}
