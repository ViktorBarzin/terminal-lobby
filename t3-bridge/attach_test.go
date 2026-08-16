package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"terminal-lobby/sessionio"
)

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

// attachFakeTmux is a scripted tmux: a set of live sessions with their options,
// plus a log of every verb that was driven at them. It exists so the attach
// path can be exercised with no tmux server, no Claude and no T3 — and so a
// test can assert on what was NOT done, which is most of what matters here.
//
// It deliberately implements KillSession even though TmuxDriver does not name
// it: the fake can then prove the bridge never reached for it, rather than the
// test relying on the interface's silence.
type attachFakeTmux struct {
	mu       sync.Mutex
	sessions map[string]*attachFakeSession

	prompts []attachPrompt
	cancels []string
	created []sessionio.NewSessionSpec
	kills   []string

	promptErr  error
	cancelErr  error
	newErr     error
	readyCalls []string
	readyErr   error
	listErr    error

	// onNew runs inside NewSession, standing in for the SessionStart hook that
	// stamps @claude_transcript once Claude is up.
	onNew func(f *attachFakeTmux, spec sessionio.NewSessionSpec)
}

type attachFakeSession struct {
	dir  string
	opts map[string]string
}

type attachPrompt struct{ session, text string }

func newAttachFakeTmux() *attachFakeTmux {
	return &attachFakeTmux{sessions: map[string]*attachFakeSession{}}
}

func (f *attachFakeTmux) start(name, dir string, opts map[string]string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	cp := map[string]string{}
	for k, v := range opts {
		cp[k] = v
	}
	f.sessions[name] = &attachFakeSession{dir: dir, opts: cp}
}

func (f *attachFakeTmux) Option(_, session, name string) (string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s, ok := f.sessions[session]
	if !ok {
		return "", false
	}
	return s.opts[name], true
}

func (f *attachFakeTmux) SetOption(_, session, name, value string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	s, ok := f.sessions[session]
	if !ok {
		return fmt.Errorf("can't find session: %s", session)
	}
	s.opts[name] = value
	return nil
}

func (f *attachFakeTmux) State(osUser, session string) string {
	v, _ := f.Option(osUser, session, sessionio.OptionState)
	return v
}

func (f *attachFakeTmux) HasSession(_, session string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.sessions[session]
	return ok
}

func (f *attachFakeTmux) ListSessions(string) ([]sessionio.TmuxSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.listErr != nil {
		return nil, f.listErr
	}
	out := make([]sessionio.TmuxSession, 0, len(f.sessions))
	for name, s := range f.sessions {
		out = append(out, sessionio.TmuxSession{Name: name, Dir: s.dir})
	}
	return out, nil
}

// Prompt and Cancel FAIL against a session that is not there, the way tmux does
// now that every target is exact (sessionio.exactPane). A fake that accepted
// them hid the case the bridge cares most about: a session that died under a
// bridge T3 is still holding.
func (f *attachFakeTmux) Prompt(_, session, text string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, live := f.sessions[session]; !live {
		return fmt.Errorf("can't find session: %s", session)
	}
	f.prompts = append(f.prompts, attachPrompt{session, text})
	return f.promptErr
}

func (f *attachFakeTmux) Cancel(_, session string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, live := f.sessions[session]; !live {
		return fmt.Errorf("can't find session: %s", session)
	}
	f.cancels = append(f.cancels, session)
	return f.cancelErr
}

// readyWaits returns the sessions AwaitInputReady was called for.
func (f *attachFakeTmux) readyWaits() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.readyCalls...)
}

// readyCalls records each AwaitInputReady, so a test can assert the resurrect
// path waited for the pane before anything was typed into it.
func (f *attachFakeTmux) AwaitInputReady(ctx context.Context, osUser, session string, wait, poll time.Duration) error {
	f.mu.Lock()
	f.readyCalls = append(f.readyCalls, session)
	err := f.readyErr
	f.mu.Unlock()
	return err
}

