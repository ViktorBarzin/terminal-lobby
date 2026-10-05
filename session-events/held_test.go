package main

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"terminal-lobby/sessionio"
)

// heldMux is modTurnMux with held prompts kept under a temporary directory.
func heldMux(t *testing.T, dir string) (*registry, http.Handler) {
	t.Helper()
	rg, mux := modTurnMux(t, &fakeTurns{})
	rg.mods.files = heldFiles{dir: dir}
	return rg, mux
}

// running says hello and folds a snapshot with a main turn running.
func running(t *testing.T, rg *registry, sid string) *modConn {
	t.Helper()
	rg.mods.hello("wizard", modHello{SID: sid, Session: "demo", Pane: "%3", Instance: "i-" + sid})
	c := rg.mods.conn("wizard", "demo")
	c.apply([]sessionio.ModEvent{
		{Type: sessionio.ModHistoryEvent, Running: true, Messages: []sessionio.ModHistoryMessage{{Role: "user", Text: "work"}}},
		{Type: sessionio.ModLevelEvent, Running: true},
	})
	return c
}

// queueOf is the queue the session's stream says Claude has waiting.
func queueOf(c *modConn) []string {
	c.mu.Lock()
	ls := c.ls
	c.mu.Unlock()
	if ls == nil {
		return nil
	}
	return ls.fs.State(0).Queue
}

// prompts waits for the mod to have been sent n commands and returns their texts.
func prompts(t *testing.T, sent func() []modCommand, n int) []string {
	t.Helper()
	var got []string
	deadline := time.Now().Add(2 * time.Second)
	for len(got) < n && time.Now().Before(deadline) {
		for _, cmd := range sent() {
			got = append(got, cmd.Op+" "+cmd.Text)
		}
		time.Sleep(time.Millisecond)
	}
	return got
}

func TestAPromptDuringATurnIsHeldAndShownQueued(t *testing.T) {
	rg, mux := heldMux(t, t.TempDir())
	c := running(t, rg, "sid1")
	sent := fakeMod(t, c)
	if rec := postTurn(t, mux, "/prompt/demo", `{"text":"and then this"}`); rec.Code != http.StatusNoContent {
		t.Fatalf("status %d (%s)", rec.Code, rec.Body.String())
	}
	time.Sleep(20 * time.Millisecond)
	if got := sent(); len(got) != 0 {
		t.Fatalf("the mod was sent %+v while the turn ran", got)
	}
	if q := queueOf(c); !slices.Equal(q, []string{"and then this"}) {
		t.Fatalf("queue = %q", q)
	}
}

// A slash command runs as one and leaves no prompt row, so held it would sit
// on the queue for good after it ran. It goes to the mod as before.
func TestASlashCommandDuringATurnIsNotHeld(t *testing.T) {
	rg, mux := heldMux(t, t.TempDir())
	c := running(t, rg, "sid1")
	sent := fakeMod(t, c)
	postTurn(t, mux, "/prompt/demo", `{"text":"  /compact"}`)
	if got := prompts(t, sent, 1); !slices.Equal(got, []string{"prompt   /compact"}) {
		t.Fatalf("sent %q", got)
	}
	if q := queueOf(c); len(q) != 0 {
		t.Fatalf("queue = %q", q)
	}
}

func TestAPromptWhileIdleIsSentAtOnce(t *testing.T) {
	rg, mux := heldMux(t, t.TempDir())
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3", Instance: "i1"})
	c := rg.mods.conn("wizard", "demo")
	c.apply([]sessionio.ModEvent{idleHistory(), {Type: sessionio.ModLevelEvent}})
	sent := fakeMod(t, c)
	if rec := postTurn(t, mux, "/prompt/demo", `{"text":"go"}`); rec.Code != http.StatusNoContent {
		t.Fatalf("status %d", rec.Code)
	}
	if got := prompts(t, sent, 1); !slices.Equal(got, []string{"prompt go"}) {
		t.Fatalf("sent %q", got)
	}
}

// Until the snapshot after a hello has been folded the turn is not known, and
// a prompt goes to the mod as before rather than waiting on a guess.
func TestAPromptBeforeTheSnapshotIsSentAtOnce(t *testing.T) {
	rg, mux := heldMux(t, t.TempDir())
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3", Instance: "i1"})
	sent := fakeMod(t, rg.mods.conn("wizard", "demo"))
	postTurn(t, mux, "/prompt/demo", `{"text":"go"}`)
	if got := prompts(t, sent, 1); !slices.Equal(got, []string{"prompt go"}) {
		t.Fatalf("sent %q", got)
	}
}

