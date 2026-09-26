package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"terminal-lobby/sessionio"
)

// agentClock is the "now" the watcher tests measure against. Record times and
// file times are written relative to it, so the retention window is exact.
var agentClock = time.Date(2026, 9, 24, 6, 0, 0, 0, time.UTC)

// agentAt is a record timestamp d from agentClock, in the transcript's own format.
func agentAt(d time.Duration) string {
	return agentClock.Add(d).UTC().Format("2006-01-02T15:04:05.000Z")
}

func agentMS(d time.Duration) int64 { return agentClock.Add(d).UnixMilli() }

// The records an agent transcript is made of, cut down to the fields the tail
// reads.
func userLine(id string, d time.Duration, text string) string {
	return fmt.Sprintf(`{"type":"user","isSidechain":true,"agentId":%q,"timestamp":%q,"message":{"role":"user","content":%q}}`,
		id, agentAt(d), text)
}

func toolLine(id string, d time.Duration, msg, toolID, tool, input string) string {
	return fmt.Sprintf(`{"type":"assistant","isSidechain":true,"agentId":%q,"timestamp":%q,"message":{"id":%q,"role":"assistant","model":"claude-opus-5-5","content":[{"type":"tool_use","id":%q,"name":%q,"input":%s}],"stop_reason":"tool_use","usage":{"output_tokens":10}}}`,
		id, agentAt(d), msg, toolID, tool, input)
}

func endLine(id string, d time.Duration, msg, text string) string {
	return fmt.Sprintf(`{"type":"assistant","isSidechain":true,"agentId":%q,"timestamp":%q,"message":{"id":%q,"role":"assistant","model":"claude-opus-5-5","content":[{"type":"text","text":%q}],"stop_reason":"end_turn","usage":{"output_tokens":20}}}`,
		id, agentAt(d), msg, text)
}

// hookLine is the attachment a SubagentStop hook trails an agent's last answer
// with: written after the end, and not new work.
func hookLine(id string, d time.Duration) string {
	return fmt.Sprintf(`{"type":"attachment","isSidechain":true,"agentId":%q,"timestamp":%q,"attachment":{"type":"hook_success","hookName":"SubagentStop"}}`,
		id, agentAt(d))
}

// writeAgent lays down one agent the way Claude Code does, under rel below the
// session directory: its sidecar when meta is not "", its transcript when lines
// is not nil, both dated mtime.
func writeAgent(t *testing.T, dir, rel, id, meta string, lines []string, mtime time.Time) string {
	t.Helper()
	base := filepath.Join(dir, filepath.FromSlash(rel), "agent-"+id)
	if err := os.MkdirAll(filepath.Dir(base), 0o755); err != nil {
		t.Fatal(err)
	}
	if meta != "" {
		writeDated(t, base+".meta.json", meta, mtime)
	}
	if lines != nil {
		writeDated(t, base+".jsonl", strings.Join(lines, "\n")+"\n", mtime)
	}
	return base + ".jsonl"
}

func writeDated(t *testing.T, path, body string, mtime time.Time) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, mtime, mtime); err != nil {
		t.Fatal(err)
	}
}

// appendDated adds lines to a transcript and moves its mtime, the way an agent
// writing more does.
func appendDated(t *testing.T, path string, mtime time.Time, lines ...string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(strings.Join(lines, "\n") + "\n"); err != nil {
		t.Fatal(err)
	}
	f.Close()
	if err := os.Chtimes(path, mtime, mtime); err != nil {
		t.Fatal(err)
	}
}

// countingReader is the local reader with a count of every read, by file name,
// so a test can say what the watcher opened and what it left alone. A read of
// gate blocks until release is closed, which is how a slow first read is
// expressed without a slow disk.
type countingReader struct {
	sessionio.LocalReader

	mu      sync.Mutex
	reads   map[string]int
	smalls  map[string]int
	lists   int
	listErr error

	gate    string
	entered chan struct{}
	release chan struct{}
}

func newCountingReader() *countingReader {
	return &countingReader{reads: map[string]int{}, smalls: map[string]int{}}
}

