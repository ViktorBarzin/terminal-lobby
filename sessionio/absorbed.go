package sessionio

import (
	"bytes"
	"encoding/json"
	"strings"
)

// absorbedPrompt reads the one attachment that is a person speaking: a prompt
// Claude took into the turn it was already running.
//
// Sent while a turn runs, a prompt joins Claude's queue. Taken BETWEEN turns it
// is written as an ordinary user record. Taken mid-turn it is not: the queue
// reports it leaving with reason absorbed_mid_turn, and the prompt's only
// account is an attachment of type queued_command that the CLI shows the model
// as a system reminder. Measured 2026-09-27 across this box's transcripts: 87
// absorbed human prompts, and none of them has a user record of its own. So a
// reader who sent a message mid-turn found it missing from the conversation
// after a reload, and the bubble standing in for it was never let go.
//
// Only commandMode "prompt" from origin "human" counts. The same attachment
// delivers every background task's notification (756 on this box), which
// renders through its own record, and a message from another session (origin
// "peer", 12), which the reader did not type. A sidechain's attachment belongs
// to a subagent, whose prompts are not the reader's either.
func absorbedPrompt(rec Record) (string, bool) {
	if rec.IsSidechain || !bytes.Contains(rec.Line, []byte(`"queued_command"`)) {
		return "", false
	}
	var a struct {
		Attachment struct {
			Type        string          `json:"type"`
			CommandMode string          `json:"commandMode"`
			Prompt      json.RawMessage `json:"prompt"`
			Origin      struct {
				Kind string `json:"kind"`
			} `json:"origin"`
		} `json:"attachment"`
	}
	if json.Unmarshal(rec.Line, &a) != nil {
		return "", false
	}
	at := a.Attachment
	if at.Type != "queued_command" || at.CommandMode != "prompt" || at.Origin.Kind != "human" {
		return "", false
	}
	// A string, or content blocks when a picture was pasted with it. The
	// picture is not carried: an image reference is fetched through a user
	// record's uuid, and this prompt has none.
	var text string
	if json.Unmarshal(at.Prompt, &text) != nil {
		var blocks []Block
		if json.Unmarshal(at.Prompt, &blocks) != nil {
			return "", false
		}
		text = strings.TrimSuffix(blockText(blocks), "\n")
	}
	if strings.TrimSpace(text) == "" {
		return "", false
	}
	return text, true
}

// absorbed turns an absorbed prompt into the user event a typed one gets, as
// the start of a turn of its own. The renderer draws one prompt per turn, and
// what Claude writes after taking it is its answer to it.
func (n *Normalizer) absorbed(rec Record) []Event {
	text, ok := absorbedPrompt(rec)
	if !ok {
		return nil
	}
	n.startTurn()
	e := n.emit(KindUser, parseAt(rec.Timestamp))
	e.Body = plainText(text)
	return []Event{e}
}