func TestHeldPromptsGoOutInOrderWhenTheTurnEnds(t *testing.T) {
	rg, mux := heldMux(t, t.TempDir())
	c := running(t, rg, "sid1")
	sent := fakeMod(t, c)
	postTurn(t, mux, "/prompt/demo", `{"text":"one"}`)
	postTurn(t, mux, "/prompt/demo", `{"text":"two"}`)
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModTurnEndEvent}})
	if got := prompts(t, sent, 2); !slices.Equal(got, []string{"prompt one", "prompt two"}) {
		t.Fatalf("sent %q", got)
	}
	// Their rows take them off the queue as they open the next turn.
	c.apply([]sessionio.ModEvent{userRow("one"), userRow("two")})
	if q := queueOf(c); len(q) != 0 {
		t.Fatalf("queue after their rows = %q", q)
	}
}

// A snapshot can be what says the turn is over: its turn_end was missed.
func TestHeldPromptsGoOutWhenALevelSaysNoTurnRuns(t *testing.T) {
	rg, mux := heldMux(t, t.TempDir())
	c := running(t, rg, "sid1")
	sent := fakeMod(t, c)
	postTurn(t, mux, "/prompt/demo", `{"text":"one"}`)
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModLevelEvent}})
	if got := prompts(t, sent, 1); !slices.Equal(got, []string{"prompt one"}) {
		t.Fatalf("sent %q", got)
	}
}

func decodeTake(t *testing.T, body string) takeReply {
	t.Helper()
	var r takeReply
	if err := json.Unmarshal([]byte(body), &r); err != nil {
		t.Fatalf("reply %q: %v", body, err)
	}
	return r
}

func TestUnqueueHandsBackEveryHeldPrompt(t *testing.T) {
	rg, mux := heldMux(t, t.TempDir())
	c := running(t, rg, "sid1")
	sent := fakeMod(t, c)
	postTurn(t, mux, "/prompt/demo", `{"text":"one"}`)
	postTurn(t, mux, "/prompt/demo", `{"text":"two\nlines"}`)
	rec := postTurn(t, mux, "/prompt/demo/unqueue", ``)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d (%s)", rec.Code, rec.Body.String())
	}
	if r := decodeTake(t, rec.Body.String()); !r.Restored || !slices.Equal(r.Queue, []string{"one", "two\nlines"}) {
		t.Fatalf("reply %+v", r)
	}
	if q := queueOf(c); len(q) != 0 {
		t.Fatalf("queue after the hand-back = %q", q)
	}
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModTurnEndEvent}})
	time.Sleep(20 * time.Millisecond)
	if got := sent(); len(got) != 0 {
		t.Fatalf("handed-back prompts were sent: %+v", got)
	}
}

func TestUnqueueWithNothingHeldHandsBackNothing(t *testing.T) {
	for name, setup := range map[string]func(*registry){
		"no mod":       func(*registry) {},
		"nothing held": func(rg *registry) { running(t, rg, "sid1") },
	} {
		t.Run(name, func(t *testing.T) {
			rg, mux := heldMux(t, t.TempDir())
			setup(rg)
			rec := postTurn(t, mux, "/prompt/demo/unqueue", ``)
			if r := decodeTake(t, rec.Body.String()); rec.Code != http.StatusOK || r.Restored || r.Queue == nil || len(r.Queue) != 0 {
				t.Fatalf("status %d reply %q", rec.Code, rec.Body.String())
			}
		})
	}
}

// An interrupt ends the turn, and the turn's end would send what is held. A
// Stop that asks for the queue back takes it first.
func TestAStopTakesTheHeldPromptsBackBeforeItAborts(t *testing.T) {
	rg, mux := heldMux(t, t.TempDir())
	c := running(t, rg, "sid1")
	sent := fakeMod(t, c)
	postTurn(t, mux, "/prompt/demo", `{"text":"later"}`)
	rec := postTurn(t, mux, "/cancel/demo", `{"restoreQueue":["later"]}`)
	if r := decodeTake(t, rec.Body.String()); rec.Code != http.StatusOK || !r.Restored || !slices.Equal(r.Queue, []string{"later"}) {
		t.Fatalf("status %d reply %q", rec.Code, rec.Body.String())
	}
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModTurnEndEvent}})
	if got := prompts(t, sent, 2); !slices.Equal(got, []string{"abort "}) {
		t.Fatalf("mod got %q, want the abort alone", got)
	}
}

// A Stop that does not ask for the queue leaves it to run after the turn, as
// Claude runs its own queue on an interrupt.
func TestAStopWithoutTheQueueLetsTheHeldPromptsRun(t *testing.T) {
	rg, mux := heldMux(t, t.TempDir())
	c := running(t, rg, "sid1")
	sent := fakeMod(t, c)
	postTurn(t, mux, "/prompt/demo", `{"text":"later"}`)
	postTurn(t, mux, "/cancel/demo", ``)
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModTurnEndEvent}})
	if got := prompts(t, sent, 2); !slices.Equal(got, []string{"abort ", "prompt later"}) {
		t.Fatalf("mod got %q", got)
	}
}

