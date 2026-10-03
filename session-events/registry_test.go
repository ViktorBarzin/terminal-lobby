package main

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"terminal-lobby/sessionio"
	"terminal-lobby/sessionio/siotest"
)

// writeTranscript lays down a one-line transcript whose single user message
// carries `marker`, at the path Claude files it under for (cwd, claudeID).
func writeTranscript(t *testing.T, homeBase, osUser, cwd, claudeID, marker string) string {
	t.Helper()
	root := filepath.Join(homeBase, osUser, ".claude", "projects")
	path := sessionio.TranscriptPath(root, cwd, claudeID)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	line := `{"type":"user","message":{"role":"user","content":"` + marker + `"}}` + "\n"
	if err := os.WriteFile(path, []byte(line), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// waitForMarker polls the source's log until an event body carries want.
func waitForMarker(t *testing.T, fs *sessionio.FileSource, want string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		for _, e := range fs.Replay(0) {
			if e.Body == want {
				return
			}
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("source for %s never produced %q; got %+v", fs.Path(), want, fs.Replay(0))
}

func bodies(fs *sessionio.FileSource) []string {
	var out []string
	for _, e := range fs.Replay(0) {
		out = append(out, e.Body)
	}
	return out
}

// register connects a mod for the session the way a Claude's mod does, and
// feeds it whatever the transcript at (cwd, claudeID) already holds, row by
// row, as the mod would have forwarded it.
func register(t *testing.T, rg *registry, osUser, claudeID, cwd, tmuxSession string) {
	t.Helper()
	path := sessionio.TranscriptPath(sessionio.ProjectsRoot(rg.homeBase, osUser), cwd, claudeID)
	rg.mods.hello(osUser, modHello{SID: claudeID, Session: tmuxSession, Pane: "%1", CWD: cwd, Transcript: path})
	c := rg.mods.conn(osUser, tmuxSession)
	if c == nil {
		t.Fatalf("hello for %s/%s registered nothing", osUser, tmuxSession)
	}
	c.apply(transcriptEvents(t, path))
}

// transcriptEvents reads a transcript into the events a mod sends for it: a
// result ahead of each row carrying a structured tool result, then the row.
func transcriptEvents(t *testing.T, path string) []sessionio.ModEvent {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	var evs []sessionio.ModEvent
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 16<<20)
	for sc.Scan() {
		rec, ok := sessionio.DecodeRecord(sc.Bytes())
		if !ok || (rec.Type != sessionio.RecordUser && rec.Type != sessionio.RecordAssistant) {
			continue
		}
		content := rec.Message.Content
		if len(content) > 0 && content[0] == '"' {
			var s string
			_ = json.Unmarshal(content, &s)
			content, _ = json.Marshal([]map[string]string{{"type": "text", "text": s}})
		}
		if len(rec.ToolUseResult) > 0 {
			for _, bl := range rec.Blocks() {
				if bl.Type == "tool_result" {
					evs = append(evs, sessionio.ModEvent{Type: sessionio.ModResultEvent, ToolID: bl.ToolUseID, Result: rec.ToolUseResult})
				}
			}
		}
		door := "response"
		if rec.Role() == "user" {
			door = "prompt"
			if rec.HasBlock("tool_result") {
				door = "tool-result"
			}
		}
		evs = append(evs, sessionio.ModEvent{
			Type: sessionio.ModRowEvent, UUID: rec.UUID, Door: door, AgentID: rec.AgentID,
			Message: &sessionio.ModMessage{Type: string(rec.Type), Role: rec.Role(), IsMeta: rec.IsMeta, Content: content},
		})
	}
	return evs
}

func newTestRegistry(t *testing.T, sessions ...string) (*registry, *siotest.FakeOptions) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	opts := siotest.NewFakeOptions(sessions...)
	return newRegistry(ctx, time.Millisecond, t.TempDir(), opts, "wizard"), opts
}

func TestRegistryResolvesOnlySessionsWithAMod(t *testing.T) {
	rg, _ := newTestRegistry(t, "wizard/demo")
	if _, ok := rg.source("wizard", "demo"); ok {
		t.Fatal("a session no mod said hello for resolved")
	}
	rg.mods.hello("wizard", modHello{SID: "11111111-2222-3333-4444-555555555555", Session: "demo", Pane: "%3"})
	if _, ok := rg.source("wizard", "demo"); !ok {
		t.Fatal("the session did not resolve after its mod said hello")
	}
	if _, ok := rg.source("emo", "demo"); ok {
		t.Fatal("another user's session of the same name resolved")
	}
}

func TestHelloStampsTheTranscriptForTheRestOfTheLobby(t *testing.T) {
	rg, opts := newTestRegistry(t, "wizard/demo")
	path := sessionio.TranscriptPath(sessionio.ProjectsRoot(rg.homeBase, "wizard"), "/w", "sid1")
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3", CWD: "/w", Transcript: path})
	if got, _ := opts.Option("wizard", "demo", sessionio.OptionTranscript); got != path {
		t.Fatalf("@claude_transcript = %q, want %q", got, path)
	}
}

func TestHelloRefusesATranscriptOutsideTheUsersProjects(t *testing.T) {
	rg, opts := newTestRegistry(t, "wizard/demo")
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3", Transcript: "/etc/passwd"})
	if got, _ := opts.Option("wizard", "demo", sessionio.OptionTranscript); got != "" {
		t.Fatalf("@claude_transcript = %q for a path outside the projects root", got)
	}
	fs, ok := rg.source("wizard", "demo")
	if !ok || fs.Path() != "" {
		t.Fatalf("source path = %q, want none", fs.Path())
	}
}

func TestHelloAgainKeepsTheLogAndAsksForNoHistory(t *testing.T) {
	rg, _ := newTestRegistry(t, "wizard/demo")
	tok1, hist1 := rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	if !hist1 {
		t.Fatal("a first hello did not ask for history")
	}
	fs1, _ := rg.source("wizard", "demo")
	tok2, hist2 := rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	fs2, _ := rg.source("wizard", "demo")
	if hist2 || fs1 != fs2 {
		t.Fatalf("a reload's hello rebuilt the log (history %v)", hist2)
	}
	if tok1 == tok2 || rg.mods.byTokenOf(tok1) != nil {
		t.Fatal("the old token still works after a fresh hello")
	}
}

// The mod says hello before Claude has written its transcript, and again,
// naming it, once the first row lands. The second hello used to be taken as a
// reload and the source kept the empty path it was built with, so every
// picture read back from the transcript, a subagent's included, answered 404
// for the life of the session, and the agent panel had no directory to list
// (2026-10-03: 421 of those 404s banned Viktor's phone at the edge).
func TestATranscriptNamedByALaterHelloReachesTheSource(t *testing.T) {
	rg, _ := newTestRegistry(t, "wizard/demo")
	path := sessionio.TranscriptPath(sessionio.ProjectsRoot(rg.homeBase, "wizard"), "/w", "sid1")
	agents := filepath.Join(sessionio.SessionDir(path), "subagents")
	if err := os.MkdirAll(agents, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(agents, "agent-a1b2c3.jsonl"), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3", CWD: "/w"})
	before, _ := rg.source("wizard", "demo")
	if before.Path() != "" {
		t.Fatalf("source path before the transcript exists = %q", before.Path())
	}
	ch, cancel := before.Subscribe()
	defer cancel()
	// Kept, not rebuilt: history carries no row ids, so a rebuilt log fed
	// history while the first row was still queued would draw it twice.
	if _, hist := rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3", CWD: "/w", Transcript: path}); hist {
		t.Fatal("naming the transcript rebuilt the log")
	}
	fs, ok := rg.source("wizard", "demo")
	if !ok || fs != before || fs.Path() != path {
		t.Fatalf("source = %p path %q, want the same source on %q", fs, fs.Path(), path)
	}
	if _, got, _, err := rg.agentTranscript("wizard", "demo", "a1b2c3"); err != nil || got != filepath.Join(agents, "agent-a1b2c3.jsonl") {
		t.Fatalf("agent transcript = %q, %v", got, err)
	}
	select {
	case _, open := <-ch:
		if !open {
			t.Fatal("naming the transcript ended the open stream")
		}
	default:
	}
}

func TestARenamedSessionMovesItsMod(t *testing.T) {
	rg, _ := newTestRegistry(t, "wizard/old", "wizard/new")
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "old", Pane: "%3"})
	fs, _ := rg.source("wizard", "old")
	ch, cancel := fs.Subscribe()
	defer cancel()
	if _, hist := rg.mods.hello("wizard", modHello{SID: "sid1", Session: "new", Pane: "%3"}); !hist {
		t.Fatal("the renamed session's fresh log did not ask for history")
	}
	if _, ok := rg.source("wizard", "old"); ok {
		t.Fatal("the old name still resolves")
	}
	if _, ok := rg.source("wizard", "new"); !ok {
		t.Fatal("the new name does not resolve")
	}
	if _, open := <-ch; open {
		t.Fatal("a stream on the old name was left open")
	}
}

