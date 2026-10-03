package main

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"terminal-lobby/sessionio"
	"terminal-lobby/sessionio/siotest"
)

// steerFixture is a session whose mod has said hello naming its transcript,
// with one subagent file, a1, in the session directory.
func steerFixture(t *testing.T, ops []string) (*registry, http.Handler) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	homeBase := t.TempDir()
	rg := newRegistry(ctx, time.Millisecond, homeBase, siotest.NewFakeOptions("wizard/demo"), "wizard")
	rg.agentEvery = 5 * time.Millisecond
	transcript := writeTranscript(t, homeBase, "wizard", "/w", "sid1", "MARKER-STEER")
	writeAgent(t, sessionio.SessionDir(transcript), "subagents", "a1", `{"description":"count"}`, []string{
		userLine("a1", 0, "count to five"),
	}, time.Now())
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3", CWD: "/w", Transcript: transcript, Ops: ops})
	mux := http.NewServeMux()
	mux.HandleFunc("POST /events/{session}/agents/{agent}/message", rg.handleSteer())
	return rg, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mux.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), osUserKey, "wizard")))
	})
}

// answeringMod acks every command with ack, and collects them.
func answeringMod(t *testing.T, c *modConn, ack modAck) func() []modCommand {
	t.Helper()
	got := make(chan modCommand, 64)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			c.mu.Lock()
			cmds := c.cmds
			c.cmds = nil
			c.mu.Unlock()
			for _, cmd := range cmds {
				got <- cmd
				c.deliver(cmd.ID, ack)
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Millisecond):
			}
		}
	}()
	t.Cleanup(func() { cancel(); <-done })
	return func() []modCommand {
		var out []modCommand
		for {
			select {
			case cmd := <-got:
				out = append(out, cmd)
			default:
				return out
			}
		}
	}
}

var steerOps = []string{"prompt", "abort", "answer", "decide", "model", "history", "steer"}

func TestASteerGoesToTheModNamingTheAgent(t *testing.T) {
	rg, h := steerFixture(t, steerOps)
	sent := answeringMod(t, rg.mods.conn("wizard", "demo"), modAck{OK: true})
	rec := serve(h, internalReq("POST", "/events/demo/agents/a1/message", `{"text":"stop and report"}`))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status %d (%s), want 204", rec.Code, rec.Body.String())
	}
	cmds := sent()
	if len(cmds) != 1 || cmds[0].Op != "steer" || cmds[0].AgentID != "a1" || cmds[0].Text != "stop and report" {
		t.Fatalf("mod got %+v", cmds)
	}
}

func TestASteerTheModRefusesSaysWhy(t *testing.T) {
	for _, c := range []struct {
		ack  string
		want int
	}{
		{"finished: this agent has finished", http.StatusConflict},
		{"not-addressable: workflow members cannot be messaged", http.StatusConflict},
		{"no agent by that id", http.StatusBadGateway},
	} {
		rg, h := steerFixture(t, steerOps)
		answeringMod(t, rg.mods.conn("wizard", "demo"), modAck{OK: false, Error: c.ack})
		rec := serve(h, internalReq("POST", "/events/demo/agents/a1/message", `{"text":"hi"}`))
		if rec.Code != c.want || !strings.Contains(rec.Body.String(), c.ack[strings.Index(c.ack, " ")+1:]) {
			t.Errorf("ack %q: status %d (%s), want %d with the reason", c.ack, rec.Code, rec.Body.String(), c.want)
		}
	}
}

// A session started before the mod learned to steer is told so up front:
// nothing is sent that it would only refuse.
func TestASteerToAModThatCannotSteerIsRefusedUpFront(t *testing.T) {
	rg, h := steerFixture(t, nil)
	sent := answeringMod(t, rg.mods.conn("wizard", "demo"), modAck{OK: true})
	rec := serve(h, internalReq("POST", "/events/demo/agents/a1/message", `{"text":"hi"}`))
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("status %d, want 501", rec.Code)
	}
	if got := sent(); len(got) != 0 {
		t.Fatalf("the mod was sent %+v", got)
	}
}

