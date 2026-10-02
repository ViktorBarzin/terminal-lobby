package main

import (
	"context"
	"sync"
	"testing"
	"time"

	"terminal-lobby/sessionio"
	"terminal-lobby/sessionio/siotest"
)

// panes is a fake tmux pane table: which session a pane is in now.
type panes struct {
	mu sync.Mutex
	in map[string]string
}

func (p *panes) set(pane, session string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.in[pane] = session
}

func (p *panes) session(_, pane string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.in[pane]
}

// tmux-api's autotitle renames a session a few seconds into its first turn,
// and the mod learns the new name only at its next turn start. Measured live
// on 2026-10-02: every write after the rename went to the old name and
// failed, @claude_state stayed running after the turn ended, and the agent
// API's task for that turn never settled. The writes follow the pane instead,
// and the mod is asked to say hello again under the new name.
func TestModWritesFollowARenamedSession(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	opts := siotest.NewFakeOptions("wizard/demo")
	rg := newRegistry(ctx, time.Millisecond, t.TempDir(), opts, "wizard")
	tbl := &panes{in: map[string]string{"%3": "demo"}}
	rg.mods.paneSession = tbl.session

	token, _ := rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	c := rg.mods.conn("wizard", "demo")
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModTurnStartEvent, TurnID: "t1"}})
	if st, _ := opts.Option("wizard", "demo", sessionio.OptionState); st != sessionio.StateRunning {
		t.Fatalf("state %q before the rename, want running", st)
	}

	opts.Rename("wizard", "demo", "pong-response")
	tbl.set("%3", "pong-response")
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModTurnEndEvent, TurnID: "t1", Answer: "PONG"}})

	if st, _ := opts.Option("wizard", "pong-response", sessionio.OptionState); st != sessionio.StateDone {
		t.Fatalf("state %q on the renamed session, want done", st)
	}
	if reply, _ := opts.Option("wizard", "pong-response", optReply); reply == "" {
		t.Fatal("the reply was not stamped on the renamed session")
	}
	if rg.mods.byTokenOf(token) != nil {
		t.Fatal("the mod's token still works, so it will not say hello under the new name")
	}

	// The mod's hello under the new name takes the connection over.
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "pong-response", Pane: "%3"})
	if rg.mods.conn("wizard", "pong-response") != c {
		t.Fatal("the hello under the new name did not keep the connection")
	}
	if rg.mods.conn("wizard", "demo") != nil {
		t.Fatal("the old name still resolves to the connection")
	}
}

// A session that is gone, rather than renamed, is not followed anywhere.
func TestModWritesToAGoneSessionStayFailed(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	opts := siotest.NewFakeOptions("wizard/demo")
	rg := newRegistry(ctx, time.Millisecond, t.TempDir(), opts, "wizard")
	tbl := &panes{in: map[string]string{"%3": "demo"}}
	rg.mods.paneSession = tbl.session

	token, _ := rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	c := rg.mods.conn("wizard", "demo")
	opts.Kill("wizard", "demo")
	tbl.set("%3", "")
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModTurnStartEvent, TurnID: "t1"}})
	if rg.mods.byTokenOf(token) == nil {
		t.Fatal("a gone session revoked the mod's token")
	}
}
