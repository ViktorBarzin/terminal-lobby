package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"terminal-lobby/sessionio"
)

// Regression tests for the review pass on 2026-08-16. Each one names the shape
// the finding took in the wild; the fixes themselves live in the file the
// finding was against.

// ---------------------------------------------------------------------------
// The binding index is written by two processes, and neither knows everything
// ---------------------------------------------------------------------------

// The bridge is never told which thread it is serving, and it stamps no
// @t3_thread of its own, so a session it created reads the option back as "".
// Record used to Put that over the pairing the syncer had written; the next
// reconcile then saw an unadopted session and made a SECOND thread for it, and
// the kill path read whichever of the two the index happened to name (E2E 9a:
// two threads titled t3e2e-born, and a thread.delete that killed nothing).
func TestRecordKeepsAThreadTheBridgeDoesNotKnow(t *testing.T) {
	b := OpenBindingsAt(filepath.Join(t.TempDir(), "index.json"))
	if err := b.Index().Put(attachTestID, sessionio.Binding{
		TmuxName: "t3e2e-born", CWD: "/home/wizard/code/tl", ThreadID: "thread-from-the-syncer",
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// Two attaches, the shape T3 produces when it reuses a bridge for a thread.
	for i := 0; i < 2; i++ {
		if err := b.Record(Target{ClaudeID: attachTestID, TmuxName: "t3e2e-born", CWD: "/home/wizard/code/tl"}); err != nil {
			t.Fatalf("Record: %v", err)
		}
	}

	got, ok, err := b.Lookup(attachTestID)
	if err != nil || !ok {
		t.Fatalf("Lookup: (%v, %v)", ok, err)
	}
	if got.ThreadID != "thread-from-the-syncer" {
		t.Fatalf("threadId = %q after two attaches, want the syncer's — the bridge cleared a pairing it cannot see", got.ThreadID)
	}
}

// tmux's session_path is where a NEW window would start, not where the
// conversation is: `tmux new -s work -c ~/code/tl` then `cd .worktrees/x &&
// claude` leaves the two two directories apart. Filing the binding by
// session_path resurrects the session in the parent, whose project slug holds
// somebody else's transcripts.
func TestResolveFilesTheBindingByTheTranscriptCWD(t *testing.T) {
	rig := newAttachRig(t)
	const worktree = "/home/wizard/code/terminal-lobby/.worktrees/t3-bridge"
	attachAppend(t, rig.path, fmt.Sprintf(
		`{"type":"user","uuid":"u-0","sessionId":%q,"cwd":%q,"message":{"role":"user","content":"hi"}}`,
		attachTestID, worktree))

	bindings := OpenBindingsAt(filepath.Join(t.TempDir(), "index.json"))
	target, live, found, err := NewSessionResolver("wizard", rig.tmux, bindings).Resolve(attachTestID)
	if err != nil || !live || !found {
		t.Fatalf("Resolve = (%+v, %v, %v, %v)", target, live, found, err)
	}
	if target.CWD != worktree {
		t.Errorf("target cwd = %q, want the transcript's %q", target.CWD, worktree)
	}
	stored, _, err := bindings.Lookup(attachTestID)
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	if stored.CWD != worktree {
		t.Errorf("stored cwd = %q, want the transcript's %q", stored.CWD, worktree)
	}
}

// ---------------------------------------------------------------------------
// Turn bookkeeping
// ---------------------------------------------------------------------------

// A paste that fails closes the turn through the protocol loop, which does not
// go through the attacher — so the attacher went on believing a result was
// owed. The next thing the pane settled, minutes later and started by the
// operator in the terminal, emitted a second result for a turn T3 had nowhere
// to put.
func TestSendClearsTheOwedResultWhenThePasteFails(t *testing.T) {
	rig := newAttachRig(t)
	rig.tmux.promptErr = errors.New("exit status 1")
	a := rig.attacher()

	if err := a.Send("a prompt the pane cannot take"); err == nil {
		t.Fatal("Send reported success on a failed paste")
	}
	rig.out.Reset()

	// Work the operator then does in the pane settles a turn of its own.
	rig.tmux.promptErr = nil
	attachAppend(t, rig.path, attachAssistant("a-1", "done in the terminal", "end_turn"))
	if _, err := a.Replay(context.Background()); err != nil {
		t.Fatalf("Replay: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if err := a.Follow(ctx); err != nil {
		t.Fatalf("Follow: %v", err)
	}
	for _, frame := range attachFrames(t, rig.out) {
		if frame["type"] == "result" {
			t.Fatalf("a result was emitted for a turn T3 never opened: %v", frame)
		}
	}
}

// ---------------------------------------------------------------------------
// The protocol channel stays answerable
// ---------------------------------------------------------------------------

// A prompt can take the better part of a minute to deliver — the session may
// have to be brought back first. While the reading goroutine was the one doing
// that, T3's control_requests went unread: an operator pressing Stop got no
// control_response at all, and on a resurrection that timed out, never.
func TestControlRequestsAreAnsweredWhileAPromptIsBlocked(t *testing.T) {
	blocked := make(chan struct{})
	release := make(chan struct{})
	h := &protoBlockingHandler{blocked: blocked, release: release}
	// A guarded sink, because the point of the test is to read what has been
	// written WHILE the loop is still writing.
	out := &attachSyncBuf{}
	loop := &protoLoop{
		In: NewDecoder(strings.NewReader(
			`{"type":"user","message":{"role":"user","content":"a prompt that takes a while"}}` + "\n" +
				`{"type":"control_request","request_id":"stop-1","request":{"subtype":"interrupt"}}` + "\n")),
		Out:       NewEncoder(out),
		Handler:   h,
		SessionID: "sess-1",
	}

	served := make(chan error, 1)
	go func() { served <- loop.Serve(nil) }()

	select {
	case <-blocked:
	case <-time.After(2 * time.Second):
		t.Fatal("the prompt never reached the handler")
	}
	// The interrupt has to be answered with the prompt still in flight.
	deadline := time.Now().Add(2 * time.Second)
	for !strings.Contains(out.String(), "stop-1") {
		if time.Now().After(deadline) {
			t.Fatalf("no control_response for the interrupt while a prompt was blocked:\n%s", out.String())
		}
		time.Sleep(5 * time.Millisecond)
	}
	close(release)
	if err := <-served; err != nil {
		t.Fatalf("Serve: %v", err)
	}
}

type protoBlockingHandler struct {
	blocked chan struct{}
	release chan struct{}
	once    bool
}

func (h *protoBlockingHandler) Send(string) error {
	if !h.once {
		h.once = true
		close(h.blocked)
		<-h.release
	}
	return nil
}

func (h *protoBlockingHandler) Interrupt() error { return nil }

// A line over the scanner's cap left bufio.Scanner unusable, so the bridge
// exited — an unhandled process death driven by ordinary user input (paste more
// than 16 MiB into the composer), taking every frame queued behind it with it.
func TestDecoderRecoversFromAnOverlongLine(t *testing.T) {
	huge := `{"type":"user","message":"` + strings.Repeat("x", protoMaxFrameBytes) + `"}`
	d := NewDecoder(strings.NewReader(huge + "\n" + `{"type":"user","message":"after"}` + "\n"))

	if _, err := d.Next(); !errors.Is(err, ErrFrameTooLong) {
		t.Fatalf("first Next err = %v, want ErrFrameTooLong", err)
	}
	frame, err := d.Next()
	if err != nil {
		t.Fatalf("the decoder did not recover: %v", err)
	}
	if frame.Text() != "after" {
		t.Fatalf("recovered frame = %q, want the one behind the oversize line", frame.Text())
	}
}

// ---------------------------------------------------------------------------
// Adoption: T3 invents a session id, and only the warm-up says what it stands for
// ---------------------------------------------------------------------------

func TestSentinelCarriesTheConversation(t *testing.T) {
	prompt := SentinelFor(attachTestID)
	if !IsSentinel(prompt) {
		t.Fatalf("the bridge does not recognise its own sentinel: %q", prompt)
	}
	if got := SentinelConversation(prompt); got != attachTestID {
		t.Fatalf("SentinelConversation = %q, want %q", got, attachTestID)
	}
	// An older syncer's sentinel is still a sentinel, and names nothing.
	if !IsSentinel(SentinelPrompt) || SentinelConversation(SentinelPrompt) != "" {
		t.Fatalf("a plain sentinel should be recognised and name no conversation")
	}
	if got := SentinelConversation("please adopt [conversation:unterminated"); got != "" {
		t.Fatalf("SentinelConversation on a malformed marker = %q, want empty", got)
	}
}

// The adoption path, end to end through the seam that carries it. T3 creates
// the thread's provider session id ITSELF — no dispatchable command seeds one,
// and the snapshot does not project it — so the bridge is spawned with a uuid
// nothing on the box has heard of, for a conversation that is already running.
// Guessing "a thread born in T3" started a second claude in a second tmux
// session (E2E 4c), which is exactly what decision 1 rules out.
func TestWarmUpAdoptsTheRunningConversationRatherThanStartingASecond(t *testing.T) {
	rig := newProtoSideRig(t)
	dir := t.TempDir()
	transcript := filepath.Join(dir, attachTestID+".jsonl")
	if err := os.WriteFile(transcript, []byte(attachAssistant("a-1", "already working", "end_turn")+"\n"), 0o600); err != nil {
		t.Fatalf("transcript: %v", err)
	}
	rig.tmux.start("work", dir, map[string]string{sessionio.OptionTranscript: transcript})

	const invented = "23bcc5c1-0000-0000-0000-000000000000"
	cfg := Config{SessionID: invented, CWD: dir}

	side, err := rig.openAdopting(cfg, attachTestID)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	att, ok := side.(*Attacher)
	if !ok {
		t.Fatalf("open returned %T", side)
	}
	if att.Target().TmuxName != "work" {
		t.Fatalf("attached to %q, want the running session", att.Target().TmuxName)
	}
	if len(rig.tmux.created) != 0 {
		t.Fatalf("a second session was created for a conversation that never stopped: %+v", rig.tmux.created)
	}

	// The alias is what makes the SECOND spawn land in the same place: T3 keeps
	// its invented id as the thread's resume cursor.
	b, ok, err := rig.deps.Bindings.Lookup(invented)
	if err != nil || !ok {
		t.Fatalf("no binding for the invented id: (%v, %v)", ok, err)
	}
	if b.AliasOf != attachTestID {
		t.Fatalf("aliasOf = %q, want %q", b.AliasOf, attachTestID)
	}
	again, err := rig.open(cfg)
	if err != nil {
		t.Fatalf("second open: %v", err)
	}
	if got := again.(*Attacher).Target().TmuxName; got != "work" {
		t.Fatalf("the second spawn attached to %q, want work", got)
	}
	if len(rig.tmux.created) != 0 {
		t.Fatalf("the second spawn created a session: %+v", rig.tmux.created)
	}
}

// A warm-up naming a conversation that is not running is a stale adoption, and
// the honest answer is to say so rather than to create something.
func TestWarmUpForAConversationThatIsNotRunningIsRefused(t *testing.T) {
	rig := newProtoSideRig(t)
	_, err := rig.openAdopting(Config{SessionID: "invented-1", CWD: t.TempDir()}, attachTestID)
	if err == nil {
		t.Fatal("a warm-up for a conversation nothing is running was accepted")
	}
	if len(rig.tmux.created) != 0 {
		t.Fatalf("it created a session anyway: %+v", rig.tmux.created)
	}
}

// A session the bridge itself named is marked as such, so the syncer can tell
// "the lobby chose this name" from "the bridge slugged the workspace root".
func TestAT3BornSessionIsRecordedAsT3s(t *testing.T) {
	rig := newProtoSideRig(t)
	dir := filepath.Join(t.TempDir(), "terminal-lobby")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	rig.tmux.onNew = func(f *attachFakeTmux, spec sessionio.NewSessionSpec) {
		f.sessions[spec.Name].opts[sessionio.OptionTranscript] = filepath.Join(dir, attachTestID+".jsonl")
	}
	if _, err := rig.open(Config{SessionID: attachTestID, CWD: dir}); err != nil {
		t.Fatalf("open: %v", err)
	}
	b, ok, err := rig.deps.Bindings.Lookup(attachTestID)
	if err != nil || !ok {
		t.Fatalf("no binding: (%v, %v)", ok, err)
	}
	if !b.FromT3() {
		t.Fatalf("origin = %q, want %q", b.Origin, sessionio.OriginT3)
	}
}

// ---------------------------------------------------------------------------
// Resurrection is not a start-up-only affair
// ---------------------------------------------------------------------------

// T3 routes the next turn to the bridge process it already has, so a session
// killed under a live bridge used to turn every later prompt into
// result/error_during_execution with nothing brought back (E2E 8). The
// mechanism was there; only the trigger was missing.
func TestAPromptAfterTheSessionDiesBringsItBack(t *testing.T) {
	rig := newProtoSideRig(t)
	dir := t.TempDir()
	transcript := filepath.Join(dir, attachTestID+".jsonl")
	if err := os.WriteFile(transcript, []byte(attachAssistant("a-1", "hello", "end_turn")+"\n"), 0o600); err != nil {
		t.Fatalf("transcript: %v", err)
	}
	rig.tmux.start("work", dir, map[string]string{sessionio.OptionTranscript: transcript})
	rig.tmux.onNew = func(f *attachFakeTmux, spec sessionio.NewSessionSpec) {
		f.sessions[spec.Name].opts[sessionio.OptionTranscript] = transcript
	}

	cfg := Config{Resume: attachTestID, CWD: dir}
	side := newDeferredSide(context.Background(), cfg, NewEncoder(rig.out), rig.deps)
	defer side.Close()
	side.Warm()
	if err := side.Send("first"); err != nil {
		t.Fatalf("first Send: %v", err)
	}

	// The session dies under the bridge T3 is still holding.
	rig.tmux.KillSession("wizard", "work")

	if err := side.Send("second"); err != nil {
		t.Fatalf("the prompt after the session died was not recovered: %v", err)
	}
	if len(rig.tmux.created) != 1 {
		t.Fatalf("created %d sessions, want exactly one resurrection: %+v", len(rig.tmux.created), rig.tmux.created)
	}
	prompts, _, _ := rig.tmux.snapshot()
	if len(prompts) != 2 || prompts[1].text != "second" {
		t.Fatalf("prompts = %+v, want the retry to have landed", prompts)
	}
}

// Opening is deferred, so a spawn for a conversation nothing knows about
// creates nothing until something says what it is for. That is what stops an
// adoption's warm-up from being read as "a thread born in T3".
func TestAnUnknownConversationCreatesNothingUntilItIsPrompted(t *testing.T) {
	rig := newProtoSideRig(t)
	dir := t.TempDir()
	side := newDeferredSide(context.Background(), Config{SessionID: attachTestID, CWD: dir}, NewEncoder(rig.out), rig.deps)
	defer side.Close()

	side.Warm()
	if len(rig.tmux.created) != 0 {
		t.Fatalf("Warm created a session for a conversation it cannot identify: %+v", rig.tmux.created)
	}
	if frames := attachFrames(t, rig.out); len(frames) != 0 {
		t.Fatalf("Warm emitted %v", frames)
	}
}

// Warm runs on its own goroutine and a first prompt can arrive while it is
// still resolving. Both must end up on the SAME session — a second open would
// be a second tmux session, and a caller that read a half-set answer would get
// a nil attacher.
func TestConcurrentOpensResolveOnce(t *testing.T) {
	rig := newProtoSideRig(t)
	dir := t.TempDir()
	transcript := filepath.Join(dir, attachTestID+".jsonl")
	if err := os.WriteFile(transcript, []byte(attachAssistant("a-1", "hi", "end_turn")+"\n"), 0o600); err != nil {
		t.Fatalf("transcript: %v", err)
	}
	rig.tmux.start("work", dir, map[string]string{sessionio.OptionTranscript: transcript})

	side := newDeferredSide(context.Background(), Config{Resume: attachTestID, CWD: dir}, NewEncoder(rig.out), rig.deps)
	defer side.Close()

	const callers = 8
	errs := make(chan error, callers)
	start := make(chan struct{})
	for i := 0; i < callers; i++ {
		go func(i int) {
			<-start
			if i%2 == 0 {
				side.Warm()
				errs <- nil
				return
			}
			errs <- side.Send("prompt")
		}(i)
	}
	close(start)
	for i := 0; i < callers; i++ {
		if err := <-errs; err != nil {
			t.Fatalf("caller %d: %v", i, err)
		}
	}
	if len(rig.tmux.created) != 0 {
		t.Fatalf("a session was created for a conversation that is already running: %+v", rig.tmux.created)
	}
}

// An open that failed must not latch: the reasons are mostly transient, and a
// bridge that answered every later prompt with the first failure would need T3
// to reap it before the thread could work again.
func TestAFailedOpenIsRetriedOnTheNextPrompt(t *testing.T) {
	rig := newProtoSideRig(t)
	dir := t.TempDir()
	transcript := filepath.Join(dir, attachTestID+".jsonl")
	if err := os.WriteFile(transcript, []byte(attachAssistant("a-1", "hi", "end_turn")+"\n"), 0o600); err != nil {
		t.Fatalf("transcript: %v", err)
	}
	rig.tmux.listErr = errors.New("tmux is busy")

	side := newDeferredSide(context.Background(), Config{Resume: attachTestID, CWD: dir}, NewEncoder(rig.out), rig.deps)
	defer side.Close()
	if err := side.Send("first"); err == nil {
		t.Fatal("Send succeeded with tmux unreachable")
	}

	rig.tmux.listErr = nil
	rig.tmux.start("work", dir, map[string]string{sessionio.OptionTranscript: transcript})
	if err := side.Send("second"); err != nil {
		t.Fatalf("the retry after a transient failure: %v", err)
	}
	prompts, _, _ := rig.tmux.snapshot()
	if len(prompts) != 1 || prompts[0].text != "second" {
		t.Fatalf("prompts = %+v, want the retry to have landed", prompts)
	}
}

// Stop pressed on a session that has already died: there is nothing to Ctrl-C,
// and the turn is over either way. Reporting the failed send-keys would leave
// T3 holding an open turn nothing will ever close.
func TestInterruptClosesTheTurnWhenTheSessionIsGone(t *testing.T) {
	rig := newAttachRig(t)
	a := rig.attacher()
	if err := a.Send("work on this"); err != nil {
		t.Fatalf("Send: %v", err)
	}
	rig.tmux.KillSession("wizard", "feat-header")
	rig.out.Reset()

	if err := a.Interrupt(); err != nil {
		t.Fatalf("Interrupt on a dead session = %v, want the turn simply closed", err)
	}
	frames := attachFrames(t, rig.out)
	if len(frames) != 1 || frames[0]["type"] != "result" {
		t.Fatalf("frames = %v, want exactly the closing result", frames)
	}
}
