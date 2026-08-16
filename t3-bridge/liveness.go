package main

import (
	"sync"
	"time"

	"terminal-lobby/sessionio"
)

// The liveness pin: keeping T3 from reaping a bridge whose tmux session is
// still working (design decision 12).
//
// WHY A PIN IS NEEDED AT ALL. T3's ProviderSessionReaper sweeps every 5 minutes
// and stops any provider session idle for 30, where "idle" is measured from the
// binding's lastSeenAt — and lastSeenAt is bumped only at session start,
// recover, sendTurn and stop. A session driven from the tmux pane sends no
// turns through T3, so its clock is frozen at the moment the bridge spawned:
// after 30 minutes the reaper wants it, every sweep, forever. Without a pin, a
// long session worked from the terminal stops mirroring half an hour in.
//
// THE TWO EXEMPTIONS the reaper honours (apps/server/src/provider/Layers/
// ProviderSessionReaper.ts, t3 v0.0.34-nightly.20260815.1098) are an active
// turn and non-null backgroundLiveness. The first is unavailable here — the
// work was never a T3 turn — so the pin is the second, and the chain it rides
// was read end to end rather than guessed:
//
//	bridge stdout line
//	  → @anthropic-ai/claude-agent-sdk 0.3.233 Query.readMessages, which passes
//	    every message that is not control_*/keep_alive/transcript_mirror through
//	    to the consumer verbatim — no schema check, no turn gate
//	  → ClaudeAdapter.handleSystemMessage, whose task_* cases are reachable with
//	    no turn open (turnId is merely omitted from the runtime event)
//	  → ProviderRuntimeIngestion.processRuntimeEvent
//	  → ThreadBackgroundLivenessService.recordTaskLiveness
//	  → getThreadBackgroundLiveness → "working"
//	  → ProjectionSnapshotQuery.getThreadShellById().backgroundLiveness
//	  → the reaper's skipped-background-work branch.
//
// WHY task_progress AND NOT task_started. Both feed the registry the same way.
// They differ in what they leave behind in the thread: T3 files a task.started
// activity under the event's own id — a new row every time — while task.progress
// is filed under a STABLE id (`task-progress:<thread>:<task>`), so re-asserting
// updates one row instead of growing the work log by two rows per turn. With
// one task id for the life of the bridge, a whole session costs the thread a
// single row that says what it is.
//
// WHY THE RELEASE IS task_updated. recordTaskLiveness drops a task on a
// terminal status, and `patch.status: "completed"` is the smallest message that
// carries one. It does leave one activity row per release; that is the cost of
// being honest about when the session stopped working.
//
// WHAT BREAKS IF T3 CHANGES THIS. Nothing dangerous: the pin stops holding,
// bridges get reaped at 30 minutes, and threads catch up on next touch. The
// design records that as the accepted failure mode.

// attachPinInterval is how often a held pin is re-asserted. The registry entry
// does not expire, so this is refresh rather than heartbeat: it covers a
// dropped message, and it is minutes rather than seconds because every assert
// costs T3 a projection write and a client broadcast.
const attachPinInterval = 60 * time.Second

// attachPin holds T3's background-liveness pin for one tmux session.
//
// Safe for concurrent use: Follow syncs it on every tick while Release can come
// from the shutdown path.
type attachPin struct {
	mu   sync.Mutex
	out  *Encoder
	held bool

	// taskID is stable for the life of the bridge. See the header: it is what
	// keeps the thread to one activity row.
	taskID    string
	sessionID string
	desc      string

	interval   time.Duration
	lastAssert time.Time
	// now is injectable so the rate limit can be tested without sleeping.
	now func() time.Time
}

