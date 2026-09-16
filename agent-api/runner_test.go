package main

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// waitIdle blocks until the runner has nothing left, or fails the test.
func waitIdle(t *testing.T, r *Runner) {
	t.Helper()
	select {
	case <-r.Idle():
	case <-time.After(5 * time.Second):
		t.Fatal("runner did not go idle")
	}
}

// The property the whole file exists for: two messages to ONE conversation
// never overlap. Asserted by counting concurrent turns rather than by timing,
// so a slow machine cannot make it pass by accident.
func TestRunnerSerialisesOneConversation(t *testing.T) {
	var inFlight, maxInFlight int32
	var order []string
	var mu sync.Mutex

	r := NewRunner(func(task *Task) {
		n := atomic.AddInt32(&inFlight, 1)
		for {
			m := atomic.LoadInt32(&maxInFlight)
			if n <= m || atomic.CompareAndSwapInt32(&maxInFlight, m, n) {
				break
			}
		}
		mu.Lock()
		order = append(order, task.ID)
		mu.Unlock()
		time.Sleep(5 * time.Millisecond)
		atomic.AddInt32(&inFlight, -1)
	})

	for _, id := range []string{"a", "b", "c", "d"} {
		r.Submit(&Task{ID: id, ConversationID: "same"})
	}
	waitIdle(t, r)

	if got := atomic.LoadInt32(&maxInFlight); got != 1 {
		t.Fatalf("%d turns ran at once in one conversation, want 1", got)
	}
	mu.Lock()
	defer mu.Unlock()
	want := []string{"a", "b", "c", "d"}
	if len(order) != len(want) {
		t.Fatalf("ran %v, want %v", order, want)
	}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("ran %v, want %v — a queue must be FIFO", order, want)
		}
	}
}

// The other half: different conversations do not wait for each other. Every
// turn blocks until all of them have started, so the test deadlocks rather
// than passing if they are serialised.
func TestRunnerRunsConversationsConcurrently(t *testing.T) {
	const n = 4
	var wg sync.WaitGroup
	wg.Add(n)
	started := make(chan struct{})
	var once sync.Once
	var arrived int32

	r := NewRunner(func(*Task) {
		if atomic.AddInt32(&arrived, 1) == n {
			once.Do(func() { close(started) })
		}
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			t.Error("turns in different conversations were serialised")
		}
		wg.Done()
	})

	for _, id := range []string{"c1", "c2", "c3", "c4"} {
		r.Submit(&Task{ID: "t-" + id, ConversationID: id})
	}
	wg.Wait()
	waitIdle(t, r)
}

// A message arriving while a turn is already running queues behind it rather
// than interleaving, and the endpoint can see how deep the queue is.
func TestRunnerAhead(t *testing.T) {
	release := make(chan struct{})
	entered := make(chan struct{}, 1)
	r := NewRunner(func(*Task) {
		select {
		case entered <- struct{}{}:
		default:
		}
		<-release
	})

	r.Submit(&Task{ID: "first", ConversationID: "c"})
	<-entered // the first turn is in flight

	r.Submit(&Task{ID: "second", ConversationID: "c"})
	r.Submit(&Task{ID: "third", ConversationID: "c"})
	// Three outstanding: one running, two waiting.
	if got := r.Ahead("c"); got != 3 {
		t.Fatalf("Ahead = %d, want 3", got)
	}
	if got := r.Ahead("other"); got != 0 {
		t.Fatalf("Ahead(other) = %d, want 0", got)
	}

	close(release)
	waitIdle(t, r)
	if got := r.Ahead("c"); got != 0 {
		t.Fatalf("Ahead after drain = %d, want 0", got)
	}
}

// A drained conversation leaves nothing behind. A service that talks to
// thousands of conversations over its life must not keep a struct per
// conversation it has ever seen.
func TestRunnerForgetsDrainedConversations(t *testing.T) {
	r := NewRunner(func(*Task) {})
	for i := 0; i < 50; i++ {
		r.Submit(&Task{ID: "t", ConversationID: string(rune('a' + i%26))})
	}
	waitIdle(t, r)
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.queues) != 0 {
		t.Fatalf("%d queues left after draining", len(r.queues))
	}
}

// Idle on a runner that never ran anything is already closed, so a caller
// cannot hang waiting for work that does not exist.
func TestRunnerIdleWhenEmpty(t *testing.T) {
	r := NewRunner(func(*Task) {})
	select {
	case <-r.Idle():
	default:
		t.Fatal("a runner with no work was not idle")
	}
}
