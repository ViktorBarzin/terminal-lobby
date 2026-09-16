package main

import (
	"testing"
	"time"
)

// Every ordered pair of statuses, stated once. A transition table is the kind
// of thing that drifts silently when somebody adds a status, so the table
// names the whole matrix rather than the interesting half.
func TestTaskStatusTransitions(t *testing.T) {
	all := []TaskStatus{
		StatusAccepted, StatusRunning, StatusNeedsInput,
		StatusDone, StatusFailed, StatusCancelled,
	}
	allowed := map[TaskStatus]map[TaskStatus]bool{
		StatusAccepted: {
			StatusRunning: true, StatusNeedsInput: true,
			StatusDone: true, StatusFailed: true, StatusCancelled: true,
		},
		StatusRunning: {
			StatusNeedsInput: true,
			StatusDone:       true, StatusFailed: true, StatusCancelled: true,
		},
		StatusNeedsInput: {
			StatusRunning: true,
			StatusDone:    true, StatusFailed: true, StatusCancelled: true,
		},
		StatusDone:      {},
		StatusFailed:    {},
		StatusCancelled: {},
	}
	for _, from := range all {
		for _, to := range all {
			want := allowed[from][to]
			if got := from.canGo(to); got != want {
				t.Errorf("%s -> %s = %v, want %v", from, to, got, want)
			}
		}
	}
}

func TestTaskStatusTerminal(t *testing.T) {
	for _, c := range []struct {
		s    TaskStatus
		want bool
	}{
		{StatusAccepted, false},
		{StatusRunning, false},
		{StatusNeedsInput, false},
		{StatusDone, true},
		{StatusFailed, true},
		{StatusCancelled, true},
	} {
		if got := c.s.terminal(); got != c.want {
			t.Errorf("%s.terminal() = %v, want %v", c.s, got, c.want)
		}
	}
}

// A clock a test drives, so updated_at is asserted rather than slept for.
type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time { c.t = c.t.Add(time.Second); return c.t }

func TestTaskStoreLifecycle(t *testing.T) {
	clock := &fakeClock{t: time.Date(2026, 9, 16, 12, 0, 0, 0, time.UTC)}
	store := NewTaskStore(clock.now)
	store.Add(&Task{ID: "t1", ConversationID: "c1", Actor: "muse", Text: "hello"})

	v, ok := store.Get("t1")
	if !ok {
		t.Fatal("task not found after Add")
	}
	if v.Status != StatusAccepted {
		t.Fatalf("status %q, want accepted", v.Status)
	}
	// accepted carries no detail_url: there is nothing to read yet.
	if v.DetailURL != "" {
		t.Fatalf("accepted task has detail_url %q", v.DetailURL)
	}

	if !store.Update("t1", StatusRunning, nil) {
		t.Fatal("accepted -> running refused")
	}
	v, _ = store.Get("t1")
	if v.DetailURL != "/v1/conversations/c1/transcript" {
		t.Fatalf("detail_url %q", v.DetailURL)
	}
	if !v.UpdatedAt.After(v.CreatedAt) {
		t.Fatal("updated_at did not move")
	}

	if !store.Update("t1", StatusNeedsInput, func(tk *Task) { tk.Question = "Approve?" }) {
		t.Fatal("running -> needs_input refused")
	}
	v, _ = store.Get("t1")
	if v.Question != "Approve?" {
		t.Fatalf("question %q", v.Question)
	}
	if v.Result != "" || v.Error != "" {
		t.Fatalf("needs_input leaked result/error: %+v", v)
	}

	if !store.Update("t1", StatusDone, func(tk *Task) { tk.Result = "finished" }) {
		t.Fatal("needs_input -> done refused")
	}
	v, _ = store.Get("t1")
	if v.Result != "finished" {
		t.Fatalf("result %q", v.Result)
	}
	// The question was answered; reporting it alongside a result would tell a
	// poller the turn is still blocked.
	if v.Question != "" {
		t.Fatalf("done still carries question %q", v.Question)
	}

	if store.Update("t1", StatusRunning, nil) {
		t.Fatal("a done task went back to running")
	}
}

