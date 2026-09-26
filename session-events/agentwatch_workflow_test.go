package main

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"terminal-lobby/sessionio"
)

// The workflow half of the watch (design step 3). A Workflow run's members are
// ordinary agents under subagents/workflows/wf_<runId>/, beside the run's
// journal; the run file under workflows/ is written once, when the run is over.

const wfRun = "wf_r1"

// wfMembers is where the run's members and its journal are written.
const wfMembers = "subagents/workflows/" + wfRun

// memberMeta is a member's sidecar as Claude Code 2.1.281 writes it: the
// member's label as its description, and its phase title.
func memberMeta(label, phase string) string {
	return fmt.Sprintf(`{"agentType":"workflow-subagent","description":%q,"workflowPhase":%q,"spawnDepth":1}`, label, phase)
}

// The journal lines the watch reads: a member starting, and one returning.
func journalStarted(key, id, label, phase string) string {
	return fmt.Sprintf(`{"type":"started","key":%q,"agentId":%q,"label":%q,"phase":%q}`, key, id, label, phase)
}

func journalResult(key, id, result string) string {
	return fmt.Sprintf(`{"type":"result","key":%q,"agentId":%q,"result":%s}`, key, id, result)
}

// writeJournal lays down the run's journal, dated mtime.
func writeJournal(t *testing.T, dir string, mtime time.Time, lines ...string) string {
	t.Helper()
	p := filepath.Join(dir, filepath.FromSlash(wfMembers), "journal.jsonl")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	writeDated(t, p, strings.Join(lines, "\n")+"\n", mtime)
	return p
}

// writeRunFile lays down the run file, dated mtime.
func writeRunFile(t *testing.T, dir, body string, mtime time.Time) string {
	t.Helper()
	p := filepath.Join(dir, "workflows", wfRun+".json")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	writeDated(t, p, body, mtime)
	return p
}

// runFile is the run file of a run that started at start and ran for length:
// its status, its phase titles, and its members as runMember writes them.
func runFile(status string, start, length time.Duration, phases []string, members ...string) string {
	var ps []string
	for _, p := range phases {
		ps = append(ps, fmt.Sprintf(`{"title":%q,"detail":""}`, p))
	}
	return fmt.Sprintf(`{"runId":%q,"workflowName":"check-change","summary":"Check the change before it lands","status":%q,`+
		`"startTime":%d,"durationMs":%d,"phases":[%s],"agentCount":%d,"totalTokens":1000,"totalToolCalls":9,"workflowProgress":[%s]}`,
		wfRun, status, agentMS(start), length.Milliseconds(), strings.Join(ps, ","), len(members), strings.Join(members, ","))
}

// runMember is one member's entry in a run file. A member still in progress
// when the run ended carries no durationMs, as Claude Code writes it.
func runMember(index int, id, label string, phase int, state string, started, last time.Duration) string {
	length := ""
	if state != "progress" {
		length = fmt.Sprintf(`,"durationMs":%d`, (last - started).Milliseconds())
	}
	return fmt.Sprintf(`{"type":"workflow_agent","index":%d,"label":%q,"phaseIndex":%d,"agentId":%q,"state":%q,"startedAt":%d,"lastProgressAt":%d%s}`,
		index, label, phase, id, state, agentMS(started), agentMS(last), length)
}

func workflowIDs(set sessionio.AgentSet) []string {
	var ids []string
	for _, w := range set.Workflows {
		ids = append(ids, w.ID)
	}
	return ids
}

