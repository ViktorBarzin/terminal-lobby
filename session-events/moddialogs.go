package main

import (
	"context"
	"encoding/json"
	"slices"
	"strings"

	"terminal-lobby/sessionio"
)

// The dialogs a mod-fed session waits on a person for (ADR-0036): what each
// shows, how they reach the Text view's cards, and how an answer from a card
// or the agent API becomes the command that settles one. Which dialogs are
// open is the fold's (stampState), so @claude_ask, the cards and the answer
// routes always agree.

// modDialog is a dialog a session is waiting on a person for, with what it
// shows: enough for a program to read it without the pane.
type modDialog struct {
	kind      string // "ask", "plan" or "permission"
	toolID    string
	questions []heldQuestion
	raw       json.RawMessage // the questions exactly as asked

	plan, planFilePath string // a plan's text and file

	tool, title, reason string   // a permission prompt's tool, heading and why it asks
	detail              []string // what the tool will do
}

// dialogOf is the dialog an ask, plan or permission event opens, with what
// it shows; nil for any other event.
func dialogOf(ev sessionio.ModEvent) *modDialog {
	d := &modDialog{toolID: ev.ToolID}
	switch ev.Type {
	case sessionio.ModAskEvent:
		d.kind, d.raw = "ask", ev.Questions
		_ = json.Unmarshal(ev.Questions, &d.questions)
	case sessionio.ModPlanEvent:
		d.kind, d.plan, d.planFilePath = "plan", ev.Plan, ev.PlanFilePath
	case sessionio.ModPermissionEvent:
		d.kind, d.tool, d.reason = "permission", ev.Tool, ev.Reason
		d.title, d.detail = permissionTitle(ev.Tool), permissionDetail(ev.Input)
	default:
		return nil
	}
	return d
}

// openDialogs is the dialogs the session waits on a person for, oldest first:
// the same list @claude_ask is written from.
func (c *modConn) openDialogs() []*modDialog {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.st.open()
}

// showDialogs puts the open dialogs on the wire in the shapes the Text view's
// cards already read: the held calls for questions (ADR-0034's `held`, oldest
// first, the card answers the first), and a reading for the oldest plan or
// permission prompt (`asking`). The source skips a body it already sent.
func (c *modConn) showDialogs(fs *sessionio.FileSource) {
	var calls []map[string]json.RawMessage
	var first json.RawMessage
	var asking *modDialog
	for _, d := range c.openDialogs() {
		switch {
		case d.kind == "ask":
			if first == nil {
				first = d.raw
			}
			calls = append(calls, map[string]json.RawMessage{"questions": d.raw})
		case asking == nil:
			asking = d
		}
	}
	held := ""
	if first != nil {
		body, _ := json.Marshal(map[string]any{"questions": first, "calls": calls})
		held = string(body)
	}
	fs.SetHeld(held)
	reading := ""
	switch {
	case asking == nil:
	case asking.kind == "plan":
		body, _ := json.Marshal(sessionio.Dialog{
			Kind:        sessionio.DialogKindPlan,
			Options:     []sessionio.PlanOption{{Number: 1, Label: "Yes, approve the plan"}},
			FeedbackRow: 2, PlanPath: asking.planFilePath,
		})
		reading = string(body)
	default:
		body, _ := json.Marshal(sessionio.Dialog{
			Kind: sessionio.DialogKindPermission, Title: asking.title,
			Detail: asking.detail, Prompt: "Do you want to proceed?",
			Options: []sessionio.PlanOption{{Number: 1, Label: "Yes"}, {Number: 2, Label: "No"}},
		})
		reading = string(body)
	}
	fs.SetAsking(reading)
}

// permissionTitle is the card's heading for a tool, in the words Claude's own
// prompt uses for the common ones.
func permissionTitle(tool string) string {
	switch tool {
	case "Bash":
		return "Bash command"
	case "Edit", "MultiEdit":
		return "Edit file"
	case "Write":
		return "Create file"
	case "Read":
		return "Read file"
	case "WebFetch":
		return "Fetch"
	}
	return tool
}

// permissionDetail is what the tool will do, as a few lines: the command, the
// file, or failing those the input's fields.
func permissionDetail(input json.RawMessage) []string {
	var in map[string]any
	if json.Unmarshal(input, &in) != nil {
		return nil
	}
	for _, k := range []string{"command", "file_path", "url", "path", "pattern"} {
		if s, ok := in[k].(string); ok && s != "" {
			lines := strings.Split(s, "\n")
			if d, ok := in["description"].(string); ok && d != "" {
				lines = append(lines, d)
			}
			return capLines(lines)
		}
	}
	var lines []string
	for k, v := range in {
		b, _ := json.Marshal(v)
		lines = append(lines, k+": "+string(b))
	}
	return capLines(lines)
}

func capLines(lines []string) []string {
	const most, width = 12, 400
	if len(lines) > most {
		lines = append(lines[:most], "…")
	}
	for i, l := range lines {
		if len(l) > width {
			lines[i] = strings.ToValidUTF8(l[:width], "") + "…"
		}
	}
	return lines
}

// dialogNow is the dialog the session is waiting on, nil when none.
func (c *modConn) dialogNow() *modDialog {
	if open := c.openDialogs(); len(open) > 0 {
		return open[0]
	}
	return nil
}

// dialogFor finds the dialog an answer is for: the one it names, or else the
// oldest open dialog of its kind. A named dialog of another kind is nil.
func (c *modConn) dialogFor(kind, toolID string) *modDialog {
	for _, d := range c.openDialogs() {
		if toolID != "" && d.toolID == toolID {
			if d.kind != kind {
				return nil
			}
			return d
		}
		if toolID == "" && d.kind == kind {
			return d
		}
	}
	return nil
}

