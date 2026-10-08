package main

// What a blocked session is asking, read from the lobby's mod.
//
// Three dialogs can stop a turn: a tool permission prompt, a plan approval,
// and an AskUserQuestion menu. The lobby's mod (claude-mod/) reports each one
// to session-events as data, holds it, and settles it when the web answers,
// which is how the Text view's cards work. This service reads and answers them
// the same way, through session-events' internal routes (dialog.go, ADR-0037).
// Since Claude Code 2.1.293 the plan approval is Claude's own menu again, and
// session-events approves it with a key in the pane (ADR-0036, 2026-10-08).
// It used to read the pane and press keys; that code is gone.
//
// A session whose Claude has no mod (it never loaded, or session-events
// restarted a moment ago) has no dialog to read, and its question is reported
// as unknown, with the bottom of the pane as the text.

import (
	"errors"
	"fmt"
	"strings"

	"terminal-lobby/sessionio"
)

// The question kinds a needs_input task reports.
const (
	// KindPermission is Claude Code's tool permission prompt. Answerable:
	// Allow or Deny by number, or words that deny the call and say why.
	KindPermission = "permission"
	// KindPlan is the plan approval. Answerable: Approve plan or Keep planning
	// by number, or words sent back as feedback, after which Claude keeps
	// planning. Approve plan approves in the first mode Claude's menu offers
	// that keeps the context and the permission prompts.
	KindPlan = "plan"
	// KindChoice is an AskUserQuestion menu. Answerable when it asks one
	// question: a row by number, or words as the "Other" answer. A menu of
	// several questions is shown and refused, because an answer body carries
	// one answer.
	KindChoice = "choice"
	// KindUnknown is a session waiting on something the lobby's mod did not
	// report: the mod is not connected for the session, or the dialog is in a
	// shape the lobby does not know. The question is the bottom of the pane.
	KindUnknown = "unknown"
)

// The two answer bodies, as AnswerWith names them.
const (
	answerOption = "option"
	answerText   = "text"
)

// The rows offered for a plan and a permission prompt. They name the two
// choices, not rows of Claude's own menu, and session-events reads them by
// label: Approve plan presses the first row of Claude's plan menu that keeps
// the context and does not turn permission prompts off, and Keep planning
// sends the plan back with no key (session-events/moddialogs.go).
var (
	planRows       = []TaskOption{{1, sessionio.PlanRowApprove}, {2, sessionio.PlanRowKeep}}
	permissionRows = []TaskOption{{1, "Allow"}, {2, "Deny"}}
)

// TaskOption is one row a question offers.
type TaskOption struct {
	// Index is the row's number as drawn, which is the number an answer
	// names. 1-based, because the screen is.
	Index int    `json:"index"`
	Label string `json:"label"`
}

// questionReading is one reading of a blocked session.
type questionReading struct {
	Kind       string
	Text       string
	Options    []TaskOption
	AnswerWith []string
	// ToolID names the dialog, so an answer goes to it and nowhere else.
	// Empty for an unknown question.
	ToolID string
	// question is a choice's question exactly as asked, which is the key its
	// answer is filed under.
	question string
}

// setQuestion stamps a reading on a task. Called with the store's lock held.
func (t *Task) setQuestion(q questionReading) {
	t.Question = q.Text
	t.Kind = q.Kind
	t.Options = q.Options
	t.AnswerWith = q.AnswerWith
	t.toolID = q.ToolID
}

// readingFromDialog turns the mod's dialog into a question.
func readingFromDialog(d modDialog) questionReading {
	r := questionReading{ToolID: d.ToolID}
	switch d.Kind {
	case "permission":
		r.Kind, r.Options = KindPermission, permissionRows
		r.AnswerWith = []string{answerOption, answerText}
		lines := append([]string{"Allow " + firstNonEmpty(d.Title, d.Tool) + "?"}, d.Detail...)
		if d.Reason != "" {
			lines = append(lines, "Claude Code asks because: "+d.Reason)
		}
		r.Text = strings.Join(lines, "\n")
	case "plan":
		r.Kind, r.Options, r.Text = KindPlan, planRows, d.Plan
		r.AnswerWith = []string{answerOption, answerText}
	case "ask":
		r.Kind = KindChoice
		if len(d.Questions) == 0 {
			r.Kind, r.ToolID = KindUnknown, ""
			return r
		}
		q := d.Questions[0]
		r.question, r.Text = q.Question, q.Question
		for i, o := range q.Options {
			r.Options = append(r.Options, TaskOption{Index: i + 1, Label: o.Label})
		}
		switch {
		case len(d.Questions) > 1:
			r.Text = fmt.Sprintf("%s (one of %d questions asked together)", q.Question, len(d.Questions))
		default:
			// A multi-select takes one row here too: an answer body names
			// one, and words cover anything else, as the "Other" row does.
			r.AnswerWith = []string{answerOption, answerText}
		}
	default:
		r.Kind, r.ToolID = KindUnknown, ""
	}
	return r
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// readQuestion reads the dialog the session is waiting on. A session with no
// dialog to read is an unknown question with no text yet; withPaneText adds
// the bottom of the pane when the task is about to report it.
func (s *Server) readQuestion(osUser, session string) questionReading {
	d, err := s.Sessions.Dialog(osUser, session)
	if err != nil {
		return questionReading{Kind: KindUnknown}
	}
	return readingFromDialog(d)
}

// withPaneText gives an unknown question the bottom of the pane as its text,
// the only description there is of what the session is waiting on.
func (s *Server) withPaneText(osUser, session string, q questionReading) questionReading {
	if q.Kind != KindUnknown || q.Text != "" {
		return q
	}
	if pane, err := s.Sessions.Pane(osUser, session); err == nil {
		q.Text = paneTail(pane, paneQuestionLimit)
	}
	return q
}

// errNotAnswerable says why a reading takes no answer body.
func errNotAnswerable(q questionReading) error {
	switch q.Kind {
	case KindUnknown:
		return errors.New("the session is waiting on something the lobby's mod did not report (the mod may not be " +
			"connected for this session), so there is nothing to check an answer against. Answer it in the terminal, " +
			"then poll the task again")
	case KindChoice:
		return errors.New("this AskUserQuestion menu asks several questions together, and an answer body carries " +
			"one answer. Answer it in the lobby or the terminal, then poll the task again")
	}
	return fmt.Errorf("a %s question takes no answer here", q.Kind)
}
