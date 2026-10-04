package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"terminal-lobby/sessionio"
	"terminal-lobby/sessionio/siotest"
)

// The four options the mod's fold owns.
var stateOptions = []string{sessionio.OptionState, sessionio.OptionAsk, sessionio.OptionTool, sessionio.OptionBackground}

// flakyOptions is the tmux option store with writes that can be made to fail,
// and an unset that clears what FakeOptions holds.
type flakyOptions struct {
	*siotest.FakeOptions
	mu    sync.Mutex
	fails int // how many more SetOption calls fail
	sets  int
}

func (f *flakyOptions) SetOption(osUser, session, name, value string) error {
	f.mu.Lock()
	f.sets++
	failing := f.fails > 0
	if failing {
		f.fails--
	}
	f.mu.Unlock()
	if failing {
		return errors.New("exit status 1")
	}
	return f.FakeOptions.SetOption(osUser, session, name, value)
}

func (f *flakyOptions) unset(osUser, session string, names []string) error {
	for _, n := range names {
		if err := f.FakeOptions.SetOption(osUser, session, n, ""); err != nil {
			return err
		}
	}
	return nil
}

func (f *flakyOptions) failNext(n int) {
	f.mu.Lock()
	f.fails = n
	f.mu.Unlock()
}

func (f *flakyOptions) setCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sets
}

// writableRegistry is a test registry whose mod hub writes and unsets through
// a flakyOptions holding the given options on wizard/demo.
func writableRegistry(t *testing.T, seed map[string]string) (*registry, *flakyOptions) {
	t.Helper()
	rg, fake := newTestRegistry(t, "wizard/demo")
	opts := &flakyOptions{FakeOptions: fake}
	for k, v := range seed {
		_ = fake.SetOption("wizard", "demo", k, v)
	}
	rg.mods.stamp = opts
	rg.mods.unset = opts.unset
	return rg, opts
}

func options(o sessionio.Options) string {
	var out []string
	for _, n := range stateOptions {
		v, _ := o.Option("wizard", "demo", n)
		out = append(out, n+"="+v)
	}
	return strings.Join(out, " ")
}

func idleHistory() sessionio.ModEvent {
	return sessionio.ModEvent{Type: sessionio.ModHistoryEvent, Messages: []sessionio.ModHistoryMessage{{Role: "user", Text: "hi"}}}
}

// After a restart, the options the last process wrote are still on the
// session and the new process's memory starts empty. The first state-bearing
// apply after the hello writes all four in full, so what the last process left
// is cleared: the health-app-migration-and-mobile session read done with a
// stale @claude_bg a:<id> through 27 restarts (2026-10-03).
func TestTheFirstStateAfterAHelloClearsWhatTheLastProcessWrote(t *testing.T) {
	stale := map[string]string{
		sessionio.OptionState: "running", sessionio.OptionBackground: "a:x",
		sessionio.OptionAsk: "t1", sessionio.OptionTool: "toolu_9",
	}
	cases := []struct {
		name  string
		hello modHello
		evs   []sessionio.ModEvent
	}{
		// 0.1.0 and 0.2.0 send no level: their last history chunk is the
		// state-bearing apply.
		{"an old mod's last history chunk", modHello{SID: "sid1", Session: "demo", Pane: "%3", Mod: "0.2.0"},
			[]sessionio.ModEvent{idleHistory(), {Type: sessionio.ModAgentsEvent}}},
		{"an old mod's history in two chunks", modHello{SID: "sid1", Session: "demo", Pane: "%3", Mod: "0.1.0"},
			[]sessionio.ModEvent{{Type: sessionio.ModHistoryEvent, More: true}, idleHistory()}},
		{"a new mod's level", modHello{SID: "sid1", Session: "demo", Pane: "%3", Mod: "0.3.0", Instance: "i1"},
			[]sessionio.ModEvent{idleHistory(), {Type: sessionio.ModLevelEvent}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rg, opts := writableRegistry(t, stale)
			rg.mods.hello("wizard", tc.hello)
			c := rg.mods.conn("wizard", "demo")
			for _, ev := range tc.evs {
				c.apply([]sessionio.ModEvent{ev})
			}
			want := "@claude_state=done @claude_ask= @claude_tool= @claude_bg="
			if got := options(opts); got != want {
				t.Fatalf("options = %q, want %q", got, want)
			}
		})
	}
}

