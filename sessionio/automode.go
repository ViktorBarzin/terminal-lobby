package sessionio

import (
	"bytes"
	"encoding/json"
)

// autoModeAttachment reads the mode an auto_mode attachment says is in force.
//
// Claude Code writes the attachment as the session enters auto mode, with
// bypass true when it is bypassing permissions instead. It is the only record
// of the mode a plan approval chose when that choice is auto: approving with
// "Yes, and use auto mode" writes plan_mode_exit and then this attachment, and
// no permission-mode record until after the next prompt (Claude Code 2.1.283,
// measured 2026-09-27). Across this box's transcripts, 21 of 25 of these
// attachments named the same mode as the next permission-mode record; the
// other four were followed by the operator switching back to plan mode before
// the next prompt.
//
// auto_mode_exit is not read: leaving auto mode does not say which mode the
// session left for. A sidechain's attachment belongs to a subagent.
func autoModeAttachment(rec Record) (string, bool) {
	if rec.IsSidechain || !bytes.Contains(rec.Line, []byte(`"auto_mode"`)) {
		return "", false
	}
	var a struct {
		Attachment struct {
			Type   string `json:"type"`
			Bypass bool   `json:"bypass"`
		} `json:"attachment"`
	}
	if json.Unmarshal(rec.Line, &a) != nil || a.Attachment.Type != "auto_mode" {
		return "", false
	}
	if a.Attachment.Bypass {
		return "bypassPermissions", true
	}
	return "auto", true
}