func TestANewClaudeInTheSameSessionReplacesTheOld(t *testing.T) {
	rg, _ := newTestRegistry(t, "wizard/demo")
	tok, _ := rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	rg.mods.hello("wizard", modHello{SID: "sid2", Session: "demo", Pane: "%3"})
	if rg.mods.byTokenOf(tok) != nil {
		t.Fatal("the replaced Claude's token still works")
	}
	if c := rg.mods.conn("wizard", "demo"); c == nil || c.sid != "sid2" {
		t.Fatal("the session does not belong to the new Claude")
	}
}

func TestEventsFeedTheLogAndStampTheSession(t *testing.T) {
	rg, opts := newTestRegistry(t, "wizard/demo")
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	c := rg.mods.conn("wizard", "demo")
	c.apply([]sessionio.ModEvent{promptRow(), {Type: sessionio.ModTurnEndEvent, Answer: "ok"}})
	fs, _ := rg.source("wizard", "demo")
	if got := strings.Join(bodies(fs), "|"); got != "hi|" {
		t.Fatalf("log bodies = %q", got)
	}
	if st, _ := opts.Option("wizard", "demo", sessionio.OptionState); st != "done" {
		t.Fatalf("@claude_state = %q, want done", st)
	}
}

func TestByeDropsTheConnection(t *testing.T) {
	rg, _ := newTestRegistry(t, "wizard/demo")
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	rg.mods.conn("wizard", "demo").apply([]sessionio.ModEvent{{Type: sessionio.ModByeEvent}})
	if rg.mods.conn("wizard", "demo") != nil {
		t.Fatal("the connection survived its bye")
	}
}

