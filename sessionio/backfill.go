package sessionio

// Reading a transcript backwards.
//
// A view of a session opens at the live end and is usually closed there: the
// last thing that happened is what someone came to see. So the stream starts at
// the newest event and walks towards the oldest, and stops on a BYTE budget
// rather than a turn count.
//
// Turns were the unit until 2026-08-28 and are not a unit of size: measured
// across one 23-turn session, per-turn cost ran 0, 2, 57, 70, 72, 74 … 410, 484
// and 1,092 KB. A window of N turns therefore has no bound at all, and the
// heaviest single turn measured (377 KB) is on its own more than a slow link
// delivers in seven seconds. Bytes bound it; a turn boundary is a rendering
// concern, honoured where it is free (the split turn's prompt, below) and
// otherwise left to the renderer.
//
// See docs/plans/2026-08-28-text-reverse-transcript-load-design.md.

// Backfill is one step of history, newest-end first.
type Backfill struct {
	// Events, ASCENDING like every other slice this package returns. The SSE
	// writer emits them in reverse so the newest row paints first; a JSON
	// caller prepends the slice as it stands.
	Events []Event
	// Cursor is the `before` for the next step back — the id of the oldest
	// event this step WALKED to, which is not always the oldest event it
	// carries (a split turn's prompt rides along from further back). 0 once the
	// start of the log has been reached.
	Cursor int64
}

// Backfill returns the newest events below `before` (0 = from the live end),
// walking backwards until `budget` bytes have been accounted for.
//
// It always returns at least one event while any remain: a budget below the
// size of a single event must still produce something to render, and the
// alternative is a client that cannot make progress.
//
// When the walk stops midway through a turn, that turn's prompt is carried too,
// so a reader never meets an answer with no question above it. That prompt sits
// below the cursor, so the next step re-delivers it; ids make that a no-op for
// the caller.
func (f *FileSource) Backfill(before int64, budget int) Backfill {
	f.mu.Lock()
	defer f.mu.Unlock()

	// The newest event below `before`.
	end := len(f.logbuf)
	if before > 0 {
		end = 0
		for i, e := range f.logbuf {
			if e.ID >= before {
				break
			}
			end = i + 1
		}
	}
	if end == 0 {
		return Backfill{}
	}

	spent := 0
	start := end
	for i := end - 1; i >= 0; i-- {
		// At least one event, then stop as soon as the budget is met. The test
		// is on what has ALREADY been taken, so the walk overshoots by at most
		// one event rather than stalling on an event bigger than the budget.
		if start < end && spent >= budget {
			break
		}
		spent += len(f.logbuf[i].JSON())
		start = i
	}

	out := make([]Event, 0, end-start+1)
	// A split turn's prompt, from below the cursor. Only when the turn really
	// is split — a walk that reached the turn's own first event has nothing to
	// add, and neither does one that stopped between turns.
	if turnID := f.logbuf[start].TurnID; turnID != "" && f.logbuf[start].Kind != KindUser {
		for i := start - 1; i >= 0; i-- {
			if f.logbuf[i].TurnID != turnID {
				break
			}
			if f.logbuf[i].Kind == KindUser {
				out = append(out, f.logbuf[i])
				break
			}
		}
	}
	out = append(out, f.logbuf[start:end]...)

	cursor := int64(0)
	if start > 0 {
		cursor = f.logbuf[start].ID
	}
	return Backfill{Events: out, Cursor: cursor}
}

// SessionState is what the reader needs that is NOT in the window they hold.
//
// Three things the renderer shows are folded from the whole conversation rather
// than read off a row: the permission mode, the newest `/context` reading, and
// the prompt queue. A client used to derive all three by scanning whatever
// events it happened to have, which worked while a fresh open carried twenty
// turns. At a 100 KB backfill it does not — and the queue is the case that goes
// WRONG rather than merely short, because a `dequeued` whose `queued` fell
// outside the window takes the head off a queue that never held it.
//
// So they are computed here, over the log this source already holds in memory,
// and sent once ahead of the backfill. The client seeds from this and folds
// only what arrives after `At`.
type SessionState struct {
	// At is the newest event id this snapshot accounts for.
	At int64 `json:"at"`
	// Mode is the permission mode in force, from the newest meta that named one.
	Mode string `json:"mode,omitempty"`
	// Context is the newest `/context` reading in the session, if anyone ran it.
	Context *ContextReading `json:"context,omitempty"`
	// ContextTurnsAgo is how many turns have settled since that reading.
	ContextTurnsAgo int `json:"contextTurnsAgo,omitempty"`
	// Queue is what Claude has waiting, oldest first. Carried raw: the harness's
	// own injected notices are filtered by the renderer, which owns that list.
	Queue []string `json:"queue"`
	// Prompts is the composer's history, oldest first, consecutive repeats
	// collapsed — the same rule the renderer applied to the window.
	Prompts []string `json:"prompts"`
}

// State folds the whole log into the session state above, keeping at most
// `maxPrompts` of history.
func (f *FileSource) State(maxPrompts int) SessionState {
	f.mu.Lock()
	defer f.mu.Unlock()

	st := SessionState{Queue: []string{}, Prompts: []string{}}
	ctxAt := -1
	for i, e := range f.logbuf {
		st.At = e.ID
		switch e.Kind {
		case KindUser:
			if t := e.Body; t != "" && (len(st.Prompts) == 0 || st.Prompts[len(st.Prompts)-1] != t) {
				st.Prompts = append(st.Prompts, t)
			}
		case KindMeta:
			switch e.Meta {
			case MetaPermissionMode:
				if e.Body != "" {
					st.Mode = e.Body
				}
			case MetaContext:
				if e.Context != nil {
					st.Context, ctxAt = e.Context, i
				}
			case MetaQueued:
				if e.Body != "" {
					st.Queue = append(st.Queue, e.Body)
				}
			case MetaUnqueued:
				for j, q := range st.Queue {
					if q == e.Body {
						st.Queue = append(st.Queue[:j], st.Queue[j+1:]...)
						break
					}
				}
			case MetaDequeued:
				if len(st.Queue) > 0 {
					st.Queue = st.Queue[1:]
				}
			case MetaQueueCleared:
				st.Queue = st.Queue[:0]
			}
		}
	}
	if ctxAt >= 0 {
		for _, e := range f.logbuf[ctxAt+1:] {
			if e.Kind == KindTurnEnd {
				st.ContextTurnsAgo++
			}
		}
	}
	if maxPrompts > 0 && len(st.Prompts) > maxPrompts {
		st.Prompts = st.Prompts[len(st.Prompts)-maxPrompts:]
	}
	return st
}