// The design's "done when" for this step, one level down: a workflow run
// reports its phases and members. The contract carries every member of a
// running run, however long ago it finished, so a member whose files are
// older than the window is opened all the same. A run that is going has no
// run file yet, so its journal and its members say what it is.
func TestAgentWatchCarriesARunningWorkflowWhole(t *testing.T) {
	dir := t.TempDir()
	// Phase 1 ended over an hour ago, and its files have not moved since.
	writeAgent(t, dir, wfMembers, "m1", memberMeta("plan", "Plan"), []string{
		userLine("m1", -2*time.Hour, "Plan the review."),
		endLine("m1", -80*time.Minute, "mm1", "Two reviewers."),
	}, agentClock.Add(-80*time.Minute))
	writeAgent(t, dir, wfMembers, "m2", memberMeta("review:bugs", "Review"), []string{
		userLine("m2", -79*time.Minute, "Review for bugs."),
		toolLine("m2", -10*time.Second, "mm2", "toolu_m2", "Bash", `{"command":"go test ./..."}`),
	}, agentClock.Add(-10*time.Second))
	writeJournal(t, dir, agentClock.Add(-79*time.Minute),
		`{"type":"launched"}`,
		journalStarted("k1", "m1", "plan", "Plan"),
		journalResult("k1", "m1", `"Two reviewers."`),
		journalStarted("k2", "m2", "review:bugs", "Review"),
	)

	r := newCountingReader()
	now := agentClock
	aw := watchAt(dir, r, &now)
	aw.scan()
	set, _, _ := aw.Current()

	want := sessionio.WorkflowInfo{
		ID: wfRun, State: sessionio.WorkflowRunning, StartedAt: agentMS(-2 * time.Hour),
		Phases:       []sessionio.WorkflowPhase{{Index: 1, Title: "Plan"}, {Index: 2, Title: "Review"}},
		CurrentPhase: 2, AgentCount: 2, ToolCalls: 1,
	}
	if !reflect.DeepEqual(set.Workflows, []sessionio.WorkflowInfo{want}) {
		t.Fatalf("workflows\n got %+v\nwant [%+v]", set.Workflows, want)
	}
	if ids := agentIDs(set); !slices.Equal(ids, []string{"m1", "m2"}) {
		t.Fatalf("agents = %v, want both members in spawn order", ids)
	}
	if r.opened("m1") == 0 {
		t.Error("a running run's member was left unopened because its files are old")
	}
	m1 := agentByID(t, set, "m1")
	if m1.WorkflowID != wfRun || m1.Label != "plan" || m1.PhaseIndex != 1 || m1.State != sessionio.AgentDone ||
		m1.EndedAt != agentMS(-80*time.Minute) || m1.Result != "Two reviewers." {
		t.Errorf("m1 = %+v", m1)
	}
	m2 := agentByID(t, set, "m2")
	if m2.WorkflowID != wfRun || m2.Label != "review:bugs" || m2.PhaseIndex != 2 || m2.State != sessionio.AgentRunning ||
		m2.Tool != "Bash" || m2.ToolDetail != "go test ./..." || m2.ToolCalls != 1 {
		t.Errorf("m2 = %+v", m2)
	}
}

// A run that is over is carried for the window after it ended, with those of
// its members that ended inside the window. A member that ended before it is
// not carried, and its files, as old as its end, are never opened: the run
// file already holds all the panel would show of it.
func TestAgentWatchCarriesAnEndedWorkflowWhileItIsRecent(t *testing.T) {
	dir := t.TempDir()
	writeAgent(t, dir, wfMembers, "m1", memberMeta("plan", "Plan"), []string{
		userLine("m1", -2*time.Hour, "Plan the review."),
		endLine("m1", -80*time.Minute, "mm1", "Two reviewers."),
	}, agentClock.Add(-80*time.Minute))
	writeAgent(t, dir, wfMembers, "m2", memberMeta("review:bugs", "Review"), []string{
		userLine("m2", -79*time.Minute, "Review for bugs."),
		endLine("m2", -5*time.Minute, "mm2", "No bugs found."),
	}, agentClock.Add(-5*time.Minute))
	writeJournal(t, dir, agentClock.Add(-5*time.Minute),
		`{"type":"launched"}`,
		journalStarted("k1", "m1", "plan", "Plan"),
		journalResult("k1", "m1", `"Two reviewers."`),
		journalStarted("k2", "m2", "review:bugs", "Review"),
		journalResult("k2", "m2", `"No bugs found."`),
	)
	writeRunFile(t, dir, runFile("completed", -2*time.Hour, 116*time.Minute, []string{"Plan", "Review"},
		runMember(1, "m1", "plan", 1, "done", -2*time.Hour, -80*time.Minute),
		runMember(2, "m2", "review:bugs", 2, "done", -79*time.Minute, -5*time.Minute),
	), agentClock.Add(-4*time.Minute))

	r := newCountingReader()
	now := agentClock
	aw := watchAt(dir, r, &now)
	aw.scan()
	set, _, _ := aw.Current()

	want := sessionio.WorkflowInfo{
		ID: wfRun, Name: "check-change", Summary: "Check the change before it lands", State: sessionio.WorkflowDone,
		StartedAt: agentMS(-2 * time.Hour), EndedAt: agentMS(-4 * time.Minute),
		Phases:       []sessionio.WorkflowPhase{{Index: 1, Title: "Plan"}, {Index: 2, Title: "Review"}},
		CurrentPhase: 2, AgentCount: 2, Tokens: 1000, ToolCalls: 9,
	}
	if !reflect.DeepEqual(set.Workflows, []sessionio.WorkflowInfo{want}) {
		t.Fatalf("workflows\n got %+v\nwant [%+v]", set.Workflows, want)
	}
	if ids := agentIDs(set); !slices.Equal(ids, []string{"m2"}) {
		t.Fatalf("agents = %v, want only the member that ended inside the window", ids)
	}
	if n := r.opened("m1"); n != 0 {
		t.Errorf("m1 was read %d times; a finished run's member older than the window must not be opened", n)
	}
	if m2 := agentByID(t, set, "m2"); m2.State != sessionio.AgentDone || m2.EndedAt != agentMS(-5*time.Minute) || m2.Result != "No bugs found." {
		t.Errorf("m2 = %+v", m2)
	}
}