func TestAQuietModIsDropped(t *testing.T) {
	rg, _ := newTestRegistry(t, "wizard/demo")
	now := time.Now()
	rg.mods.now = func() time.Time { return now }
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	now = now.Add(modExpiry + time.Second)
	rg.sweep()
	if rg.mods.conn("wizard", "demo") != nil {
		t.Fatal("a mod silent past modExpiry is still connected")
	}
}

func TestPollHandsOverACommandAndTheAckReachesTheSender(t *testing.T) {
	rg, _ := newTestRegistry(t, "wizard/demo")
	tok, _ := rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	c := rg.mods.conn("wizard", "demo")
	got := make(chan modAck, 1)
	go func() {
		a, _ := c.send(context.Background(), modCommand{Op: "prompt", Text: "hello"})
		got <- a
	}()
	rec := httptest.NewRecorder()
	rg.mods.handlePoll()(rec, httptest.NewRequest("GET", "/mod/v1/poll?token="+tok, nil))
	var body struct {
		Commands []modCommand `json:"commands"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || len(body.Commands) != 1 || body.Commands[0].Text != "hello" {
		t.Fatalf("poll = %s (%v)", rec.Body.String(), err)
	}
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModAckEvent, ID: body.Commands[0].ID, OK: true}})
	select {
	case a := <-got:
		if !a.OK {
			t.Fatalf("ack = %+v", a)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the sender never saw the ack")
	}
}

// A reload takes the module that held a poll away. Its token is superseded, so
// its poll is refused, and a command it took but never acked goes to the
// module that says hello next.
func TestACommandTheReloadedModuleTookGoesToTheNextOne(t *testing.T) {
	rg, _ := newTestRegistry(t, "wizard/demo")
	old, _ := rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	c := rg.mods.conn("wizard", "demo")
	acked := make(chan modAck, 1)
	go func() {
		a, _ := c.send(context.Background(), modCommand{Op: "abort"})
		acked <- a
	}()
	poll := func(tok string) (int, []modCommand) {
		rec := httptest.NewRecorder()
		rg.mods.handlePoll()(rec, httptest.NewRequest("GET", "/mod/v1/poll?token="+tok, nil))
		var body struct {
			Commands []modCommand `json:"commands"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		return rec.Code, body.Commands
	}
	if code, cmds := poll(old); code != 200 || len(cmds) != 1 {
		t.Fatalf("first poll: %d %+v", code, cmds)
	}
	fresh, _ := rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	if code, _ := poll(old); code != http.StatusConflict {
		t.Fatalf("the superseded token's poll: %d, want 409", code)
	}
	code, cmds := poll(fresh)
	if code != 200 || len(cmds) != 1 || cmds[0].Op != "abort" {
		t.Fatalf("the new module was not sent the unacked command: %d %+v", code, cmds)
	}
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModAckEvent, ID: cmds[0].ID, OK: true}})
	if a := <-acked; !a.OK {
		t.Fatalf("ack = %+v", a)
	}
}

