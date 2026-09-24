package sessionio

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// Claude Code's plan approval, read off the pane.
//
// WHY IT NEEDS A PARSER OF ITS OWN. ExitPlanMode puts a menu up and waits for a
// person, as AskUserQuestion does, and until 2026-09-24 the Text view could not
// answer it: ParseDialog wants the select widget's "Enter to select … Esc to
// cancel" footer and a free-text or chat row, this dialog has neither, so no
// card docked and POST /answer said no-dialog while the session sat blocked.
// Measured on CLI 2.1.281 on 2026-09-24 (memory #13896, and the captures under
// testdata/plan-*.txt), it is drawn like this, rules shortened:
//
//	▔▔▔                                  the fullscreen renderer's top edge
//	  ───
//	   Ready to code?
//
//	   Here is Claude's plan:
//	  ╌╌╌
//	   <the plan, as rendered markdown>
//	  ╌╌╌
//	  ───
//	   Claude has written up a plan and is ready to execute. Would you like to proceed?
//
//	   ❯ 1. Yes, clear context (6% used) and use auto mode
//	     2. Yes, and use auto mode
//	     3. Yes, manually approve edits
//	     4. Tell Claude what to change
//	        shift+tab to approve with this feedback
//
//	   ctrl+g to edit in Vim · ~/.claude/plans/<slug>.md
//
// THE BOTTOM IS THE ANCHOR. Everything from the rule over the question down to
// the footer is pinned: a plan longer than its panel is clipped with a grey ↓
// and PgDn scrolls it, and the options never move (plan-long.txt,
// plan-long-scrolled.txt). So the parse starts at the footer and walks up, and
// it never reads a line of the plan itself. A plan that quotes the dialog,
// "1. Yes, delete everything" and a footer of its own included, sits above the
// rule and is never mistaken for the options (plan-quoted-in-plan.txt).
//
// THE FOOTER IS THE LAST THING ON THE PANE. The dialog takes the input box's
// place, so nothing is drawn under it, in either renderer. A copy of the
// dialog in the CONVERSATION always has the input box and the status line
// below it, and that is what rules it out: the copy in
// plan-quoted-in-conversation.txt is real, carries every landmark down to a
// hint at its label column, and does not parse.
//
// NOTHING IS HARD-CODED BUT THE FURNITURE. The approve labels change with the
// session: "(6% used)" moves, auto mode may not exist, and the clear context
// option shows only under showClearContextOnPlanAccept. An account with
// neither draws "1. Yes, auto-accept edits / 2. Yes, manually approve edits /
// 3. Tell Claude what to change" (plan-no-auto.txt), so the feedback row is 3
// there. The options are read as drawn, and the feedback row is the last row,
// the one with the hint under it.
//
// THE FEEDBACK ROW IS AN INLINE FIELD. Typing replaces its label, and the words
// wrap at the label column, as a long label does on a narrow pane. So a row is
// told from a continuation by WHERE its label starts: every row's label, the
// hint and every wrapped line start at the same column, and a continuation
// that happens to read "2. more words" has its would-be label three columns
// further right.
//
// THE HEAD SCROLLS WITH THE PLAN, so nothing requires it. "Ready to code?" and
// "Here is Claude's plan:" are the first lines of the scrolling panel, not of
// the pinned block: PgDn takes both off the screen (plan-long-scrolled.txt),
// and on a 58-column pane long feedback squeezes the heading out
// (plan-narrow-typed.txt). Where they are drawn they, or the ▔ edge above
// them, mark where the dialog's own lines start; that is all they are used
// for.

// DialogKindPlan is Dialog.Kind for the plan approval.
const DialogKindPlan = "plan"

// PlanOption is one approve row of the plan approval: its number, which is the
// digit that selects it, and its label exactly as drawn.
type PlanOption struct {
	Number int    `json:"number"`
	Label  string `json:"label"`
}

// The dialog's own words, as CLI 2.1.281 draws them.
const (
	planTitle       = "Ready to code?"
	planHeading     = "Here is Claude's plan:"
	planProceed     = "Would you like to proceed?"
	planPlaceholder = "Tell Claude what to change"
	planHint        = "shift+tab to approve with this feedback"
)