// A write that fails leaves tmux behind memory. The next apply writes all
// four options again instead of only what changed since.
func TestAFailedWriteIsWrittenInFullByTheNextApply(t *testing.T) {
	rg, opts := writableRegistry(t, nil)
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	c := rg.mods.conn("wizard", "demo")
	c.apply([]sessionio.ModEvent{idleHistory()})
	opts.failNext(1)
	c.apply([]sessionio.ModEvent{promptRow(), {Type: sessionio.ModPlanEvent, ToolID: "toolu_p"}})
	if got, _ := opts.Option("wizard", "demo", sessionio.OptionState); got == "awaiting" {
		t.Fatal("the failing write landed; the test needs it to fail")
	}
	// Nothing in this event changes the derived options.
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModDeltaEvent, Kind: "text", Text: "more"}})
	want := "@claude_state=awaiting @claude_ask=toolu_p @claude_tool= @claude_bg="
	if got := options(opts); got != want {
		t.Fatalf("options = %q, want %q", got, want)
	}
}

// Viktor's rule for a manual status (tmux-api POST /sessions/{name}/state):
// it lasts until the system has something new to say. A periodic level with
// the same values refreshes memory and writes nothing; the next change does.
func TestAManualStateLastsUntilTheDerivedStateChanges(t *testing.T) {
	rg, opts := writableRegistry(t, nil)
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3", Instance: "i1"})
	c := rg.mods.conn("wizard", "demo")
	running := sessionio.ModEvent{Type: sessionio.ModLevelEvent, Running: true}
	c.apply([]sessionio.ModEvent{idleHistory(), running})
	if st, _ := opts.Option("wizard", "demo", sessionio.OptionState); st != "running" {
		t.Fatalf("state = %q after a running level", st)
	}
	_ = opts.FakeOptions.SetOption("wizard", "demo", sessionio.OptionState, "done") // a person marks it done
	c.apply([]sessionio.ModEvent{running})
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModTurnStartEvent}})
	if st, _ := opts.Option("wizard", "demo", sessionio.OptionState); st != "done" {
		t.Fatalf("state = %q, want the manual done kept while nothing changed", st)
	}
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModTurnEndEvent}})
	c.apply([]sessionio.ModEvent{promptRow()})
	if st, _ := opts.Option("wizard", "demo", sessionio.OptionState); st != "running" {
		t.Fatalf("state = %q, want the next turn written", st)
	}
}

// A level is the mod's whole view: it replaces the turn, the tool, the agents
// and the open dialogs the fold had, whatever events came before it.
func TestALevelReplacesWhatTheFoldHad(t *testing.T) {
	rg, opts := writableRegistry(t, nil)
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3", Instance: "i1"})
	c := rg.mods.conn("wizard", "demo")
	c.apply([]sessionio.ModEvent{
		idleHistory(),
		askEvent("toolu_a", "Which?"),
		{Type: sessionio.ModPermissionEvent, ToolID: "toolu_b", Tool: "Bash", Input: json.RawMessage(`{"command":"ls"}`)},
	})
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModLevelEvent, Running: false, Tool: "toolu_t",
		Agents: []sessionio.ModAgent{{ID: "ag1", Type: "general-purpose", Status: "waiting"}},
		Asks:   []string{"toolu_b", "toolu_c"}}})
	want := "@claude_state=awaiting @claude_ask=toolu_c @claude_tool=toolu_t @claude_bg=a:ag1"
	if got := options(opts); got != want {
		t.Fatalf("options = %q, want %q", got, want)
	}
	// The question it no longer lists is gone from the card and the routes;
	// the permission it does list keeps the body it came with.
	if d := c.dialogFor("ask", ""); d != nil {
		t.Fatalf("a dialog the level dropped is still answerable: %+v", d)
	}
	if d := c.dialogNow(); d == nil || d.toolID != "toolu_b" || d.tool != "Bash" {
		t.Fatalf("dialog now = %+v, want the listed permission with its body", d)
	}
	// A compaction keeps the session running with no turn open.
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModLevelEvent, Compacting: true}})
	if got := options(opts); got != "@claude_state=running @claude_ask= @claude_tool= @claude_bg=" {
		t.Fatalf("options while compacting = %q", got)
	}
}

