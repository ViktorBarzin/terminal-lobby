package main

import (
	"context"
	"testing"
	"time"

	"terminal-lobby/sessionio"
	"terminal-lobby/sessionio/siotest"
)

// A session's agents are watched beside its transcript, from the directory
// Claude Code keeps next to it, and an agent spawned while somebody is
// watching appears without anything being restarted.
func TestRegistryWatchesTheAgentsOfAWatchedSession(t *testing.T) {
	const (
		osUser = "wizard"
		cwd    = "/home/wizard/qa"
		tmux   = "qa-agents"
	)
	homeBase := t.TempDir()
	transcript := writeTranscript(t, homeBase, osUser, cwd, "aaaa-1111", "MARKER-AGENTS")
	dir := sessionio.SessionDir(transcript)
	writeAgent(t, dir, "subagents", "a1", `{"description":"first"}`, []string{
		userLine("a1", 0, "go"),
	}, time.Now())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rg := newRegistry(ctx, time.Millisecond, homeBase, siotest.NewFakeOptions(osUser+"/"+tmux), osUser)
	rg.agentEvery = 5 * time.Millisecond
	register(t, rg, osUser, "aaaa-1111", cwd, tmux)

	ls, ok := rg.live(osUser, tmux)
	if !ok || ls.agents == nil {
		t.Fatal("a registered session has no agent watch")
	}
	if fs, _ := rg.source(osUser, tmux); fs != ls.fs {
		t.Fatal("source and live disagree about the session's transcript source")
	}
	_, release := ls.agents.Subscribe()
	defer release()
	count := func() int {
		set, _, ok := ls.agents.Current()
		if !ok {
			return -1
		}
		return len(set.Agents)
	}
	waitFor(t, "the first agent", func() bool { return count() == 1 })

	writeAgent(t, dir, "subagents", "a2", `{"description":"second"}`, []string{
		userLine("a2", 0, "go"),
	}, time.Now())
	waitFor(t, "the agent spawned while watching", func() bool { return count() == 2 })
}

// Stop watching when a session has no streams: the idle sweep that retires a
// transcript source retires its agent watch with it, and done closes only once
// both have stopped.
func TestRegistryStopsWatchingAgentsWithTheSource(t *testing.T) {
	const (
		osUser = "wizard"
		cwd    = "/home/wizard/qa"
		tmux   = "qa-agents-idle"
	)
	homeBase := t.TempDir()
	writeTranscript(t, homeBase, osUser, cwd, "aaaa-1111", "MARKER-A")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rg := newRegistry(ctx, time.Millisecond, homeBase, siotest.NewFakeOptions(osUser+"/"+tmux), osUser)
	rg.agentEvery = 2 * time.Millisecond
	now := time.Unix(1000, 0)
	rg.now = func() time.Time { return now }
	rg.mods.now = rg.now
	counter := newCountingReader()
	rg.user(osUser).agents = counter
	register(t, rg, osUser, "aaaa-1111", cwd, tmux)

	ls, ok := rg.live(osUser, tmux)
	if !ok {
		t.Fatal("session does not resolve")
	}
	// Subscribed so the watch is scanning. Nobody reads the transcript, so the
	// sweep finds the source idle, as it does once the last tab is closed.
	_, releaseAgents := ls.agents.Subscribe()
	defer releaseAgents()
	waitFor(t, "the watch to scan", func() bool { return counter.listings() > 2 })

	// The mod goes quiet (its Claude was killed), and the session is dropped.
	now = now.Add(modExpiry + time.Second)
	rg.sweep()
	select {
	case <-ls.done:
	case <-time.After(2 * time.Second):
		t.Fatal("the retired source's goroutines are still running")
	}
	before := counter.listings()
	time.Sleep(20 * time.Millisecond) // ten scan intervals
	if n := counter.listings(); n != before {
		t.Fatalf("the agent watch kept listing after its source was retired: %d -> %d", before, n)
	}
}

// The agent files are reached the same two ways as the transcripts: directly
// for the service's own user, through the child running as them for anyone
// else.
func TestRegistryReadsAgentFilesTheWayItReadsTranscripts(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rg := newRegistry(ctx, time.Millisecond, t.TempDir(), siotest.NewFakeOptions(), "wizard")

	if _, ok := rg.user("wizard").agents.(sessionio.LocalReader); !ok {
		t.Fatalf("own user's agent reader is %T, want sessionio.LocalReader", rg.user("wizard").agents)
	}
	foreign := rg.user("bob")
	if foreign.agents != sessionio.AgentReader(foreign.priv) {
		t.Fatalf("another user's agent files must be read through their child, got %T", foreign.agents)
	}
}
