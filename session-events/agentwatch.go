package main

import (
	"context"
	"log"
	"path"
	"path/filepath"
	"reflect"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"terminal-lobby/sessionio"
)

// The agent panel's server half: one session's subagents and Workflow runs,
// followed through the files Claude Code keeps beside the transcript, and
// carried to the text view as the `agents` SSE event (design steps 2 and 3,
// docs/plans/2026-09-12-agent-workflow-visualisation-design.md).
//
// The directory is polled rather than watched with fsnotify. Most users' files
// are read through a child running as that user (privreader.go), and an
// inotify watch cannot cross that boundary. A listing is names, sizes and
// times, so a poll costs one directory read and a stat per file, and a file is
// read only when its size or time moved.

// AgentScanInterval is how often a watched session's agent files are listed.
// The panel ticks its own elapsed clock, so this bounds only how late a new
// agent or a new tool name appears: a second, beside agent files measured
// landing 450 ms behind the model.
const AgentScanInterval = time.Second

// agentRetention is the contract's window. An agent file not written inside it
// is never opened, unless its agent is a member of a workflow run still going,
// and an agent or a run that ended longer ago is no longer carried.
const agentRetention = 15 * time.Minute

// maxEndedAgents bounds how many finished agents a snapshot carries, newest
// ends first. The busiest session on this box has 153 agent transcripts.
const maxEndedAgents = 64

// agentFresh is how old a snapshot may be and still go to a stream that has
// just opened. A watch with no subscriber stops scanning, so its set can be
// minutes old by the time a reader comes back; that reader waits for the scan
// its own subscription triggers rather than seeing a finished agent as running.
const agentFresh = 3 * time.Second

// bigAgentRead is the pending read above which a scan publishes what it already
// has before reading on. The first read of a 34 MB agent transcript measured
// 5 s cold and 1.4 s warm, and the agents that are cheap to read should not
// wait behind it.
const bigAgentRead = 1 << 20

// agentWatch follows the agents of one session: the directory beside its
// transcript, one sessionio.AgentTail per agent, one sessionio.Workflow per
// workflow run, and the AgentSet built from them. The goroutine in run owns
// the tails, the runs and everything else below mu's fields; readers see only
// the published snapshot.
type agentWatch struct {
	// dir is the session directory, sessionio.SessionDir of the transcript,
	// read through directory: a mod names the transcript only once Claude has
	// written it, after the watch is running (SetDir). "" lists nothing.
	dirMu  sync.Mutex
	dir    string
	reader sessionio.AgentReader
	now    func() time.Time
	every  time.Duration
	wake   chan struct{} // a new subscriber asks for a scan now

	mu      sync.Mutex
	set     sessionio.AgentSet
	version uint64    // moves when set does; 0 until the first scan
	scanned time.Time // when a listing last confirmed set
	subs    map[int]chan struct{}
	nextSub int
	paths   map[string]string // agent id -> transcript, for every agent file in the last listing

	// engine is the engine's own agent list as the mod last reported it, by
	// id, nil until it has reported one; canSteer is whether the session's mod
	// runs the steer op. Both decide AgentInfo.Steerable (steerability), and
	// are guarded by engineMu, since the mod's routes set them.
	engineMu sync.Mutex
	engine   map[string]sessionio.ModAgent
	canSteer bool

	agents  map[string]*watchedAgent
	runs    map[string]*watchedRun // by run id, "wf_<runId>"
	failing bool                   // the last listing failed; logged once per run of failures
}

// watchedAgent is one agent the watch has opened.
type watchedAgent struct {
	run  string // the workflow run a member belongs to, "" for any other agent
	tail *sessionio.AgentTail
	meta sessionio.AgentMeta

	// What the listing said when each file was last read, so a scan reads
	// only what moved: the size for the transcript, which only grows, and the
	// size and time for the sidecar, which is rewritten in place.
	polled   int64 // -1 until the transcript's first read
	metaSize int64 // -1 until the sidecar has parsed
	metaTime int64

	hasTranscript bool  // the last listing had agent-<id>.jsonl
	newest        int64 // the latest mtime of its files in the last listing, ms
}