func TestASteerIsRefusedForWhatTheSessionDoesNotHold(t *testing.T) {
	rg, h := steerFixture(t, steerOps)
	sent := answeringMod(t, rg.mods.conn("wizard", "demo"), modAck{OK: true})
	for path, want := range map[string]int{
		"/events/demo/agents/zz9/message":   http.StatusNotFound,
		"/events/demo/agents/..%2F/message": http.StatusBadRequest,
		"/events/other/agents/a1/message":   http.StatusServiceUnavailable,
	} {
		if rec := serve(h, internalReq("POST", path, `{"text":"hi"}`)); rec.Code != want {
			t.Errorf("%s: status %d (%s), want %d", path, rec.Code, rec.Body.String(), want)
		}
	}
	if rec := serve(h, internalReq("POST", "/events/demo/agents/a1/message", `{"text":"  "}`)); rec.Code != http.StatusBadRequest {
		t.Errorf("an empty message: status %d, want 400", rec.Code)
	}
	if got := sent(); len(got) != 0 {
		t.Fatalf("the mod was sent %+v", got)
	}
}

func TestSteerabilityFollowsTheEngineFirst(t *testing.T) {
	running := sessionio.AgentInfo{ID: "a1", State: sessionio.AgentRunning}
	done := sessionio.AgentInfo{ID: "a1", State: sessionio.AgentDone}
	member := sessionio.AgentInfo{ID: "m1", State: sessionio.AgentRunning, WorkflowID: "wf_r1"}
	listed := func(status, typ string) map[string]sessionio.ModAgent {
		return map[string]sessionio.ModAgent{"a1": {ID: "a1", Status: status, Type: typ}}
	}
	cases := []struct {
		name     string
		info     sessionio.AgentInfo
		engine   map[string]sessionio.ModAgent
		canSteer bool
		want     bool
		note     string
	}{
		{"running in the engine and on disk", running, listed("running", "general-purpose"), true, true, ""},
		// The mod reports the list as a turn completes, while the engine still
		// calls the subagent running (measured live, 2026-10-03): the file's
		// ended turn is the truer word for a plain subagent.
		{"a subagent the engine has not caught up on", done, listed("running", "general-purpose"), true, false, sessionio.SteerFinished},
		{"an idle teammate the engine still runs", done, listed("running", "teammate"), true, true, ""},
		{"completed in the engine", running, listed("completed", "general-purpose"), true, false, sessionio.SteerFinished},
		{"not listed yet, running on disk", running, nil, true, true, ""},
		{"not listed, done on disk", done, nil, true, false, sessionio.SteerFinished},
		{"a workflow member", member, nil, true, false, sessionio.SteerWorkflow},
		{"a mod that cannot steer", running, listed("running", "general-purpose"), false, false, sessionio.SteerOldMod},
	}
	for _, c := range cases {
		ok, note := steerability(c.info, c.engine, c.canSteer)
		if ok != c.want || note != c.note {
			t.Errorf("%s: steerable %v %q, want %v %q", c.name, ok, note, c.want, c.note)
		}
	}
}

// The agent set the stream carries says which agents can be messaged, from
// the engine's own list as the mod reports it.
func TestTheAgentSetSaysWhichAgentsCanBeSteered(t *testing.T) {
	rg, _ := steerFixture(t, steerOps)
	c := rg.mods.conn("wizard", "demo")
	c.mu.Lock()
	aw := c.ls.agents
	c.mu.Unlock()
	sig, release := aw.Subscribe()
	defer release()
	aw.SetEngine([]sessionio.ModAgent{{ID: "a1", Status: "completed", Type: "general-purpose"}})
	deadline := time.After(3 * time.Second)
	for {
		set, _, ok := aw.Current()
		if ok && len(set.Agents) == 1 && set.Agents[0].SteerNote == sessionio.SteerFinished && !set.Agents[0].Steerable {
			break
		}
		select {
		case <-sig:
		case <-deadline:
			t.Fatalf("set never said a1 is finished: %+v", set)
		}
	}
	aw.SetEngine([]sessionio.ModAgent{{ID: "a1", Status: "running", Type: "general-purpose"}})
	for {
		set, _, ok := aw.Current()
		if ok && len(set.Agents) == 1 && set.Agents[0].Steerable {
			return
		}
		select {
		case <-sig:
		case <-deadline:
			t.Fatalf("set never said a1 can be steered: %+v", set)
		}
	}
}