var (
	// The footer: "ctrl+g to edit in Vim · ~/.claude/plans/<slug>.md". The
	// editor's name is the one the CLI resolves, so any word is taken there;
	// the path is optional so a plan with no file still reads.
	rePlanFooter = regexp.MustCompile(`^ctrl\+g to edit in \S+(?:\s+·\s*(.*))?$`)
	// A numbered row: the indent and the cursor, the number, and the label,
	// which is absent on a feedback field holding only spaces (the capture
	// trims them away).
	rePlanRow = regexp.MustCompile(`^(\s*(?:[❯>]\s*)?)(\d+)\.(?:(\s+)(.*\S))?\s*$`)
	// The fullscreen renderer's top edge over the dialog, a full row of ▔.
	rePlanEdge = regexp.MustCompile(`^\s*▔+\s*$`)
)

// planScreen is one reading of the plan approval: the reading that goes on the
// wire, plus what the driver needs and the wire does not carry.
type planScreen struct {
	dialog *Dialog
	// top and end bound the dialog's own lines, end exclusive.
	top, end int
	// cursor is the number of the row the ❯ is drawn in front of, 0 when no
	// row draws it.
	cursor int
	// typed is what the feedback field holds, "" while it shows its
	// placeholder. holdsText is true whenever it holds anything, which covers
	// a field holding only spaces, drawn as a bare "4.".
	typed     string
	holdsText bool
}

// ParsePlanDialog reads the plan approval off the visible pane, or returns nil
// when the pane is not showing one.
//
// Strict for the reason ParseDialog is: the card that docks over a reading
// types keys, and the keys here approve a plan. Everything pinned under the
// plan has to be on screen and in place: the footer as the pane's last line,
// the hint, the rows numbered from 1, the question and the rule over it.
func ParsePlanDialog(pane string) *Dialog {
	s, ok := parsePlan(strings.Split(pane, "\n"))
	if !ok {
		return nil
	}
	return s.dialog
}

// planRowAt is one numbered row as drawn, bottom-up while it is collected.
type planRowAt struct {
	n       int
	parts   []string // the label, then any lines it wrapped onto
	focused bool
}

// parsePlan is ParsePlanDialog's work, returning the whole reading.
func parsePlan(lines []string) (planScreen, bool) {
	last := len(lines) - 1
	for last >= 0 && strings.TrimSpace(lines[last]) == "" {
		last--
	}
	if last < 0 {
		return planScreen{}, false
	}
	foot, path, ok := planFooterAt(lines, last)
	if !ok {
		return planScreen{}, false
	}

	// The hint under the feedback row, which sits at the label column.
	i := skipBlankUp(lines, foot-1)
	hint, ok := planHintAt(lines, i)
	if !ok {
		return planScreen{}, false
	}
	labelCol := leadingSpace(lines[hint])

	// The rows, bottom-up, each with any lines its label wrapped onto.
	var rows []planRowAt
	var cont []string
	for i = hint - 1; i >= 0; i-- {
		line := lines[i]
		if strings.TrimSpace(line) == "" {
			break // the blank between the question and the rows
		}
		if n, label, focused, col, ok := planRow(line); ok && col == labelCol {
			parts := []string{label}
			for j := len(cont) - 1; j >= 0; j-- {
				parts = append(parts, cont[j])
			}
			rows = append(rows, planRowAt{n: n, parts: parts, focused: focused})
			cont = nil
			continue
		}
		if leadingSpace(line) >= labelCol {
			cont = append(cont, strings.TrimSpace(line))
			continue
		}
		return planScreen{}, false
	}
	if len(cont) > 0 || len(rows) < 2 {
		return planScreen{}, false
	}
	for l, r := 0, len(rows)-1; l < r; l, r = l+1, r-1 {
		rows[l], rows[r] = rows[r], rows[l]
	}
	for k, r := range rows {
		if r.n != k+1 {
			return planScreen{}, false
		}
	}

	// The question over the rows, wrapped over as many lines as it needs,
	// with the rule that closes the panel directly above it.
	i = skipBlankUp(lines, i)
	var q []string
	for ; i >= 0 && len(q) < maxQuestionLines; i-- {
		if strings.TrimSpace(lines[i]) == "" || reRule.MatchString(lines[i]) {
			break
		}
		q = append(q, lines[i])
	}
	for l, r := 0, len(q)-1; l < r; l, r = l+1, r-1 {
		q[l], q[r] = q[r], q[l]
	}
	if !strings.HasSuffix(joinWrapped(q), planProceed) {
		return planScreen{}, false
	}
	i = skipBlankUp(lines, i)
	if i < 0 || !isRuleLine(lines[i]) {
		return planScreen{}, false
	}
	top := planTop(lines, i)

	s := planScreen{top: top, end: last + 1}
	d := &Dialog{Kind: DialogKindPlan, PlanPath: path}
	for k, r := range rows {
		if r.focused {
			s.cursor = r.n
		}
		label := joinWrapped(r.parts)
		if k < len(rows)-1 {
			d.Options = append(d.Options, PlanOption{Number: r.n, Label: label})
			continue
		}
		d.FeedbackRow = r.n
		switch label {
		case planPlaceholder:
		case "":
			s.holdsText = true
		default:
			s.typed, s.holdsText = label, true
		}
	}
	s.dialog = d
	return s, true
}

