package sessionio

import (
	"bytes"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
)

// Workflow follows one Workflow run and merges what its files say into the
// panel's view of it: a WorkflowInfo, and its members as ordinary AgentInfo
// entries with WorkflowID set.
//
// A run leaves four kinds of file, and each answers something the others
// cannot:
//
//   - Each member's own transcript and sidecar under
//     subagents/workflows/wf_<runId>/. The watcher follows these with an
//     AgentTail like any other agent and hands them to Merge as RunAgents.
//     They are the live source: the current tool, the counts, the times, and
//     whether the agent has ended.
//   - The run's journal beside them, journal.jsonl, which Claude Code appends
//     to as members start (with their label and phase title), return a
//     result, or fail. While a run is going, it is the only record of which
//     agents belong to it and where.
//   - The run file, workflows/wf_<runId>.json (see workflowRun), written once
//     when the run is over. Where it stands, it is the authority on the run's
//     status, phases and totals, and on which agents were its members, with
//     their labels, phases and final states.
//   - The run's script, workflows/scripts/<name>-wf_<runId>.js, written when
//     the run is launched. Its meta literal (see workflowMeta) names the run,
//     describes it and lists every phase it will go through, so a run still
//     going has those before any member reaches them. It says nothing of
//     state: a script alone is not a run, since plenty never start one.
//
// A resumed run keeps its run id, and its previous attempt's run file stays on
// disk while the new attempt runs. So a run file stands only while nothing
// started after it: once the journal names an agent after the last one the
// file lists, a new attempt is running.
//
// A Workflow is NOT safe for concurrent use.
type Workflow struct {
	id      string
	runPath string
	journal workflowJournal
	run     workflowRun
	hasRun  bool
	meta    workflowMeta // from the run's script; zero until one has been read
}

// RunAgent is one agent transcript under a run's
// subagents/workflows/wf_<runId>/ directory, as the watcher follows it.
type RunAgent struct {
	Info  AgentInfo // AgentTail.Info, with the sidecar applied
	Phase string    // the sidecar's workflowPhase: the member's phase title
}

// NewWorkflow follows the run id ("wf_<runId>") under a session directory,
// which is the session transcript's path without its .jsonl. The journal is
// read through r, so another user's run is read the way their transcripts are.
func NewWorkflow(sessionDir, id string, r Reader) *Workflow {
	if r == nil {
		r = LocalReader{}
	}
	return &Workflow{
		id:      id,
		runPath: filepath.Join(sessionDir, "workflows", id+".json"),
		journal: workflowJournal{
			path:    filepath.Join(sessionDir, "subagents", "workflows", id, "journal.jsonl"),
			reader:  r,
			results: map[string]string{},
			failed:  map[string]bool{},
		},
	}
}

// ID is the run id, "wf_<runId>".
func (w *Workflow) ID() string { return w.id }

// RunPath is where the run file is, or will be once the run ends.
func (w *Workflow) RunPath() string { return w.runPath }

// JournalPath is the run's journal, beside its members' transcripts.
func (w *Workflow) JournalPath() string { return w.journal.path }

// SetRunFile takes the run file's bytes, read whole: ReadFrom cannot read it,
// since it does not end in a newline. A file that does not parse, most often
// because it was read while being written in place, is refused and the last
// good one kept, so read it again when it next changes.
func (w *Workflow) SetRunFile(b []byte) error {
	run, err := parseWorkflowRun(b)
	if err != nil {
		return err
	}
	w.run, w.hasRun = run, true
	return nil
}

// SetScript takes the run's script, read whole, and reports whether its meta
// could be read. One that cannot, a script caught mid-write among them, is
// refused and the last good one kept, like a run file; unlike a run file it is
// written once, so there is no point reading it again until it changes.
func (w *Workflow) SetScript(b []byte) bool {
	m, ok := parseWorkflowScript(b)
	if ok {
		w.meta = m
	}
	return ok
}

// PollJournal reads whatever the journal gained since the last call. A line
// still being written is left for the next one. The error is not-exist until
// the journal is created, and for runs made before Claude Code kept one.
func (w *Workflow) PollJournal() (changed bool, err error) { return w.journal.poll() }

