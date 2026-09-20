package main

import "testing"

// The push sender's half of a state a PERSON set by hand (session_state.go).
// The helpers are pushsender_test.go's.

// noManualHolds isolates a test from the process-wide correction queue, which
// the state handler writes to and tick spends.
func noManualHolds(t *testing.T) {
	t.Helper()
	clear := func() {
		manualStates.Lock()
		manualStates.m = nil
		manualStates.Unlock()
	}
	clear()
	t.Cleanup(clear)
}

// A state a PERSON set by hand does not ring their phone. Marking a stuck
// session done is a running→done edge like any other, and the one thing the
// owner of that edge already knows is that it happened.
//
// It is held the way an already-notified session is held, so the same
// engagement clears it: submitting to the session puts it back to running, and
// the completion after that rings.
func TestPushSenderHoldsAStateAPersonSetByHand(t *testing.T) {
	noManualHolds(t)
	rec := &pushRecorder{hits: map[string]int{}}
	srv := rec.server(t)
	store := newPushStore(t.TempDir())
	_ = store.upsert("alice", pushSubscription{Endpoint: srv.URL + "/d", Keys: genSubKeys(t)})
	stub := &stubStater{}
	sender := newPushSender(store, stubPrefs{}, stub, testVAPID(t))

	stub.set(map[string]string{"main": stateRunning})
	sender.tick()

	// The dot reads Working with nothing working, and somebody corrects it.
	holdManualPush("alice", "main", stateDone)
	stub.set(map[string]string{"main": stateDone})
	sender.tick()
	if got := rec.total(); got != 0 {
		t.Fatalf("a correction rang %d times, want 0", got)
	}

	// Engaging with it re-arms the session, and the next real completion rings.
	stub.set(map[string]string{"main": stateRunning})
	sender.tick()
	stub.set(map[string]string{"main": stateDone})
	sender.tick()
	if got := rec.hit("/d"); got != 1 {
		t.Fatalf("the next real completion: got %d, want 1", got)
	}
}

// The hold waits for the state to REACH a read. The stamp and this poll are
// not ordered, so a tick whose read went out first must not spend the mark on
// the state the session is still reported as being in — it would burn the hold
// and ring on the very next tick.
func TestPushSenderHoldSurvivesAPollThatMissedTheStamp(t *testing.T) {
	noManualHolds(t)
	rec := &pushRecorder{hits: map[string]int{}}
	srv := rec.server(t)
	store := newPushStore(t.TempDir())
	_ = store.upsert("alice", pushSubscription{Endpoint: srv.URL + "/d", Keys: genSubKeys(t)})
	stub := &stubStater{}
	sender := newPushSender(store, stubPrefs{}, stub, testVAPID(t))

	stub.set(map[string]string{"main": stateRunning})
	sender.tick()

	holdManualPush("alice", "main", stateDone)
	// This tick's read predates the stamp: the session still reads running.
	sender.tick()
	// And now it lands.
	stub.set(map[string]string{"main": stateDone})
	sender.tick()
	if got := rec.total(); got != 0 {
		t.Fatalf("the hold was spent on the wrong poll: rang %d times, want 0", got)
	}
}

// A mark for a session that has left the list is dropped rather than kept for
// a name that may never come back.
func TestManualHoldIsDroppedWithTheSession(t *testing.T) {
	noManualHolds(t)
	store := newPushStore(t.TempDir())
	_ = store.upsert("alice", pushSubscription{Endpoint: "https://example.invalid/d", Keys: genSubKeys(t)})
	stub := &stubStater{}
	sender := newPushSender(store, stubPrefs{}, stub, testVAPID(t))

	holdManualPush("alice", "killed", stateDone)
	stub.set(map[string]string{"main": stateRunning})
	sender.tick()

	manualStates.Lock()
	held := len(manualStates.m["alice"])
	manualStates.Unlock()
	if held != 0 {
		t.Errorf("the queue still holds %d correction(s) for a session that is gone", held)
	}
}

// Running is never queued: it fires no push, and the same loop clears an
// outstanding mark the moment a session goes back to running, so a mark for it
// could only silence a later completion that nobody corrected.
func TestManualHoldIgnoresRunning(t *testing.T) {
	noManualHolds(t)
	holdManualPush("alice", "main", stateRunning)
	manualStates.Lock()
	held := len(manualStates.m["alice"])
	manualStates.Unlock()
	if held != 0 {
		t.Errorf("running was queued (%d held), and it has no edge to hold", held)
	}
}