func (c *countingReader) ReadFrom(path string, off int64) ([]string, int64, error) {
	c.mu.Lock()
	c.reads[filepath.Base(path)]++
	gated := c.gate != "" && filepath.Base(path) == c.gate
	c.mu.Unlock()
	if gated {
		close(c.entered)
		<-c.release
	}
	return c.LocalReader.ReadFrom(path, off)
}

func (c *countingReader) ReadSmallFile(path string) ([]byte, error) {
	c.mu.Lock()
	c.smalls[filepath.Base(path)]++
	c.mu.Unlock()
	return c.LocalReader.ReadSmallFile(path)
}

func (c *countingReader) ListAgentFiles(dir string) ([]sessionio.AgentFile, error) {
	c.mu.Lock()
	c.lists++
	err := c.listErr
	c.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return c.LocalReader.ListAgentFiles(dir)
}

// opened is how many times anything of agent id was read.
func (c *countingReader) opened(id string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.reads["agent-"+id+".jsonl"] + c.smalls["agent-"+id+".meta.json"]
}

func (c *countingReader) listings() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lists
}

// watchAt builds a watcher over dir whose clock reads *now.
func watchAt(dir string, r sessionio.AgentReader, now *time.Time) *agentWatch {
	aw := newAgentWatch(dir, r)
	aw.now = func() time.Time { return *now }
	return aw
}

func agentIDs(set sessionio.AgentSet) []string {
	var ids []string
	for _, a := range set.Agents {
		ids = append(ids, a.ID)
	}
	return ids
}

func agentByID(t *testing.T, set sessionio.AgentSet, id string) sessionio.AgentInfo {
	t.Helper()
	for _, a := range set.Agents {
		if a.ID == id {
			return a
		}
	}
	t.Fatalf("agent %s is not in the set %v", id, agentIDs(set))
	return sessionio.AgentInfo{}
}

// The design's "done when" for this step, one level down: an agent spawned
// while the session is being watched appears on the next scan, with nothing
// restarted.
func TestAgentWatchSeesANewAgentWithoutARestart(t *testing.T) {
	dir := t.TempDir()
	now := agentClock
	aw := watchAt(dir, sessionio.LocalReader{}, &now)

	aw.scan()
	set, v1, ok := aw.Current()
	if !ok || len(set.Agents) != 0 || set.Workflows != nil {
		t.Fatalf("a session with no agents: Current = %+v, %d, %v", set, v1, ok)
	}

	writeAgent(t, dir, "subagents", "a1", `{"agentType":"Explore","description":"Look around","toolUseId":"toolu_main","spawnDepth":1}`, []string{
		userLine("a1", -time.Minute, "Look around."),
		toolLine("a1", -50*time.Second, "m1", "toolu_r1", "Read", `{"file_path":"/w/README.md"}`),
	}, agentClock.Add(-50*time.Second))
	aw.scan()

	set, v2, ok := aw.Current()
	if !ok || v2 == v1 {
		t.Fatalf("a new agent did not change the set: version %d -> %d, ok %v", v1, v2, ok)
	}
	want := sessionio.AgentInfo{
		ID: "a1", Description: "Look around", AgentType: "Explore", Model: "claude-opus-5-5",
		Depth: 1, ToolUseID: "toolu_main", State: sessionio.AgentRunning,
		StartedAt: agentMS(-time.Minute), LastActivityAt: agentMS(-50 * time.Second),
		Tool: "Read", ToolDetail: "/w/README.md", ToolCalls: 1, OutputTokens: 10,
	}
	if len(set.Agents) != 1 || set.Agents[0] != want {
		t.Fatalf("agents\n got %+v\nwant [%+v]", set.Agents, want)
	}
}

// The contract's retention rule: a session with 150 old agent transcripts
// costs nothing on open, because a file not written in the last 15 minutes is
// never opened at all.
func TestAgentWatchNeverOpensFilesOlderThanTheRetention(t *testing.T) {
	dir := t.TempDir()
	for i := range 3 {
		old := agentClock.Add(-agentRetention - time.Duration(i+1)*time.Minute)
		id := fmt.Sprintf("old%d", i)
		writeAgent(t, dir, "subagents", id, `{"description":"long done"}`, []string{
			userLine(id, -2*time.Hour, "go"), endLine(id, -time.Hour, "m", "done"),
		}, old)
	}
	writeAgent(t, dir, "subagents", "fresh", `{"description":"just now"}`, []string{
		userLine("fresh", -time.Minute, "go"),
	}, agentClock.Add(-time.Minute))

	r := newCountingReader()
	now := agentClock
	aw := watchAt(dir, r, &now)
	aw.scan()

	for i := range 3 {
		if n := r.opened(fmt.Sprintf("old%d", i)); n != 0 {
			t.Errorf("old%d was read %d times; files older than the retention must never be opened", i, n)
		}
	}
	set, _, _ := aw.Current()
	if ids := agentIDs(set); len(ids) != 1 || ids[0] != "fresh" {
		t.Fatalf("agents = %v, want [fresh]", ids)
	}
}