// A run that ended before the window is not carried, even when something under
// it was written since: here a hook trailing a member's last answer.
func TestAgentWatchDropsAWorkflowThatEndedBeforeTheWindow(t *testing.T) {
	dir := t.TempDir()
	writeAgent(t, dir, wfMembers, "m1", memberMeta("review", "Review"), []string{
		userLine("m1", -40*time.Minute, "Review the change."),
		endLine("m1", -21*time.Minute, "mm1", "Looks right."),
		hookLine("m1", -time.Minute),
	}, agentClock.Add(-time.Minute))
	writeJournal(t, dir, agentClock.Add(-21*time.Minute), `{"type":"launched"}`,
		journalStarted("k1", "m1", "review", "Review"), journalResult("k1", "m1", `"Looks right."`))
	writeRunFile(t, dir, runFile("completed", -40*time.Minute, 20*time.Minute, []string{"Review"},
		runMember(1, "m1", "review", 1, "done", -40*time.Minute, -21*time.Minute)), agentClock.Add(-20*time.Minute))

	now := agentClock
	aw := watchAt(dir, sessionio.LocalReader{}, &now)
	aw.scan()
	if set, _, _ := aw.Current(); len(set.Agents) != 0 || len(set.Workflows) != 0 {
		t.Fatalf("carried %v and runs %v; the run ended 20 minutes ago", agentIDs(set), workflowIDs(set))
	}
}

// The retention rule holds for runs too: a run nothing under which was written
// inside the window is never opened, whether it ended or its session died
// before it could.
func TestAgentWatchNeverOpensAnOldWorkflow(t *testing.T) {
	for _, tc := range []struct {
		name    string
		runFile bool
	}{
		{"it ended", true},
		{"its session died mid-run, so it never got a run file", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			old := agentClock.Add(-agentRetention - time.Minute)
			writeAgent(t, dir, wfMembers, "m1", memberMeta("build", "Build"), []string{
				userLine("m1", -time.Hour, "Build it."),
				toolLine("m1", -17*time.Minute, "mm1", "toolu_1", "Bash", `{"command":"go build ./..."}`),
			}, old)
			writeJournal(t, dir, old, `{"type":"launched"}`, journalStarted("k1", "m1", "build", "Build"))
			if tc.runFile {
				writeRunFile(t, dir, runFile("killed", -time.Hour, 44*time.Minute, []string{"Build"},
					runMember(1, "m1", "build", 1, "progress", -time.Hour, -17*time.Minute)), old)
			}

			r := newCountingReader()
			now := agentClock
			aw := watchAt(dir, r, &now)
			aw.scan()

			if n := r.opened("m1") + r.reads["journal.jsonl"] + r.smalls[wfRun+".json"]; n != 0 {
				t.Fatalf("an old run was read: reads %v, whole reads %v", r.reads, r.smalls)
			}
			if set, _, _ := aw.Current(); len(set.Agents) != 0 || len(set.Workflows) != 0 {
				t.Fatalf("carried %v and runs %v", agentIDs(set), workflowIDs(set))
			}
		})
	}
}

