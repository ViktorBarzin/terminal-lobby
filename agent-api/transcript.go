package main

// Reading a conversation back.
//
// The transcript is Claude Code's own .jsonl, decoded through sessionio's
// Record — the same decoder session-events uses for the lobby's Text view, so
// a record shape that changes upstream changes in one place for both.
//
// What this file adds is the reduction to a MESSAGE LIST: an LLM client asked
// for "the full history" wants what was said, not the harness's bookkeeping.
// Tool calls and their results stay out, which is why a task's detail_url
// points here and the design doc still describes the full turn as the thing
// behind it — the transcript on disk carries everything; this view carries the
// conversation.

import (
	"strings"

	"terminal-lobby/sessionio"
)

// TranscriptMessage is one thing that was said.
type TranscriptMessage struct {
	// Role is "user" or "assistant".
	Role string `json:"role"`
	Text string `json:"text"`
	// At is the record's RFC3339 timestamp, absent on the few record types
	// that carry none.
	At string `json:"at,omitempty"`
}

// decodeTranscript reduces raw transcript lines to the conversation.
//
// Four kinds of line are dropped, each for its own reason:
//
//   - anything sessionio does not call Conversational: the lifecycle records
//     (mode, permission-mode, queue-operation, attachment, system) are the
//     harness talking to itself.
//   - isMeta: the harness feeding Claude context the human never typed.
//   - isSidechain: a subagent's own conversation, which belongs to the tool
//     call that launched it rather than to this thread.
//   - a record with no text block: a "user" record carrying only a
//     tool_result is the harness handing Claude its own tool output back, and
//     rendering it as the human's words is how a transcript reads as if
//     somebody pasted a directory listing into the chat.
func decodeTranscript(lines [][]byte) []TranscriptMessage {
	out := make([]TranscriptMessage, 0, len(lines))
	for _, line := range lines {
		rec, ok := sessionio.DecodeRecord(line)
		if !ok || !rec.Conversational() || rec.IsMeta || rec.IsSidechain {
			continue
		}
		text := strings.TrimSpace(rec.Text())
		if text == "" {
			continue
		}
		out = append(out, TranscriptMessage{
			Role: rec.Role(),
			Text: text,
			At:   rec.Timestamp,
		})
	}
	return out
}

// lastAssistantText is a turn's final message: the last assistant record with
// something to say.
//
// Searched backwards, and it has to be: a turn ends with the assistant's
// answer, but between that answer and the end of the file sit the tool_result
// records the harness wrote while the turn ran. Taking the last CONVERSATIONAL
// record would return one of those.
func lastAssistantText(lines [][]byte) string {
	for i := len(lines) - 1; i >= 0; i-- {
		rec, ok := sessionio.DecodeRecord(lines[i])
		if !ok || rec.Role() != "assistant" || rec.IsMeta || rec.IsSidechain {
			continue
		}
		if text := strings.TrimSpace(rec.Text()); text != "" {
			return text
		}
	}
	return ""
}
