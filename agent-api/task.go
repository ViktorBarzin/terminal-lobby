package main

// Tasks: one per message a caller sends, and the only thing it gets back.
//
// A turn takes minutes to hours, and the caller polls from a VM it does not
// control the inbound path to, so the write endpoint answers immediately with
// an id and the reader asks about it later. That shape is the design doc's
// "task id, Muse polls", and it means the whole lifecycle of a turn has to be
// expressible as one of six words.

import (
	"sync"
	"time"
)

// TaskStatus is what GET /v1/tasks/{id} reports.
type TaskStatus string

const (
	// StatusAccepted — the message is queued behind another turn in the same
	// conversation, or has not been injected yet. Nothing has reached Claude.
	StatusAccepted TaskStatus = "accepted"
	// StatusRunning — the prompt is in and the session is working.
	StatusRunning TaskStatus = "running"
	// StatusNeedsInput — the session is waiting on a human: a permission
	// dialog or an AskUserQuestion. Question carries what it is asking.
	StatusNeedsInput TaskStatus = "needs_input"
	// StatusDone — the turn finished. Result carries the agent's final
	// message.
	StatusDone TaskStatus = "done"
	// StatusFailed — the turn could not be run or could not be followed to the
	// end. Error says which.
	StatusFailed TaskStatus = "failed"
	// StatusCancelled — the caller cancelled it, either before it started or
	// by interrupting the turn in flight.
	StatusCancelled TaskStatus = "cancelled"
)

// terminal reports whether a status is an end state. A task in one never
// changes again, which is what lets a poller stop asking.
func (s TaskStatus) terminal() bool {
	switch s {
	case StatusDone, StatusFailed, StatusCancelled:
		return true
	}
	return false
}

// canGo reports whether a task may move from s to next.
//
// The rules are short and worth stating rather than leaving implicit in the
// code that happens to call them:
//
//   - A terminal status is final. A late poll of a cancelled task must not see
//     it turn "done" because the session finished the turn anyway, and a turn
//     that fails after a cancel is still cancelled.
//   - needs_input goes back to running, because answering the dialog resumes
//     the same turn. It is a pause, not an end.
//   - accepted may reach any live status, because a queued task can be
//     cancelled before it is ever injected, and injection can fail outright.
//   - A status never transitions to itself. Re-stamping is not an error, but
//     it is also not a change, and the store treats it as a no-op so the
//     updated_at clock reports when something actually happened.
func (s TaskStatus) canGo(next TaskStatus) bool {
	if s.terminal() || s == next {
		return false
	}
	switch s {
	case StatusAccepted:
		return next == StatusRunning || next == StatusNeedsInput ||
			next == StatusDone || next == StatusFailed || next == StatusCancelled
	case StatusRunning:
		return next == StatusNeedsInput || next == StatusDone ||
			next == StatusFailed || next == StatusCancelled
	case StatusNeedsInput:
		return next == StatusRunning || next == StatusDone ||
			next == StatusFailed || next == StatusCancelled
	}
	return false
}

// Task is one message's whole life. The mutable fields are guarded by the
// store's lock; nothing outside the store may read or write them directly,
// which is what Snapshot is for.
type Task struct {
	ID             string
	ConversationID string
	// Actor is the credential that sent the message, for the trace. Never the
	// token — authuser.Identity.Header on a bearer request is the credential's
	// NAME.
	Actor  string
	OSUser string
	// Text is the caller's own words, kept so the trace can replay the run.
	Text string

	Status   TaskStatus
	Question string
	Result   string
	Error    string

	Created time.Time
	Updated time.Time

	// cancel is closed once, by Cancel, and is what stops the poll loop
	// watching a turn that nobody is waiting for any more.
	cancel     chan struct{}
	cancelOnce sync.Once
}