// watchedRun is one Workflow run the watch follows. Its journal, run file and
// script are read into a sessionio.Workflow, which merges them with the
// members' tails; the members themselves are watchedAgents with run set.
type watchedRun struct {
	wf *sessionio.Workflow

	// What the listing said when each file was last read, as for an agent:
	// the size for the journal, which only grows, and the size and time for
	// the run file, which is written in place.
	journal int64 // -1 until the journal's first read
	runSize int64
	runTime int64 // -1 until the run file has parsed

	// The script's name, size and time when it was last read. It is written
	// once, when the run is launched, so it is read once whether or not its
	// meta parsed, and again only if a resume rewrites it.
	script     string // "" until it has been read
	scriptSize int64
	scriptTime int64

	newest int64 // the latest mtime of any file under the run in the last listing, its members' included
}

func newAgentWatch(dir string, r sessionio.AgentReader) *agentWatch {
	return &agentWatch{
		dir: dir, reader: r, now: time.Now, every: AgentScanInterval,
		wake:   make(chan struct{}, 1),
		subs:   map[int]chan struct{}{},
		paths:  map[string]string{},
		agents: map[string]*watchedAgent{},
		runs:   map[string]*watchedRun{},
	}
}

// run scans once straight away, so the stream that caused the session's
// source to be built finds a set waiting, then every `every` for as long as
// somebody is subscribed.
func (aw *agentWatch) run(ctx context.Context) {
	aw.scan()
	t := time.NewTicker(aw.every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-aw.wake:
		case <-t.C:
		}
		if aw.watched() {
			aw.scan()
		}
	}
}

// directory is the session directory the watch lists, "" until it has one.
func (aw *agentWatch) directory() string {
	aw.dirMu.Lock()
	defer aw.dirMu.Unlock()
	return aw.dir
}

// SetDir points the watch at the session directory once the transcript is
// known, and scans it straight away.
func (aw *agentWatch) SetDir(dir string) {
	aw.dirMu.Lock()
	aw.dir = dir
	aw.dirMu.Unlock()
	select {
	case aw.wake <- struct{}{}:
	default:
	}
}

// SetEngine records the engine's agent list from the mod's `agents` event and
// has the set published again.
func (aw *agentWatch) SetEngine(agents []sessionio.ModAgent) {
	m := make(map[string]sessionio.ModAgent, len(agents))
	for _, a := range agents {
		m[a.ID] = a
	}
	aw.engineMu.Lock()
	aw.engine = m
	aw.engineMu.Unlock()
	aw.poke()
}

// SetSteer records whether the session's mod can steer an agent.
func (aw *agentWatch) SetSteer(can bool) {
	aw.engineMu.Lock()
	changed := aw.canSteer != can
	aw.canSteer = can
	aw.engineMu.Unlock()
	if changed {
		aw.poke()
	}
}

// poke asks the loop for a scan now, which publishes the set again.
func (aw *agentWatch) poke() {
	select {
	case aw.wake <- struct{}{}:
	default:
	}
}

// steerability is whether the person can message an agent from the Text view,
// and the note why not. The engine's list decides for a teammate, which reads
// done between its turns though the engine still runs it, and that is when it
// takes a message. For a plain subagent both must agree it is running: the mod
// sends the list as a turn completes, and measured live on 2026-10-03 that list
// still called a finished subagent running, which left the composer open on
// it. An agent the engine has not listed yet goes by its file. Workflow members are not addressed (the engine lists the run, not
// them), and a mod from before steering cannot be asked at all.
func steerability(info sessionio.AgentInfo, engine map[string]sessionio.ModAgent, canSteer bool) (bool, string) {
	switch {
	case !canSteer:
		return false, sessionio.SteerOldMod
	case info.WorkflowID != "":
		return false, sessionio.SteerWorkflow
	}
	if a, ok := engine[info.ID]; ok {
		switch {
		case a.Status != "running" || a.Type == "workflow":
			return false, sessionio.SteerFinished
		case a.Type != "teammate" && info.State != sessionio.AgentRunning:
			return false, sessionio.SteerFinished
		}
		return true, ""
	}
	if info.State == sessionio.AgentRunning {
		return true, ""
	}
	return false, sessionio.SteerFinished
}