// can reports whether the mod said in its hello that it runs op.
func (c *modConn) can(op string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return slices.Contains(c.ops, op)
}

// answer turns a card's answer into the command that settles the dialog.
func (c *modConn) answer(ctx context.Context, req sessionio.AnswerRequest) sessionio.AnswerResponse {
	var cmds []modCommand
	switch {
	case req.Answers != nil || req.Chat != nil:
		d := c.dialogFor("ask", req.ToolID)
		if d == nil {
			return sessionio.AnswerResponse{Reason: sessionio.AnswerNotHeld}
		}
		cmd := modCommand{Op: "answer", ToolID: d.toolID}
		if req.Chat != nil {
			msg := chatMessage(*req.Chat)
			cmd.Chat = &msg
		} else {
			answers, ok := answersFor(d.questions, req.Answers)
			if !ok {
				return sessionio.AnswerResponse{Reason: sessionio.AnswerIncomplete}
			}
			cmd.Answers = answers
		}
		cmds = append(cmds, cmd)
	case req.Plan != nil:
		d := c.dialogFor("plan", req.ToolID)
		if d == nil {
			return sessionio.AnswerResponse{Reason: sessionio.AnswerNotDrawn}
		}
		p := req.Plan
		switch {
		case p.Option == 1:
			cmds = append(cmds, modCommand{Op: "decide", ToolID: d.toolID, Decision: "allow"})
		case p.Option == 2 && strings.TrimSpace(p.Feedback) == "":
			// Keep planning, with no words: the mod sends its own message.
			cmds = append(cmds, modCommand{Op: "decide", ToolID: d.toolID, Decision: "deny"})
		case strings.TrimSpace(p.Feedback) != "" && p.Approve && c.can("decide-feedback"):
			// The mod hands the words to Claude with the approval, so they
			// land in the turn that carries out the plan.
			cmds = append(cmds, modCommand{Op: "decide", ToolID: d.toolID, Decision: "allow", Feedback: p.Feedback})
		case strings.TrimSpace(p.Feedback) != "" && p.Approve:
			// An older mod has only a prompt, which Claude takes as a turn of
			// its own once the plan's turn is over.
			cmds = append(cmds, modCommand{Op: "decide", ToolID: d.toolID, Decision: "allow"},
				modCommand{Op: "prompt", Text: p.Feedback})
		case strings.TrimSpace(p.Feedback) != "":
			cmds = append(cmds, modCommand{Op: "decide", ToolID: d.toolID, Decision: "deny", Reason: p.Feedback})
		default:
			return sessionio.AnswerResponse{Reason: sessionio.AnswerUnknownOption}
		}
	case req.Permission != nil:
		d := c.dialogFor("permission", req.ToolID)
		if d == nil {
			return sessionio.AnswerResponse{Reason: sessionio.AnswerNotDrawn}
		}
		p := req.Permission
		switch {
		case p.Option == 1:
			cmds = append(cmds, modCommand{Op: "decide", ToolID: d.toolID, Decision: "allow"})
		case p.Option == 2:
			cmds = append(cmds, modCommand{Op: "decide", ToolID: d.toolID, Decision: "deny",
				Reason: "The user declined this tool call."})
		case strings.TrimSpace(p.Decline) != "":
			cmds = append(cmds, modCommand{Op: "decide", ToolID: d.toolID, Decision: "deny", Reason: p.Decline})
		default:
			return sessionio.AnswerResponse{Reason: sessionio.AnswerUnknownOption}
		}
	default:
		return sessionio.AnswerResponse{Reason: sessionio.AnswerNotHeld}
	}
	for _, cmd := range cmds {
		a, err := c.send(ctx, cmd)
		if err != nil {
			return sessionio.AnswerResponse{Reason: sessionio.AnswerUnverified}
		}
		if !a.OK {
			// The dialog was settled elsewhere a moment ago.
			return sessionio.AnswerResponse{Reason: sessionio.AnswerNotHeld}
		}
	}
	return sessionio.AnswerResponse{Applied: true, Done: true}
}

// heldQuestion is the part of an AskUserQuestion question an answer is checked
// against.
type heldQuestion struct {
	Question    string `json:"question"`
	MultiSelect bool   `json:"multiSelect,omitempty"`
}

// answersFor builds Claude's answer map from the card's, keyed by the question
// text, or reports that a question is left without an answer. Claude reads a
// missing answer as a skipped question, so a partial map is refused rather than
// sent. A multi-select's picks go as one "A, B" string: an array reaches the
// model as "A,B" and the terminal draws no answer row for it (ADR-0034).
func answersFor(qs []heldQuestion, got map[string][]string) (map[string]string, bool) {
	out := make(map[string]string, len(qs))
	for _, q := range qs {
		var picks []string
		for _, p := range got[q.Question] {
			if p = strings.TrimSpace(p); p != "" {
				picks = append(picks, p)
			}
		}
		if len(picks) == 0 {
			return nil, false
		}
		out[q.Question] = strings.Join(picks, ", ")
	}
	return out, true
}

// chatMessage is what Claude reads when the reader declines the question to
// talk instead. Claude shows a refusal as an error, so the words say plainly
// that this is the reader's choice and what to do next.
func chatMessage(words string) string {
	words = strings.TrimSpace(words)
	if words == "" {
		return "The user chose not to answer these questions and wants to talk about them instead. " +
			"Do not ask them again; wait for the user's next message."
	}
	return "The user chose not to pick an answer and replied instead: " + words
}
