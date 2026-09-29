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
func absorbedPrompt(rec Record) (string, []ImageRef, bool) {
	if rec.IsSidechain || !bytes.Contains(rec.Line, []byte(`"queued_command"`)) {
		return "", nil, false
	}
	at, ok := queuedCommand(rec.Line)
	if !ok || at.Type != "queued_command" || at.CommandMode != "prompt" || at.Origin.Kind != "human" {
		return "", nil, false
	}
	// A string, or content blocks when a picture was pasted with it. The
	// pictures travel as references, as a user record's do (Normalizer.Record),
	// fetched through the attachment's own uuid (ScanImageBlock). Deployed
	// review round 2 of the T3 pass (2026-09-29): a picture queued mid-turn
	// drew as "[Image #1]  pic in queue" with no picture.
	var text string
	var pics []ImageRef
	if json.Unmarshal(at.Prompt, &text) != nil {
		var blocks []Block
		if json.Unmarshal(at.Prompt, &blocks) != nil {
			return "", nil, false
		}
		text = strings.TrimSuffix(blockText(blocks), "\n")
		n := 0
		for _, bl := range blocks {
			if bl.Type != "image" {
				continue
			}
			if ref, ok := imageRef(bl, n); ok {
				pics = append(pics, ref)
			}
			n++
		}
		// Paste ids are trusted only one to one with the blocks, as for a
		// user record.
		if len(at.ImagePasteIDs) == n {
			for i := range pics {
				pics[i].Paste = at.ImagePasteIDs[pics[i].N]
			}
		}
	}
	if strings.TrimSpace(text) == "" {
		return "", nil, false
	}
	// Without the record's uuid a reference could never be fetched.
	if rec.UUID == "" {
		pics = nil
	}
	return text, pics, true
}

// queuedAttachment is the part of an attachment record absorbedPrompt reads.
type queuedAttachment struct {
	Type          string          `json:"type"`
	CommandMode   string          `json:"commandMode"`
	Prompt        json.RawMessage `json:"prompt"`
	ImagePasteIDs pasteIDs        `json:"imagePasteIds"`
	Origin        struct {
		Kind string `json:"kind"`
	} `json:"origin"`
}

// queuedCommand decodes an attachment record's attachment.
func queuedCommand(line []byte) (queuedAttachment, bool) {
	var a struct {
		Attachment queuedAttachment `json:"attachment"`
	}
	if json.Unmarshal(line, &a) != nil {
		return queuedAttachment{}, false
	}
	return a.Attachment, true
}

// absorbed turns an absorbed prompt into the user event a typed one gets, as
// the start of a turn of its own. The renderer draws one prompt per turn, and
// what Claude writes after taking it is its answer to it.
func (n *Normalizer) absorbed(rec Record) []Event {
	text, pics, ok := absorbedPrompt(rec)
	if !ok {
		return nil
	}
	n.startTurn()
	e := n.emit(KindUser, parseAt(rec.Timestamp))
	e.Body = plainText(text)
	if len(pics) > 0 {
		e.Images, e.RecordID = pics, rec.UUID
	}
	return []Event{e}
}