func (aw *agentWatch) watched() bool {
	aw.mu.Lock()
	defer aw.mu.Unlock()
	return len(aw.subs) > 0
}

// Current is the newest snapshot and its version. ok is false before the first
// scan has finished and while the snapshot is older than agentFresh.
func (aw *agentWatch) Current() (set sessionio.AgentSet, version uint64, ok bool) {
	aw.mu.Lock()
	defer aw.mu.Unlock()
	return aw.set, aw.version, aw.version > 0 && aw.now().Sub(aw.scanned) <= agentFresh
}

// Subscribe returns a channel signalled after every scan, changed or not, and
// the func that releases it. It also asks for a scan now, because a watch with
// no subscriber has not been scanning.
func (aw *agentWatch) Subscribe() (<-chan struct{}, func()) {
	aw.mu.Lock()
	id := aw.nextSub
	aw.nextSub++
	ch := make(chan struct{}, 1)
	aw.subs[id] = ch
	aw.mu.Unlock()
	select {
	case aw.wake <- struct{}{}:
	default:
	}
	return ch, func() {
		aw.mu.Lock()
		delete(aw.subs, id)
		aw.mu.Unlock()
	}
}

// TranscriptPath is the transcript of the agent with this id, when the last
// listing had one: ad-hoc agents, teammates and workflow members alike. Only
// names the session directory actually holds resolve, so an id taken from a
// request cannot point a read anywhere else.
func (aw *agentWatch) TranscriptPath(id string) (string, bool) {
	aw.mu.Lock()
	defer aw.mu.Unlock()
	p, ok := aw.paths[id]
	return p, ok
}

// Resolve is TranscriptPath for a request: the watch's last listing when it
// has the id, and otherwise one more listing of the directory. A watch nobody
// is subscribed to has not scanned since it went quiet, and has never scanned
// at all when a drill-in is the first thing to open its session, so an agent
// missing from the listing it holds may only be newer than it. The id is
// compared against the names the directory lists and never becomes a path.
func (aw *agentWatch) Resolve(id string) (string, bool) {
	if p, ok := aw.TranscriptPath(id); ok {
		return p, true
	}
	dir := aw.directory()
	if dir == "" {
		return "", false
	}
	files, err := aw.reader.ListAgentFiles(dir)
	if err != nil {
		return "", false
	}
	for _, f := range files {
		if got, isMeta, _, ok := agentFileName(f.Name); ok && !isMeta && got == id {
			return aw.abs(f.Name), true
		}
	}
	return "", false
}

// listedAgent is what one listing holds for one agent.
type listedAgent struct {
	run   string // the workflow run a member belongs to, "" for any other agent
	jsonl *sessionio.AgentFile
	meta  *sessionio.AgentFile
}

// listedRun is what one listing holds for one workflow run.
type listedRun struct {
	journal *sessionio.AgentFile
	runFile *sessionio.AgentFile
	script  *sessionio.AgentFile
	// newest is the latest mtime of any file under the run, its members'
	// included and its script left out: a script is written when a run is
	// launched whether or not the run ever starts anything, so it says nothing
	// about whether the run is recent.
	newest int64
}

