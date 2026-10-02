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

var (
	noticeTaskRe   = regexp.MustCompile(`<task-id>([^<]+)</task-id>`)
	noticeStatusRe = regexp.MustCompile(`<status>([a-z_]+)</status>`)
)

// noticeEnds are the <task-notification> statuses that end a task; a monitor
// also sends notices for events while it keeps running.
var noticeEnds = map[string]bool{"completed": true, "failed": true, "killed": true, "stopped": true, "expired": true}

// backgroundOutstanding lists the background tasks these records started and
// did not see end, in the order they started.
//
// Started: a Bash call with run_in_background (its result carries
// backgroundTaskId) or a Monitor (taskId, unless persistent, which runs for
// the life of the session and never re-enters on its own). Ended: a
// <task-notification> with a final status, or a TaskStop/KillShell result
// naming the task.
func backgroundOutstanding(lines [][]byte) []string {
	var order []string
	open := map[string]bool{}
	for _, l := range lines {
		var r struct {
			Type          string          `json:"type"`
			ToolUseResult json.RawMessage `json:"toolUseResult"`
		}
		if json.Unmarshal(l, &r) != nil || r.Type != "user" {
			continue
		}
		var tur struct {
			BackgroundTaskID string `json:"backgroundTaskId"`
			TaskID           string `json:"taskId"`
			Persistent       bool   `json:"persistent"`
			StoppedID        string `json:"task_id"`
			ShellID          string `json:"shell_id"`
		}
		if len(r.ToolUseResult) > 0 && r.ToolUseResult[0] == '{' && json.Unmarshal(r.ToolUseResult, &tur) == nil {
			started := []string{tur.BackgroundTaskID}
			if !tur.Persistent {
				started = append(started, tur.TaskID)
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
		text := rec.Text()
		if !strings.Contains(text, "<task-notification>") {
			continue
		}
		id, status := noticeTaskRe.FindStringSubmatch(text), noticeStatusRe.FindStringSubmatch(text)
		if id != nil && status != nil && noticeEnds[status[1]] {
			delete(open, strings.TrimSpace(id[1]))
		}
	}
	var out []string
	for _, id := range order {
		if open[id] {
			out = append(out, id)
		}
	}
	return out
}