// T-F3: a hello's history answer can be lost (a rehello while it was in
// flight). The connection owes a history until a final chunk is applied, and
// every hello says so.
func TestAHelloOwesHistoryUntilAFinalChunkLands(t *testing.T) {
	rg, _ := newTestRegistry(t, "wizard/demo")
	h := modHello{SID: "sid1", Session: "demo", Pane: "%3", Instance: "i1"}
	if _, owed := rg.mods.hello("wizard", h); !owed {
		t.Fatal("a first hello did not ask for history")
	}
	if _, owed := rg.mods.hello("wizard", h); !owed {
		t.Fatal("a second hello before any history forgot it is owed")
	}
	c := rg.mods.conn("wizard", "demo")
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModHistoryEvent, More: true}})
	fs1, _ := rg.source("wizard", "demo")
	if _, owed := rg.mods.hello("wizard", h); !owed {
		t.Fatal("a chunk with more to come settled the history")
	}
	// Half a history is in the log; the next one starts a fresh log rather
	// than drawing those messages twice.
	fs2, _ := rg.source("wizard", "demo")
	if fs1 == fs2 {
		t.Fatal("a history asked for again was fed into a log already holding half of one")
	}
	rg.mods.conn("wizard", "demo").apply([]sessionio.ModEvent{idleHistory()})
	if _, owed := rg.mods.hello("wizard", h); owed {
		t.Fatal("history is still owed after its final chunk")
	}
}

// A mod from before 0.3.0 puts a history ahead of everything it has queued, a
// history it was sent before included. It is asked only by the hello that
// built the log, or it would draw the conversation twice.
func TestAnOldModIsAskedForHistoryOnlyWhenTheLogIsNew(t *testing.T) {
	rg, _ := newTestRegistry(t, "wizard/demo")
	h := modHello{SID: "sid1", Session: "demo", Pane: "%3", Mod: "0.2.0"}
	if _, hist := rg.mods.hello("wizard", h); !hist {
		t.Fatal("a first hello did not ask for history")
	}
	if _, hist := rg.mods.hello("wizard", h); hist {
		t.Fatal("an old mod was asked for a second history while the first may still be queued")
	}
}

// A new module instance (a reload or a worker respawn) forgot everything it
// knew. The connection starts its fold over and asks for the snapshot again.
func TestANewModuleInstanceStartsOver(t *testing.T) {
	rg, opts := writableRegistry(t, nil)
	h := modHello{SID: "sid1", Session: "demo", Pane: "%3", Instance: "i1"}
	rg.mods.hello("wizard", h)
	c := rg.mods.conn("wizard", "demo")
	c.apply([]sessionio.ModEvent{idleHistory(), {Type: sessionio.ModLevelEvent}, promptRow(), askEvent("toolu_a", "Which?")})
	if _, owed := rg.mods.hello("wizard", h); owed {
		t.Fatal("the same instance saying hello again was asked for history")
	}
	h.Instance = "i2"
	if _, owed := rg.mods.hello("wizard", h); !owed {
		t.Fatal("a new instance was not asked for history")
	}
	c.mu.Lock()
	asks := len(c.st.asks)
	c.mu.Unlock()
	if asks != 0 {
		t.Fatal("the fold kept the old instance's dialogs")
	}
	_ = opts.FakeOptions.SetOption("wizard", "demo", sessionio.OptionTool, "toolu_stale")
	c.apply([]sessionio.ModEvent{idleHistory(), {Type: sessionio.ModLevelEvent}})
	if got := options(opts); got != "@claude_state=done @claude_ask= @claude_tool= @claude_bg=" {
		t.Fatalf("options = %q, want a full write from the new instance", got)
	}
}