// scan lists the session directory once and brings the snapshot up to date.
func (aw *agentWatch) scan() {
	dir := aw.directory()
	if dir == "" {
		return
	}
	files, err := aw.reader.ListAgentFiles(dir)
	if err != nil {
		if !aw.failing {
			log.Printf("agents %s: listing failed, keeping the last set: %v", dir, err)
		}
		aw.failing = true
		return
	}
	if aw.failing {
		log.Printf("agents %s: listing works again", dir)
		aw.failing = false
	}
	cutoff := aw.now().Add(-agentRetention).UnixMilli()

	listed := map[string]*listedAgent{}
	runs := map[string]*listedRun{}
	runOf := func(id string) *listedRun {
		r := runs[id]
		if r == nil {
			r = &listedRun{}
			runs[id] = r
		}
		return r
	}
	paths := map[string]string{}
	for i := range files {
		f := &files[i]
		if run, ok := scriptName(f.Name); ok {
			// Two scripts for one run would be a rename; the later one stands.
			if r := runOf(run); r.script == nil || f.MTime > r.script.MTime {
				r.script = f
			}
			continue
		}
		if run, journal, ok := runFileName(f.Name); ok {
			r := runOf(run)
			if journal {
				r.journal = f
			} else {
				r.runFile = f
			}
			r.newest = max(r.newest, f.MTime)
			continue
		}
		id, isMeta, run, ok := agentFileName(f.Name)
		if !ok {
			continue
		}
		if run != "" {
			r := runOf(run)
			r.newest = max(r.newest, f.MTime)
		}
		l := listed[id]
		if l == nil {
			l = &listedAgent{run: run}
			listed[id] = l
		}
		if isMeta {
			l.meta = f
		} else {
			l.jsonl = f
			paths[id] = aw.abs(f.Name)
		}
	}
	aw.mu.Lock()
	aw.paths = paths
	aw.mu.Unlock()

	for id := range aw.agents {
		if listed[id] == nil {
			delete(aw.agents, id) // its files are gone
		}
	}
	for id := range aw.runs {
		if runs[id] == nil {
			delete(aw.runs, id) // and so are its members', with theirs
		}
	}
	// Runs first: whether a run is still going decides which of its members
	// are opened.
	aw.followRuns(runs, cutoff)

	type read struct {
		a       *watchedAgent
		size    int64
		pending int64
	}
	var reads []read
	for id, l := range listed {
		newest := max(mtimeOf(l.jsonl), mtimeOf(l.meta))
		a := aw.agents[id]
		if a == nil {
			if !aw.opens(l.run, newest, cutoff) {
				continue // not written inside the window, nor in a run still going: never opened
			}
			transcript := aw.abs(transcriptName(l.run, id))
			a = &watchedAgent{run: l.run, tail: sessionio.NewAgentTail(transcript, aw.reader), polled: -1, metaSize: -1}
			aw.agents[id] = a
		}
		a.newest, a.hasTranscript = newest, l.jsonl != nil
		if l.meta != nil && (l.meta.Size != a.metaSize || l.meta.MTime != a.metaTime) {
			aw.readMeta(a, l.meta)
		}
		if l.jsonl != nil && l.jsonl.Size != a.polled {
			reads = append(reads, read{a, l.jsonl.Size, l.jsonl.Size - a.tail.Offset()})
		}
	}

	// Cheapest first, and before the first big one, a publish of what is
	// already known.
	sort.Slice(reads, func(i, j int) bool { return reads[i].pending < reads[j].pending })
	early := false
	for _, r := range reads {
		if r.pending > bigAgentRead && !early {
			aw.publish()
			early = true
		}
		if _, err := r.a.tail.Poll(); err != nil {
			continue // gone since the listing, or not readable: the next scan retries
		}
		r.a.polled = r.size
	}
	aw.evict(cutoff)
	aw.publish()
}

// readMeta reads a sidecar the listing says moved. A read that lands mid-write
// does not parse; the old identity stays and the next scan reads it again.
func (aw *agentWatch) readMeta(a *watchedAgent, f *sessionio.AgentFile) {
	b, err := aw.reader.ReadSmallFile(aw.abs(f.Name))
	if err != nil {
		return
	}
	m, err := sessionio.ParseAgentMeta(b)
	if err != nil {
		return
	}
	m.WrittenAt = f.MTime
	a.meta, a.metaSize, a.metaTime = m, f.Size, f.MTime
}

// followRuns brings the runs up to date from one listing. A run is taken up
// only when something under it was written inside the window, as an agent is,
// and is then followed until evict lets it go, which it never does while the
// run is going. Its journal is polled when it grew, its run file read again
// whenever it moved, and its script read when it is new or rewritten.
func (aw *agentWatch) followRuns(runs map[string]*listedRun, cutoff int64) {
	for id, l := range runs {
		r := aw.runs[id]
		if r == nil {
			if l.newest < cutoff {
				continue // nothing under it written inside the window: never opened
			}
			r = &watchedRun{wf: sessionio.NewWorkflow(aw.directory(), id, aw.reader), journal: -1, runSize: -1, runTime: -1}
			aw.runs[id] = r
		}
		r.newest = l.newest
		if f := l.runFile; f != nil && (f.Size != r.runSize || f.MTime != r.runTime) {
			aw.readRunFile(r, f)
		}
		if f := l.journal; f != nil && f.Size != r.journal {
			if _, err := r.wf.PollJournal(); err == nil {
				r.journal = f.Size
			}
		}
		if f := l.script; f != nil && (f.Name != r.script || f.Size != r.scriptSize || f.MTime != r.scriptTime) {
			aw.readScript(r, f)
		}
	}
}

