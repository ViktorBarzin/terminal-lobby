package main

// Reading one turn's records out of a transcript: its answer, and whether
// background work it started is still outstanding.

import (
	"encoding/json"
	"regexp"
	"strings"
	"time"

	"terminal-lobby/sessionio"
)

// turnLines is the part of a transcript this turn wrote: everything after
// mark, or, when the length before the turn is unknown, the records stamped
// at or after the moment the message was sent. A record without a timestamp
// cannot be placed, so an unknown mark leaves it out.
func turnLines(lines [][]byte, mark int, sentAt time.Time) [][]byte {
	if mark != unknownMark {
		if mark > len(lines) {
			return nil
		}
		return lines[mark:]
	}
	var out [][]byte
	for _, l := range lines {
		rec, ok := sessionio.DecodeRecord(l)
		if !ok {
			continue
		}
		at, err := time.Parse(time.RFC3339Nano, rec.Timestamp)
		if err != nil || at.Before(sentAt) {
			continue
		}
		out = append(out, l)
	}
	return out
}

// turnAnswer is the turn's final message: the last assistant text, provided
// nothing was said to Claude after it. A prompt or a <task-notification>
// with no reply after it means a turn is still to come, so settled is false.
func turnAnswer(lines [][]byte) (answer string, settled bool) {
	waiting := false
	for _, l := range lines {
		rec, ok := sessionio.DecodeRecord(l)
		if !ok || rec.IsMeta || rec.IsSidechain {
			continue
		}
		text := strings.TrimSpace(rec.Text())
		if text == "" {
			continue
		}
		switch rec.Role() {
		case "assistant":
			answer, waiting = text, false
		case "user":
			if rec.Conversational() {
				waiting = true
			}
		}
	}
	return answer, answer != "" && !waiting
}

// turnEnded reports whether the last thing these records hold is the end of
// a turn: Claude Code's turn-end record (system "turn_duration") with nothing
// said to or by Claude after it. A prompt or a <task-notification> after it
// means another turn is starting, and an answer after it belongs to one.
func turnEnded(lines [][]byte) bool {
	ended := false
	for _, l := range lines {
		var r struct {
			Type    string `json:"type"`
			Subtype string `json:"subtype"`
		}
		if json.Unmarshal(l, &r) == nil && r.Type == "system" && r.Subtype == "turn_duration" {
			ended = true
			continue
		}
		rec, ok := sessionio.DecodeRecord(l)
		if !ok || rec.IsMeta || rec.IsSidechain || strings.TrimSpace(rec.Text()) == "" {
			continue
		}
		switch rec.Role() {
		case "assistant":
			ended = false
		case "user":
			if rec.Conversational() {
				ended = false
			}
		}
	}
	return ended
}

var (
	noticeRe       = regexp.MustCompile(`(?s)<task-notification>.*?</task-notification>`)
	noticeTaskRe   = regexp.MustCompile(`<task-id>([^<]+)</task-id>`)
	noticeStatusRe = regexp.MustCompile(`<status>([a-z_]+)</status>`)
	// noticeInterimRe is the note a subagent's notice carries when the agent
	// stopped with background work of its own still running (measured live
	// on 2026-10-02): its status reads "completed", but the agent resumes
	// when that work ends and the same task-id notifies again.
	noticeInterimRe = regexp.MustCompile(`(?s)<note>[^<]*may be interim[^<]*</note>`)
	// noticeExpiredRe is the event a Monitor's notice carries when its
	// timeout ends it. The notice has no <status> (measured on transcripts
	// from 2026-10-02), and the Monitor is over.
	noticeExpiredRe = regexp.MustCompile(`<event>\[Monitor expired\b`)
)

// noticeEnds are the <task-notification> statuses that end a task; a monitor
// also sends notices for events while it keeps running.
var noticeEnds = map[string]bool{"completed": true, "failed": true, "killed": true, "stopped": true, "expired": true}