// Running reports whether the run is going, as far as its files say: it has no
// run file yet, or the journal has started agents since the one it has was
// written.
//
// Nothing here judges liveness. A run whose session died mid-run never gets a
// run file and reads as running for good. The watcher bounds that by how
// recently anything under the run was written, and the panel by whether the
// session still owes any work.
func (w *Workflow) Running() bool {
	_, state := w.standing()
	return state == WorkflowRunning
}

// standing says whether the run file stands for the run, and the run's state.
func (w *Workflow) standing() (recorded bool, state WorkflowState) {
	if !w.hasRun || w.superseded() {
		return false, WorkflowRunning
	}
	return true, w.run.state()
}

// superseded reports whether the journal started agents after the last one the
// run file lists: a resumed run's new attempt. Checked against the 151 run
// files and journals on this box, all of them over, it reads none as going. A
// looser test, any started agent the file does not list, misreads the 10 whose
// journals hold an earlier attempt's agents.
func (w *Workflow) superseded() bool {
	return w.hasRun && w.cut() < len(w.journal.starts)-1
}

// cut is the position among the journal's starts of the last agent the run
// file lists, -1 when it lists none of them. Starts up to it belong to attempts
// the run file covers.
func (w *Workflow) cut() int {
	listed := w.listed()
	for i := len(w.journal.starts) - 1; i >= 0; i-- {
		if listed[w.journal.starts[i].agentID] {
			return i
		}
	}
	return -1
}

// listed is the agents the run file names.
func (w *Workflow) listed() map[string]bool {
	ids := map[string]bool{}
	if w.hasRun {
		for _, m := range w.run.Members {
			if m.AgentID != "" {
				ids[m.AgentID] = true
			}
		}
	}
	return ids
}

// Merge folds the members' transcripts into the run's structure and returns
// the run and its members, in spawn order (startedAt, then id).
//
// A member's label and phase come from the run file, else the journal, else
// its sidecar. Its live fields come from its transcript; without one, the run
// file's own figures stand in: the last tool and its summary, the tool-call
// count and the times. Not its token count, which is the agent's context size
// rather than the output tokens every other agent reports.
//
// A member of a run that is over and still reads as running or queued was cut
// off with the run. Its state stays as its own sources say, so the panel can
// tell it from a failure, and its EndedAt is the run's, so its elapsed time
// stops where the run did.
func (w *Workflow) Merge(agents []RunAgent) (WorkflowInfo, []AgentInfo) {
	files := make(map[string]*RunAgent, len(agents))
	for i := range agents {
		if id := agents[i].Info.ID; id != "" { // never matched to a member that has no agent
			files[id] = &agents[i]
		}
	}
	recorded, state := w.standing()
	var sources []memberSource
	if recorded {
		sources = w.recordedMembers(files)
	} else {
		sources = w.liveMembers(agents, files)
	}
	var runEnd int64
	if recorded && state != WorkflowRunning {
		runEnd = w.run.EndedAt
	}

	phases := w.phases(sources)
	info := WorkflowInfo{ID: w.id, State: state, Phases: phases}
	members := make([]AgentInfo, 0, len(sources))
	for _, s := range sources {
		m := w.member(s, phases, runEnd)
		members = append(members, m)
		// While a run is going, its figures are its members'. A replay is left
		// out: the run counts its work once, in the attempt that did it.
		if !recorded && !s.carried {
			info.ToolCalls += m.ToolCalls
			if m.StartedAt > 0 && (info.StartedAt == 0 || m.StartedAt < info.StartedAt) {
				info.StartedAt = m.StartedAt
			}
		}
	}
	sort.SliceStable(members, func(i, j int) bool {
		if members[i].StartedAt != members[j].StartedAt {
			return members[i].StartedAt < members[j].StartedAt
		}
		return members[i].ID < members[j].ID
	})
	info.CurrentPhase = currentPhase(members)

	// The run file names the run where it stands, and a resumed run still has
	// its previous attempt's. Until then the script is all that names it.
	info.Name = firstOf(w.run.Name, w.meta.Name)
	info.Summary = firstOf(w.run.Summary, w.meta.Description)
	if recorded {
		info.StartedAt, info.EndedAt = w.run.StartedAt, runEnd
		info.AgentCount, info.Tokens, info.ToolCalls = w.run.AgentCount, w.run.Tokens, w.run.ToolCalls
	} else {
		// Tokens stays 0 until the run file brings the run's total: that
		// counts context sizes, and the members' own figures are output
		// tokens, so a sum of those would change measure when the run ends.
		info.AgentCount = len(members)
	}
	return info, members
}