// newAttachPin builds the pin for one session. The description is what the
// thread's work-log row will read, so it names the surface and the session
// rather than pretending to be a subagent.
func newAttachPin(out *Encoder, sessionID, tmuxName string) *attachPin {
	return &attachPin{
		out:       out,
		taskID:    "tl-tmux-" + sessionID,
		sessionID: sessionID,
		desc:      "terminal-lobby: tmux session " + tmuxName + " is working",
		interval:  attachPinInterval,
		now:       time.Now,
	}
}

// Held reports whether the pin is currently taken.
func (p *attachPin) Held() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.held
}

// Sync brings the pin in line with the session's @claude_state.
//
// Only "running" holds it. "awaiting" is a session waiting on the operator, not
// on Claude; "done" is finished; the empty string is a session no Claude ever
// ran in. Holding the pin for any of those would show Working in T3's sidebar
// for a thread that is idle, and would keep a bridge alive that has nothing to
// mirror.
func (p *attachPin) Sync(state string) error {
	if state != sessionio.StateRunning {
		return p.Release()
	}
	p.mu.Lock()
	if p.held && p.now().Sub(p.lastAssert) < p.interval {
		p.mu.Unlock()
		return nil
	}
	p.held = true
	p.lastAssert = p.now()
	frame := attachTaskProgress{
		Type:        TypeSystem,
		Subtype:     "task_progress",
		TaskID:      p.taskID,
		Description: p.desc,
		UUID:        attachUUID(),
		SessionID:   p.sessionID,
	}
	p.mu.Unlock()
	return p.out.Emit(frame)
}

// Release drops the pin, and does nothing when it is not held: a stray release
// would file a "Task completed" row against a task T3 never saw start.
func (p *attachPin) Release() error {
	p.mu.Lock()
	if !p.held {
		p.mu.Unlock()
		return nil
	}
	p.held = false
	frame := attachTaskUpdated{
		Type:      TypeSystem,
		Subtype:   "task_updated",
		TaskID:    p.taskID,
		Patch:     attachTaskPatch{Status: "completed"},
		UUID:      attachUUID(),
		SessionID: p.sessionID,
	}
	p.mu.Unlock()
	return p.out.Emit(frame)
}

// attachTaskProgress is SDKTaskProgressMessage, minus its usage.
//
// The SDK's type declares usage as required, and the bridge omits it anyway:
// T3 reads it defensively everywhere (`message.usage ? … : {}`), and the
// alternatives are both worse. Sending zeros makes normalizeTaskUsage produce a
// typedUsage of 0 tokens, which grows the thread a second "Task usage updated"
// row reporting nothing; inventing a count would put a fiction in the thread's
// token display. The bridge genuinely does not know the session's token usage —
// the transcript's own usage belongs to the mirrored messages — so it says
// nothing.
type attachTaskProgress struct {
	Type        string `json:"type"`    // "system"
	Subtype     string `json:"subtype"` // "task_progress"
	TaskID      string `json:"task_id"`
	Description string `json:"description"`
	UUID        string `json:"uuid"`
	SessionID   string `json:"session_id"`
}

func (f attachTaskProgress) frameType() string { return f.Type }

// attachTaskUpdated is SDKTaskUpdatedMessage: a status patch, which is the
// smallest thing that carries a terminal status.
type attachTaskUpdated struct {
	Type      string          `json:"type"`    // "system"
	Subtype   string          `json:"subtype"` // "task_updated"
	TaskID    string          `json:"task_id"`
	Patch     attachTaskPatch `json:"patch"`
	UUID      string          `json:"uuid"`
	SessionID string          `json:"session_id"`
}

func (f attachTaskUpdated) frameType() string { return f.Type }

// attachTaskPatch is the wire-safe TaskState subset T3 merges. Only Status is
// ever set here; the rest of the patch describes work the bridge is not doing.
type attachTaskPatch struct {
	Status string `json:"status,omitempty"`
}

// Compile-time proof that both pin frames are ordinary outbound frames and go
// out through the same mutex-guarded encoder as everything else.
var (
	_ Frame = attachTaskProgress{}
	_ Frame = attachTaskUpdated{}
)