// backgroundOutstanding lists the background tasks these records started and
// did not see end, in the order they started.
//
// Started: a Bash call with run_in_background (its result carries
// backgroundTaskId), an Agent with run_in_background (status async_launched,
// agentId), or a Monitor (taskId, unless persistent, which runs for the life
// of the session and never re-enters on its own). Ended: a
// <task-notification> with a final status, a Monitor's expiry notice, or a
// TaskStop/KillShell result naming the task.
//
// A subagent's notice whose note says the result may be interim ends it only
// when v shows the subagent is idle (agentView.idle): the note means the
// subagent still had background work of its own, which can wake it and make
// the same task-id notify again. Measured live on 2026-10-02 (rv3-flow): the
// subagent's last notice carried the note too, because a Monitor it had armed
// was still counting down, and nothing ever came after it.
//
// Read as a subagent's transcript (v.subagent), a Monitor is never
// outstanding: a stopped subagent's Monitor events are only enqueued in the
// main session and never wake the subagent (measured live on 2026-10-03,
// rv-bg-c: the Monitor fired, its event sat in the session's queue, and the
// subagent's transcript got nothing). Holding for one held the turn until the
// Monitor's timeout, up to the 30-minute hold.
//
// A pending ScheduleWakeup is outstanding too, as wakeupTask: the turn that
// armed it ends by saying it will wait, and the answer comes in the turn the
// wakeup starts. It stays outstanding from the moment it fires until that
// turn says something, because the fire is recorded before the turn's state
// turns to running and settling in between would hand back the old words.
func backgroundOutstanding(lines [][]byte, v agentView) []string {
	var order []string
	open := map[string]bool{}
	// monitors are the Monitors among the started tasks, which a
	// subagent's view does not count (see above).
	monitors := map[string]bool{}
	wakeup := wakeupNone
	for _, l := range lines {
		var r struct {
			Type          string          `json:"type"`
			Subtype       string          `json:"subtype"`
			Timestamp     string          `json:"timestamp"`
			ToolUseResult json.RawMessage `json:"toolUseResult"`
			Attachment    struct {
				Type   string `json:"type"`
				Prompt string `json:"prompt"`
			} `json:"attachment"`
		}
		if json.Unmarshal(l, &r) != nil {
			continue
		}
		if r.Type == "system" && r.Subtype == "scheduled_task_fire" && wakeup == wakeupPending {
			wakeup = wakeupFired
			continue
		}
		if r.Type == "assistant" && wakeup == wakeupFired {
			if rec, ok := sessionio.DecodeRecord(l); ok && !rec.IsSidechain && strings.TrimSpace(rec.Text()) != "" {
				wakeup = wakeupNone
			}
			continue
		}
		// A notice that arrives while a turn runs is absorbed into it as a
		// queued_command attachment, never as a user record of its own
		// (measured live on 2026-10-02).
		if r.Type == "attachment" && r.Attachment.Type == "queued_command" {
			v.closeNoticed(open, r.Attachment.Prompt, r.Timestamp)
			continue
		}
		if r.Type != "user" {
			continue
		}
		var tur struct {
			BackgroundTaskID string `json:"backgroundTaskId"`
			TaskID           string `json:"taskId"`
			Persistent       bool   `json:"persistent"`
			Status           string `json:"status"`
			AgentID          string `json:"agentId"`
			StoppedID        string `json:"task_id"`
			ShellID          string `json:"shell_id"`
			// ScheduleWakeup answers with scheduledFor (0 once stopped),
			// and only ScheduleWakeup does.
			ScheduledFor *int64 `json:"scheduledFor"`
			Stopped      bool   `json:"stopped"`
			TimeoutMs    int64  `json:"timeoutMs"`
		}
		if len(r.ToolUseResult) > 0 && r.ToolUseResult[0] == '{' && json.Unmarshal(r.ToolUseResult, &tur) == nil {
			if tur.ScheduledFor != nil {
				// One wakeup slot: arming again replaces it, a stop cancels it.
				wakeup = wakeupNone
				if *tur.ScheduledFor > 0 && !tur.Stopped {
					wakeup = wakeupPending
				}
				continue
			}
			started := []string{tur.BackgroundTaskID}
			if !tur.Persistent {
				started = append(started, tur.TaskID)
				if tur.TaskID != "" && tur.TimeoutMs > 0 {
					monitors[tur.TaskID] = true
				}
			}
			// A foreground Agent answers with an agentId too, once it has
			// finished; only a launch is outstanding.
			if tur.Status == "async_launched" {
				started = append(started, tur.AgentID)
			}
			for _, id := range started {
				if id != "" && !open[id] {
					open[id] = true
					order = append(order, id)
				}
			}
			for _, id := range []string{tur.StoppedID, tur.ShellID} {
				delete(open, id)
			}
			continue
		}
		rec, ok := sessionio.DecodeRecord(l)
		if !ok {
			continue
		}
		v.closeNoticed(open, rec.Text(), rec.Timestamp)
	}
	var out []string
	for _, id := range order {
		if !open[id] {
			continue
		}
		if v.subagent && monitors[id] {
			continue
		}
		out = append(out, id)
	}
	if wakeup != wakeupNone {
		out = append(out, wakeupTask)
	}
	return out
}