// The run file lands only when a run is over, written in place, so a scan can
// catch it half written. That read does not parse and changes nothing, and
// the file is read again on the next scan until it does. Then the run is over,
// with the name, summary and totals only the run file has. A later read that
// catches the file mid-write again keeps what the last good read gave.
func TestAgentWatchSeesAWorkflowEnd(t *testing.T) {
	dir := t.TempDir()
	member := writeAgent(t, dir, wfMembers, "m1", memberMeta("review", "Review"), []string{
		userLine("m1", -time.Minute, "Review the change."),
		toolLine("m1", -30*time.Second, "mm1", "toolu_1", "Read", `{"file_path":"/w/diff.patch"}`),
	}, agentClock.Add(-30*time.Second))
	journal := writeJournal(t, dir, agentClock.Add(-time.Minute),
		`{"type":"launched"}`, journalStarted("k1", "m1", "review", "Review"))

	r := newCountingReader()
	now := agentClock
	aw := watchAt(dir, r, &now)
	aw.scan()
	set, _, _ := aw.Current()
	if len(set.Workflows) != 1 || set.Workflows[0].State != sessionio.WorkflowRunning {
		t.Fatalf("before the run file: workflows %+v", set.Workflows)
	}
	if m := agentByID(t, set, "m1"); m.State != sessionio.AgentRunning || m.Tool != "Read" {
		t.Fatalf("before the run file: m1 = %+v", m)
	}

	// The member answers, the journal records it, and the run file is caught
	// half written.
	now = agentClock.Add(10 * time.Second)
	appendDated(t, member, now, endLine("m1", 10*time.Second, "mm2", "Looks right."))
	appendDated(t, journal, now, journalResult("k1", "m1", `"Looks right."`))
	whole := runFile("completed", -time.Minute, 70*time.Second, []string{"Review"},
		runMember(1, "m1", "review", 1, "done", -time.Minute, 10*time.Second))
	runPath := writeRunFile(t, dir, whole[:len(whole)/2], now)
	aw.scan()
	aw.scan()
	set, _, _ = aw.Current()
	if len(set.Workflows) != 1 || set.Workflows[0].State != sessionio.WorkflowRunning || set.Workflows[0].Name != "" {
		t.Fatalf("a half-written run file changed the run: %+v", set.Workflows)
	}
	if n := r.smalls[wfRun+".json"]; n != 2 {
		t.Fatalf("a half-written run file was read %d times in two scans, want 2", n)
	}
	if m := agentByID(t, set, "m1"); m.State != sessionio.AgentDone || m.Result != "Looks right." {
		t.Fatalf("after its answer: m1 = %+v", m)
	}

	now = agentClock.Add(11 * time.Second)
	writeDated(t, runPath, whole, now)
	aw.scan()
	set, _, _ = aw.Current()
	want := sessionio.WorkflowInfo{
		ID: wfRun, Name: "check-change", Summary: "Check the change before it lands", State: sessionio.WorkflowDone,
		StartedAt: agentMS(-time.Minute), EndedAt: agentMS(10 * time.Second),
		Phases:       []sessionio.WorkflowPhase{{Index: 1, Title: "Review"}},
		CurrentPhase: 1, AgentCount: 1, Tokens: 1000, ToolCalls: 9,
	}
	if !reflect.DeepEqual(set.Workflows, []sessionio.WorkflowInfo{want}) {
		t.Fatalf("after the run file\n got %+v\nwant [%+v]", set.Workflows, want)
	}

	now = agentClock.Add(12 * time.Second)
	writeDated(t, runPath, whole[:len(whole)-10], now)
	aw.scan()
	set, _, _ = aw.Current()
	if !reflect.DeepEqual(set.Workflows, []sessionio.WorkflowInfo{want}) {
		t.Fatalf("a read mid-write lost the last good run file: %+v", set.Workflows)
	}
}