// A cancel arriving after the turn finished changes nothing, and a turn
// finishing after a cancel does not undo it. Both directions, because the
// runner and the cancel endpoint genuinely race.
func TestTaskStoreCancelRaces(t *testing.T) {
	t.Run("cancel then finish", func(t *testing.T) {
		store := NewTaskStore(nil)
		store.Add(&Task{ID: "t", ConversationID: "c"})
		store.Update("t", StatusRunning, nil)

		cancelled, wasLive := store.Cancel("t")
		if !cancelled || !wasLive {
			t.Fatalf("Cancel = (%v, %v), want (true, true)", cancelled, wasLive)
		}
		if store.Update("t", StatusDone, func(tk *Task) { tk.Result = "too late" }) {
			t.Fatal("a cancelled task was marked done")
		}
		v, _ := store.Get("t")
		if v.Status != StatusCancelled || v.Result != "" {
			t.Fatalf("view %+v", v)
		}
	})

	t.Run("finish then cancel", func(t *testing.T) {
		store := NewTaskStore(nil)
		store.Add(&Task{ID: "t", ConversationID: "c"})
		store.Update("t", StatusRunning, nil)
		store.Update("t", StatusDone, nil)

		if cancelled, _ := store.Cancel("t"); cancelled {
			t.Fatal("a finished task was cancelled")
		}
	})

	t.Run("cancel before it starts", func(t *testing.T) {
		store := NewTaskStore(nil)
		store.Add(&Task{ID: "t", ConversationID: "c"})
		cancelled, wasLive := store.Cancel("t")
		if !cancelled {
			t.Fatal("a queued task could not be cancelled")
		}
		if wasLive {
			t.Fatal("a queued task reported a turn in flight")
		}
	})

	t.Run("cancel twice", func(t *testing.T) {
		store := NewTaskStore(nil)
		store.Add(&Task{ID: "t", ConversationID: "c"})
		store.Cancel("t")
		if cancelled, _ := store.Cancel("t"); cancelled {
			t.Fatal("the second cancel also claimed to cancel")
		}
	})
}

// The cancel channel is what stops a poll loop. It closes exactly once,
// however many times Cancel is called.
func TestTaskStoreCancelChannel(t *testing.T) {
	store := NewTaskStore(nil)
	store.Add(&Task{ID: "t", ConversationID: "c"})
	ch := store.Cancelled("t")
	select {
	case <-ch:
		t.Fatal("cancel channel was closed before any cancel")
	default:
	}
	store.Cancel("t")
	store.Cancel("t")
	select {
	case <-ch:
	default:
		t.Fatal("cancel channel did not close")
	}
	// An unknown id yields an already-closed channel, so a runner whose task
	// was pruned gives up rather than blocking forever.
	select {
	case <-store.Cancelled("nope"):
	default:
		t.Fatal("unknown task's cancel channel is open")
	}
}

// The store forgets the oldest FINISHED tasks and never a live one.
func TestTaskStorePrune(t *testing.T) {
	store := NewTaskStore(nil)
	store.Max = 3

	store.Add(&Task{ID: "old-done", ConversationID: "c"})
	store.Update("old-done", StatusDone, nil)
	store.Add(&Task{ID: "old-live", ConversationID: "c"})
	store.Update("old-live", StatusRunning, nil)
	store.Add(&Task{ID: "mid-done", ConversationID: "c"})
	store.Update("mid-done", StatusFailed, nil)
	store.Add(&Task{ID: "new-a", ConversationID: "c"})
	store.Add(&Task{ID: "new-b", ConversationID: "c"})

	if _, ok := store.Get("old-done"); ok {
		t.Error("the oldest terminal task survived the prune")
	}
	if _, ok := store.Get("old-live"); !ok {
		t.Error("a running task was pruned")
	}
	for _, id := range []string{"new-a", "new-b"} {
		if _, ok := store.Get(id); !ok {
			t.Errorf("%s was pruned", id)
		}
	}
}

func TestTaskStoreGetUnknown(t *testing.T) {
	store := NewTaskStore(nil)
	if _, ok := store.Get("nope"); ok {
		t.Fatal("an unknown task id was found")
	}
	if store.Update("nope", StatusRunning, nil) {
		t.Fatal("an unknown task id was updated")
	}
}