// memberSource is everything known about one member, before merging.
type memberSource struct {
	id    string
	entry *workflowMember // the run file's record
	start *journalStart   // the journal's
	file  *RunAgent       // its transcript
	// carried marks a member a previous attempt's run file saw finish, which a
	// resume replays from the journal rather than running again.
	carried bool
}

func (s memberSource) phaseTitle() string {
	var fromEntry, fromJournal, fromFile string
	if s.entry != nil {
		fromEntry = s.entry.PhaseTitle
	}
	if s.start != nil {
		fromJournal = s.start.phase
	}
	if s.file != nil {
		fromFile = s.file.Phase
	}
	return firstOf(fromEntry, fromJournal, fromFile)
}

// recordedMembers is the members of a run whose run file stands: exactly the
// ones it lists. Transcripts beside them that it does not list belong to an
// earlier attempt.
func (w *Workflow) recordedMembers(files map[string]*RunAgent) []memberSource {
	starts := map[string]*journalStart{}
	for i := range w.journal.starts {
		starts[w.journal.starts[i].agentID] = &w.journal.starts[i]
	}
	var out []memberSource
	seen := map[string]bool{}
	for i := range w.run.Members {
		m := &w.run.Members[i]
		id := m.AgentID
		if id == "" {
			// Never started, so no agent: queued when the run was killed, or
			// blocked before it began. The run's own numbering keeps it apart.
			id = fmt.Sprintf("%s#%d", w.id, m.Index)
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, memberSource{id: id, entry: m, start: starts[m.AgentID], file: files[m.AgentID]})
	}
	return out
}

// liveMembers is the members of a run that is still going: what a previous
// attempt's run file saw finish, this attempt's starts in the journal, and any
// transcript the journal has not named yet, since its start line can land
// after the agent's first records.
func (w *Workflow) liveMembers(agents []RunAgent, files map[string]*RunAgent) []memberSource {
	var out []memberSource
	seen := map[string]bool{}
	add := func(s memberSource) {
		if s.id != "" && !seen[s.id] {
			seen[s.id] = true
			out = append(out, s)
		}
	}
	cut := -1
	if w.hasRun {
		cut = w.cut()
		for i := range w.run.Members {
			if m := &w.run.Members[i]; m.State == "done" && m.AgentID != "" {
				add(memberSource{id: m.AgentID, entry: m, file: files[m.AgentID], carried: true})
			}
		}
	}
	// An agent started again under the same key, work an earlier attempt left
	// unfinished, replaces the one before it.
	fresh := w.journal.starts[cut+1:]
	for i := range fresh {
		s := &fresh[i]
		if !startedAgain(fresh[i+1:], s.key) {
			add(memberSource{id: s.agentID, start: s, file: files[s.agentID]})
		}
	}
	named, listed := map[string]bool{}, w.listed()
	for _, s := range w.journal.starts {
		named[s.agentID] = true
	}
	for i := range agents {
		if id := agents[i].Info.ID; !named[id] && !listed[id] {
			add(memberSource{id: id, file: &agents[i]})
		}
	}
	return out
}

func startedAgain(later []journalStart, key string) bool {
	if key == "" {
		return false
	}
	for _, s := range later {
		if s.key == key {
			return true
		}
	}
	return false
}

