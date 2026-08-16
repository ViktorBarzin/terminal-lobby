package main

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"terminal-lobby/sessionio"
)

// Attaching a thread to a live tmux session: resolve the target, replay what it
// has already said, then mirror it as it works and paste what T3 sends back.
//
// The whole file rests on one asymmetry. Downward, the bridge writes into a pty
// — one prompt at a time, and Claude's own queue holds anything sent mid-turn
// (decision 9). Upward it reads the transcript, which only ever gains complete
// messages, so a bridged thread updates per message rather than per token
// (a stated non-goal of the design).
//
// The second thing to hold in mind is that the bridge is a DETACHED CLIENT. The
// tmux session existed before it and outlives it; T3 reaps an idle provider
// session at 30 minutes and spawns a fresh bridge on the next touch. So nothing
// here may assume it is the only reader, the first reader, or the last one —
// hence the durable cursor (cursor.go) and the liveness pin (liveness.go), and
// hence the rule that exit touches nothing.

// TmuxDriver is the slice of sessionio.Injector the attach path uses.
//
// It is an interface for two reasons. The obvious one is testing: the resolve,
// replay and inject paths can then run with no tmux server anywhere. The other
// is the omission — KillSession is NOT in it. Destroying a session is a
// deliberate cross-surface act that belongs to the syncer (decision 3), and a
// bridge that cannot name the verb cannot reach for it by accident on a
// shutdown path. *sessionio.Injector satisfies this as it stands.
type TmuxDriver interface {
	Prompt(osUser, session, text string) error
	Cancel(osUser, session string) error
	State(osUser, session string) string
	Option(osUser, session, name string) (string, bool)
	SetOption(osUser, session, name, value string) error
	HasSession(osUser, session string) bool
	ListSessions(osUser string) ([]sessionio.TmuxSession, error)
	NewSession(spec sessionio.NewSessionSpec) error
	// AwaitInputReady blocks until the session's pane is drawn and settled.
	// Only the resurrect path needs it — a session that was already running
	// when the bridge attached has been ready for a long time.
	AwaitInputReady(ctx context.Context, osUser, session string, wait, poll time.Duration) error
}

// Target is the tmux session a thread is bound to, with everything the bridge
// needs to work it.
type Target struct {
	// ClaudeID is the Claude session uuid, from T3's argv.
	ClaudeID string
	// TmuxName is the tmux session running that conversation.
	TmuxName string
	// CWD is where the session was started.
	CWD string
	// Transcript is the absolute path of the .jsonl the session's Claude writes.
	Transcript string
	// ThreadID is the T3 thread, "" when nothing has recorded it yet.
	ThreadID string
	// Origin says who chose TmuxName — sessionio.OriginLobby for a session that
	// existed before this bridge, OriginT3 for one the bridge created because
	// T3 opened a thread with nowhere to run it.
	Origin string
	// AliasOf is set when T3's session id is a stand-in for a conversation that
	// was already running under a different one; see sessionio.Binding.AliasOf.
	AliasOf string
}

// Resolver answers "which tmux session is this Claude conversation running in".
//
// Two sources, in order: the LIVE one — walk the user's sessions and match
// @claude_transcript against the uuid's transcript path — and the DURABLE one,
// the binding index, which is the only source that still answers once the
// session is gone. A resolver that finds a binding but no live session is the
// resurrection case, not a failure.
type Resolver interface {
	// Resolve returns the target for a Claude session uuid. found=false means
	// nothing on this box has ever heard of it.
	Resolve(claudeID string) (target Target, live bool, found bool, err error)
}

// SessionResolver is the real Resolver: live tmux first, the durable index
// second.
type SessionResolver struct {
	osUser   string
	tmux     TmuxDriver
	bindings *Bindings
}

// NewSessionResolver binds a resolver to one OS user's tmux server and the
// per-user binding index.
func NewSessionResolver(osUser string, tmux TmuxDriver, bindings *Bindings) *SessionResolver {
	return &SessionResolver{osUser: osUser, tmux: tmux, bindings: bindings}
}

var _ Resolver = (*SessionResolver)(nil)