// readScript reads a run's script the listing says is new or was rewritten. A
// script whose meta does not parse is not read again until it changes, since
// it is written once; a read that fails is tried again on the next scan. A
// script past MaxSmallFile is never asked for, since the reader refuses it
// whole, and the run reads as it would without one.
func (aw *agentWatch) readScript(r *watchedRun, f *sessionio.AgentFile) {
	if f.Size <= sessionio.MaxSmallFile {
		b, err := aw.reader.ReadSmallFile(aw.abs(f.Name))
		if err != nil {
			return
		}
		r.wf.SetScript(b)
	}
	r.script, r.scriptSize, r.scriptTime = f.Name, f.Size, f.MTime
}

// readRunFile reads a run file the listing says moved. Claude Code writes it in
// place, so a read can land mid-write and not parse; the run keeps the last one
// that did, and the next scan reads it again. A file past MaxSmallFile is never
// asked for, since the reader refuses it whole.
func (aw *agentWatch) readRunFile(r *watchedRun, f *sessionio.AgentFile) {
	if f.Size > sessionio.MaxSmallFile {
		return
	}
	b, err := aw.reader.ReadSmallFile(r.wf.RunPath())
	if err != nil || r.wf.SetRunFile(b) != nil {
		return
	}
	r.runSize, r.runTime = f.Size, f.MTime
}

// opens says whether to open an agent the watch has not: one with a file
// written inside the window, or a member of a run still going, which the
// contract carries whole however long ago the member finished. A member of a
// run the watch does not follow is never opened, since it is never carried.
func (aw *agentWatch) opens(run string, newest, cutoff int64) bool {
	if run == "" {
		return newest >= cutoff
	}
	r := aw.runs[run]
	return r != nil && (newest >= cutoff || r.wf.Running())
}

// end is when a run that is over ended: as its run file says, else when that
// file was written.
func (r *watchedRun) end(info sessionio.WorkflowInfo) int64 {
	if info.EndedAt > 0 {
		return info.EndedAt
	}
	return r.runTime
}

// evict lets go of what the snapshot no longer carries and nothing has written
// to since: an agent that ended before the window, and a run that is over and
// ended before it, with its members. Their files are then as old as any the
// watch never opened, and they are treated the same way: opened again only if
// one of them moves. A member goes with its run and not before, so it never
// flips between its own figures and the run file's.
func (aw *agentWatch) evict(cutoff int64) {
	for id, a := range aw.agents {
		if a.run != "" {
			continue
		}
		info := a.tail.Info(a.meta)
		if hasEnded(info) && endOf(info) < cutoff && a.newest < cutoff {
			delete(aw.agents, id)
		}
	}
	for id, r := range aw.runs {
		if r.wf.Running() || r.newest >= cutoff {
			continue
		}
		if info, _ := r.wf.Merge(nil); r.end(info) >= cutoff {
			continue
		}
		delete(aw.runs, id)
		for aid, a := range aw.agents {
			if a.run == id {
				delete(aw.agents, aid)
			}
		}
	}
}

// ready reports whether the agent has anything true to show: its transcript
// read at least once, or, in the two seconds before the transcript exists, its
// sidecar. An agent whose first read is still to come is left out rather than
// shown as whatever its sidecar alone would suggest.
func (a *watchedAgent) ready() bool {
	return a.polled >= 0 || !a.hasTranscript && a.metaSize >= 0
}