// A bye still queued from the conversation before a /clear arrives under the
// new conversation's token. It names its own sid and is ignored.
func TestAByeForAnotherConversationIsIgnored(t *testing.T) {
	rg, _ := newTestRegistry(t, "wizard/demo")
	rg.mods.hello("wizard", modHello{SID: "sid2", Session: "demo", Pane: "%3"})
	c := rg.mods.conn("wizard", "demo")
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModByeEvent, Sid: "sid1"}})
	if rg.mods.conn("wizard", "demo") == nil {
		t.Fatal("a bye for the old conversation dropped the new one's connection")
	}
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModByeEvent, Sid: "sid2"}})
	if rg.mods.conn("wizard", "demo") != nil {
		t.Fatal("the connection survived its own bye")
	}
}

// S-F5: a second Claude in another pane of the same tmux session gets a
// connection of its own that writes no options, so the two do not take the
// session from each other on every hello.
func TestASecondLiveClaudeOnAnotherPaneDoesNotTakeTheSession(t *testing.T) {
	rg, opts := writableRegistry(t, nil)
	now := time.Now()
	rg.mods.now = func() time.Time { return now }
	first, _ := rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	second, owed := rg.mods.hello("wizard", modHello{SID: "sid2", Session: "demo", Pane: "%4"})
	if owed {
		t.Fatal("the second Claude was asked for a history nothing reads")
	}
	if c := rg.mods.conn("wizard", "demo"); c == nil || c.sid != "sid1" {
		t.Fatal("the second Claude took the session from a live first one")
	}
	if rg.mods.byTokenOf(first) == nil || rg.mods.byTokenOf(second) == nil {
		t.Fatal("one of the two Claudes lost its token")
	}
	sets := opts.setCount()
	rg.mods.byTokenOf(second).apply([]sessionio.ModEvent{promptRow()})
	if opts.setCount() != sets {
		t.Fatal("the second Claude wrote the session's options")
	}
	// Once the first is gone, the second is asked to say hello and takes it.
	now = now.Add(modLiveGap + time.Second)
	rg.mods.byTokenOf(second).apply([]sessionio.ModEvent{promptRow()})
	if rg.mods.byTokenOf(second) != nil {
		t.Fatal("the second Claude was not asked to say hello once the session was free")
	}
	rg.mods.hello("wizard", modHello{SID: "sid2", Session: "demo", Pane: "%4"})
	if c := rg.mods.conn("wizard", "demo"); c == nil || c.sid != "sid2" {
		t.Fatal("the second Claude did not take the free session")
	}
}

// S-F7: a mod that went quiet leaves its options behind. If the pane no longer
// runs Claude, all four go, as a bye would clear them; if it still does, only
// the dialog and tool go, as before.
func TestTheSweepClearsAllFourOnlyWhenClaudeHasLeftThePane(t *testing.T) {
	for _, tc := range []struct {
		cmd  string
		want string
	}{
		{"zsh", "@claude_state= @claude_ask= @claude_tool= @claude_bg="},
		{"claude", "@claude_state=running @claude_ask= @claude_tool= @claude_bg=a:x"},
	} {
		t.Run(tc.cmd, func(t *testing.T) {
			rg, opts := writableRegistry(t, nil)
			now := time.Now()
			rg.mods.now = func() time.Time { return now }
			rg.mods.paneProcs = func(_, _ string) []paneProc { return []paneProc{{Cmd: tc.cmd}} }
			rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
			c := rg.mods.conn("wizard", "demo")
			c.apply([]sessionio.ModEvent{promptRow(), askEvent("toolu_a", "Which?"), {Type: sessionio.ModAgentsEvent,
				Agents: []sessionio.ModAgent{{ID: "x", Type: "general-purpose", Status: "running"}}}})
			_ = opts.FakeOptions.SetOption("wizard", "demo", sessionio.OptionTool, "toolu_t")
			now = now.Add(modExpiry + time.Second)
			rg.sweep()
			// Awaiting goes back to running once the dialog is cleared only in
			// memory; the sweep leaves state alone while Claude runs.
			got := strings.Replace(options(opts), "@claude_state=awaiting", "@claude_state=running", 1)
			if got != tc.want {
				t.Fatalf("options = %q, want %q", got, tc.want)
			}
		})
	}
}