// One tail per agent, and a scan reads only what changed: the listing's size
// says which transcripts grew, and nothing else is touched. A scan that finds
// nothing new publishes nothing new.
func TestAgentWatchTailsOnlyTheFilesThatGrew(t *testing.T) {
	dir := t.TempDir()
	writeAgent(t, dir, "subagents", "quiet", `{"description":"quiet"}`, []string{
		userLine("quiet", -time.Minute, "go"),
	}, agentClock.Add(-time.Minute))
	busy := writeAgent(t, dir, "subagents", "busy", `{"description":"busy"}`, []string{
		userLine("busy", -time.Minute, "go"),
	}, agentClock.Add(-time.Minute))

	r := newCountingReader()
	now := agentClock
	aw := watchAt(dir, r, &now)
	aw.scan()
	_, v1, _ := aw.Current()

	aw.scan()
	if _, v, _ := aw.Current(); v != v1 {
		t.Fatalf("a scan that found nothing new moved the version %d -> %d", v1, v)
	}
	if r.reads["agent-quiet.jsonl"] != 1 || r.reads["agent-busy.jsonl"] != 1 {
		t.Fatalf("unchanged transcripts were read again: %v", r.reads)
	}
	if r.smalls["agent-quiet.meta.json"] != 1 || r.smalls["agent-busy.meta.json"] != 1 {
		t.Fatalf("unchanged sidecars were read again: %v", r.smalls)
	}

	now = agentClock.Add(time.Second)
	appendDated(t, busy, now, toolLine("busy", 0, "m1", "toolu_b1", "Bash", `{"command":"sleep 20"}`))
	aw.scan()
	if r.reads["agent-quiet.jsonl"] != 1 || r.reads["agent-busy.jsonl"] != 2 {
		t.Fatalf("reads after one transcript grew = %v, want quiet 1 and busy 2", r.reads)
	}
	set, v2, _ := aw.Current()
	if v2 == v1 {
		t.Fatal("the busy agent's new tool call did not change the set")
	}
	if a := agentByID(t, set, "busy"); a.Tool != "Bash" || a.ToolDetail != "sleep 20" {
		t.Fatalf("busy = %+v, want its Bash call", a)
	}
}

// A sidecar is rewritten long after the agent last wrote a record: a stop from
// the operator lands there and nowhere else. Its mtime is what says so, and an
// agent the retention had left alone comes back when it happens.
func TestAgentWatchRereadsARewrittenSidecar(t *testing.T) {
	for _, tc := range []struct {
		name  string
		files time.Time // when the agent last wrote anything, before the stop
	}{
		{"while it is being watched", agentClock.Add(-time.Minute)},
		{"after the retention had left it alone", agentClock.Add(-agentRetention - time.Hour)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			writeAgent(t, dir, "subagents", "a1", `{"description":"long read"}`, []string{
				userLine("a1", tc.files.Sub(agentClock)-time.Minute, "go"),
				toolLine("a1", tc.files.Sub(agentClock), "m1", "toolu_1", "Read", `{"file_path":"/w/big.log"}`),
			}, tc.files)
			now := agentClock
			aw := watchAt(dir, sessionio.LocalReader{}, &now)
			aw.scan()

			now = agentClock.Add(2 * time.Second)
			writeDated(t, filepath.Join(dir, "subagents", "agent-a1.meta.json"),
				`{"description":"long read","stoppedByUser":true}`, now)
			aw.scan()

			set, _, _ := aw.Current()
			a := agentByID(t, set, "a1")
			if a.State != sessionio.AgentFailed || a.Result != "Stopped by user" || a.EndedAt != now.UnixMilli() {
				t.Fatalf("after the stop: %+v", a)
			}
		})
	}
}

