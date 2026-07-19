package main

import (
	"context"
	"strconv"
	"sync"
	"time"
)

// Permission decisions map to Claude Code's PreToolUse hook `permissionDecision`.
const (
	DecisionAllow = "allow"
	DecisionDeny  = "deny"
	DecisionAsk   = "ask"
)

// PermissionBroker mediates Claude Code permission prompts between the blocking
// PreToolUse hook and the web client. Safety contract:
//   - a web decision resolves the wait (allow/deny),
//   - the deadline elapsing → deny (FAIL-CLOSED),
//   - no text-mode client watching → ask (FALL THROUGH to the terminal prompt).
type PermissionBroker struct {
	mu       sync.Mutex
	pending  map[string]chan string
	seq      int
	hasSub   func(session string) bool
	emit     func(Event)
	deadline time.Duration
}

func NewPermissionBroker(hasSub func(string) bool, emit func(Event), deadline time.Duration) *PermissionBroker {
	return &PermissionBroker{pending: map[string]chan string{}, hasSub: hasSub, emit: emit, deadline: deadline}
}

func (b *PermissionBroker) register() (string, chan string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.seq++
	id := "perm-" + strconv.Itoa(b.seq)
	ch := make(chan string, 1)
	b.pending[id] = ch
	return id, ch
}

func (b *PermissionBroker) drop(id string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.pending, id)
}

// Request blocks for the web client's decision. Returns "ask" immediately when no
// client is watching (so the terminal prompt handles it), and "deny" if the
// deadline or context expires first (fail-closed).
func (b *PermissionBroker) Request(ctx context.Context, session, tool, input string) string {
	if b.hasSub == nil || !b.hasSub(session) {
		return DecisionAsk
	}
	id, ch := b.register()
	defer b.drop(id)
	if b.emit != nil {
		b.emit(Event{Kind: KindPermissionRequest, Session: session, Tool: tool, Body: input, ReqID: id})
	}
	select {
	case d := <-ch:
		if b.emit != nil {
			b.emit(Event{Kind: KindPermissionResolved, Session: session, Tool: tool, ReqID: id, Body: d})
		}
		return d
	case <-time.After(b.deadline):
		return DecisionDeny
	case <-ctx.Done():
		return DecisionDeny
	}
}

// Resolve delivers a decision to a waiting Request. Returns false if the id is
// unknown (already resolved, timed out, or never existed).
func (b *PermissionBroker) Resolve(id, decision string) bool {
	b.mu.Lock()
	ch, ok := b.pending[id]
	b.mu.Unlock()
	if !ok {
		return false
	}
	select {
	case ch <- decision:
		return true
	default:
		return false
	}
}