// T-F4: a command the route gave up on is not handed to a later poll, where
// it would act on whatever the session is doing by then.
func TestACommandTheRouteGaveUpOnIsNotSentLater(t *testing.T) {
	rg, _ := newTestRegistry(t, "wizard/demo")
	tok, _ := rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	c := rg.mods.conn("wizard", "demo")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := c.send(ctx, modCommand{Op: "abort"}); err == nil {
		t.Fatal("a send nobody polled for returned no error")
	}
	pctx, pcancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer pcancel()
	rec := httptest.NewRecorder()
	rg.mods.handlePoll()(rec, httptest.NewRequest("GET", "/mod/v1/poll?token="+tok, nil).WithContext(pctx))
	if strings.Contains(rec.Body.String(), "abort") {
		t.Fatalf("poll handed over a command nobody waits on: %s", rec.Body.String())
	}
}

// T-F8: connections per OS user are bounded; the longest-silent one goes.
func TestConnectionsPerUserAreBounded(t *testing.T) {
	rg, _ := newTestRegistry(t)
	now := time.Now()
	rg.mods.now = func() time.Time { return now }
	for i := 0; i <= modConnsPerUser; i++ {
		now = now.Add(time.Second)
		rg.mods.hello("wizard", modHello{SID: "0000000" + strconv.Itoa(1000+i), Session: "s" + strconv.Itoa(i), Pane: "%" + strconv.Itoa(i)})
	}
	rg.mods.mu.Lock()
	n := len(rg.mods.bySID)
	_, oldest := rg.mods.bySID[hubKey("wizard", "00000001000")]
	rg.mods.mu.Unlock()
	if n != modConnsPerUser || oldest {
		t.Fatalf("%d connections, oldest kept %v; want %d with the longest-silent gone", n, oldest, modConnsPerUser)
	}
}

// D-F2: feedback given with a plan approval goes inside the decide to a mod
// that can carry it into the same turn; an older mod still gets it as a
// prompt after.
func TestPlanFeedbackRidesTheDecideWhenTheModCanCarryIt(t *testing.T) {
	for _, tc := range []struct {
		ops  []string
		want string
	}{
		{[]string{"decide", "decide-feedback"}, "decide:allow:use sqlite"},
		{nil, "decide:allow: prompt::use sqlite"},
	} {
		rg, _ := newTestRegistry(t, "wizard/demo")
		rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3", Ops: tc.ops})
		c := rg.mods.conn("wizard", "demo")
		c.apply([]sessionio.ModEvent{{Type: sessionio.ModPlanEvent, ToolID: "toolu_p", Plan: "use postgres"}})
		resp, cmds := answered(t, c, sessionio.AnswerRequest{Plan: &sessionio.PlanAnswer{Approve: true, Feedback: "use sqlite"}})
		var got []string
		for _, cmd := range cmds {
			got = append(got, cmd.Op+":"+cmd.Decision+":"+cmd.Feedback+cmd.Text)
		}
		if !resp.Applied || strings.Join(got, " ") != tc.want {
			t.Errorf("ops %v: sent %q (%+v), want %q", tc.ops, strings.Join(got, " "), resp, tc.want)
		}
	}
}