// Resolve finds the tmux session for a Claude session uuid.
//
// The live pass reads @claude_transcript off every session the user has and
// matches the FILE NAME against the uuid. Matching the name rather than the
// whole path is what makes it work for a session that has moved directory, and
// sessionio.ClaudeIDFromTranscript is the same decoder every other reader in
// the lobby uses — a near-miss like "<uuid>-extra.jsonl" is not a match.
//
// A live hit also refreshes the durable binding. This is the only moment both
// halves are in hand at once: tmux knows the name and the cwd, T3 knows the
// uuid, and nothing else ever sees them together. Refreshing here is what makes
// a session renamed in the lobby still findable the next time it dies. The
// write is best-effort — an unwritable state directory must not stop a thread
// from opening — so it logs and carries on.
func (r *SessionResolver) Resolve(claudeID string) (Target, bool, bool, error) {
	return r.resolve(claudeID, 0)
}

// resolveAliasDepth bounds the alias hop. One is all the design needs — T3's
// invented id stands in for a real conversation, and that conversation is real
// — and a bound is what stops a corrupt index from looping.
const resolveAliasDepth = 4

func (r *SessionResolver) resolve(claudeID string, depth int) (Target, bool, bool, error) {
	if claudeID == "" {
		return Target{}, false, false, fmt.Errorf("resolve: empty claude session id")
	}

	sessions, err := r.tmux.ListSessions(r.osUser)
	if err != nil {
		return Target{}, false, false, fmt.Errorf("resolve %s: %w", claudeID, err)
	}
	for _, s := range sessions {
		stamp, ok := r.tmux.Option(r.osUser, s.Name, sessionio.OptionTranscript)
		if !ok || stamp == "" {
			continue // a plain shell, or a session that went away mid-walk
		}
		if sessionio.ClaudeIDFromTranscript(stamp) != claudeID {
			continue
		}
		// The @t3_thread stamp is only ever written by the syncer, and only on a
		// session it adopted; a session the bridge created carries none. So an
		// absent stamp means "not known here", never "no thread" — Record merges
		// on that basis and leaves any stored pairing alone.
		thread, _ := r.tmux.Option(r.osUser, s.Name, sessionio.OptionThread)
		target := Target{
			ClaudeID:   claudeID,
			TmuxName:   s.Name,
			CWD:        resolveCWD(stamp, s.Dir),
			Transcript: stamp,
			ThreadID:   thread,
		}
		if r.bindings != nil {
			if err := r.bindings.Record(target); err != nil {
				log.Printf("resolve %s: recording the binding failed: %v", claudeID, err)
			}
		}
		return target, true, true, nil
	}

	if r.bindings == nil {
		return Target{}, false, false, nil
	}
	b, ok, err := r.bindings.Lookup(claudeID)
	if err != nil {
		return Target{}, false, false, fmt.Errorf("resolve %s: %w", claudeID, err)
	}
	if !ok {
		return Target{}, false, false, nil
	}
	// An alias is T3's invented session id standing in for the conversation that
	// was really adopted (sessionio.Binding.AliasOf). Following it is what makes
	// the second and later spawns of an adopted thread land on the same tmux
	// session instead of starting a second Claude for a conversation that never
	// stopped running.
	if b.AliasOf != "" && b.AliasOf != claudeID && depth < resolveAliasDepth {
		aliased, live, found, err := r.resolve(b.AliasOf, depth+1)
		if err == nil && found {
			aliased.AliasOf = b.AliasOf
			if aliased.ThreadID == "" {
				aliased.ThreadID = b.ThreadID
			}
			return aliased, live, true, nil
		}
	}
	// Deliberately no Transcript: the session is gone, so nothing is stamped,
	// and guessing the path here would hand the attacher a file that may belong
	// to a conversation the resurrection is about to replace.
	return Target{
		ClaudeID: claudeID,
		TmuxName: b.TmuxName,
		CWD:      b.CWD,
		ThreadID: b.ThreadID,
		Origin:   b.Origin,
		AliasOf:  b.AliasOf,
	}, false, true, nil
}

