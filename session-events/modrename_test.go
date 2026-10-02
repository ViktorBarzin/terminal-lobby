package main

import (
	"context"
	"net/http"
	"net/http/httptest"
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

// sessionPanes lists the panes in a session, the inverse of session.
func (p *panes) sessionPanes(_, session string) []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out []string
	for pane, s := range p.in {
		if s == session {
			out = append(out, pane)
		}
	}
	return out
}

// tmux-api's autotitle renames a Muse session two seconds after its only
// turn ends, so no write follows the rename to notice it. Measured live on
// 2026-10-02: the Text view on the new name answered `nomod` for minutes,
// until a second turn made the mod say hello again. Opening the new name
// asks the mod in that session's pane to say hello again, and the stream
// opens on it.
func TestOpeningARenamedSessionFollowsItsMod(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	opts := siotest.NewFakeOptions("wizard/rv-ui")
	rg := newRegistry(ctx, time.Millisecond, t.TempDir(), opts, "wizard")
	tbl := &panes{in: map[string]string{"%3": "rv-ui", "%4": "other"}}
	rg.mods.paneSession = tbl.session
	rg.mods.sessionPanes = tbl.sessionPanes

	token, _ := rg.mods.hello("wizard", modHello{SID: "sid1", Session: "rv-ui", Pane: "%3"})
	c := rg.mods.conn("wizard", "rv-ui")

	// The mod as it runs: long-poll, and say hello again under the pane's
	// current name when the poll is refused.
	go func() {
		for ctx.Err() == nil {
			req := httptest.NewRequest("GET", "/mod/v1/poll?token="+token, nil).WithContext(ctx)
			rec := httptest.NewRecorder()
			rg.mods.handlePoll()(rec, req)
			if rec.Code == http.StatusConflict {
				token, _ = rg.mods.hello("wizard", modHello{SID: "sid1", Session: tbl.session("wizard", "%3"), Pane: "%3"})
			}
		}
	}()

	opts.Rename("wizard", "rv-ui", "kumquat")
	tbl.set("%3", "kumquat")

	ls, ok := rg.mods.follow(ctx, "wizard", "kumquat", 2*time.Second)
	if !ok || ls == nil {
		t.Fatal("the renamed session has no stream after the follow")
	}
	if rg.mods.conn("wizard", "kumquat") != c {
		t.Fatal("the new name does not resolve to the session's connection")
	}
	if rg.mods.conn("wizard", "rv-ui") != nil {
		t.Fatal("the old name still resolves to the connection")
	}
}

// A session no mod's pane is in is not followed: the stream says nomod as
// before, without waiting.
func TestOpeningASessionWithNoModPaneDoesNotWait(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	opts := siotest.NewFakeOptions("wizard/demo", "wizard/shell")
	rg := newRegistry(ctx, time.Millisecond, t.TempDir(), opts, "wizard")
	tbl := &panes{in: map[string]string{"%3": "demo", "%9": "shell"}}
	rg.mods.paneSession = tbl.session
	rg.mods.sessionPanes = tbl.sessionPanes
	token, _ := rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})

	start := time.Now()
	if _, ok := rg.mods.follow(ctx, "wizard", "shell", 5*time.Second); ok {
		t.Fatal("a session no mod is in resolved")
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("the miss waited %s", d)
	}
	if rg.mods.byTokenOf(token) == nil {
		t.Fatal("an unrelated mod's token was revoked")
	}
}
