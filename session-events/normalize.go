package main

import "encoding/json"

// Normalizer turns Claude Code transcript JSONL lines into normalized Events.
// It is stateful only for the monotonic sequence and the current turn id, so a
// fresh Normalizer replays a transcript identically from the start.
type Normalizer struct {
	session string
	seq     int64
	turnID  string
}

func NewNormalizer(session string) *Normalizer { return &Normalizer{session: session} }

type rawLine struct {
	Type    string `json:"type"`
	Message struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

type rawBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	IsError   bool            `json:"is_error"`
}

func (n *Normalizer) next() int64 { n.seq++; return n.seq }

func (n *Normalizer) emit(k Kind) Event {
	return Event{ID: n.next(), Kind: k, Session: n.session, TurnID: n.turnID}
}

// Line normalizes one transcript JSONL line into zero or more Events. Non-message
// (meta) lines and unparseable input yield nil.
func (n *Normalizer) Line(b []byte) []Event {
	var rl rawLine
	if json.Unmarshal(b, &rl) != nil {
		return nil
	}
	switch rl.Type {
	case "assistant", "user":
	default:
		return nil // meta lines: mode, permission-mode, last-prompt, ...
	}
	blocks := decodeContent(rl.Message.Content)
	var out []Event
	for _, bl := range blocks {
		switch bl.Type {
		case "text":
			e := n.emit(KindText)
			e.Body = bl.Text
			out = append(out, e)
		case "tool_use":
			e := n.emit(KindToolUse)
			e.Tool, e.ToolID = bl.Name, bl.ID
			e.Body = string(bl.Input)
			out = append(out, e)
		case "tool_result":
			e := n.emit(KindToolResult)
			e.ToolID, e.IsError = bl.ToolUseID, bl.IsError
			e.Body = decodeToolResult(bl.Content)
			out = append(out, e)
		}
	}
	return out
}

// decodeContent accepts message.content as either a plain string (wrapped into a
// single text block) or an array of blocks.
func decodeContent(raw json.RawMessage) []rawBlock {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return []rawBlock{{Type: "text", Text: s}}
	}
	var blocks []rawBlock
	if json.Unmarshal(raw, &blocks) == nil {
		return blocks
	}
	return nil
}

// decodeToolResult accepts a tool_result content as a JSON string or an array of
// {type:text,text} blocks.
func decodeToolResult(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var blocks []rawBlock
	if json.Unmarshal(raw, &blocks) == nil {
		for _, b := range blocks {
			if b.Type == "text" {
				return b.Text
			}
		}
	}
	return string(raw)
}
