package sessionio

import (
	"bytes"
	"encoding/json"
	"strings"
)

// MainSteerLead opens every message the lobby delivers into Claude's running
// main turn. A prompt sent from the Text view while a turn runs is held by
// session-events (held.go); at the turn's next tool boundary the mod takes
// what is held and attaches each one to the tool's result as context, which
// the model reads before its next step (claude-mod/hooks/lib/steermain.ts).
// That is where Claude Code delivers a prompt typed in the pane mid-turn.
//
// The line tells the model the words are the person's and are to be acted on
// now, and marks the entry for the readers below: the same context carries
// the mod's plan feedback and any other plugin's. The mod spells it too, and
// a test holds the two together.
const MainSteerLead = "The person watching this session in the lobby sent this message while you were working. Read it before your next step, and change course if it asks you to:"

// FrameMainSteer is the context entry that delivers text.
func FrameMainSteer(text string) string {
	return MainSteerLead + "\n\n" + strings.TrimSpace(text)
}

// mainSteerPieces splits text at each lead and returns what follows each
// one, trimmed. Text before the first lead is someone else's context.
func mainSteerPieces(text string) []string {
	parts := strings.Split(text, MainSteerLead)
	var out []string
	for _, p := range parts[1:] {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// toolCallContextHead is what the engine puts before a tool.call hook's
// context in the row it stores (measured on CLI 2.1.296, 2026-10-10).
const toolCallContextHead = "tool.call hook additional context: "

// MainSteerTexts is what a mod row delivered into the main turn, oldest
// first: the messages of a hook-context row a plugin's tool.call attached,
// one per lead. Nil for every other row.
//
// The row's origin names the event but not the plugin, so the lead is what
// says the entry is the lobby's.
func MainSteerTexts(ev ModEvent) []string {
	if ev.Door != "hook-context" || ev.AgentID != "" || ev.Message == nil || ev.Message.Name != "hook_additional_context" {
		return nil
	}
	var o struct {
		Kind  string `json:"kind"`
		Event string `json:"event"`
	}
	if json.Unmarshal(ev.Origin, &o) != nil || o.Kind != "plugin" || o.Event != "tool.call" {
		return nil
	}
	var blocks []Block
	if json.Unmarshal(ev.Message.Content, &blocks) != nil {
		return nil
	}
	var b strings.Builder
	for _, bl := range blocks {
		if bl.Type != "text" {
			continue
		}
		t := strings.TrimSpace(bl.Text)
		t = strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(t, "<system-reminder>"), "</system-reminder>"))
		b.WriteString(strings.TrimPrefix(t, toolCallContextHead))
		b.WriteString("\n")
	}
	return mainSteerPieces(b.String())
}

// transcriptMainSteerTexts is the same for a transcript line: an attachment
// of type hook_additional_context from tool.call, one content entry per
// context string.
func transcriptMainSteerTexts(rec Record) []string {
	if rec.IsSidechain || !bytes.Contains(rec.Line, []byte(`"hook_additional_context"`)) {
		return nil
	}
	var a struct {
		Attachment struct {
			Type     string   `json:"type"`
			HookName string   `json:"hookName"`
			Content  []string `json:"content"`
		} `json:"attachment"`
	}
	if json.Unmarshal(rec.Line, &a) != nil || a.Attachment.Type != "hook_additional_context" || a.Attachment.HookName != "tool.call" {
		return nil
	}
	var out []string
	for _, c := range a.Attachment.Content {
		if rest, ok := strings.CutPrefix(c, MainSteerLead); ok {
			if rest = strings.TrimSpace(rest); rest != "" {
				out = append(out, rest)
			}
		}
	}
	return out
}

// steeredMain draws each delivered message as the reader's prompt, opening a
// turn of its own as an absorbed prompt does (absorbed): the renderer draws
// one prompt per turn, and what Claude writes after reading it answers it.
func (n *Normalizer) steeredMain(texts []string, at int64) []Event {
	var out []Event
	for _, t := range texts {
		n.startTurn()
		e := n.emit(KindUser, at)
		e.Body = plainText(t)
		out = append(out, e)
	}
	return out
}