// D-F1: the card, the agent API and @claude_ask read one list of dialogs. A
// background subagent's prompt survives the main turn's end on all three,
// and a tool's result takes its dialog off all three.
func TestOneListOfDialogsForTheCardTheRoutesAndTheOption(t *testing.T) {
	rg, opts := writableRegistry(t, nil)
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	c := rg.mods.conn("wizard", "demo")
	c.apply([]sessionio.ModEvent{
		promptRow(),
		{Type: sessionio.ModPermissionEvent, ToolID: "toolu_s", Tool: "Bash", AgentID: "ag1", Input: json.RawMessage(`{"command":"make"}`)},
		{Type: sessionio.ModTurnEndEvent},
	})
	if ask, _ := opts.Option("wizard", "demo", sessionio.OptionAsk); ask != "toolu_s" {
		t.Fatalf("@claude_ask = %q", ask)
	}
	if d := c.dialogFor("permission", "toolu_s"); d == nil {
		t.Fatal("the subagent's prompt cannot be answered after the main turn ended")
	}
	fs, _ := rg.source("wizard", "demo")
	if lastMeta(fs, sessionio.MetaAsking) == "" {
		t.Fatal("the card lost the subagent's prompt at the main turn's end")
	}
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModResultEvent, ToolID: "toolu_s", AgentID: "ag1"}})
	if c.dialogNow() != nil || lastMeta(fs, sessionio.MetaAsking) != "" {
		t.Fatal("a tool with a result is still shown as waiting on a person")
	}
}

// Q-F3: the hello names the model, so a source built after a restart shows it
// before anyone switches model.
func TestTheHellosModelReachesAFreshSource(t *testing.T) {
	rg, _ := newTestRegistry(t, "wizard/demo")
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3", Model: "claude-opus-5-5"})
	fs, _ := rg.source("wizard", "demo")
	var model string
	for _, e := range fs.Replay(0) {
		if e.Kind == sessionio.KindMeta && e.Meta == sessionio.MetaModel && e.Model != nil {
			model = e.Model.Model
		}
	}
	if model != "claude-opus-5-5" {
		t.Fatalf("model = %q", model)
	}
}

// D-F4: the stop button reports a refusal, not a cancel.
func TestStopReportsTheModRefusingTheAbort(t *testing.T) {
	f := &fakeTurns{}
	rg, h := modTurnMux(t, f)
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	c := rg.mods.conn("wizard", "demo")
	_ = answeringMod(t, c, modAck{OK: false, Error: "idle"})
	rec := postTurn(t, h, "/cancel/demo", `{}`)
	if rec.Code == http.StatusNoContent || rec.Code == http.StatusOK {
		t.Fatalf("cancel answered %d after the mod refused the abort", rec.Code)
	}
}

// The hello body, pinned like the events (sessionio's golden wire test): every
// key the mod sends has a field here.
func TestTheGoldenHelloDecodesWithNoKeyLeftOver(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "testdata", "mod-wire", "hello.json"))
	if err != nil {
		t.Fatal(err)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var b modHello
	if err := dec.Decode(&b); err != nil {
		t.Fatal(err)
	}
	if b.Instance == "" || !slices.Contains(b.Ops, "level") || !slices.Contains(b.Ops, "decide-feedback") {
		t.Fatalf("hello = %+v, want an instance and the 0.3.0 ops", b)
	}
}

// A command the mod acked and could not carry out shows in the session's
// Text view and leaves the session's state alone.
func TestAFailedCommandShowsInTheTextView(t *testing.T) {
	rg, opts := writableRegistry(t, nil)
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	c := rg.mods.conn("wizard", "demo")
	c.apply([]sessionio.ModEvent{idleHistory()})
	sets := opts.setCount()
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModCommandFailedEvent, ID: "c1.x", Op: "prompt", Error: "dropped: refused"}})
	fs, _ := rg.source("wizard", "demo")
	evs := fs.Replay(0)
	if last := evs[len(evs)-1]; last.Kind != sessionio.KindError || !strings.Contains(last.Body, "refused") {
		t.Fatalf("last event = %+v, want the failure", last)
	}
	if opts.setCount() != sets {
		t.Fatal("a failed command wrote options")
	}
}