// The mod resends a refused batch until it is taken, and every later event
// waits behind it. One event this build cannot decode must not refuse the
// batch, or the session's log stays empty for good.
func TestAnEventThatDoesNotDecodeDoesNotRefuseItsBatch(t *testing.T) {
	rg, _ := newTestRegistry(t, "wizard/demo")
	tok, _ := rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	body := `{"token":"` + tok + `","events":[` +
		`{"type":"history","messages":[{"role":"user","text":{"not":"a string"}}]},` +
		`{"type":"row","uuid":"u1","door":"prompt","message":{"type":"user","role":"user","content":[{"type":"text","text":"still here"}]}}` +
		`]}`
	rec := httptest.NewRecorder()
	rg.mods.handleEvents()(rec, httptest.NewRequest("POST", "/mod/v1/events", strings.NewReader(body)))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status %d (%s), want 204", rec.Code, rec.Body.String())
	}
	fs, _ := rg.source("wizard", "demo")
	if got := strings.Join(bodies(fs), "|"); got != "still here" {
		t.Fatalf("log bodies = %q, want the row that decoded", got)
	}
}

// A long session's history arrives in chunks; only the last one may close the
// last turn, or a turn split across two chunks would end halfway.
func TestHistoryInChunksClosesTheTurnOnce(t *testing.T) {
	rg, _ := newTestRegistry(t, "wizard/demo")
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	c := rg.mods.conn("wizard", "demo")
	c.apply([]sessionio.ModEvent{
		{Type: sessionio.ModHistoryEvent, More: true, Messages: []sessionio.ModHistoryMessage{{Role: "user", Text: "first"}}},
		{Type: sessionio.ModHistoryEvent, Messages: []sessionio.ModHistoryMessage{{Role: "assistant", Text: "answer"}}},
	})
	fs, _ := rg.source("wizard", "demo")
	var kinds []string
	for _, e := range fs.Replay(0) {
		kinds = append(kinds, string(e.Kind))
	}
	if got := strings.Join(kinds, ","); got != "user,text,turn_end" {
		t.Fatalf("kinds = %s, want user,text,turn_end", got)
	}
}

func TestPollAndEventsRefuseAnUnknownToken(t *testing.T) {
	rg, _ := newTestRegistry(t)
	rec := httptest.NewRecorder()
	rg.mods.handlePoll()(rec, httptest.NewRequest("GET", "/mod/v1/poll?token=nope", nil))
	if rec.Code != http.StatusConflict {
		t.Fatalf("poll: %d, want 409", rec.Code)
	}
	rec = httptest.NewRecorder()
	rg.mods.handleEvents()(rec, httptest.NewRequest("POST", "/mod/v1/events", strings.NewReader(`{"token":"nope","events":[]}`)))
	if rec.Code != http.StatusConflict {
		t.Fatalf("events: %d, want 409", rec.Code)
	}
}

// answered runs c.answer against a mod stand-in that acks every command, and
// returns the commands it was sent.
func answered(t *testing.T, c *modConn, req sessionio.AnswerRequest) (sessionio.AnswerResponse, []modCommand) {
	t.Helper()
	var sent []modCommand
	done := make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		defer close(done)
		for {
			c.mu.Lock()
			cmds := c.cmds
			c.cmds = nil
			c.mu.Unlock()
			for _, cmd := range cmds {
				sent = append(sent, cmd)
				c.deliver(cmd.ID, modAck{OK: true})
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Millisecond):
			}
		}
	}()
	resp := c.answer(context.Background(), req)
	cancel()
	<-done
	return resp, sent
}

func TestAQuestionIsAnsweredThroughTheMod(t *testing.T) {
	rg, _ := newTestRegistry(t, "wizard/demo")
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	c := rg.mods.conn("wizard", "demo")
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModAskEvent, ToolID: "toolu_q",
		Questions: json.RawMessage(`[{"question":"Pick?","multiSelect":true,"options":[{"label":"A"},{"label":"B"}]}]`)}})
	fs, _ := rg.source("wizard", "demo")
	if held := lastMeta(fs, sessionio.MetaHeld); !strings.Contains(held, "Pick?") {
		t.Fatalf("the held question is not on the wire: %q", held)
	}
	resp, sent := answered(t, c, sessionio.AnswerRequest{Answers: map[string][]string{"Pick?": {"A", "B"}}})
	if !resp.Applied || len(sent) != 1 || sent[0].Op != "answer" || sent[0].Answers["Pick?"] != "A, B" || sent[0].ToolID != "toolu_q" {
		t.Fatalf("resp %+v, sent %+v", resp, sent)
	}
	if resp, _ := answered(t, c, sessionio.AnswerRequest{Answers: map[string][]string{"Other?": {"A"}}}); resp.Reason != sessionio.AnswerIncomplete {
		t.Fatalf("an answer missing the question: %+v", resp)
	}
}