func (f *attachFakeTmux) NewSession(spec sessionio.NewSessionSpec) error {
	f.mu.Lock()
	if f.newErr != nil {
		err := f.newErr
		f.mu.Unlock()
		return err
	}
	if _, taken := f.sessions[spec.Name]; taken {
		f.mu.Unlock()
		return fmt.Errorf("duplicate session: %s", spec.Name)
	}
	f.created = append(f.created, spec)
	f.sessions[spec.Name] = &attachFakeSession{dir: spec.Dir, opts: map[string]string{}}
	onNew := f.onNew
	f.mu.Unlock()
	if onNew != nil {
		onNew(f, spec)
	}
	return nil
}

// KillSession is never reachable through TmuxDriver. It is here so a test can
// say so out loud.
func (f *attachFakeTmux) KillSession(_, session string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.kills = append(f.kills, session)
	delete(f.sessions, session)
	return nil
}

func (f *attachFakeTmux) snapshot() ([]attachPrompt, []string, []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]attachPrompt(nil), f.prompts...),
		append([]string(nil), f.cancels...),
		append([]string(nil), f.kills...)
}

var _ TmuxDriver = (*attachFakeTmux)(nil)

// ---------------------------------------------------------------------------
// Transcript helpers
// ---------------------------------------------------------------------------

const attachTestID = "6c420342-1111-2222-3333-444444444444"

// attachTranscript writes a transcript file and returns its path.
func attachTranscript(t *testing.T, dir string, lines ...string) string {
	t.Helper()
	path := filepath.Join(dir, attachTestID+".jsonl")
	attachAppend(t, path, lines...)
	return path
}

func attachAppend(t *testing.T, path string, lines ...string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatalf("open transcript: %v", err)
	}
	defer f.Close()
	for _, l := range lines {
		if _, err := f.WriteString(l + "\n"); err != nil {
			t.Fatalf("write transcript: %v", err)
		}
	}
}

func attachAssistant(uuid, text, stopReason string) string {
	return fmt.Sprintf(`{"type":"assistant","uuid":%q,"sessionId":%q,"timestamp":"2026-08-15T10:00:00Z","message":{"id":"msg_%s","role":"assistant","model":"claude","stop_reason":%q,"content":[{"type":"text","text":%q}]}}`,
		uuid, attachTestID, uuid, stopReason, text)
}

func attachUser(uuid, text string) string {
	return fmt.Sprintf(`{"type":"user","uuid":%q,"sessionId":%q,"timestamp":"2026-08-15T10:00:00Z","message":{"role":"user","content":[{"type":"text","text":%q}]}}`,
		uuid, attachTestID, text)
}

// attachSyncBuf is the encoder's sink. Follow writes frames from its own
// goroutine while the test reads them, so the buffer has to be guarded even
// though the Encoder already serialises its writes.
type attachSyncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *attachSyncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *attachSyncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func (s *attachSyncBuf) Reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.b.Reset()
}

// attachFrames decodes the encoder's buffer into one map per line.
func attachFrames(t *testing.T, buf *attachSyncBuf) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSuffix(buf.String(), "\n"), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("frame %q is not JSON: %v", line, err)
		}
		out = append(out, m)
	}
	return out
}

func attachKinds(frames []map[string]any) []string {
	var out []string
	for _, f := range frames {
		kind, _ := f["type"].(string)
		if sub, ok := f["subtype"].(string); ok && kind == "system" {
			kind += "/" + sub
		}
		out = append(out, kind)
	}
	return out
}

// attachRig is one wired-up attacher over a temp transcript and a fake tmux.
type attachRig struct {
	tmux    *attachFakeTmux
	out     *attachSyncBuf
	cursors *CursorStore
	dir     string
	path    string
}

