package main

// What a blocked session is asking, read off its pane.
//
// Three dialogs can stop a turn, and the lobby reads each with its own
// sessionio parser: the tool permission prompt, the plan approval, and an
// AskUserQuestion menu. The first two the lobby answers by keys through
// sessionio.Injector.Answer, and so can this service. The third it answers as
// DATA, through the PermissionRequest hook session-events holds (ADR-0034,
// session-events/hold.go); that hold lives in session-events' memory, and this
// service calls no other service's port (main.go), so an AskUserQuestion is
// reported here with its options and refused by the answer route rather than
// typed into.
//
// The terminal-lobby mod (claude-mod/) holds plan approvals and permission
// prompts itself and draws its own dialog in their place, which the pane
// shows as an AskUserQuestion menu with fixed rows. Those two are recognised
// by their header and rows and reported as permission and plan questions,
// and a digit answers them: the mod reads the row picked in the terminal as
// the decision (checked on a live pane on 2026-10-02).

import (
	"strings"

	"terminal-lobby/sessionio"
)

// The question kinds a needs_input task reports.
const (
	// KindPermission is Claude Code's tool permission prompt. Answerable: a
	// row by number, or words that decline the call through its No row.
	KindPermission = "permission"
	// KindPlan is the plan approval. Answerable: an approve row by number, or
	// words sent back as feedback, after which Claude keeps planning.
	KindPlan = "plan"
	// KindChoice is an AskUserQuestion menu. Shown, not answerable here.
	KindChoice = "choice"
	// KindUnknown is a session waiting on something no parser recognised: a
	// dialog in a shape the lobby does not know, or one read before it was
	// drawn. The question is the bottom of the pane.
	KindUnknown = "unknown"
)

// The two answer bodies, as AnswerWith names them.
const (
	answerOption = "option"
	answerText   = "text"
)

// TaskOption is one row a question offers.
type TaskOption struct {
	// Index is the row's number as drawn, which is the number an answer
	// names. 1-based, because the screen is: the digit that picks a row is
	// its number.
	Index int    `json:"index"`
	Label string `json:"label"`
}

// questionReading is one reading of a blocked pane.
type questionReading struct {
	Kind       string
	Text       string
	Options    []TaskOption
	AnswerWith []string
	// Mod says the dialog is the terminal-lobby mod's own Allow / Deny or
	// plan approval, answered by pressing its row's digit.
	Mod bool
}

// setQuestion stamps a reading on a task. Called with the store's lock held.
func (t *Task) setQuestion(q questionReading) {
	t.Question = q.Text
	t.Kind = q.Kind
	t.Options = q.Options
	t.AnswerWith = q.AnswerWith
}

// sameQuestion reports whether two readings ask the same thing. The text is
// compared for every kind but the plan, whose text is the bottom of the
// rendered plan and can reflow without the question changing; its rows carry
// what matters, "(6% used)" included.
func sameQuestion(a, b questionReading) bool {
	if a.Kind != b.Kind || len(a.Options) != len(b.Options) {
		return false
	}
	for i := range a.Options {
		if a.Options[i] != b.Options[i] {
			return false
		}
	}
	return a.Kind == KindPlan || a.Text == b.Text
}

// parseQuestion reads a pane.
//
// The question parser first, as before options were read, so an
// AskUserQuestion still reports the question as the tool posed it. The three
// parsers anchor on footers that cannot be mistaken for one another, so the
// order decides nothing else. A pane none of them reads falls back to its
// tail, because saying nothing would leave the caller holding a needs_input it
// cannot act on.
func parseQuestion(pane string) questionReading {
	if d := sessionio.ParseDialog(pane); d != nil && len(d.Questions) > 0 {
		q := d.Questions[0]
		r := questionReading{Kind: KindChoice, Text: strings.TrimSpace(q.Question)}
		for i, o := range q.Options {
			r.Options = append(r.Options, TaskOption{Index: i + 1, Label: o.Label})
		}
		if r.Text == "" {
			r.Text = paneTail(pane, paneQuestionLimit)
		}
		if kind, ok := modDialogKind(d); ok {
			r.Kind, r.Mod, r.AnswerWith = kind, true, []string{answerOption}
		}
		return r
	}
	if d := sessionio.ParsePlanDialog(pane); d != nil {
		r := questionReading{
			Kind: KindPlan,
			// The plan itself is above the rows, and its last lines are the
			// most a task view can carry of it.
			Text:       paneTail(pane, paneQuestionLimit),
			AnswerWith: []string{answerOption, answerText},
		}
		for _, o := range d.Options {
			r.Options = append(r.Options, TaskOption{Index: o.Number, Label: o.Label})
		}
		return r
	}
	if d := sessionio.ParsePermissionDialog(pane); d != nil {
		r := questionReading{Kind: KindPermission, AnswerWith: []string{answerOption}}
		var text []string
		for _, l := range append(append([]string{d.Title}, d.Detail...), d.Prompt) {
			if l = strings.TrimSpace(l); l != "" {
				text = append(text, l)
			}
		}
		r.Text = strings.Join(text, "\n")
		for _, o := range d.Options {
			r.Options = append(r.Options, TaskOption{Index: o.Number, Label: o.Label})
			// Words decline the call through the No row's field, so a prompt
			// without one has nowhere to put them (sessionio refuses it as
			// unknown-option). Matched on the label at rest and once its field
			// is open, which are the two ways permdialog.go reads it.
			if o.Label == "No" || strings.HasPrefix(o.Label, "No,") {
				r.AnswerWith = []string{answerOption, answerText}
			}
		}
		return r
	}
	return questionReading{Kind: KindUnknown, Text: paneTail(pane, paneQuestionLimit)}
}

// readQuestion reads one session's pane. A pane that cannot be captured is an
// unknown question with nothing to say, which is what the watcher reported
// before options were read.
func (s *Server) readQuestion(osUser, session string) questionReading {
	pane, err := s.Sessions.Pane(osUser, session)
	if err != nil {
		return questionReading{Kind: KindUnknown}
	}
	return parseQuestion(pane)
}

// modDialogs are the mod's own dialogs, with the header, the rows and the
// shape of the question each draws (claude-mod/hooks/lib/shape.ts, dialogFor).
var modDialogs = []struct {
	kind, header string
	rows         [2]string
	asks         func(question string) bool
}{
	{KindPermission, "Permission", [2]string{"Allow", "Deny"},
		func(q string) bool { return strings.HasPrefix(q, "Allow ") && strings.HasSuffix(q, "?") }},
	{KindPlan, "Plan", [2]string{"Approve plan", "Keep planning"},
		func(q string) bool { return strings.HasSuffix(q, "Approve the plan?") }},
}

// modDialogKind reports whether a menu is one of the mod's dialogs: a single
// question with exactly its two rows, asked the way the mod asks it, under
// its header. The header can sit above the pane's view of a long plan, so a
// header the parser could not see is not held against it; one that says
// something else is.
func modDialogKind(d *sessionio.Dialog) (string, bool) {
	if len(d.Questions) != 1 || d.Count > 1 {
		return "", false
	}
	q := d.Questions[0]
	question := strings.TrimSpace(q.Question)
	for _, m := range modDialogs {
		if q.MultiSelect || len(q.Options) != len(m.rows) || (q.Header != "" && q.Header != m.header) || !m.asks(question) {
			continue
		}
		match := true
		for i, o := range q.Options {
			match = match && o.Label == m.rows[i]
		}
		if match {
			return m.kind, true
		}
	}
	return "", false
}