// A kill leaves the members it cut off reading as running in every file they
// have. They end with their run: carried with it while it is recent, with its
// end as theirs, and let go with it once the window has passed.
func TestAgentWatchEndsACutOffMemberWithItsRun(t *testing.T) {
	dir := t.TempDir()
	writeAgent(t, dir, wfMembers, "m1", memberMeta("build", "Build"), []string{
		userLine("m1", -10*time.Minute, "Build it."),
		toolLine("m1", -2*time.Minute, "mm1", "toolu_1", "Bash", `{"command":"go build ./..."}`),
	}, agentClock.Add(-2*time.Minute))
	writeJournal(t, dir, agentClock.Add(-10*time.Minute),
		`{"type":"launched"}`, journalStarted("k1", "m1", "build", "Build"))
	writeRunFile(t, dir, runFile("killed", -10*time.Minute, 9*time.Minute, []string{"Build"},
		runMember(1, "m1", "build", 1, "progress", -10*time.Minute, -2*time.Minute)), agentClock.Add(-time.Minute))

	now := agentClock
	aw := watchAt(dir, sessionio.LocalReader{}, &now)
	aw.scan()
	set, _, _ := aw.Current()
	if len(set.Workflows) != 1 || set.Workflows[0].State != sessionio.WorkflowKilled || set.Workflows[0].EndedAt != agentMS(-time.Minute) {
		t.Fatalf("workflows = %+v", set.Workflows)
	}
	if m := agentByID(t, set, "m1"); m.State != sessionio.AgentRunning || m.EndedAt != agentMS(-time.Minute) {
		t.Fatalf("the cut-off member = %+v, want it running as its files say, ended with the run", m)
	}

	now = agentClock.Add(agentRetention)
	aw.scan()
	if set, _, _ := aw.Current(); len(set.Agents) != 0 || len(set.Workflows) != 0 {
		t.Fatalf("after the window: carried %v and runs %v", agentIDs(set), workflowIDs(set))
	}
	if len(aw.runs) != 0 || len(aw.agents) != 0 {
		t.Fatalf("still holding %d runs and %d agents after the window", len(aw.runs), len(aw.agents))
	}
}

// A member can spawn agents of its own. Those are ordinary agents under
// subagents/, and the member whose transcript emitted the Agent call is their
// parent.
func TestAgentWatchFindsAParentAmongWorkflowMembers(t *testing.T) {
	dir := t.TempDir()
	mtime := agentClock.Add(-10 * time.Second)
	writeAgent(t, dir, wfMembers, "m1", memberMeta("survey", "Survey"), []string{
		userLine("m1", -time.Minute, "Survey the callers."),
		toolLine("m1", -50*time.Second, "mm1", "toolu_spawn", "Agent", `{"description":"dig deeper"}`),
	}, mtime)
	writeAgent(t, dir, "subagents", "c1", `{"toolUseId":"toolu_spawn","spawnDepth":2}`, []string{
		userLine("c1", -40*time.Second, "dig"),
	}, mtime)

	now := agentClock
	aw := watchAt(dir, sessionio.LocalReader{}, &now)
	aw.scan()
	set, _, _ := aw.Current()
	if c := agentByID(t, set, "c1"); c.ParentID != "m1" || c.WorkflowID != "" {
		t.Fatalf("the member's own agent = %+v, want parentId m1 and no workflow", c)
	}
}