// parentId: the sidecar's own parentAgentId when it has one, else the agent
// whose transcript emitted the Agent tool_use the sidecar's toolUseId names.
// A toolUseId no agent emitted was the session's own call.
func TestAgentWatchFindsEachAgentsParent(t *testing.T) {
	dir := t.TempDir()
	mtime := agentClock.Add(-10 * time.Second)
	writeAgent(t, dir, "subagents", "top", `{"toolUseId":"toolu_main","spawnDepth":1}`, []string{
		userLine("top", -time.Minute, "go"),
		toolLine("top", -50*time.Second, "m1", "toolu_spawn", "Agent", `{"description":"dig deeper"}`),
	}, mtime)
	writeAgent(t, dir, "subagents", "nested", `{"toolUseId":"toolu_spawn","spawnDepth":2}`, []string{
		userLine("nested", -40*time.Second, "dig"),
	}, mtime)
	writeAgent(t, dir, "subagents", "named", `{"toolUseId":"toolu_other","parentAgentId":"top","spawnDepth":2}`, []string{
		userLine("named", -30*time.Second, "dig"),
	}, mtime)
	writeAgent(t, dir, "subagents", "orphan", `{"toolUseId":"toolu_gone","spawnDepth":2}`, []string{
		userLine("orphan", -20*time.Second, "dig"),
	}, mtime)

	now := agentClock
	aw := watchAt(dir, sessionio.LocalReader{}, &now)
	aw.scan()
	set, _, _ := aw.Current()

	for id, want := range map[string]string{"top": "", "nested": "top", "named": "top", "orphan": ""} {
		if got := agentByID(t, set, id).ParentID; got != want {
			t.Errorf("%s: parentId = %q, want %q", id, got, want)
		}
	}
}

// Which agents a snapshot carries: every running one, and those that ended in
// the last 15 minutes, at most 64 of them, the newest ends first. The set is in
// spawn order: startedAt, then id.
func TestAgentWatchCarriesRunningAndRecentlyEndedAgents(t *testing.T) {
	dir := t.TempDir()
	recent := agentClock.Add(-10 * time.Second)
	// A long-running agent, spawned before everything else and still going.
	writeAgent(t, dir, "subagents", "runner", `{"description":"runner"}`, []string{
		userLine("runner", -3*time.Hour, "go"),
		toolLine("runner", -10*time.Second, "m1", "toolu_r", "Bash", `{"command":"sleep 20"}`),
	}, recent)
	// 70 agents that ended in the last 15 minutes, one every 10 seconds, the
	// first to end at -12 minutes. Only the 64 newest ends are carried.
	for i := range 70 {
		id := fmt.Sprintf("e%02d", i)
		end := -12*time.Minute + time.Duration(i)*10*time.Second
		writeAgent(t, dir, "subagents", id, `{"description":"`+id+`"}`, []string{
			userLine(id, -14*time.Minute, "go"), endLine(id, end, "m"+id, "done"),
		}, recent)
	}
	// Ended 16 minutes ago, though a hook wrote to its transcript since: read,
	// because its file is recent, but no longer carried.
	writeAgent(t, dir, "subagents", "stale", `{"description":"stale"}`, []string{
		userLine("stale", -20*time.Minute, "go"),
		endLine("stale", -16*time.Minute, "ms", "done"),
		hookLine("stale", -time.Minute),
	}, recent)

	now := agentClock
	aw := watchAt(dir, sessionio.LocalReader{}, &now)
	aw.scan()
	set, _, _ := aw.Current()

	got := map[string]bool{}
	for _, id := range agentIDs(set) {
		got[id] = true
	}
	if len(set.Agents) != 1+maxEndedAgents {
		t.Fatalf("carried %d agents, want the runner and %d ended: %v", len(set.Agents), maxEndedAgents, agentIDs(set))
	}
	if !got["runner"] {
		t.Error("the running agent is not carried")
	}
	for i := range 70 - maxEndedAgents {
		if id := fmt.Sprintf("e%02d", i); got[id] {
			t.Errorf("%s is among the oldest ends and should have been dropped", id)
		}
	}
	if got["stale"] {
		t.Error("an agent that ended 16 minutes ago is still carried")
	}
	if !sort.SliceIsSorted(set.Agents, func(i, j int) bool {
		a, b := set.Agents[i], set.Agents[j]
		return a.StartedAt < b.StartedAt || a.StartedAt == b.StartedAt && a.ID < b.ID
	}) {
		t.Fatalf("not in spawn order: %v", agentIDs(set))
	}
	if set.Agents[0].ID != "runner" || set.Agents[1].ID != "e06" {
		t.Fatalf("order = %v, want runner first, then the ended ones by id", agentIDs(set))
	}
}

