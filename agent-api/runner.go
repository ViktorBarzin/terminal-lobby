package main

// One turn at a time per conversation, all conversations at once.
//
// A tmux session processes one turn at a time whatever we do — a second
// bracketed paste arriving mid-turn lands on Claude's input line and is
// submitted into the middle of the first answer. So the serialisation is not a
// policy the API invented; it is the shape of the thing underneath, and the
// queue here is what turns "do not do that" into "your second message waits".
//
// Different conversations are different tmux sessions and share nothing, so
// they run concurrently and the queue is per conversation rather than global.

import "sync"

// Runner serialises turns within a conversation.
//
// Turn is the work itself, injected rather than called directly, for two
// reasons. The queueing is the part with the concurrency bug in it and is
// worth testing without a tmux server anywhere near it, and the turn itself
// needs the whole Server — sessions, store, trace — which would make this file
// depend on all of them to run a loop.
type Runner struct {
	Turn func(*Task)

	mu     sync.Mutex
	queues map[string]*convQueue
	// idle is closed and replaced whenever the last queue drains. Tests wait
	// on it; production ignores it.
	idle chan struct{}
	live int
}

// convQueue is one conversation's pending turns. active says a goroutine is
// draining it, which is what keeps exactly one turn in flight per conversation
// without holding a lock across the turn itself.
type convQueue struct {
	pending []*Task
	active  bool
}

// NewRunner builds a runner around a turn function.
func NewRunner(turn func(*Task)) *Runner {
	return &Runner{Turn: turn, queues: map[string]*convQueue{}, idle: make(chan struct{})}
}

// Submit queues a task and starts the conversation's drain goroutine if it is
// not already running. It never blocks: the write endpoint answers "accepted"
// before the turn starts, and a caller must not be made to wait on somebody
// else's turn to be told their message was taken.
func (r *Runner) Submit(t *Task) {
	r.mu.Lock()
	q := r.queues[t.ConversationID]
	if q == nil {
		q = &convQueue{}
		r.queues[t.ConversationID] = q
	}
	q.pending = append(q.pending, t)
	start := !q.active
	if start {
		q.active = true
		r.live++
	}
	r.mu.Unlock()
	if start {
		go r.drain(t.ConversationID)
	}
}

// Ahead reports how many turns in a conversation have not finished, counting
// the one in flight.
//
// Counting the in-flight turn is the whole point: a caller asking "how many
// turns are ahead of the message I just sent" is asking how long it waits, and
// the turn currently running is the one it waits for. A count of the pending
// queue alone answers zero for a conversation that is busy, which reads as
// "starting now" and is the opposite of the truth.
func (r *Runner) Ahead(conversationID string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	q := r.queues[conversationID]
	if q == nil {
		return 0
	}
	n := len(q.pending)
	if q.active {
		n++
	}
	return n
}

// drain runs one conversation's turns, in order, until none are left.
//
// The queue map entry is deleted when it empties rather than left behind: a
// long-lived service talking to many conversations would otherwise keep one
// struct per conversation it has ever seen.
func (r *Runner) drain(conversationID string) {
	for {
		r.mu.Lock()
		q := r.queues[conversationID]
		if q == nil || len(q.pending) == 0 {
			if q != nil {
				q.active = false
				delete(r.queues, conversationID)
			}
			r.live--
			if r.live == 0 {
				close(r.idle)
				r.idle = make(chan struct{})
			}
			r.mu.Unlock()
			return
		}
		t := q.pending[0]
		q.pending = q.pending[1:]
		r.mu.Unlock()

		r.Turn(t)
	}
}

// Idle returns a channel closed when every queue has drained. A test seam: the
// service itself never waits for its own work to finish.
func (r *Runner) Idle() <-chan struct{} {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.live == 0 {
		closed := make(chan struct{})
		close(closed)
		return closed
	}
	return r.idle
}