// planFooterAt finds the footer ending on line `last`: one line on a wide pane,
// two or three where the terminal wrapped it. On the 58-column capture the
// path goes on a line of its own ("ctrl+g to edit in Vim ·" over
// "~/.claude/plans/…"). A path longer than the pane is broken with no space to
// break at, so the path's own pieces are joined with none.
func planFooterAt(lines []string, last int) (int, string, bool) {
	for n := 1; n <= footerWrapLines && last-n+1 >= 0; n++ {
		start := last - n + 1
		if m := rePlanFooter.FindStringSubmatch(joinWrapped(lines[start : last+1])); m != nil {
			return start, strings.Join(strings.Fields(m[1]), ""), true
		}
	}
	return 0, "", false
}

// planHintAt checks that line `at` ends the hint, and returns where the hint
// starts: the same line, or the one above where a narrow pane wrapped it.
func planHintAt(lines []string, at int) (int, bool) {
	if at < 0 {
		return 0, false
	}
	if strings.TrimSpace(lines[at]) == planHint {
		return at, true
	}
	if at >= 1 && joinWrapped(lines[at-1:at+1]) == planHint {
		return at - 1, true
	}
	return 0, false
}

// planRow reads a numbered row and the column its label starts at, counted in
// runes, which is the terminal's column for everything this dialog draws in
// front of a label. A row with nothing after its number is a feedback field
// holding only spaces, and its label column is the one a single space puts it
// at.
func planRow(line string) (n int, label string, focused bool, col int, ok bool) {
	m := rePlanRow.FindStringSubmatch(line)
	if m == nil {
		return 0, "", false, 0, false
	}
	col = utf8.RuneCountInString(m[1]) + len(m[2]) + 1
	if m[3] != "" {
		col += utf8.RuneCountInString(m[3])
	} else {
		col++
	}
	return atoi(m[2]), m[4], strings.ContainsAny(m[1], "❯>"), col, true
}

// planTop is the first line of the dialog's own region, found above the rule
// at `rule` that closes the plan panel.
//
// It walks up and stops at the first of: the ▔ edge the fullscreen renderer
// draws over the dialog; the title, the panel's first line, with the rule over
// it where the default renderer draws one; or the top of the capture. The
// heading and the ↑ scroll mark are the panel's top too when the title has
// scrolled away. With none of them on screen the region is the pinned block
// alone, from the rule down.
func planTop(lines []string, rule int) int {
	top := rule
	for j := rule - 1; j >= 0; j-- {
		line := lines[j]
		if rePlanEdge.MatchString(line) {
			return j
		}
		t, mark := cutScrollMark(strings.TrimSpace(line))
		switch {
		case t == planTitle:
			if j >= 1 && isRuleLine(lines[j-1]) {
				return j - 1
			}
			return j
		case t == planHeading || mark == "↑":
			top = j
		}
	}
	return top
}

// cutScrollMark takes the panel's ↑ or ↓ off the end of a line and says which
// it was. The panel draws them at its right edge, past the padding, on its
// first and last visible lines.
func cutScrollMark(t string) (string, string) {
	for _, mark := range []string{"↑", "↓"} {
		if rest, ok := strings.CutSuffix(t, mark); ok {
			return strings.TrimSpace(rest), mark
		}
	}
	return t, ""
}

// isRuleLine is a rule and not merely a blank, which reRule also matches.
func isRuleLine(line string) bool {
	return strings.TrimSpace(line) != "" && reRule.MatchString(line)
}

// skipBlankUp returns the nearest line at or above `i` with anything on it, or
// -1.
func skipBlankUp(lines []string, i int) int {
	for ; i >= 0 && strings.TrimSpace(lines[i]) == ""; i-- {
	}
	return i
}

// leadingSpace is the column a line's first visible character sits at.
func leadingSpace(line string) int {
	return utf8.RuneCountInString(line) - utf8.RuneCountInString(strings.TrimLeft(line, " \t"))
}