// session-events restarts with every release. What it held is on disk, shown
// again in the new stream, and sent once the new snapshot says no turn runs.
func TestHeldPromptsSurviveARestart(t *testing.T) {
	dir := t.TempDir()
	rg, mux := heldMux(t, dir)
	running(t, rg, "sid1")
	postTurn(t, mux, "/prompt/demo", `{"text":"kept"}`)

	rg2, _ := heldMux(t, dir)
	rg2.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3", Instance: "i-sid1"})
	c := rg2.mods.conn("wizard", "demo")
	sent := fakeMod(t, c)
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModHistoryEvent, Running: true, Messages: []sessionio.ModHistoryMessage{{Role: "user", Text: "work"}}}})
	if q := queueOf(c); !slices.Equal(q, []string{"kept"}) {
		t.Fatalf("queue after the restart = %q", q)
	}
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModLevelEvent}})
	if got := prompts(t, sent, 1); !slices.Equal(got, []string{"prompt kept"}) {
		t.Fatalf("sent %q", got)
	}
	if entries, _ := filepath.Glob(filepath.Join(dir, "*", "*")); len(entries) != 0 {
		t.Fatalf("held files left after sending: %q", entries)
	}
}

// A /clear ends the conversation, and its connection with it. What it held
// goes to the next conversation in the same pane.
func TestHeldPromptsFollowTheConversationAfterAClear(t *testing.T) {
	rg, mux := heldMux(t, t.TempDir())
	c := running(t, rg, "sid1")
	postTurn(t, mux, "/prompt/demo", `{"text":"carried"}`)
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModByeEvent, Sid: "sid1"}})

	rg.mods.hello("wizard", modHello{SID: "sid2", Session: "demo", Pane: "%3", Instance: "i-sid1"})
	c2 := rg.mods.conn("wizard", "demo")
	sent := fakeMod(t, c2)
	c2.apply([]sessionio.ModEvent{idleHistory(), {Type: sessionio.ModLevelEvent}})
	if got := prompts(t, sent, 1); !slices.Equal(got, []string{"prompt carried"}) {
		t.Fatalf("sent %q", got)
	}
}

func TestAHeldPromptTheModRefusesIsShownAsAnError(t *testing.T) {
	rg, mux := heldMux(t, t.TempDir())
	c := running(t, rg, "sid1")
	postTurn(t, mux, "/prompt/demo", `{"text":"refused one"}`)
	refuseMod(t, c, "dropped: policy")
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModTurnEndEvent}})
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		for _, e := range c.ls.fs.Replay(0) {
			if e.Kind == sessionio.KindError && strings.Contains(e.Body, "refused one") && strings.Contains(e.Body, "dropped: policy") {
				return
			}
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("no error row names the refused prompt")
}

func TestAHeldPromptTheModRefusesLeavesTheQueue(t *testing.T) {
	rg, mux := heldMux(t, t.TempDir())
	c := running(t, rg, "sid1")
	postTurn(t, mux, "/prompt/demo", `{"text":"refused one"}`)
	refuseMod(t, c, "dropped: policy")
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModTurnEndEvent}})
	deadline := time.Now().Add(2 * time.Second)
	for len(queueOf(c)) > 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if q := queueOf(c); len(q) != 0 {
		t.Fatalf("queue = %q after the mod refused it", q)
	}
}

func TestHeldFilesRoundTrip(t *testing.T) {
	s := heldFiles{dir: t.TempDir()}
	if got := s.load("wizard", "sid1"); len(got) != 0 {
		t.Fatalf("nothing saved loads %q", got)
	}
	s.save("wizard", "sid1", []string{"a", "b\nc"})
	if got := s.load("wizard", "sid1"); !slices.Equal(got, []string{"a", "b\nc"}) {
		t.Fatalf("loaded %q", got)
	}
	s.save("wizard", "sid1", nil)
	if entries, _ := filepath.Glob(filepath.Join(s.dir, "*", "*")); len(entries) != 0 {
		t.Fatalf("an empty save left %q", entries)
	}
	// A conversation id is a file name here: one that is not a plain id
	// keeps nothing rather than writing outside the directory.
	s.save("wizard", "../escape", []string{"x"})
	if entries, _ := filepath.Glob(filepath.Join(filepath.Dir(s.dir), "escape*")); len(entries) != 0 {
		t.Fatalf("wrote %q", entries)
	}
	// No directory keeps nothing and fails nothing.
	heldFiles{}.save("wizard", "sid1", []string{"a"})
	if got := (heldFiles{}).load("wizard", "sid1"); len(got) != 0 {
		t.Fatalf("no directory loaded %q", got)
	}
}