// resolveCWD is where the conversation is actually happening.
//
// The transcript's own cwd wins over tmux's session_path, which is only where a
// NEW window in that session would start. `claude` is routinely started from a
// subdirectory — `tmux new -s work -c ~/code/tl` then `cd .worktrees/x && claude`
// — and filing the binding by session_path resurrects the session in the parent
// directory, under a project slug that holds a different conversation's
// transcripts. The syncer's adoption already files by the transcript's cwd
// (sessionio.TranscriptCWD); this is the same rule on the bridge's side, so the
// two writers of one index cannot disagree about where a session lives.
func resolveCWD(transcript, tmuxDir string) string {
	if cwd := sessionio.TranscriptCWD(transcript); cwd != "" {
		return cwd
	}
	return tmuxDir
}

// AttacherDeps are the collaborators an Attacher is built from. They are
// injected rather than constructed inside so the attach logic can be tested
// against a fake tmux and a transcript in a temp dir, with no T3 and no Claude.
type AttacherDeps struct {
	// OSUser owns the tmux session; the bridge always runs as them
	// (t3-serve@%i runs User=%i), so this is the process's own user.
	OSUser string
	// Tmux drives the session: paste, interrupt, read options.
	Tmux TmuxDriver
	// Out writes frames to T3.
	Out *Encoder
	// Poll is how often the transcript is re-read while following. Zero takes
	// the same 200ms session-events tails at.
	Poll time.Duration
	// StatePoll is how often @claude_state is re-read, which is a tmux fork
	// rather than a file read and so is deliberately much slower. Zero takes
	// attachStatePoll.
	StatePoll time.Duration
	// Cursors is where the replay position is kept. Zero falls back to the
	// per-user default, which is what the real bridge wants and what every test
	// must override.
	Cursors *CursorStore
}

// attachPoll matches session-events' -poll default: the same transcripts, read
// at the same rate, so the two surfaces do not visibly disagree about when a
// message arrived.
const attachPoll = 200 * time.Millisecond

// attachStatePoll is how often @claude_state is re-read. It is a subprocess,
// not a file read, and the only consumer is a pin that re-asserts once a
// minute — so it runs at seconds rather than at the transcript's cadence.
const attachStatePoll = 3 * time.Second

// Attacher mirrors one tmux session into one T3 thread for the life of the
// bridge process.
type Attacher struct {
	target Target
	deps   AttacherDeps
	pin    *attachPin

	// mu guards everything below. Send and Interrupt run on the protocol
	// goroutine while Follow runs on its own, and both settle turns.
	mu     sync.Mutex
	tail   *sessionio.Tail
	cursor Cursor
	// primed is false until the cursor has been loaded off disk, so a Send that
	// arrives before Replay still starts from the right place.
	primed bool
	// owes records that T3 has an open turn with us. A turn is opened by T3
	// sending a user message and closed by our result frame; work done in the
	// pane opens nothing, so mirroring it must not manufacture a result for a
	// turn that was never started.
	owes bool
	// turnDone / doneMsg mirror sessionio's settle rules: one result per turn,
	// however many transcript lines Claude splits a reply across.
	turnDone bool
	doneMsg  string
	// skipTo is set only while re-anchoring a transcript whose byte offset can
	// no longer be trusted: records are dropped until this uuid goes past.
	skipTo string
	// lastSeen is the newest record uuid observed during that scan, so a scan
	// that never finds its anchor can still leave a usable one behind.
	lastSeen string
}

// NewAttacher binds an attacher to a resolved target.
func NewAttacher(target Target, deps AttacherDeps) *Attacher {
	if deps.Poll <= 0 {
		deps.Poll = attachPoll
	}
	if deps.StatePoll <= 0 {
		deps.StatePoll = attachStatePoll
	}
	if deps.Cursors == nil {
		dir, err := DefaultCursorDir()
		if err != nil {
			// Nothing can be persisted, which means a re-attach will replay.
			// Say so once, loudly, rather than duplicating a conversation
			// without explanation.
			log.Printf("no cursor directory (%v): a re-attach will replay this thread", err)
		}
		deps.Cursors = NewCursorStore(dir)
	}
	return &Attacher{
		target: target,
		deps:   deps,
		tail:   sessionio.NewTail(target.Transcript),
		pin:    newAttachPin(deps.Out, target.ClaudeID, target.TmuxName),
	}
}

