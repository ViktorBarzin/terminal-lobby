package main

import (
	"context"
	"testing"
	"time"
)

// Case (b): a web decision resolves the wait.
func TestPermissionResolveAllow(t *testing.T) {
	emitted := make(chan Event, 8)
	b := NewPermissionBroker(time.Second)

	got := make(chan string, 1)
	go func() {
		got <- b.Request(context.Background(), "demo", "Bash", `{"command":"ls"}`, true, func(e Event) { emitted <- e })
	}()

	var reqID string
	select {
	case e := <-emitted:
		if e.Kind != KindPermissionRequest || e.Tool != "Bash" || e.ReqID == "" {
			t.Fatalf("bad permission_request event: %+v", e)
		}
		reqID = e.ReqID
	case <-time.After(time.Second):
		t.Fatal("no permission_request emitted")
	}

	if !b.Resolve(reqID, DecisionAllow) {
		t.Fatal("Resolve returned false for a live request")
	}
	select {
	case d := <-got:
		if d != DecisionAllow {
			t.Fatalf("decision = %q, want allow", d)
		}
	case <-time.After(time.Second):
		t.Fatal("Request did not return after Resolve")
	}
	select {
	case e := <-emitted:
		if e.Kind != KindPermissionResolved || e.ReqID != reqID || e.Body != DecisionAllow {
			t.Fatalf("bad permission_resolved event: %+v", e)
		}
	case <-time.After(time.Second):
		t.Fatal("no permission_resolved emitted")
	}
}

// Case (c): no text client watching → ask (terminal prompt handles it), no emit.
func TestPermissionFallThroughNoSubscriber(t *testing.T) {
	b := NewPermissionBroker(time.Second)
	emit := func(Event) { t.Fatal("must not emit when no subscriber") }
	if d := b.Request(context.Background(), "demo", "Bash", "{}", false, emit); d != DecisionAsk {
		t.Fatalf("want ask (fall through), got %q", d)
	}
}

// Case (d): subscriber present but no answer by the deadline → deny (fail-closed).
func TestPermissionFailClosedOnDeadline(t *testing.T) {
	b := NewPermissionBroker(40 * time.Millisecond)
	if d := b.Request(context.Background(), "demo", "Bash", "{}", true, func(Event) {}); d != DecisionDeny {
		t.Fatalf("want deny (fail-closed), got %q", d)
	}
}

// Resolving an unknown id is a no-op.
func TestPermissionResolveUnknown(t *testing.T) {
	b := NewPermissionBroker(time.Second)
	if b.Resolve("perm-999", DecisionAllow) {
		t.Fatal("Resolve of unknown id should return false")
	}
}
