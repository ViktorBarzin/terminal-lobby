package main

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"time"

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

	// native is Claude's own plan menu as the pane draws it, read for a mod
	// that lists plan-keys (watchPlan); nil until read. Guarded by modConn.mu.
	native *sessionio.Dialog
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
		body, _ := json.Marshal(c.planCard(asking))
		reading = string(body)
		c.watchPlan(asking)
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

// planApproveSynthetic is the card's one approve row for a plan whose menu has
// not been read off the pane: every plan of a mod before plan-keys, and a
// plan-keys one for the moment before Claude draws its menu.
const planApproveSynthetic = "Yes, approve the plan"

// planCard is the reading the plan card draws: Claude's own menu once the pane
// has shown it, and the synthetic row until then, each with the plan's text
// from the mod.
func (c *modConn) planCard(d *modDialog) sessionio.Dialog {
	c.mu.Lock()
	native := d.native
	c.mu.Unlock()
	if native != nil {
		out := *native
		if out.PlanPath == "" {
			out.PlanPath = d.planFilePath
		}
		out.Plan = d.plan
		return out
	}
	return sessionio.Dialog{
		Kind:        sessionio.DialogKindPlan,
		Options:     []sessionio.PlanOption{{Number: 1, Label: planApproveSynthetic}},
		FeedbackRow: 2, PlanPath: d.planFilePath, Plan: d.plan,
	}
}

// How often and for how long watchPlan reads the pane for Claude's plan menu.
// The mod announces the plan just before Claude draws the menu, so the first
// reading or two usually miss it; a menu not drawn within planReadFor is left
// to the synthetic row. Vars so a test can shorten them.
var (
	planReadEvery = 300 * time.Millisecond
	planReadFor   = 15 * time.Second
)

// watchPlan reads Claude's plan menu off the pane for a plan-keys mod's open
// plan, once, and puts it on the card: the rows Claude draws are the ones the
// answer presses, and their labels change from session to session. It stops
// at the first reading, when the dialog closes, or after planReadFor. A plan
// announced again (a snapshot after a hello) is a new dialog and read again.
func (c *modConn) watchPlan(d *modDialog) {
	h := c.hub
	if h.plans == nil || !c.can(opPlanKeys) {
		return
	}
	c.mu.Lock()
	if d.native != nil || c.planPolls[d] {
		c.mu.Unlock()
		return
	}
	if c.planPolls == nil {
		c.planPolls = map[*modDialog]bool{}
	}
	c.planPolls[d] = true
	c.mu.Unlock()
	every, deadline := planReadEvery, time.Now().Add(planReadFor)
	go func() {
		defer func() {
			c.mu.Lock()
			delete(c.planPolls, d)
			c.mu.Unlock()
		}()
		ctx := h.rg.ctx
		for time.Now().Before(deadline) {
			select {
			case <-ctx.Done():
				return
			case <-time.After(every):
			}
			if c.dialogFor("plan", d.toolID) != d {
				return
			}
			reading, err := h.plans.ReadPlan(c.user, c.sessionName())
			if err != nil || reading == nil {
				continue
			}
			c.mu.Lock()
			d.native = reading
			c.mu.Unlock()
			// Under applyMu, so this write cannot land between an apply's
			// fold and its own showDialogs.
			c.applyMu.Lock()
			if fs := c.source(); fs != nil {
				c.showDialogs(fs)
			}
			c.applyMu.Unlock()
			return
		}
	}()
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
		if c.hub.plans != nil && c.can(opPlanKeys) {
			return c.answerPlanKeys(ctx, d, *req.Plan)
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
	return c.sendDecisions(ctx, cmds)
}

// sendDecisions sends the commands that settle a dialog, in order, and stops
// at the first the mod did not take.
func (c *modConn) sendDecisions(ctx context.Context, cmds []modCommand) sessionio.AnswerResponse {
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

// opPlanKeys is the hello op of a mod that leaves the plan to Claude's own
// menu (mod 0.5.0): approvals are keys in the pane, and a deny goes to the mod.
const opPlanKeys = "plan-keys"

// answerPlanKeys answers a plan-keys mod's plan. Claude Code 2.1.293 keeps its
// own menu up whatever a hook answers (ADR-0036, 2026-10-08), so:
//
//   - an approval presses a row of that menu in the pane, after a `decide
//     allow` that tells the mod the web answered and hands it any words, which
//     it attaches to the approved result; nothing is typed into the menu's
//     feedback field;
//   - Keep planning and words sent back are a `decide deny`, which the mod's
//     tool.call returns as the call's answer, and that takes the menu down.
//
// The label decides what an answer means, never the number. A row of Claude's
// menu has to carry the same label on a reading taken now. agent-api's
// Approve plan and the card's synthetic row mean the row PlanApproveRow picks;
// agent-api's Keep planning is row 2, which on Claude's menu approves.
func (c *modConn) answerPlanKeys(ctx context.Context, d *modDialog, p sessionio.PlanAnswer) sessionio.AnswerResponse {
	words := strings.TrimSpace(p.Feedback)
	deny := modCommand{Op: "decide", ToolID: d.toolID, Decision: "deny"}
	switch {
	case p.Option != 0 && words != "":
		return sessionio.AnswerResponse{Reason: sessionio.AnswerUnknownOption}
	case p.Option != 0 && p.Label == sessionio.PlanRowKeep:
		// The mod sends its own keep-planning message.
		return c.sendDecisions(ctx, []modCommand{deny})
	case p.Option == 0 && words == "":
		return sessionio.AnswerResponse{Reason: sessionio.AnswerUnknownOption}
	case p.Option == 0 && !p.Approve:
		deny.Reason = p.Feedback
		return c.sendDecisions(ctx, []modCommand{deny})
	}
	h := c.hub
	osUser, session := c.user, c.sessionName()
	reading, err := h.plans.ReadPlan(osUser, session)
	if err != nil {
		return sessionio.AnswerResponse{Reason: sessionio.AnswerUnverified}
	}
	if reading == nil {
		return sessionio.AnswerResponse{Reason: sessionio.AnswerNotDrawn}
	}
	var row sessionio.PlanOption
	var ok bool
	if p.Option == 0 || p.Label == sessionio.PlanRowApprove || p.Label == planApproveSynthetic {
		row, ok = sessionio.PlanApproveRow(reading)
	} else {
		row, ok = sessionio.PlanOptionNamed(reading, p.Option, p.Label)
	}
	if !ok {
		return sessionio.AnswerResponse{Reason: sessionio.AnswerUnknownOption, Dialog: reading}
	}
	allow := modCommand{Op: "decide", ToolID: d.toolID, Decision: "allow"}
	if p.Option == 0 {
		allow.Feedback = p.Feedback
	}
	if resp := c.sendDecisions(ctx, []modCommand{allow}); !resp.Applied {
		return resp
	}
	resp, err := h.plans.PressPlanRow(ctx, osUser, session, row.Number, row.Label)
	if err != nil {
		return sessionio.AnswerResponse{Reason: sessionio.AnswerUnverified}
	}
	return resp
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