// Target is the session this attacher is bound to.
func (a *Attacher) Target() Target { return a.target }

// Replay emits the session's whole history into the thread once, so a session
// worked in all day reads as itself in T3 rather than as a blank thread
// (decision 6). It returns the transcript cursor it reached, which Follow
// continues from — the same cursor, so nothing is delivered twice.
//
// "Whole history" is bounded by what this thread has already been told: the
// durable cursor is loaded first, and on the second and later attaches of the
// same session Replay is a no-op that emits nothing.
func (a *Attacher) Replay(ctx context.Context) (int64, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.prime(); err != nil {
		return 0, err
	}
	if _, err := a.drainLocked(ctx, true); err != nil {
		return a.tail.Offset(), err
	}
	return a.tail.Offset(), nil
}

// Follow mirrors the session as it works, until ctx is cancelled or the pipe
// closes. It emits a ResultFrame each time the transcript settles a turn T3 is
// waiting on, and holds T3's background-liveness pin while the session is
// mid-turn (decision 12, mechanism in liveness.go).
//
// It returns nil on cancellation: a bridge told to stop has not failed. On the
// way out it drops the pin and saves the cursor, and touches the tmux session
// in no other way — the bridge is a detached client, not the session's owner.
func (a *Attacher) Follow(ctx context.Context) error {
	ticker := time.NewTicker(a.deps.Poll)
	defer ticker.Stop()
	// The state read has its own, much slower cadence. It is a `tmux
	// display-message` fork, and the thing it feeds — the liveness pin — only
	// re-asserts once a minute anyway (liveness.go), so reading it at the
	// transcript's 200 ms would fork tmux five times a second for the life of
	// every open thread. On a box whose binding constraint is memory that is
	// avoidable churn in the component the design justifies on resource grounds.
	state := time.NewTicker(a.deps.StatePoll)
	defer state.Stop()
	defer func() {
		if err := a.pin.Release(); err != nil {
			log.Printf("follow %s: releasing the liveness pin failed: %v", a.target.TmuxName, err)
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-state.C:
			// The pin follows the session's own state stamp, so it is held
			// exactly while a turn is in flight in the pane — whoever started it.
			if err := a.pin.Sync(a.deps.Tmux.State(a.deps.OSUser, a.target.TmuxName)); err != nil {
				return fmt.Errorf("follow %s: liveness pin: %w", a.target.TmuxName, err)
			}
			continue
		case <-ticker.C:
		}

		a.mu.Lock()
		err := a.prime()
		if err == nil {
			_, err = a.drainLocked(ctx, false)
		}
		a.mu.Unlock()
		if err != nil {
			return err
		}
	}
}

// Send pastes a prompt into the pane and submits it. A turn already in flight
// is not an error: Claude's own queue holds the prompt and it stays visible in
// the pane, which is the behaviour on both surfaces (decision 9). Nothing here
// reads @claude_state — gating on it is what the lobby's old 409 did, and the
// design removes it.
//
// The sentinel is swallowed. The protocol loop already recognises the warm-up
// turn, and this is the second place that does: the rule "it must never reach a
// live pane" is worth holding wherever a prompt could get out, because the cost
// of getting it wrong is a stray line typed into somebody's working session.
// Swallowing it still replays and still closes the turn, because a turn that
// never reached Claude will never be settled by anything in the transcript.
func (a *Attacher) Send(text string) error {
	// Either way, T3 has just opened a turn — a user message is what opens one,
	// and only a result closes it. Marked before the paste, not after: the
	// reply can land in the transcript while Prompt is still returning, and a
	// result owed but not yet recorded is a turn that never closes.
	a.mu.Lock()
	a.owes = true
	a.turnDone, a.doneMsg = false, ""
	a.mu.Unlock()

	if IsSentinel(text) {
		if _, err := a.Replay(context.Background()); err != nil {
			return err
		}
		return a.result("")
	}
	if err := a.deps.Tmux.Prompt(a.deps.OSUser, a.target.TmuxName, text); err != nil {
		// The turn is over as far as this attacher is concerned: the caller
		// closes it with a result of its own. Leaving `owes` set would make the
		// NEXT thing the pane settles — work the operator started in the
		// terminal, minutes later — emit a second result for a turn T3 has
		// nowhere to put.
		a.mu.Lock()
		a.owes = false
		a.mu.Unlock()
		return err
	}
	return nil
}