// publish builds the snapshot from what has been read and signals every
// subscriber. The version moves only when the set did, so a stream tells a
// scan that found nothing from one that found something.
func (aw *agentWatch) publish() {
	now := aw.now()
	set := aw.snapshot(now)
	aw.mu.Lock()
	if aw.version == 0 || !sameAgentSet(aw.set, set) {
		aw.set = set
		aw.version++
	}
	aw.scanned = now
	subs := make([]chan struct{}, 0, len(aw.subs))
	for _, ch := range aw.subs {
		subs = append(subs, ch)
	}
	aw.mu.Unlock()
	for _, ch := range subs {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

// snapshot is the part of what the watch knows that a set sends: every agent
// still going and every member of a run still going, then the agents that
// ended inside the window, at most maxEndedAgents of them with the newest ends
// first. A run that is over is carried while it ended inside the window, with
// those of its members that did, and its cut-off members count as ended with
// it. A member is never carried without its run, which the panel draws it
// under. Agents are in spawn order, runs in start order, both then by id.
func (aw *agentWatch) snapshot(now time.Time) sessionio.AgentSet {
	cutoff := now.Add(-agentRetention).UnixMilli()
	spawner := aw.spawners()
	var going, ended []sessionio.AgentInfo
	for _, a := range aw.agents {
		if a.run != "" || !a.ready() {
			continue
		}
		switch info := a.info(spawner); {
		case !hasEnded(info):
			going = append(going, info)
		case endOf(info) >= cutoff:
			ended = append(ended, info)
		}
	}
	var set sessionio.AgentSet
	for id, r := range aw.runs {
		run, members := aw.merge(id, r, spawner)
		switch {
		case run.State == sessionio.WorkflowRunning:
			going = append(going, members...)
		case r.end(run) >= cutoff:
			for _, m := range members {
				if endOf(m) >= cutoff {
					ended = append(ended, m)
				}
			}
		default:
			continue
		}
		set.Workflows = append(set.Workflows, run)
	}
	set.Agents = carried(going, ended)
	aw.engineMu.Lock()
	for i := range set.Agents {
		set.Agents[i].Steerable, set.Agents[i].SteerNote = steerability(set.Agents[i], aw.engine, aw.canSteer)
	}
	aw.engineMu.Unlock()
	sort.Slice(set.Workflows, func(i, j int) bool {
		a, b := set.Workflows[i], set.Workflows[j]
		if a.StartedAt != b.StartedAt {
			return a.StartedAt < b.StartedAt
		}
		return a.ID < b.ID
	})
	return set
}

// merge is one run and its members as the panel shows them. A member whose
// transcript is listed but not read yet is left out, as any agent is before its
// first read; one the run names with no transcript listed shows what the run's
// own files say of it. The members go in in spawn order, which is how a run
// still going numbers any phase its journal has not named.
func (aw *agentWatch) merge(id string, r *watchedRun, spawner map[string]string) (sessionio.WorkflowInfo, []sessionio.AgentInfo) {
	var files []sessionio.RunAgent
	pending := map[string]bool{}
	for aid, a := range aw.agents {
		switch {
		case a.run != id:
		case a.ready():
			files = append(files, sessionio.RunAgent{Info: a.info(spawner), Phase: a.meta.WorkflowPhase})
		case a.hasTranscript:
			pending[aid] = true
		}
	}
	sort.Slice(files, func(i, j int) bool { return spawnedBefore(files[i].Info, files[j].Info) })
	run, members := r.wf.Merge(files)
	return run, slices.DeleteFunc(members, func(m sessionio.AgentInfo) bool { return pending[m.ID] })
}

// spawners maps each Agent tool_use id to the agent whose transcript emitted
// it. Members are among them: an agent a member spawns is an ordinary one.
func (aw *agentWatch) spawners() map[string]string {
	spawner := map[string]string{}
	for id, a := range aw.agents {
		for _, use := range a.tail.Spawned() {
			spawner[use] = id
		}
	}
	return spawner
}

// info is the agent as the panel shows it, with its parent resolved: the
// sidecar's parentAgentId when it names one, else the agent whose transcript
// emitted the Agent call the sidecar's toolUseId points at. A call no agent
// emitted was the session's own, and leaves the parent "".
func (a *watchedAgent) info(spawner map[string]string) sessionio.AgentInfo {
	info := a.tail.Info(a.meta)
	if info.ParentID == "" && info.ToolUseID != "" {
		if p := spawner[info.ToolUseID]; p != info.ID {
			info.ParentID = p
		}
	}
	return info
}

// carried is the agents a snapshot sends: all of going, and the newest
// maxEndedAgents ends of ended, in spawn order.
func carried(going, ended []sessionio.AgentInfo) []sessionio.AgentInfo {
	sort.Slice(ended, func(i, j int) bool {
		if ei, ej := endOf(ended[i]), endOf(ended[j]); ei != ej {
			return ei > ej
		}
		return ended[i].ID < ended[j].ID
	})
	if len(ended) > maxEndedAgents {
		ended = ended[:maxEndedAgents]
	}
	out := append(going, ended...)
	sort.Slice(out, func(i, j int) bool { return spawnedBefore(out[i], out[j]) })
	return out
}

// spawnedBefore is spawn order: startedAt, then id.
func spawnedBefore(a, b sessionio.AgentInfo) bool {
	if a.StartedAt != b.StartedAt {
		return a.StartedAt < b.StartedAt
	}
	return a.ID < b.ID
}

func hasEnded(a sessionio.AgentInfo) bool {
	return a.State == sessionio.AgentDone || a.State == sessionio.AgentFailed
}

// endOf is when an agent ended, falling back to its last activity for an end
// whose record carried no time.
func endOf(a sessionio.AgentInfo) int64 {
	if a.EndedAt > 0 {
		return a.EndedAt
	}
	return a.LastActivityAt
}

// sameAgentSet compares two snapshots on everything but At, which is stamped
// as each frame is written.
func sameAgentSet(a, b sessionio.AgentSet) bool {
	return slices.Equal(a.Agents, b.Agents) && reflect.DeepEqual(a.Workflows, b.Workflows)
}

// agentFileName reads one listing name: the agent it belongs to, whether it is
// the sidecar rather than the transcript, and the workflow run of a member. Any
// other name, a run's journal, run file or script included, is ok=false.
func agentFileName(name string) (id string, meta bool, run string, ok bool) {
	dir, base := path.Split(name)
	switch {
	case dir == "subagents/":
	case strings.HasPrefix(dir, "subagents/workflows/wf_") && strings.Count(dir, "/") == 3:
		run = strings.TrimSuffix(strings.TrimPrefix(dir, "subagents/workflows/"), "/")
	default:
		return "", false, "", false
	}
	if id, ok := sessionio.AgentFileID(base); ok {
		return id, false, run, true
	}
	if strings.HasPrefix(base, "agent-") && strings.HasSuffix(base, ".meta.json") {
		id = strings.TrimSuffix(strings.TrimPrefix(base, "agent-"), ".meta.json")
		return id, true, run, id != ""
	}
	return "", false, "", false
}

// runFileName reads a listing name that belongs to a workflow run rather than
// to one of its agents: the run's journal, beside its members, or its run file
// under workflows/. Any other name is ok=false.
func runFileName(name string) (run string, journal bool, ok bool) {
	dir, base := path.Split(name)
	switch {
	case dir == "workflows/" && strings.HasPrefix(base, "wf_") && strings.HasSuffix(base, ".json"):
		run = strings.TrimSuffix(base, ".json")
		return run, false, run != "wf_"
	case base == "journal.jsonl" && strings.HasPrefix(dir, "subagents/workflows/wf_") && strings.Count(dir, "/") == 3:
		return strings.TrimSuffix(strings.TrimPrefix(dir, "subagents/workflows/"), "/"), true, true
	}
	return "", false, false
}

// scriptName reads a listing name that is a run's script,
// workflows/scripts/<name>-wf_<runId>.js, and returns the run. Any other name
// is ok=false.
func scriptName(name string) (run string, ok bool) {
	dir, base := path.Split(name)
	if dir != "workflows/scripts/" {
		return "", false
	}
	return sessionio.WorkflowScriptRun(base)
}

// transcriptName is where an agent's transcript is below the session
// directory: under its run's directory for a workflow member.
func transcriptName(run, id string) string {
	if run == "" {
		return path.Join("subagents", "agent-"+id+".jsonl")
	}
	return path.Join("subagents", "workflows", run, "agent-"+id+".jsonl")
}

// abs is a listing name as a path under the session directory.
func (aw *agentWatch) abs(name string) string {
	return filepath.Join(aw.directory(), filepath.FromSlash(name))
}

func mtimeOf(f *sessionio.AgentFile) int64 {
	if f == nil {
		return 0
	}
	return f.MTime
}