// TaskView is the immutable answer GET /v1/tasks/{id} serves. A copy rather
// than the Task itself: the runner mutates a live task from its own goroutine,
// and handing a pointer to an HTTP handler is a data race with a JSON encoder
// on the other end of it.
type TaskView struct {
	ID             string     `json:"task_id"`
	ConversationID string     `json:"conversation_id"`
	Status         TaskStatus `json:"status"`
	// Question is set on needs_input only.
	Question string `json:"question,omitempty"`
	// Result is set on done only: the agent's final message.
	Result string `json:"result,omitempty"`
	// Error is set on failed only.
	Error string `json:"error,omitempty"`
	// DetailURL is the full turn, tool calls included. Set on every status
	// that has something to read, which is every one but accepted.
	DetailURL string    `json:"detail_url,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// TaskStore holds every task this process has seen.
//
// In memory, and that is a real limitation rather than an oversight: a restart
// of agent-api loses the task ids, and a poller holding one gets a 404. The
// conversation itself survives, because it is a tmux session and the
// transcript is on disk — so the recovery is to list conversations and read
// the transcript, not to retry the message. Making tasks durable would mean a
// store, and the design doc's "one small addition upstream" budget did not
// include one. Recorded in the OpenAPI document so a generated client is not
// surprised by it.
type TaskStore struct {
	mu   sync.Mutex
	byID map[string]*Task
	// order is insertion order, for the prune below.
	order []string
	// Max is how many tasks to keep. A long-lived service that never forgot a
	// task would grow without bound; the oldest TERMINAL tasks go first, so a
	// live turn is never dropped out from under its poller.
	Max int
	Now func() time.Time
}

// defaultMaxTasks is roughly a fortnight of heavy use at the rate a polling
// caller generates turns, and a few megabytes at the size of a final message.
const defaultMaxTasks = 2000

// NewTaskStore builds an empty store.
func NewTaskStore(now func() time.Time) *TaskStore {
	if now == nil {
		now = time.Now
	}
	return &TaskStore{byID: map[string]*Task{}, Max: defaultMaxTasks, Now: now}
}

// Add records a new accepted task.
func (s *TaskStore) Add(t *Task) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.Now()
	t.Status = StatusAccepted
	t.Created, t.Updated = now, now
	t.cancel = make(chan struct{})
	s.byID[t.ID] = t
	s.order = append(s.order, t.ID)
	s.prune()
}

// prune drops the oldest terminal tasks until the store is within Max. Called
// with the lock held.
func (s *TaskStore) prune() {
	if s.Max <= 0 || len(s.byID) <= s.Max {
		return
	}
	kept := s.order[:0]
	over := len(s.byID) - s.Max
	for _, id := range s.order {
		t := s.byID[id]
		if over > 0 && t != nil && t.Status.terminal() {
			delete(s.byID, id)
			over--
			continue
		}
		kept = append(kept, id)
	}
	s.order = kept
}

// Get returns a snapshot of one task.
func (s *TaskStore) Get(id string) (TaskView, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.byID[id]
	if !ok {
		return TaskView{}, false
	}
	return t.view(), true
}

// view renders a task. Called with the store's lock held.
func (t *Task) view() TaskView {
	v := TaskView{
		ID:             t.ID,
		ConversationID: t.ConversationID,
		Status:         t.Status,
		CreatedAt:      t.Created,
		UpdatedAt:      t.Updated,
	}
	switch t.Status {
	case StatusNeedsInput:
		v.Question = t.Question
	case StatusDone:
		v.Result = t.Result
	case StatusFailed:
		v.Error = t.Error
	}
	if t.Status != StatusAccepted {
		v.DetailURL = "/v1/conversations/" + t.ConversationID + "/transcript"
	}
	return v
}

// Meta reports the immutable half of a task: who sent it and as which OS
// user. The cancel endpoint needs both — the actor to decide whether this
// caller may stop it, and the OS user to send the interrupt as.
func (s *TaskStore) Meta(id string) (actor, osUser string, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, found := s.byID[id]
	if !found {
		return "", "", false
	}
	return t.Actor, t.OSUser, true
}

// Update applies a status change, and reports whether it took. A refused
// transition is not an error to anybody: the runner races the cancel endpoint
// by design, and whichever writes a terminal status first wins.
func (s *TaskStore) Update(id string, next TaskStatus, apply func(*Task)) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.byID[id]
	if !ok || !t.Status.canGo(next) {
		return false
	}
	t.Status = next
	t.Updated = s.Now()
	if apply != nil {
		apply(t)
	}
	return true
}

// Cancel moves a task to cancelled and closes its cancel channel. It reports
// whether this call is the one that cancelled it, and whether the task was
// already running — the caller needs the second to decide whether there is a
// turn in flight to interrupt.
func (s *TaskStore) Cancel(id string) (cancelled, wasLive bool) {
	s.mu.Lock()
	t, ok := s.byID[id]
	if !ok || !t.Status.canGo(StatusCancelled) {
		s.mu.Unlock()
		return false, false
	}
	wasLive = t.Status == StatusRunning || t.Status == StatusNeedsInput
	t.Status = StatusCancelled
	t.Updated = s.Now()
	ch := t.cancel
	once := &t.cancelOnce
	s.mu.Unlock()
	once.Do(func() { close(ch) })
	return true, wasLive
}

// Cancelled is the channel a task's runner watches. Closed means give up.
func (s *TaskStore) Cancelled(id string) <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	if t, ok := s.byID[id]; ok {
		return t.cancel
	}
	closed := make(chan struct{})
	close(closed)
	return closed
}