// Interrupt maps T3's interrupt control_request to the existing Cancel path:
// Ctrl-C plus the @claude_state re-derivation, because an interrupt never fires
// Claude's Stop hook (ADR-0001).
//
// It also closes the turn on T3's side. An interrupt that lands before the
// first token leaves NOTHING in the transcript — no notice, sometimes not even
// the prompt line — so whoever injects it owes T3 the closing frame, the same
// reasoning that makes Injector.Cancel own the @claude_state transition.
//
// A cancel that failed is reported rather than swallowed: the protocol loop
// answers the control request with it, and an operator who pressed Stop must
// not be told it worked while the turn runs on.
func (a *Attacher) Interrupt() error {
	if err := a.deps.Tmux.Cancel(a.deps.OSUser, a.target.TmuxName); err != nil {
		if a.deps.Tmux.HasSession(a.deps.OSUser, a.target.TmuxName) {
			return err
		}
		// The session is gone, so there is nothing left to interrupt and the
		// turn is over whatever the operator meant by Stop. Reporting the
		// failure instead would be true of the Ctrl-C and false of the
		// question T3 asked — and would leave the turn open for ever.
		log.Printf("interrupt %s: the session is gone; closing the turn", a.target.TmuxName)
		return a.result("")
	}
	return a.result("")
}

// prime loads the durable cursor once and positions the tail on it. Callers
// hold a.mu.
func (a *Attacher) prime() error {
	if a.primed {
		return nil
	}
	cur, err := a.deps.Cursors.Load(a.target.ClaudeID)
	if err != nil {
		return err
	}
	a.cursor = cur
	a.primed = true

	start := cur.Offset
	if start > 0 {
		if fi, statErr := os.Stat(a.target.Transcript); statErr == nil && fi.Size() < start {
			// The file is shorter than where we left off, so it is not the file
			// the offset was taken from. Re-read from the top and find our
			// place by record uuid instead of trusting a byte count.
			log.Printf("attach %s: transcript is shorter than the saved cursor; re-anchoring on %s",
				a.target.ClaudeID, cur.LastUUID)
			start = 0
		}
	}
	if start != cur.Offset {
		a.tail = sessionio.NewTail(a.target.Transcript)
		a.cursor.Offset = 0
		a.skipTo = cur.LastUUID
	} else {
		a.tail = sessionio.NewTailAt(a.target.Transcript, start)
	}
	return nil
}

// drainLocked reads everything the transcript has gained and mirrors it,
// settling turns as it goes. Callers hold a.mu.
//
// It is one function for replay and for following because they differ in
// exactly one thing — whether a mirrored user message is marked isReplay — and
// splitting them would be two implementations of the record→frame mapping to
// keep in step.
func (a *Attacher) drainLocked(ctx context.Context, replay bool) (int, error) {
	emitted := 0
	startOffset := a.tail.Offset()
	for {
		if err := ctx.Err(); err != nil {
			return emitted, nil // a cancelled bridge has not failed
		}
		records, err := a.tail.Next()
		if err != nil {
			if os.IsNotExist(err) {
				// The session's Claude has not written its first line yet, or
				// the session is gone. Both are states to wait through, not
				// failures: the bridge outlives neither event.
				return emitted, nil
			}
			return emitted, fmt.Errorf("tail %s: %w", a.tail.Path(), err)
		}
		if len(records) == 0 {
			// End of file. An anchor still unfound is an anchor that is not in
			// this transcript at all, so there is no placing what came before
			// it. The bridge takes the silent side — emitting the file would
			// duplicate a conversation into a live thread — and picks the
			// stream up from here, so live work still flows.
			if a.skipTo != "" {
				log.Printf("attach %s: record %s is not in %s; mirroring resumes from the end",
					a.target.ClaudeID, a.skipTo, a.tail.Path())
				a.skipTo = ""
				a.cursor.LastUUID = a.lastSeen
			}
			if a.tail.Offset() != startOffset {
				if err := a.saveCursorLocked(); err != nil {
					return emitted, err
				}
			}
			return emitted, nil
		}
		for _, rec := range records {
			n, err := a.mirrorLocked(rec, replay)
			if err != nil {
				return emitted, err
			}
			emitted += n
		}
	}
}