func TestAPlanIsApprovedOrSentBackThroughTheMod(t *testing.T) {
	rg, _ := newTestRegistry(t, "wizard/demo")
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	c := rg.mods.conn("wizard", "demo")
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModPlanEvent, ToolID: "toolu_p", Plan: "do it"}})
	_, sent := answered(t, c, sessionio.AnswerRequest{Plan: &sessionio.PlanAnswer{Option: 1, Label: "Yes, approve the plan"}})
	if len(sent) != 1 || sent[0].Decision != "allow" {
		t.Fatalf("approve sent %+v", sent)
	}
	_, sent = answered(t, c, sessionio.AnswerRequest{Plan: &sessionio.PlanAnswer{Feedback: "smaller"}})
	if len(sent) != 1 || sent[0].Decision != "deny" || sent[0].Reason != "smaller" {
		t.Fatalf("feedback sent %+v", sent)
	}
	_, sent = answered(t, c, sessionio.AnswerRequest{Plan: &sessionio.PlanAnswer{Feedback: "and test it", Approve: true}})
	if len(sent) != 2 || sent[0].Decision != "allow" || sent[1].Op != "prompt" || sent[1].Text != "and test it" {
		t.Fatalf("approve with feedback sent %+v", sent)
	}
}

func TestAPermissionPromptIsDecidedThroughTheMod(t *testing.T) {
	rg, _ := newTestRegistry(t, "wizard/demo")
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	c := rg.mods.conn("wizard", "demo")
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModPermissionEvent, ToolID: "toolu_b", Tool: "Bash",
		Input: json.RawMessage(`{"command":"rm -rf build","description":"Clean"}`)}})
	fs, _ := rg.source("wizard", "demo")
	if st := lastMeta(fs, sessionio.MetaAsking); !strings.Contains(st, "rm -rf build") || !strings.Contains(st, "Bash command") {
		t.Fatalf("the permission prompt is not on the wire: %s", st)
	}
	_, sent := answered(t, c, sessionio.AnswerRequest{Permission: &sessionio.PermissionAnswer{Decline: "use make clean"}})
	if len(sent) != 1 || sent[0].Decision != "deny" || sent[0].Reason != "use make clean" {
		t.Fatalf("decline sent %+v", sent)
	}
	c.apply([]sessionio.ModEvent{{Type: sessionio.ModSettledEvent, ToolID: "toolu_b", By: "web"}})
	if resp, _ := answered(t, c, sessionio.AnswerRequest{Permission: &sessionio.PermissionAnswer{Option: 1}}); resp.Reason != sessionio.AnswerNotDrawn {
		t.Fatalf("answering a settled prompt: %+v", resp)
	}
}

// The mod draws its own Allow / Deny dialog as an AskUserQuestion call of its
// own. That call must not turn the permission card into a question card.
func TestTheModsOwnDialogIsNotAQuestion(t *testing.T) {
	rg, opts := newTestRegistry(t, "wizard/demo")
	rg.mods.hello("wizard", modHello{SID: "sid1", Session: "demo", Pane: "%3"})
	c := rg.mods.conn("wizard", "demo")
	c.apply([]sessionio.ModEvent{
		{Type: sessionio.ModPermissionEvent, ToolID: "toolu_01b", Tool: "Bash", Input: json.RawMessage(`{"command":"ls"}`)},
		{Type: sessionio.ModAskEvent, ToolID: "toolu_plugin_530e", Questions: json.RawMessage(`[{"question":"Allow Bash: ls?","options":[{"label":"Allow"},{"label":"Deny"}]}]`)},
		{Type: sessionio.ModSettledEvent, ToolID: "toolu_plugin_530e", By: "web"},
	})
	if d := c.dialogNow(); d == nil || d.kind != "permission" {
		t.Fatalf("dialog = %+v, want the permission prompt", d)
	}
	if ask, _ := opts.Option("wizard", "demo", sessionio.OptionAsk); ask != "toolu_01b" {
		t.Fatalf("@claude_ask = %q, want the tool call waiting on permission", ask)
	}
}

// lastMeta is the body of the newest meta event of kind m in the log.
func lastMeta(fs *sessionio.FileSource, m sessionio.Meta) string {
	body := ""
	for _, e := range fs.Replay(0) {
		if e.Kind == sessionio.KindMeta && e.Meta == m {
			body = e.Body
		}
	}
	return body
}