// A finished run's members count against the same 64 as every other finished
// agent, the newest ends first.
func TestAgentWatchCountsEndedMembersInTheCap(t *testing.T) {
	dir := t.TempDir()
	recent := agentClock.Add(-10 * time.Second)
	// 60 ad-hoc agents that ended between 12 and 7 minutes ago.
	for i := range 60 {
		id := fmt.Sprintf("e%02d", i)
		writeAgent(t, dir, "subagents", id, `{"description":"`+id+`"}`, []string{
			userLine(id, -14*time.Minute, "go"), endLine(id, -12*time.Minute+time.Duration(i)*5*time.Second, "m"+id, "done"),
		}, recent)
	}
	// A run that ended a minute ago, whose 10 members ended after all of them.
	var entries, journal []string
	for i := range 10 {
		id := fmt.Sprintf("w%d", i)
		end := -6*time.Minute + time.Duration(i)*20*time.Second
		writeAgent(t, dir, wfMembers, id, memberMeta(id, "Review"), []string{
			userLine(id, -10*time.Minute, "go"), endLine(id, end, "m"+id, "done"),
		}, recent)
		entries = append(entries, runMember(i+1, id, id, 1, "done", -10*time.Minute, end))
		journal = append(journal, journalStarted("k"+id, id, id, "Review"))
	}
	writeJournal(t, dir, recent, journal...)
	writeRunFile(t, dir, runFile("completed", -10*time.Minute, 9*time.Minute, []string{"Review"}, entries...), recent)

	now := agentClock
	aw := watchAt(dir, sessionio.LocalReader{}, &now)
	aw.scan()
	set, _, _ := aw.Current()

	if len(set.Agents) != maxEndedAgents {
		t.Fatalf("carried %d agents, want %d: %v", len(set.Agents), maxEndedAgents, agentIDs(set))
	}
	got := map[string]bool{}
	for _, id := range agentIDs(set) {
		got[id] = true
	}
	for i := range 10 {
		if id := fmt.Sprintf("w%d", i); !got[id] {
			t.Errorf("member %s, among the newest ends, was dropped", id)
		}
	}
	for i := range 6 {
		if id := fmt.Sprintf("e%02d", i); got[id] {
			t.Errorf("%s is among the oldest ends and should have been dropped", id)
		}
	}
	if ids := workflowIDs(set); !slices.Equal(ids, []string{wfRun}) {
		t.Errorf("workflows = %v, want the run its carried members belong to", ids)
	}
}

// A member whose transcript is listed but not yet read is left out, as any
// agent is before its first read, even though the journal already names it:
// one big transcript does not hold the run's other members back, and joins
// once its read finishes.
func TestAgentWatchPublishesARunBeforeABigMemberRead(t *testing.T) {
	dir := t.TempDir()
	mtime := agentClock.Add(-time.Second)
	writeAgent(t, dir, wfMembers, "small", memberMeta("small", "Build"), []string{
		userLine("small", -time.Minute, "go"),
	}, mtime)
	writeAgent(t, dir, wfMembers, "big", memberMeta("big", "Build"), []string{
		userLine("big", -2*time.Minute, strings.Repeat("x", bigAgentRead)),
	}, mtime)
	writeJournal(t, dir, mtime, `{"type":"launched"}`,
		journalStarted("k1", "big", "big", "Build"), journalStarted("k2", "small", "small", "Build"))

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
	if ids := agentIDs(set); !ok || !slices.Equal(ids, []string{"small"}) || len(set.Workflows) != 1 {
		t.Fatalf("during the big read: agents %v, runs %v, ok %v; want [small] in the run", ids, workflowIDs(set), ok)
	}

	close(r.release)
	<-done
	set, _, _ = aw.Current()
	if ids := agentIDs(set); !slices.Equal(ids, []string{"big", "small"}) {
		t.Fatalf("after the big read: agents = %v, want both", ids)
	}
}

// A run whose files have left the directory is forgotten with its members.
func TestAgentWatchForgetsAWorkflowWhoseFilesAreGone(t *testing.T) {
	dir := t.TempDir()
	mtime := agentClock.Add(-time.Second)
	writeAgent(t, dir, wfMembers, "m1", memberMeta("build", "Build"), []string{userLine("m1", -time.Minute, "go")}, mtime)
	writeJournal(t, dir, mtime, `{"type":"launched"}`, journalStarted("k1", "m1", "build", "Build"))

	now := agentClock
	aw := watchAt(dir, sessionio.LocalReader{}, &now)
	aw.scan()
	if len(aw.runs) != 1 || len(aw.agents) != 1 {
		t.Fatalf("watching %d runs and %d agents, want 1 and 1", len(aw.runs), len(aw.agents))
	}

	if err := os.RemoveAll(filepath.Join(dir, filepath.FromSlash(wfMembers))); err != nil {
		t.Fatal(err)
	}
	aw.scan()
	if len(aw.runs) != 0 || len(aw.agents) != 0 {
		t.Fatalf("still holding %d runs and %d agents after their files went", len(aw.runs), len(aw.agents))
	}
	if set, _, _ := aw.Current(); len(set.Agents) != 0 || len(set.Workflows) != 0 {
		t.Fatalf("carried %v and runs %v", agentIDs(set), workflowIDs(set))
	}
}