// phases is the run's phases: the run file's, else the ones its script
// declares, then any phase its members name that the list lacks. A run still
// going with no script to read has only the titles its members name, numbered
// in the order the journal first names them; a script's phases run in order,
// so that matches the run file's numbering as far as the run has gone.
func (w *Workflow) phases(sources []memberSource) []WorkflowPhase {
	var out []WorkflowPhase
	if len(w.run.Phases) > 0 {
		out = append(out, w.run.Phases...)
	} else {
		out = append(out, w.meta.Phases...)
	}
	for _, s := range sources {
		if s.entry != nil && s.entry.PhaseIndex > 0 {
			if !hasPhase(out, s.entry.PhaseIndex) {
				out = append(out, WorkflowPhase{Index: s.entry.PhaseIndex, Title: s.entry.PhaseTitle})
			}
			continue
		}
		if title := s.phaseTitle(); title != "" && phaseByTitle(out, title) == 0 {
			next := 1
			for _, p := range out {
				next = max(next, p.Index+1)
			}
			out = append(out, WorkflowPhase{Index: next, Title: title})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Index < out[j].Index })
	return out
}

func hasPhase(phases []WorkflowPhase, index int) bool {
	for _, p := range phases {
		if p.Index == index {
			return true
		}
	}
	return false
}

// phaseByTitle is the index of the first phase with this title, 0 for none.
func phaseByTitle(phases []WorkflowPhase, title string) int {
	for _, p := range phases {
		if p.Title == title {
			return p.Index
		}
	}
	return 0
}

// member merges one member's sources into its AgentInfo. runEnd is when the
// run ended, 0 while it is going.
func (w *Workflow) member(s memberSource, phases []WorkflowPhase, runEnd int64) AgentInfo {
	var info AgentInfo
	if s.file != nil {
		info = s.file.Info
	}
	info.ID, info.WorkflowID = s.id, w.id
	e := s.entry
	var entryLabel, journalLabel string
	if e != nil {
		entryLabel = e.Label
		info.Model = firstOf(info.Model, e.Model)
		info.AgentType = firstOf(info.AgentType, e.AgentType)
	}
	if s.start != nil {
		journalLabel = s.start.label
	}
	// A member's sidecar description is its label, where the sidecar has one.
	info.Label = firstOf(entryLabel, journalLabel, info.Description)
	info.PhaseIndex = phaseByTitle(phases, s.phaseTitle())
	if e != nil && e.PhaseIndex > 0 {
		info.PhaseIndex = e.PhaseIndex
	}

	if s.file == nil {
		info.State = AgentRunning
		if e != nil {
			info.State = memberState(e.State)
			info.Tool = e.LastToolName
			info.ToolDetail = clipRight(oneLine(e.LastToolSummary), toolDetailMax)
			info.ToolCalls = e.ToolCalls
			info.StartedAt = e.StartedAt
			info.LastActivityAt = max(e.LastProgressAt, e.StartedAt)
		}
	}

	// The run file is written after every member has stopped, and the journal
	// as each one returns, so where either says a member finished it has, even
	// when its transcript has not caught up.
	switch {
	case e != nil && e.State == "done":
		finish(&info, AgentDone, memberEnd(e), clipRight(oneLine(e.ResultPreview), agentResultMax))
	case e != nil && e.State == "error":
		reason := clipRight(oneLine(e.Error), agentResultMax)
		if reason != "" {
			// The run's reason names what the transcript cannot, such as a
			// retry cap or a safety block.
			info.Result = ""
		}
		finish(&info, AgentFailed, memberEnd(e), reason)
	case info.State == AgentRunning && w.journal.hasResult(s.id):
		finish(&info, AgentDone, info.LastActivityAt, w.journal.results[s.id])
	case info.State == AgentRunning && w.journal.failed[s.id]:
		finish(&info, AgentFailed, info.LastActivityAt, "")
	}

	if runEnd > 0 && info.EndedAt == 0 && (info.State == AgentRunning || info.State == AgentQueued) {
		info.EndedAt = runEnd
	}
	return info
}