// agentView is what backgroundOutstanding can see beyond the records it is
// given: the session's subagents' own transcripts, read when a subagent's
// notice says its result may be interim. The zero value sees nothing, and an
// interim notice then leaves its subagent outstanding.
type agentView struct {
	// read returns a subagent's own transcript, ok=false when it cannot be
	// read.
	read func(agentID string) ([][]byte, bool)
	// subagent is set while reading a subagent's transcript rather than the
	// session's.
	subagent bool
	depth    int
}

// maxAgentDepth bounds how far idle follows subagents that launched
// subagents.
const maxAgentDepth = 4

// idle reports whether the subagent agentID, whose newest notice reached the
// session at noticeAt with the interim note, will not notify again. Both must
// hold:
//
//   - Nothing has happened to it since that notice: its newest message is an
//     answer written at or before noticeAt. A notice from its own work that
//     woke it, or anything it said after, means another notice is coming.
//   - Its own transcript has no background work outstanding. A Monitor it
//     armed does not count: once the subagent has stopped, the Monitor's
//     events and its expiry notice are only queued in the session and never
//     reach the subagent (measured live on 2026-10-02 and 2026-10-03). A
//     background command it ran does count, because that command's notice
//     does wake it (rv3-flow).
func (v agentView) idle(agentID, noticeAt string) bool {
	if v.read == nil || v.depth >= maxAgentDepth {
		return false
	}
	noticed, err := time.Parse(time.RFC3339Nano, noticeAt)
	if err != nil {
		return false
	}
	lines, ok := v.read(agentID)
	if !ok {
		return false
	}
	answeredAt, ok := lastAnswerAt(lines)
	if !ok || answeredAt.After(noticed) {
		return false
	}
	inner := v
	inner.subagent = true
	inner.depth++
	return len(backgroundOutstanding(lines, inner)) == 0
}

// lastAnswerAt is when an agent's newest message was written, provided that
// message is an answer: assistant text, not a tool call in flight and not
// something said to the agent.
func lastAnswerAt(lines [][]byte) (time.Time, bool) {
	var last sessionio.Record
	found := false
	for _, l := range lines {
		rec, ok := sessionio.DecodeRecord(l)
		if !ok {
			continue
		}
		if role := rec.Role(); role == "assistant" || role == "user" {
			last, found = rec, true
		}
	}
	if !found || last.Role() != "assistant" || strings.TrimSpace(last.Text()) == "" || last.HasBlock("tool_use") {
		return time.Time{}, false
	}
	at, err := time.Parse(time.RFC3339Nano, last.Timestamp)
	return at, err == nil
}

// wakeupTask names a pending ScheduleWakeup among the outstanding tasks.
const wakeupTask = "ScheduleWakeup"

// A turn's ScheduleWakeup, as backgroundOutstanding follows it.
const (
	wakeupNone    = iota // none armed, or stopped, or fired and answered
	wakeupPending        // armed and not yet fired
	wakeupFired          // fired, and the turn it started has said nothing yet
)

// closeNoticed retires every task a text's <task-notification> blocks say has
// ended. at is when the text reached the session.
func (v agentView) closeNoticed(open map[string]bool, text, at string) {
	for _, n := range noticeRe.FindAllString(text, -1) {
		m := noticeTaskRe.FindStringSubmatch(n)
		if m == nil {
			continue
		}
		id := strings.TrimSpace(m[1])
		if noticeExpiredRe.MatchString(n) {
			delete(open, id)
			continue
		}
		status := noticeStatusRe.FindStringSubmatch(n)
		if status == nil || !noticeEnds[status[1]] {
			continue
		}
		if !noticeInterimRe.MatchString(n) || v.idle(id, at) {
			delete(open, id)
		}
	}
}