// mirrorLocked turns one transcript record into what T3 should see. Callers
// hold a.mu.
func (a *Attacher) mirrorLocked(rec sessionio.Record, replay bool) (int, error) {
	// Re-anchoring after a truncated transcript: drop everything up to and
	// including the last record we know was emitted (see prime).
	if a.skipTo != "" {
		if rec.UUID != "" {
			a.lastSeen = rec.UUID
		}
		if rec.UUID == a.skipTo {
			a.skipTo = ""
			a.cursor.LastUUID = rec.UUID
		}
		return 0, nil
	}

	frame, ok := protoFrameFor(rec, a.target.ClaudeID, replay)
	if !ok {
		return 0, nil // not conversation: 16 of the 18 record types
	}
	if err := a.deps.Out.Emit(frame); err != nil {
		return 0, err
	}
	a.cursor.LastUUID = rec.UUID

	// A replayed record settles nothing. It is history: the turn it ended
	// finished long before this bridge existed, and closing the turn T3 has
	// open right now on the strength of it would end the warm-up in the middle
	// of the history it exists to deliver. The tracker is still advanced, so
	// the first LIVE record after a replay is judged against the right state.
	reason, settled := a.settleLocked(rec)
	if settled && !replay {
		if err := a.resultLocked(reason); err != nil {
			return 1, err
		}
	}
	return 1, nil
}

// settleLocked applies sessionio's turn rules to one record and reports the
// stop reason when the turn has just ended. Callers hold a.mu.
//
// The rules are the ones the lobby's Normalizer already runs on the same files,
// kept in one place there (sessionio.EndsTurn, sessionio.InterruptNotice) so
// the two surfaces cannot come to different conclusions about when a turn is
// over. What is repeated here is only the once-per-turn bookkeeping: Claude
// writes one line per content block and repeats the terminal stop_reason on
// each, so the message id is what distinguishes "the reply continues" from
// "work resumed".
func (a *Attacher) settleLocked(rec sessionio.Record) (string, bool) {
	if _, ok := sessionio.InterruptNotice(rec); ok {
		if a.turnDone {
			return "", false
		}
		a.turnDone, a.doneMsg = true, ""
		return "", true
	}
	if rec.Role() != "assistant" || !sessionio.EndsTurn(rec.Message.StopReason) {
		return "", false
	}
	if a.turnDone && rec.Message.ID != "" && rec.Message.ID == a.doneMsg {
		return "", false // a further block of the reply that already ended
	}
	if a.turnDone {
		return "", false
	}
	a.turnDone, a.doneMsg = true, rec.Message.ID
	return rec.Message.StopReason, true
}

// result emits the frame that closes T3's turn, if one is open.
func (a *Attacher) result(stopReason string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.resultLocked(stopReason)
}

// resultLocked is result with a.mu already held.
//
// Nothing is emitted when T3 has no turn open. Work driven from the pane is
// mirrored but settles nothing on that side: a result for a turn that was never
// started is a frame T3 has nowhere to put, and the design's "the bridge is a
// detached client" only holds if the bridge stays quiet about work that is not
// its own.
func (a *Attacher) resultLocked(stopReason string) error {
	if !a.owes {
		return nil
	}
	a.owes = false
	return a.deps.Out.Emit(protoResult(a.target.ClaudeID, stopReason))
}