// finish ends a member by a source written after its transcript. Where the
// transcript already ended it the same way, its own end and answer stand.
func finish(info *AgentInfo, state AgentState, at int64, result string) {
	info.Waiting = false // a member the run says has finished waits on nothing
	if info.State != state {
		info.State, info.EndedAt = state, at
		if state == AgentDone {
			info.Result = "" // an error the agent recovered from is not its answer
		}
	}
	if info.EndedAt == 0 {
		info.EndedAt = at
	}
	if info.Result == "" {
		info.Result = result
	}
}

// memberState maps a run file member's state onto the panel's.
func memberState(s string) AgentState {
	switch s {
	case "start":
		return AgentQueued
	case "done":
		return AgentDone
	case "error":
		return AgentFailed
	}
	return AgentRunning // "progress"
}

// memberEnd is when a run file member stopped, as the run file tells it.
func memberEnd(e *workflowMember) int64 {
	if e.StartedAt > 0 && e.DurationMs > 0 {
		return e.StartedAt + e.DurationMs
	}
	return max(e.LastProgressAt, e.StartedAt)
}

// currentPhase is the highest phase with a member running, else the highest
// any member has started in.
func currentPhase(members []AgentInfo) int {
	cur := 0
	for _, m := range members {
		if m.State == AgentRunning {
			cur = max(cur, m.PhaseIndex)
		}
	}
	if cur > 0 {
		return cur
	}
	for _, m := range members {
		if m.State != AgentQueued {
			cur = max(cur, m.PhaseIndex)
		}
	}
	return cur
}

// workflowJournal follows a run's journal.jsonl through a Reader, the way an
// AgentTail follows a transcript.
type workflowJournal struct {
	path   string
	reader Reader
	off    int64

	starts  []journalStart    // in the order the journal names them
	results map[string]string // agent id: what it returned, as one line
	failed  map[string]bool   // agent id: the journal says it failed
}

// journalStart is one {"type":"started"} line. Journals written before Claude
// Code 2.1.27x carry no label or phase (1,162 of the 2,242 on this box).
type journalStart struct {
	key, agentID, label, phase string
}

func (j *workflowJournal) poll() (bool, error) {
	lines, next, err := j.reader.ReadFrom(j.path, j.off)
	if err != nil {
		return false, err
	}
	changed := next != j.off
	j.off = next
	for _, ln := range lines {
		j.line([]byte(ln))
	}
	return changed, nil
}

func (j *workflowJournal) line(b []byte) {
	var e struct {
		Type    string          `json:"type"`
		Key     string          `json:"key"`
		AgentID string          `json:"agentId"`
		Label   string          `json:"label"`
		Phase   string          `json:"phase"`
		Result  json.RawMessage `json:"result"`
	}
	if json.Unmarshal(b, &e) != nil {
		return
	}
	switch e.Type {
	case "started":
		if e.AgentID != "" {
			j.starts = append(j.starts, journalStart{key: e.Key, agentID: e.AgentID, label: e.Label, phase: e.Phase})
		}
	case "result":
		if id := j.agentOf(e.AgentID, e.Key); id != "" {
			j.results[id] = resultLine(e.Result)
		}
	case "failed":
		if id := j.agentOf(e.AgentID, e.Key); id != "" {
			j.failed[id] = true
		}
	}
}

func (j *workflowJournal) hasResult(id string) bool {
	_, ok := j.results[id]
	return ok
}

// agentOf is the agent a result or failure line is for: the one it names, or
// when it names none, the latest agent started under its key.
func (j *workflowJournal) agentOf(id, key string) string {
	if id != "" || key == "" {
		return id
	}
	for i := len(j.starts) - 1; i >= 0; i-- {
		if j.starts[i].key == key {
			return j.starts[i].agentID
		}
	}
	return ""
}

// resultLine is what a member returned, as the panel's one line: text as it
// was written, anything else as compact JSON.
func resultLine(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return clipRight(oneLine(s), agentResultMax)
	}
	var b bytes.Buffer
	if json.Compact(&b, raw) != nil {
		return ""
	}
	return clipRight(oneLine(b.String()), agentResultMax)
}