func newAttachRig(t *testing.T, lines ...string) *attachRig {
	t.Helper()
	dir := t.TempDir()
	r := &attachRig{
		tmux:    newAttachFakeTmux(),
		out:     &attachSyncBuf{},
		cursors: NewCursorStore(filepath.Join(dir, "cursor")),
		dir:     dir,
	}
	r.path = attachTranscript(t, dir, lines...)
	r.tmux.start("feat-header", "/home/wizard/code/terminal-lobby", map[string]string{
		sessionio.OptionTranscript: r.path,
		sessionio.OptionState:      sessionio.StateDone,
	})
	return r
}

func (r *attachRig) attacher() *Attacher {
	return NewAttacher(Target{
		ClaudeID:   attachTestID,
		TmuxName:   "feat-header",
		CWD:        "/home/wizard/code/terminal-lobby",
		Transcript: r.path,
	}, AttacherDeps{
		OSUser:    "wizard",
		Tmux:      r.tmux,
		Out:       NewEncoder(r.out),
		Poll:      5 * time.Millisecond,
		StatePoll: 5 * time.Millisecond,
		Cursors:   r.cursors,
	})
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

// The live lookup is the one that matters: a Claude session uuid is turned into
// a tmux session by reading @claude_transcript off every session the user has
// and matching the file name. Nothing else on the box holds that mapping.
func TestResolveFindsTheLiveSession(t *testing.T) {
	tmux := newAttachFakeTmux()
	tmux.start("unrelated-shell", "/home/wizard", nil)
	tmux.start("other-claude", "/home/wizard/code/infra", map[string]string{
		sessionio.OptionTranscript: "/home/wizard/.claude/projects/-home-wizard-code-infra/aaaaaaaa-1111-2222-3333-444444444444.jsonl",
	})
	tmux.start("feat-header", "/home/wizard/code/terminal-lobby", map[string]string{
		sessionio.OptionTranscript: "/home/wizard/.claude/projects/-home-wizard-code-terminal-lobby/" + attachTestID + ".jsonl",
		sessionio.OptionThread:     "thread-7",
	})

	r := NewSessionResolver("wizard", tmux, OpenBindingsAt(filepath.Join(t.TempDir(), "index.json")))
	target, live, found, err := r.Resolve(attachTestID)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if !found || !live {
		t.Fatalf("found=%v live=%v, want both true", found, live)
	}
	if target.TmuxName != "feat-header" {
		t.Fatalf("TmuxName = %q, want feat-header", target.TmuxName)
	}
	if target.CWD != "/home/wizard/code/terminal-lobby" {
		t.Fatalf("CWD = %q", target.CWD)
	}
	if target.ThreadID != "thread-7" {
		t.Fatalf("ThreadID = %q, want the @t3_thread stamp", target.ThreadID)
	}
	if !strings.HasSuffix(target.Transcript, attachTestID+".jsonl") {
		t.Fatalf("Transcript = %q", target.Transcript)
	}
}

// A live resolve is the only moment both halves of the binding are in hand, so
// it refreshes the durable index — that is what makes the NEXT death
// recoverable, including after a rename in the lobby.
func TestResolveRefreshesTheBinding(t *testing.T) {
	tmux := newAttachFakeTmux()
	tmux.start("renamed-later", "/home/wizard/code/terminal-lobby", map[string]string{
		sessionio.OptionTranscript: "/x/" + attachTestID + ".jsonl",
		sessionio.OptionThread:     "thread-7",
	})
	bindings := OpenBindingsAt(filepath.Join(t.TempDir(), "index.json"))
	if err := bindings.Record(Target{ClaudeID: attachTestID, TmuxName: "old-name", CWD: "/old"}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	if _, _, _, err := NewSessionResolver("wizard", tmux, bindings).Resolve(attachTestID); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	got, ok, err := bindings.Lookup(attachTestID)
	if err != nil || !ok {
		t.Fatalf("Lookup: %v ok=%v", err, ok)
	}
	if got.TmuxName != "renamed-later" || got.ThreadID != "thread-7" {
		t.Fatalf("binding = %+v, want the live facts", got)
	}
}

// No live session but a binding: this is the resurrection case, not a failure.
func TestResolveFallsBackToTheIndex(t *testing.T) {
	tmux := newAttachFakeTmux()
	tmux.start("something-else", "/home/wizard", nil)
	bindings := OpenBindingsAt(filepath.Join(t.TempDir(), "index.json"))
	if err := bindings.Record(Target{
		ClaudeID: attachTestID, TmuxName: "feat-header",
		CWD: "/home/wizard/code/terminal-lobby", ThreadID: "thread-7",
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	target, live, found, err := NewSessionResolver("wizard", tmux, bindings).Resolve(attachTestID)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if !found {
		t.Fatal("found=false, want the durable binding")
	}
	if live {
		t.Fatal("live=true for a session that is not running")
	}
	if target.TmuxName != "feat-header" || target.CWD != "/home/wizard/code/terminal-lobby" {
		t.Fatalf("target = %+v, want the binding's name and cwd", target)
	}
	if target.Transcript != "" {
		t.Fatalf("Transcript = %q, want empty: the session is gone, so nothing is stamped", target.Transcript)
	}
}

// A uuid nothing on the box has heard of: found=false and NO error. T3 carries
// 386 threads, most of which this bridge has never seen.
func TestResolveUnknownIsNotAnError(t *testing.T) {
	tmux := newAttachFakeTmux()
	_, live, found, err := NewSessionResolver("wizard", tmux,
		OpenBindingsAt(filepath.Join(t.TempDir(), "index.json"))).Resolve(attachTestID)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if found || live {
		t.Fatalf("found=%v live=%v, want both false", found, live)
	}
}

// A stamp that names a DIFFERENT conversation must never match. Pasting into
// the wrong session is the failure this check exists to prevent.
func TestResolveRejectsAStampForAnotherSession(t *testing.T) {
	tmux := newAttachFakeTmux()
	tmux.start("feat-header", "/home/wizard/code/terminal-lobby", map[string]string{
		// same directory, same prefix, different uuid
		sessionio.OptionTranscript: "/p/-home-wizard/" + attachTestID + "-extra.jsonl",
	})
	_, _, found, err := NewSessionResolver("wizard", tmux,
		OpenBindingsAt(filepath.Join(t.TempDir(), "index.json"))).Resolve(attachTestID)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if found {
		t.Fatal("a near-miss stamp matched")
	}
}

// No tmux server at all is an ordinary state (a user with nothing open), and
// the index still has to be consulted.
func TestResolveWithNoTmuxServer(t *testing.T) {
	tmux := newAttachFakeTmux()
	bindings := OpenBindingsAt(filepath.Join(t.TempDir(), "index.json"))
	if err := bindings.Record(Target{ClaudeID: attachTestID, TmuxName: "gone", CWD: "/tmp"}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	_, live, found, err := NewSessionResolver("wizard", tmux, bindings).Resolve(attachTestID)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if !found || live {
		t.Fatalf("found=%v live=%v, want found without live", found, live)
	}
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

// Claude Code writes 18 record types into a transcript; two of them are
// conversation. Everything else has to be dropped, or a T3 thread fills with
// malformed messages.
func TestReplayEmitsOnlyConversation(t *testing.T) {
	r := newAttachRig(t,
		attachUser("u-1", "ship it"),
		`{"type":"attachment","uuid":"a-1","sessionId":"`+attachTestID+`"}`,
		attachAssistant("a-2", "on it", "end_turn"),
		`{"type":"last-prompt","uuid":"l-1"}`,
		`{"type":"queue-operation","uuid":"q-1"}`,
		`{"type":"worktree-state","uuid":"w-1"}`,
	)
	a := r.attacher()
	if _, err := a.Replay(context.Background()); err != nil {
		t.Fatalf("Replay: %v", err)
	}
	if got, want := attachKinds(attachFrames(t, r.out)), []string{"user", "assistant"}; !attachEqualStrings(got, want) {
		t.Fatalf("frames = %v, want %v", got, want)
	}
}

// The replay variant of a user message carries isReplay, which is what tells
// T3 these are old words rather than something just said.
func TestReplayMarksUserFramesAsReplay(t *testing.T) {
	r := newAttachRig(t, attachUser("u-1", "ship it"))
	if _, err := r.attacher().Replay(context.Background()); err != nil {
		t.Fatalf("Replay: %v", err)
	}
	frames := attachFrames(t, r.out)
	if len(frames) != 1 {
		t.Fatalf("frames = %v, want one", attachKinds(frames))
	}
	if frames[0]["isReplay"] != true {
		t.Fatalf("user frame = %v, want isReplay true", frames[0])
	}
}

// The cursor's whole purpose. T3 reaps an idle provider session at 30 minutes
// and spawns a fresh bridge on the next touch; the tmux session never stopped
// writing. A second attach must send what is NEW and nothing else.
func TestReplayNeverDuplicatesAcrossAReap(t *testing.T) {
	r := newAttachRig(t, attachUser("u-1", "ship it"), attachAssistant("a-1", "on it", "end_turn"))
	if _, err := r.attacher().Replay(context.Background()); err != nil {
		t.Fatalf("first Replay: %v", err)
	}
	if got := len(attachFrames(t, r.out)); got != 2 {
		t.Fatalf("first replay emitted %d frames, want 2", got)
	}

	// The bridge is reaped and respawned: a brand-new Attacher over the same
	// cursor store, nothing carried in memory.
	r.out.Reset()
	if _, err := r.attacher().Replay(context.Background()); err != nil {
		t.Fatalf("re-attach Replay: %v", err)
	}
	if got := attachFrames(t, r.out); len(got) != 0 {
		t.Fatalf("re-attach re-sent %v", attachKinds(got))
	}

	// The session kept working while no bridge was attached.
	attachAppend(t, r.path, attachUser("u-2", "and again"), attachAssistant("a-2", "done", "end_turn"))
	r.out.Reset()
	if _, err := r.attacher().Replay(context.Background()); err != nil {
		t.Fatalf("third Replay: %v", err)
	}
	frames := attachFrames(t, r.out)
	if len(frames) != 2 {
		t.Fatalf("third replay emitted %v, want only the two new records", attachKinds(frames))
	}
	if frames[0]["uuid"] != "u-2" {
		t.Fatalf("third replay started at %v, want u-2", frames[0]["uuid"])
	}
}

// A transcript shorter than the saved offset is not the file the offset was
// taken from. The record uuid is the anchor that still finds our place.
func TestReplayRecoversFromATruncatedTranscript(t *testing.T) {
	r := newAttachRig(t,
		attachUser("u-1", "ship it"), attachAssistant("a-1", "on it", "tool_use"),
		attachUser("u-2", "and this"), attachAssistant("a-2", "done", "end_turn"))
	if _, err := r.attacher().Replay(context.Background()); err != nil {
		t.Fatalf("first Replay: %v", err)
	}

	// The file comes back SHORTER, still carrying the anchor, plus one record
	// the thread has not seen.
	if err := os.WriteFile(r.path, []byte(attachAssistant("a-2", "done", "end_turn")+"\n"+
		attachAssistant("a-3", "more", "end_turn")+"\n"), 0o600); err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	r.out.Reset()
	if _, err := r.attacher().Replay(context.Background()); err != nil {
		t.Fatalf("second Replay: %v", err)
	}
	frames := attachFrames(t, r.out)
	if len(frames) != 1 || frames[0]["uuid"] != "a-3" {
		t.Fatalf("frames = %v, want only a-3", frames)
	}
}

// A transcript that has lost the anchor entirely cannot be placed. Emitting it
// all would duplicate a conversation into a live thread; the bridge takes the
// silent side and picks the stream up from the end.
func TestReplayWithoutItsAnchorEmitsNothing(t *testing.T) {
	r := newAttachRig(t,
		attachUser("u-1", "ship it"), attachAssistant("a-1", "on it", "tool_use"),
		attachUser("u-2", "and this"), attachAssistant("a-2", "done", "end_turn"))
	if _, err := r.attacher().Replay(context.Background()); err != nil {
		t.Fatalf("first Replay: %v", err)
	}
	if err := os.WriteFile(r.path, []byte(attachAssistant("z-1", "another file", "end_turn")+"\n"), 0o600); err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	r.out.Reset()
	if _, err := r.attacher().Replay(context.Background()); err != nil {
		t.Fatalf("second Replay: %v", err)
	}
	if got := attachFrames(t, r.out); len(got) != 0 {
		t.Fatalf("emitted %v, want nothing", attachKinds(got))
	}
	// …and the cursor now sits at the end, so live work still flows.
	attachAppend(t, r.path, attachAssistant("z-2", "live", "end_turn"))
	r.out.Reset()
	if _, err := r.attacher().Replay(context.Background()); err != nil {
		t.Fatalf("third Replay: %v", err)
	}
	frames := attachFrames(t, r.out)
	if len(frames) != 1 || frames[0]["uuid"] != "z-2" {
		t.Fatalf("frames = %v, want z-2", frames)
	}
}

// A session whose Claude has not written its first line yet is an ordinary
// state at attach time, not a failure.
func TestReplayToleratesAMissingTranscript(t *testing.T) {
	r := newAttachRig(t)
	if err := os.Remove(r.path); err != nil {
		t.Fatalf("remove: %v", err)
	}
	off, err := r.attacher().Replay(context.Background())
	if err != nil {
		t.Fatalf("Replay on a missing transcript: %v", err)
	}
	if off != 0 {
		t.Fatalf("offset = %d, want 0", off)
	}
}

// ---------------------------------------------------------------------------
// Send / Interrupt
// ---------------------------------------------------------------------------

func TestSendPastesIntoThePane(t *testing.T) {
	r := newAttachRig(t)
	if err := r.attacher().Send("do the thing"); err != nil {
		t.Fatalf("Send: %v", err)
	}
	prompts, _, _ := r.tmux.snapshot()
	if len(prompts) != 1 || prompts[0].session != "feat-header" || prompts[0].text != "do the thing" {
		t.Fatalf("prompts = %+v", prompts)
	}
}

// Decision 9: a turn already in flight is not an error. Claude Code queues the
// prompt and it stays visible in the pane, on both surfaces.
func TestSendDoesNotGateOnClaudeState(t *testing.T) {
	for _, state := range []string{sessionio.StateRunning, sessionio.StateAwaiting, sessionio.StateDone, ""} {
		t.Run("state="+state, func(t *testing.T) {
			r := newAttachRig(t)
			if err := r.tmux.SetOption("wizard", "feat-header", sessionio.OptionState, state); err != nil {
				t.Fatalf("seed state: %v", err)
			}
			if err := r.attacher().Send("mid-turn"); err != nil {
				t.Fatalf("Send: %v", err)
			}
			if prompts, _, _ := r.tmux.snapshot(); len(prompts) != 1 {
				t.Fatalf("state %q blocked the prompt: %+v", state, prompts)
			}
		})
	}
}

// Defence in depth. The protocol loop swallows the warm-up turn, but the rule
// that it must never reach a live pane is worth holding in both places.
func TestSendSwallowsTheSentinel(t *testing.T) {
	r := newAttachRig(t, attachAssistant("a-1", "history", "end_turn"))
	if err := r.attacher().Send(SentinelPrompt); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if prompts, _, _ := r.tmux.snapshot(); len(prompts) != 0 {
		t.Fatalf("the sentinel reached the pane: %+v", prompts)
	}
	// It replays what the thread has not seen and closes the turn it opened.
	if got, want := attachKinds(attachFrames(t, r.out)), []string{"assistant", "result"}; !attachEqualStrings(got, want) {
		t.Fatalf("frames = %v, want %v", got, want)
	}
}

func TestInterruptCancelsAndClosesTheTurn(t *testing.T) {
	r := newAttachRig(t)
	a := r.attacher()
	if err := a.Send("long job"); err != nil {
		t.Fatalf("Send: %v", err)
	}
	r.out.Reset()
	if err := a.Interrupt(); err != nil {
		t.Fatalf("Interrupt: %v", err)
	}
	_, cancels, _ := r.tmux.snapshot()
	if len(cancels) != 1 || cancels[0] != "feat-header" {
		t.Fatalf("cancels = %v", cancels)
	}
	// An interrupt landing before the first token leaves NOTHING in the
	// transcript, so whoever injects it owes T3 the closing frame.
	if got, want := attachKinds(attachFrames(t, r.out)), []string{"result"}; !attachEqualStrings(got, want) {
		t.Fatalf("frames = %v, want %v", got, want)
	}
}

// A Stop that could not stop anything must report the failure upward, so the
// protocol loop can answer the control request with an error.
func TestInterruptReportsFailure(t *testing.T) {
	r := newAttachRig(t)
	r.tmux.cancelErr = fmt.Errorf("no such session")
	if err := r.attacher().Interrupt(); err == nil {
		t.Fatal("Interrupt swallowed the failure")
	}
}

// ---------------------------------------------------------------------------
// Follow
// ---------------------------------------------------------------------------

// attachWaitFor polls a condition to a deadline. The transcript tail is a
// poller, so every Follow assertion is "eventually", never "immediately".
func attachWaitFor(t *testing.T, what string, cond func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Errorf("timed out waiting for %s", what)
	return false
}

// attachFollow runs Follow until want() is satisfied, then shuts it down.
func attachFollow(t *testing.T, a *Attacher, want func() bool) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- a.Follow(ctx) }()
	ok := attachWaitFor(t, "Follow to reach the expected state", want)
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Follow: %v", err)
	}
	if !ok {
		t.FailNow()
	}
}

// Work done in the pane appears in the thread, and the turn the operator
// started from T3 settles when the transcript says Claude stopped.
func TestFollowMirrorsAndSettles(t *testing.T) {
	r := newAttachRig(t)
	a := r.attacher()
	if _, err := a.Replay(context.Background()); err != nil {
		t.Fatalf("Replay: %v", err)
	}
	if err := a.Send("do it"); err != nil {
		t.Fatalf("Send: %v", err)
	}
	attachAppend(t, r.path, attachAssistant("a-1", "working", "tool_use"))
	attachAppend(t, r.path, attachAssistant("a-2", "done", "end_turn"))

	attachFollow(t, a, func() bool {
		return strings.Contains(r.out.String(), `"type":"result"`)
	})
	kinds := attachKinds(attachFrames(t, r.out))
	if got, want := kinds, []string{"assistant", "assistant", "result"}; !attachEqualStrings(got, want) {
		t.Fatalf("frames = %v, want %v", got, want)
	}
}

// A tool call is a turn CONTINUING, not a turn ending — settling there would
// close T3's turn while Claude is still working.
func TestFollowDoesNotSettleOnAToolCall(t *testing.T) {
	r := newAttachRig(t)
	a := r.attacher()
	if err := a.Send("do it"); err != nil {
		t.Fatalf("Send: %v", err)
	}
	attachAppend(t, r.path, attachAssistant("a-1", "calling a tool", "tool_use"))
	attachFollow(t, a, func() bool { return strings.Contains(r.out.String(), "a-1") })
	if strings.Contains(r.out.String(), `"type":"result"`) {
		t.Fatalf("a tool_use settled the turn:\n%s", r.out.String())
	}
}

// An interrupt typed in the pane settles the turn too: the transcript's notice
// is a user-role line that would otherwise read as the operator speaking and
// leave the turn open forever.
func TestFollowSettlesOnAnInterruptNotice(t *testing.T) {
	r := newAttachRig(t)
	a := r.attacher()
	if err := a.Send("do it"); err != nil {
		t.Fatalf("Send: %v", err)
	}
	attachAppend(t, r.path, attachAssistant("a-1", "starting", "tool_use"))
	attachAppend(t, r.path, attachUser("u-9", "[Request interrupted by user]"))
	attachFollow(t, a, func() bool { return strings.Contains(r.out.String(), `"type":"result"`) })
}

// Work driven from the terminal is mirrored, but it closes no T3 turn: nobody
// on that side is waiting for a result, and inventing one would settle a turn
// that was never opened.
func TestFollowEmitsNoResultForTerminalDrivenWork(t *testing.T) {
	r := newAttachRig(t)
	a := r.attacher()
	attachAppend(t, r.path, attachAssistant("a-1", "typed in the pane", "end_turn"))
	attachFollow(t, a, func() bool { return strings.Contains(r.out.String(), "a-1") })
	if strings.Contains(r.out.String(), `"type":"result"`) {
		t.Fatalf("emitted a result for a turn T3 never started:\n%s", r.out.String())
	}
}

// One result per turn, however many transcript lines Claude splits its reply
// across (thinking, then text, all repeating the same terminal stop_reason).
func TestFollowSettlesOncePerTurn(t *testing.T) {
	r := newAttachRig(t)
	a := r.attacher()
	if err := a.Send("do it"); err != nil {
		t.Fatalf("Send: %v", err)
	}
	line := `{"type":"assistant","uuid":"a-%d","sessionId":"` + attachTestID +
		`","message":{"id":"msg_same","role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"part"}]}}`
	attachAppend(t, r.path, fmt.Sprintf(line, 1), fmt.Sprintf(line, 2))
	attachFollow(t, a, func() bool { return strings.Contains(r.out.String(), "a-2") })

	var results int
	for _, f := range attachFrames(t, r.out) {
		if f["type"] == "result" {
			results++
		}
	}
	if results != 1 {
		t.Fatalf("emitted %d results, want 1:\n%s", results, r.out.String())
	}
}

// The cursor advances while following, so a bridge reaped mid-conversation
// does not re-send what it already mirrored.
func TestFollowPersistsTheCursor(t *testing.T) {
	r := newAttachRig(t)
	a := r.attacher()
	attachAppend(t, r.path, attachAssistant("a-1", "live", "end_turn"))
	attachFollow(t, a, func() bool { return strings.Contains(r.out.String(), "a-1") })

	r.out.Reset()
	if _, err := r.attacher().Replay(context.Background()); err != nil {
		t.Fatalf("Replay after Follow: %v", err)
	}
	if got := attachFrames(t, r.out); len(got) != 0 {
		t.Fatalf("re-attach re-sent %v", attachKinds(got))
	}
}

// Exit is a detached client going away, never a session ending. Nothing the
// bridge does on the way out may touch the tmux session (decision 3).
func TestFollowLeavesTheSessionAlone(t *testing.T) {
	r := newAttachRig(t)
	a := r.attacher()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- a.Follow(ctx) }()
	time.Sleep(20 * time.Millisecond)
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Follow: %v", err)
	}
	prompts, cancels, kills := r.tmux.snapshot()
	if len(kills) != 0 {
		t.Fatalf("the bridge killed %v on the way out", kills)
	}
	if len(prompts) != 0 || len(cancels) != 0 {
		t.Fatalf("the bridge drove the pane on the way out: prompts=%v cancels=%v", prompts, cancels)
	}
	if !r.tmux.HasSession("wizard", "feat-header") {
		t.Fatal("the tmux session did not survive the bridge")
	}
}

// A transcript that disappears (a session killed under us) must not turn into
// a spin or a crash — the bridge keeps waiting, silently.
func TestFollowToleratesAMissingTranscript(t *testing.T) {
	r := newAttachRig(t)
	if err := os.Remove(r.path); err != nil {
		t.Fatalf("remove: %v", err)
	}
	a := r.attacher()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
	defer cancel()
	if err := a.Follow(ctx); err != nil {
		t.Fatalf("Follow over a missing transcript: %v", err)
	}
}