// Memory stays bounded by the same window: an agent that ended more than 15
// minutes ago and whose files have not moved since is let go, and one that
// left the listing is forgotten.
func TestAgentWatchLetsGoOfAgentsItNoLongerCarries(t *testing.T) {
	dir := t.TempDir()
	gone := writeAgent(t, dir, "subagents", "gone", `{"description":"gone"}`, []string{
		userLine("gone", -time.Minute, "go"),
	}, agentClock.Add(-time.Minute))
	writeAgent(t, dir, "subagents", "done", `{"description":"done"}`, []string{
		userLine("done", -2*time.Minute, "go"), endLine("done", -time.Minute, "m", "ok"),
	}, agentClock.Add(-time.Minute))

	now := agentClock
	aw := watchAt(dir, sessionio.LocalReader{}, &now)
	aw.scan()
	if len(aw.agents) != 2 {
		t.Fatalf("watching %d agents, want 2", len(aw.agents))
	}

	if err := os.Remove(gone); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(sessionio.AgentMetaPath(gone)); err != nil {
		t.Fatal(err)
	}
	now = agentClock.Add(agentRetention + time.Minute)
	aw.scan()
	if len(aw.agents) != 0 {
		t.Fatalf("still holding %d agents after one left the listing and the other aged out", len(aw.agents))
	}
	if set, _, _ := aw.Current(); len(set.Agents) != 0 {
		t.Fatalf("carried %v", agentIDs(set))
	}
	if _, ok := aw.TranscriptPath("gone"); ok {
		t.Fatal("a transcript that left the listing still resolves")
	}
}

// A 34 MB agent transcript took 5 s to read cold. The agents that are cheap to
// read are published before it, so one big file does not hold the whole set
// back; the big one joins when its read finishes.
func TestAgentWatchPublishesBeforeABigFirstRead(t *testing.T) {
	dir := t.TempDir()
	mtime := agentClock.Add(-time.Second)
	writeAgent(t, dir, "subagents", "small", `{"description":"small"}`, []string{
		userLine("small", -time.Minute, "go"),
	}, mtime)
	pad := strings.Repeat("x", bigAgentRead)
	writeAgent(t, dir, "subagents", "big", `{"description":"big"}`, []string{
		userLine("big", -2*time.Minute, pad),
	}, mtime)

	r := newCountingReader()
	r.gate, r.entered, r.release = "agent-big.jsonl", make(chan struct{}), make(chan struct{})
	now := agentClock
	aw := watchAt(dir, r, &now)
	done := make(chan struct{})
	go func() {
		defer close(done)
		aw.scan()
	}()

	select {
	case <-r.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the big transcript was never read")
	}
	set, _, ok := aw.Current()
	if ids := agentIDs(set); !ok || len(ids) != 1 || ids[0] != "small" {
		t.Fatalf("during the big read: Current = %v, %v; want [small] published", ids, ok)
	}

	close(r.release)
	<-done
	set, _, _ = aw.Current()
	if ids := agentIDs(set); len(ids) != 2 {
		t.Fatalf("after the big read: agents = %v, want both", ids)
	}
}

// Before the first scan there is no set to send, and a set nobody has scanned
// for a while is not sent either: the stream waits for a fresh one rather than
// showing an agent that has since finished as running.
func TestAgentWatchCurrentOnlyWhenFresh(t *testing.T) {
	now := agentClock
	aw := watchAt(t.TempDir(), sessionio.LocalReader{}, &now)
	if _, v, ok := aw.Current(); ok || v != 0 {
		t.Fatalf("before any scan: version %d, ok %v", v, ok)
	}
	aw.scan()
	if _, v, ok := aw.Current(); !ok || v == 0 {
		t.Fatalf("right after a scan: version %d, ok %v", v, ok)
	}
	now = now.Add(agentFresh + time.Second)
	if _, _, ok := aw.Current(); ok {
		t.Fatal("a snapshot older than agentFresh is still offered")
	}
}