// A run file too big to read whole is refused by the reader, so the watch does
// not ask for it once a scan. The run reads as its journal and members say.
func TestAgentWatchNeverReadsAnOversizedRunFile(t *testing.T) {
	dir := t.TempDir()
	mtime := agentClock.Add(-time.Second)
	writeAgent(t, dir, wfMembers, "m1", memberMeta("build", "Build"), []string{userLine("m1", -time.Minute, "go")}, mtime)
	writeJournal(t, dir, mtime, `{"type":"launched"}`, journalStarted("k1", "m1", "build", "Build"))
	writeRunFile(t, dir, strings.Repeat(" ", sessionio.MaxSmallFile+1), mtime)

	r := newCountingReader()
	now := agentClock
	aw := watchAt(dir, r, &now)
	aw.scan()
	aw.scan()
	if n := r.smalls[wfRun+".json"]; n != 0 {
		t.Fatalf("an oversized run file was read %d times", n)
	}
	set, _, _ := aw.Current()
	if len(set.Workflows) != 1 || set.Workflows[0].State != sessionio.WorkflowRunning {
		t.Fatalf("workflows = %+v", set.Workflows)
	}
}

// writeScript lays down the run's script as Claude Code writes it when it
// launches the run, dated mtime.
func writeScript(t *testing.T, dir, body string, mtime time.Time) string {
	t.Helper()
	p := filepath.Join(dir, "workflows", "scripts", "check-change-"+wfRun+".js")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	writeDated(t, p, body, mtime)
	return p
}

const checkScript = `export const meta = {
  name: 'check-change',
  description: 'Check the change before it lands',
  phases: [
    { title: 'Survey', detail: 'read the diff' },
    { title: 'Check', detail: 'three checkers in parallel' },
    { title: 'Land' },
  ],
}

phase('Survey')
const survey = await agent('Read the diff.', { label: 'survey' })
`

// A run still going has no run file, but it has its script from the moment it
// was launched, and the script's meta names the run and lists every phase it
// will go through. So the panel's run header has its name straight away and
// the phases still to come are drawn waiting. The script is written once, so
// it is read once, and again only when a resume rewrites it.
func TestAgentWatchDescribesARunningWorkflowFromItsScript(t *testing.T) {
	dir := t.TempDir()
	script := writeScript(t, dir, checkScript, agentClock.Add(-2*time.Minute))
	writeAgent(t, dir, wfMembers, "m1", memberMeta("check:bugs", "Check"), []string{
		userLine("m1", -time.Minute, "Check it for bugs."),
		toolLine("m1", -5*time.Second, "mm1", "toolu_1", "Bash", `{"command":"go test ./..."}`),
	}, agentClock.Add(-5*time.Second))
	writeJournal(t, dir, agentClock.Add(-time.Minute),
		`{"type":"launched"}`, journalStarted("k1", "m1", "check:bugs", "Check"))

	r := newCountingReader()
	now := agentClock
	aw := watchAt(dir, r, &now)
	aw.scan()
	aw.scan()
	aw.scan()
	set, _, _ := aw.Current()
	want := sessionio.WorkflowInfo{
		ID: wfRun, Name: "check-change", Summary: "Check the change before it lands", State: sessionio.WorkflowRunning,
		StartedAt: agentMS(-time.Minute),
		Phases: []sessionio.WorkflowPhase{
			{Index: 1, Title: "Survey", Detail: "read the diff"},
			{Index: 2, Title: "Check", Detail: "three checkers in parallel"},
			{Index: 3, Title: "Land"},
		},
		CurrentPhase: 2, AgentCount: 1, ToolCalls: 1,
	}
	if !reflect.DeepEqual(set.Workflows, []sessionio.WorkflowInfo{want}) {
		t.Fatalf("workflows\n got %+v\nwant [%+v]", set.Workflows, want)
	}
	if m := agentByID(t, set, "m1"); m.PhaseIndex != 2 {
		t.Errorf("m1 is in phase %d, want the script's 2", m.PhaseIndex)
	}
	if n := r.smalls[filepath.Base(script)]; n != 1 {
		t.Fatalf("an unchanged script was read %d times in three scans, want once", n)
	}

	// A resume rewrites the script. The next scan reads it again.
	now = agentClock.Add(time.Second)
	writeDated(t, script, strings.Replace(checkScript, "Check the change before it lands", "Check the change again", 1), now)
	aw.scan()
	set, _, _ = aw.Current()
	if n := r.smalls[filepath.Base(script)]; n != 2 || set.Workflows[0].Summary != "Check the change again" {
		t.Fatalf("after a rewrite: read %d times, summary %q", n, set.Workflows[0].Summary)
	}
}