// saveCursorLocked persists the replay position. Callers hold a.mu.
//
// Once per drained batch rather than once per record: the initial replay of a
// 2.5 MB transcript is then one write instead of thousands, and the exposure a
// batch-sized window leaves is a bridge killed with SIGKILL mid-batch, which
// re-sends at most that batch.
func (a *Attacher) saveCursorLocked() error {
	a.cursor.Offset = a.tail.Offset()
	a.cursor.UpdatedAt = time.Time{} // let the store stamp it
	if err := a.deps.Cursors.Save(a.target.ClaudeID, a.cursor); err != nil {
		return fmt.Errorf("save cursor for %s: %w", a.target.ClaudeID, err)
	}
	return nil
}

// IsSentinel reports whether an inbound prompt is the syncer's warm-up turn,
// which exists only to make T3 spawn this bridge and must never reach the pane
// (decision 11 / CONTEXT.md "Warm-up").
//
// The wording is a shared constant rather than a heuristic, because both sides
// have to agree exactly: the syncer dispatches SentinelPrompt and the bridge
// swallows precisely that. A trailing conversation marker is allowed after it,
// so the two constants still pin each other while the marker carries the one
// fact T3 has no way to pass (see SentinelConversation).
func IsSentinel(text string) bool {
	return strings.HasPrefix(strings.TrimSpace(text), SentinelPrompt)
}

// SentinelPrompt is the warm-up turn's text. It is a legible provenance line
// rather than a blank because it stays visible in the thread forever — one
// phantom user message per adopted session is a known cost of the design.
const SentinelPrompt = "[terminal-lobby] adopting this session — mirroring its transcript into this thread."

// sentinelConversationPrefix introduces the uuid a warm-up turn is adopting.
//
// WHY THE PROMPT CARRIES IT. Adoption creates a thread for a conversation that
// is ALREADY running, and T3 offers no way to tell the thread which one: no
// dispatchable command seeds a provider session id, and the snapshot does not
// project the one T3 mints for itself. So the bridge is spawned with a session
// id T3 invented, finds nothing on the box under it, and — before this — took
// that for a thread born in T3 and started a second Claude for a conversation
// that had never stopped running, which is precisely what decision 1 exists to
// prevent.
//
// The warm-up turn is the one message that reaches the bridge from the syncer,
// so it is where the missing fact goes. It is a marker rather than a second
// field because a turn's text is all T3 forwards.
const sentinelConversationPrefix = "[conversation:"

// SentinelConversation extracts the Claude session uuid a warm-up turn names,
// or "" when it names none (an older syncer, or a hand-typed line that happens
// to start with the sentinel).
func SentinelConversation(text string) string {
	_, rest, found := strings.Cut(text, sentinelConversationPrefix)
	if !found {
		return ""
	}
	id, closed := strings.CutSuffix(strings.TrimSpace(rest), "]")
	if !closed {
		return ""
	}
	return strings.TrimSpace(id)
}

// SentinelFor is the warm-up prompt for one conversation. The syncer builds the
// same string from its own copy of SentinelPrompt; TestSentinelMatchesTheBridge
// reads this file to keep the two from drifting.
func SentinelFor(claudeID string) string {
	if claudeID == "" {
		return SentinelPrompt
	}
	return SentinelPrompt + "\n\n" + sentinelConversationPrefix + claudeID + "]"
}

// attachUUID mints a random v4 uuid for the frames that need one of their own
// (the pin's task messages, and any frame the bridge originates rather than
// mirrors). Mirrored frames carry the transcript record's uuid instead.
//
// crypto/rand does not fail on Linux, but a uuid that silently came out empty
// would be a frame T3 files under nothing at all, so the fallback is a
// time-derived value rather than a zero.
func attachUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		binary.BigEndian.PutUint64(b[0:8], uint64(time.Now().UnixNano()))
		binary.BigEndian.PutUint64(b[8:16], uint64(os.Getpid()))
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// attachStateDir is where the bridge keeps what has to survive it. Exposed as a
// helper so the cursor store and the binding index cannot drift apart.
func attachStateDir() (string, error) {
	index, err := sessionio.DefaultIndexPath()
	if err != nil {
		return "", err
	}
	return filepath.Dir(index), nil
}