// A listing that fails keeps the last good set rather than emptying it, and
// does not claim to be fresh.
func TestAgentWatchKeepsItsSetWhenAListingFails(t *testing.T) {
	dir := t.TempDir()
	writeAgent(t, dir, "subagents", "a1", `{"description":"one"}`, []string{
		userLine("a1", -time.Minute, "go"),
	}, agentClock.Add(-time.Minute))
	r := newCountingReader()
	now := agentClock
	aw := watchAt(dir, r, &now)
	aw.scan()
	_, v1, _ := aw.Current()

	r.listErr = errors.New("privreader: bob: broken pipe")
	now = now.Add(agentFresh + time.Second)
	aw.scan()
	set, v2, ok := aw.Current()
	if v2 != v1 || len(set.Agents) != 1 {
		t.Fatalf("a failed listing changed the set: version %d -> %d, %v", v1, v2, agentIDs(set))
	}
	if ok {
		t.Fatal("a set the last listing could not confirm is offered as fresh")
	}
}

// T6 serves one agent's transcript and must resolve it only from files the
// session actually has, workflow members included.
func TestAgentWatchResolvesTranscriptPaths(t *testing.T) {
	dir := t.TempDir()
	mtime := agentClock.Add(-time.Second)
	adhoc := writeAgent(t, dir, "subagents", "a1", `{"description":"one"}`, []string{userLine("a1", -time.Minute, "go")}, mtime)
	member := writeAgent(t, dir, "subagents/workflows/wf_r1", "m1", `{"description":"member"}`, []string{userLine("m1", -time.Minute, "go")}, mtime)

	now := agentClock
	aw := watchAt(dir, sessionio.LocalReader{}, &now)
	aw.scan()

	for id, want := range map[string]string{"a1": adhoc, "m1": member} {
		if got, ok := aw.TranscriptPath(id); !ok || got != want {
			t.Errorf("TranscriptPath(%s) = %q, %v; want %q", id, got, ok, want)
		}
	}
	for _, id := range []string{"nope", "../a1", ""} {
		if got, ok := aw.TranscriptPath(id); ok {
			t.Errorf("TranscriptPath(%q) resolved to %q", id, got)
		}
	}
	// The member's run has no run file, so it is going, and carried whole.
	set, _, _ := aw.Current()
	if ids := agentIDs(set); len(ids) != 2 || ids[0] != "a1" || ids[1] != "m1" {
		t.Fatalf("agents = %v, want the agent and the member", ids)
	}
	if len(set.Workflows) != 1 || set.Workflows[0].ID != "wf_r1" {
		t.Fatalf("workflows = %+v, want the member's run", set.Workflows)
	}
}

// The watcher scans once when it starts, so the first stream finds a set
// waiting, then only while somebody is subscribed; every scan signals the
// subscribers, whose streams decide whether anything changed.
func TestAgentWatchScansOnlyWhileSomeoneIsWatching(t *testing.T) {
	r := newCountingReader()
	aw := newAgentWatch(t.TempDir(), r)
	aw.every = 2 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		aw.run(ctx)
	}()
	defer func() {
		cancel()
		<-stopped
	}()

	waitFor(t, "the opening scan", func() bool { _, _, ok := aw.Current(); return ok })
	time.Sleep(20 * time.Millisecond) // ten ticks with nobody subscribed
	if n := r.listings(); n != 1 {
		t.Fatalf("listed %d times with nobody watching, want only the opening scan", n)
	}

	sig, release := aw.Subscribe()
	select {
	case <-sig:
	case <-time.After(2 * time.Second):
		t.Fatal("a subscriber was never signalled")
	}
	waitFor(t, "scans while subscribed", func() bool { return r.listings() > 3 })

	release()
	time.Sleep(10 * time.Millisecond) // let a scan already under way finish
	before := r.listings()
	time.Sleep(20 * time.Millisecond)
	if n := r.listings(); n != before {
		t.Fatalf("still scanning after the last subscriber left: %d -> %d listings", before, n)
	}
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}