// A script is not a run. Of the 138 on this box, 57 have no member, no journal
// and no run file beside them, so a script on its own takes no run up, is never
// read, and holds up nothing: the panel would otherwise show a run that never
// started as running.
func TestAgentWatchTakesNoRunUpFromItsScriptAlone(t *testing.T) {
	dir := t.TempDir()
	script := writeScript(t, dir, checkScript, agentClock)

	r := newCountingReader()
	now := agentClock
	aw := watchAt(dir, r, &now)
	aw.scan()
	set, _, _ := aw.Current()
	if len(set.Workflows) != 0 || len(aw.runs) != 0 {
		t.Fatalf("a script alone made a run: %+v, watching %d", set.Workflows, len(aw.runs))
	}
	if n := r.smalls[filepath.Base(script)]; n != 0 {
		t.Fatalf("a script with no run was read %d times", n)
	}
}

// A script whose meta cannot be read leaves the run as its journal and members
// say, and is not read again every scan: it only changes if it is rewritten.
func TestAgentWatchReadsAnUnreadableScriptOnce(t *testing.T) {
	dir := t.TempDir()
	script := writeScript(t, dir, "export const meta = { name: NAME }\n", agentClock.Add(-2*time.Minute))
	writeAgent(t, dir, wfMembers, "m1", memberMeta("build", "Build"), []string{userLine("m1", -time.Minute, "go")}, agentClock.Add(-time.Second))
	writeJournal(t, dir, agentClock.Add(-time.Minute), `{"type":"launched"}`, journalStarted("k1", "m1", "build", "Build"))

	r := newCountingReader()
	now := agentClock
	aw := watchAt(dir, r, &now)
	aw.scan()
	aw.scan()
	set, _, _ := aw.Current()
	if len(set.Workflows) != 1 || set.Workflows[0].Name != "" ||
		!reflect.DeepEqual(set.Workflows[0].Phases, []sessionio.WorkflowPhase{{Index: 1, Title: "Build"}}) {
		t.Fatalf("workflows = %+v", set.Workflows)
	}
	if n := r.smalls[filepath.Base(script)]; n != 1 {
		t.Fatalf("an unreadable script was read %d times in two scans, want once", n)
	}
}

// A Workflow script can reach 512 KB, well inside the reader's cap, but one
// past it is refused whole, so the watch never asks for it.
func TestAgentWatchNeverReadsAnOversizedScript(t *testing.T) {
	dir := t.TempDir()
	script := writeScript(t, dir, checkScript+"//"+strings.Repeat(" ", sessionio.MaxSmallFile)+"\n", agentClock.Add(-2*time.Minute))
	writeAgent(t, dir, wfMembers, "m1", memberMeta("build", "Build"), []string{userLine("m1", -time.Minute, "go")}, agentClock.Add(-time.Second))
	writeJournal(t, dir, agentClock.Add(-time.Minute), `{"type":"launched"}`, journalStarted("k1", "m1", "build", "Build"))

	r := newCountingReader()
	now := agentClock
	aw := watchAt(dir, r, &now)
	aw.scan()
	aw.scan()
	if n := r.smalls[filepath.Base(script)]; n != 0 {
		t.Fatalf("an oversized script was read %d times", n)
	}
	if set, _, _ := aw.Current(); len(set.Workflows) != 1 || set.Workflows[0].Name != "" {
		t.Fatalf("workflows = %+v", set.Workflows)
	}
}
