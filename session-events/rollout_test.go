package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"terminal-lobby/sessionio"
)

type fakeRollout struct {
	list     []sessionio.RolloutSession
	styled   string
	respawns []string
}

func (f *fakeRollout) RolloutSessions(string) ([]sessionio.RolloutSession, error) { return f.list, nil }
func (f *fakeRollout) CapturePaneStyled(string, string) (string, error)           { return f.styled, nil }
func (f *fakeRollout) Respawn(_, session, _, cmd string) error {
	f.respawns = append(f.respawns, session+": "+cmd)
	return nil
}

const idleBox = "──────────\n\x1b[39m❯ \n──────────\n"

func TestRolloutRestartsOnlySafeSessions(t *testing.T) {
	sid := "eefe8a5b-fa7b-4679-8a64-f3fcb919002e"
	tr := "/home/u/.claude/projects/-home-u/" + sid + ".jsonl"
	start := `/bin/zsh -lic "claude --dangerously-skip-permissions"`
	drv := &fakeRollout{styled: idleBox, list: []sessionio.RolloutSession{
		{Name: "idle", State: "done", Transcript: tr, Start: start},
		{Name: "busy", State: "running", Transcript: tr, Start: start},
		{Name: "asking", State: "awaiting", Transcript: tr, Start: start},
		{Name: "bg", State: "done", Background: "a:x", Transcript: tr, Start: start},
		{Name: "suspended", State: "done", Suspended: "123", Transcript: tr, Start: start},
		{Name: "shell", State: "", Start: "zsh"},
	}}
	ro := newRollout(newModHub(&registry{}, nil), drv, func() []string { return []string{"u"} })
	ro.once(context.Background())
	if len(drv.respawns) != 1 || drv.respawns[0] != `idle: /bin/zsh -lic "claude --dangerously-skip-permissions --resume `+sid+`"` {
		t.Fatalf("respawns = %v", drv.respawns)
	}
	// Never twice for the same conversation, however long it stays silent.
	ro.now = func() time.Time { return time.Now().Add(time.Hour) }
	ro.once(context.Background())
	if len(drv.respawns) != 1 {
		t.Fatalf("restarted again: %v", drv.respawns)
	}
}

func TestRolloutLeavesADraftAlone(t *testing.T) {
	drv := &fakeRollout{styled: "──────────\n\x1b[39m❯ half a thought\n──────────\n",
		list: []sessionio.RolloutSession{{Name: "s", State: "done",
			Transcript: "/p/eefe8a5b-fa7b-4679-8a64-f3fcb919002e.jsonl", Start: `/bin/zsh -lic "claude"`}}}
	ro := newRollout(newModHub(&registry{}, nil), drv, func() []string { return []string{"u"} })
	ro.once(context.Background())
	if len(drv.respawns) != 0 {
		t.Fatalf("restarted over a draft: %v", drv.respawns)
	}
}

func TestRolloutSkipsSessionsWithAMod(t *testing.T) {
	sid := "eefe8a5b-fa7b-4679-8a64-f3fcb919002e"
	drv := &fakeRollout{styled: idleBox, list: []sessionio.RolloutSession{{Name: "s", State: "done",
		Transcript: "/p/" + sid + ".jsonl", Start: `/bin/zsh -lic "claude"`}}}
	hub := newModHub(&registry{}, nil)
	hub.bySession[hubKey("u", "s")] = &modConn{}
	newRollout(hub, drv, func() []string { return []string{"u"} }).once(context.Background())
	if len(drv.respawns) != 0 {
		t.Fatalf("restarted a session whose mod is connected: %v", drv.respawns)
	}
}

func TestMapUsers(t *testing.T) {
	p := filepath.Join(t.TempDir(), "map")
	if err := os.WriteFile(p, []byte("# comment\nvbarzin=wizard\nemil.barzin=emo\nother=wizard\nbad line\nx=a b\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got := mapUsers(p)()
	if len(got) != 2 || got[0] != "wizard" || got[1] != "emo" {
		t.Fatalf("mapUsers = %v", got)
	}
}
