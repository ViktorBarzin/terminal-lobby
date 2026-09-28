package sessionio

import (
	"regexp"
	"strings"
)

// Claude Code's tool permission prompt, read off the pane.
//
// WHY IT NEEDS A PARSER OF ITS OWN. In manual mode, and in auto mode for a read
// outside the working directories, Claude asks before it runs a tool, and the
// turn waits on a person as it does for a question or a plan. Until 2026-09-27
// the Text view could not see it: the transcript holds the tool call and
// nothing else, the select-widget parser wants "Enter to select … Esc to
// cancel", and the permission-request event kind has had no producer since the
// hook broker went (575d4f5). So the status line read "Working" with a live
// Stop for minutes over a session that was waiting (measured twice on
// 2026-09-27), and nothing offered a way to answer. Measured on CLI 2.1.283
// (captures under testdata/permission-*.txt), it is drawn like this, rules
// shortened:
//
//	──────────                              the rule over the prompt
//	 Bash command                           the title
//	 Tip: auto mode handles these prompts…  sometimes
//
//	   printf 'hi\n' > a.txt                what the tool will do
//	   Write "hi" to a.txt
//
//	 Do you want to proceed?                the question
//	 ❯ 1. Yes
//	   2. Yes, and always allow access to … from this project
//	   3. No
//
//	 Esc to cancel · Tab to amend           the footer, the pane's last line
//
// A Write puts the file's contents between two ╌ rules where the command is,
// and asks "Do you want to create b.txt?".
//
// THE BOTTOM IS THE ANCHOR, as it is for the plan approval (plandialog.go):
// the prompt takes the input box's place, so its footer is the last thing on
// the pane, and a copy of the prompt in the conversation has the input box
// and the status line under it. The parse walks up from the footer through the
// rows and the question, and the title and the lines over the question are
// read for the card to show, never to decide anything.
//
// A digit picks a row at once (measured: "1" ran the Bash command with no
// Enter), so the card answers with the row's number.
//
// "Tab to amend" on the No row opens a field in it (measured on 2.1.283 on
// 2026-09-27, testdata/permission-amend-*.txt): the row reads "No, and tell
// Claude what to do differently" while the field is empty and "No, <words>"
// once something is typed, the footer drops "Tab to amend", and words longer
// than the pane wrap under the row at the words' column, below the bottom
// row. permdrive.go drives that field for the card's "Type your own answer".

// DialogKindPermission is Dialog.Kind for the tool permission prompt.
const DialogKindPermission = "permission"

// maxPermissionDetail bounds the lines of what the tool will do that a
// reading carries. A Write shows the whole file, and the card is not where a
// file is read.
const maxPermissionDetail = 8

var (
	// "Esc to cancel · Tab to amend". Anchored at the start, so the select
	// widget's "Enter to select · ↑/↓ to navigate · Esc to cancel" is not it.
	rePermFooter = regexp.MustCompile(`^Esc to cancel(?:\s*·\s*Tab to amend)?$`)
	// The dotted rule a Write draws around the file's contents.
	reDottedRule = regexp.MustCompile(`^\s*╌+\s*$`)
)

// ParsePermissionDialog reads the tool permission prompt off the visible pane,
// or returns nil when the pane is not showing one.
//
// Strict for the reason the other parsers are: the card over a reading presses
// digits on somebody's live session. The footer has to be the pane's last
// line, the rows numbered from 1 with the cursor on one of them, and a
// question directly over them.
func ParsePermissionDialog(pane string) *Dialog {
	s, ok := parsePermission(strings.Split(pane, "\n"))
	if !ok {
		return nil
	}
	return s.dialog
}

// permScreen is the whole reading of a permission prompt: the dialog the wire
// carries, and what the decline driver (permdrive.go) needs besides.
type permScreen struct {
	dialog *Dialog
	// cursor is the number of the row the ❯ is on.
	cursor int
	// no is the number of the No row, 0 when the prompt draws none.
	no int
	// amended is true once Tab has turned the No row into a field: it reads
	// "No, and tell Claude what to do differently" or "No, <words>".
	amended bool
	// typed is what the field holds, "" while it shows its placeholder or
	// only spaces ("No,").
	typed string
}

// The No row's label at rest, and the placeholder its field shows once Tab has
// opened it, both as CLI 2.1.283 draws them.
const (
	permNoLabel       = "No"
	permNoPlaceholder = "No, and tell Claude what to do differently"
)

// isPermPlaceholder reports whether an open No row shows its placeholder, the
// empty field. A pane too narrow for it cuts it short with an ellipsis rather
// than wrapping it: at 47 columns, a phone's, it reads "No, and tell Claude
// what to do different…" (CLI 2.1.283, 2026-09-28). Typed words wrap and are
// never cut, so a label that ends in the ellipsis after a leading part of the
// placeholder is the placeholder.
func isPermPlaceholder(label string) bool {
	if label == permNoPlaceholder {
		return true
	}
	head, cut := strings.CutSuffix(label, "…")
	return cut && len(head) > len(permNoLabel+",") && strings.HasPrefix(permNoPlaceholder, head)
}

// minPermLabelCol is the shallowest indent a line wrapped from the bottom row
// can have: the row's label starts after " ❯ 1. ", column 6.
const minPermLabelCol = 4

// parsePermission is ParsePermissionDialog's work, returning the whole
// reading.
func parsePermission(lines []string) (permScreen, bool) {
	s, ok := parsePermissionRows(lines)
	if !ok {
		return permScreen{}, false
	}
	for _, o := range s.dialog.Options {
		switch {
		case o.Label == permNoLabel:
			s.no, s.amended, s.typed = o.Number, false, ""
		case o.Label == permNoLabel+",", strings.HasPrefix(o.Label, permNoLabel+", "):
			// "No," alone is a field holding only spaces: the capture keeps
			// no trailing ones.
			s.no, s.amended = o.Number, true
			s.typed = strings.TrimSpace(strings.TrimPrefix(o.Label, permNoLabel+","))
			if isPermPlaceholder(o.Label) {
				s.typed = ""
			}
		}
	}
	return s, true
}

// parsePermissionRows reads the prompt and where its cursor is.
func parsePermissionRows(lines []string) (permScreen, bool) {
	last := skipBlankUp(lines, len(lines)-1)
	if last < 0 {
		return permScreen{}, false
	}
	foot := -1
	for n := 1; n <= footerWrapLines && last-n+1 >= 0; n++ {
		if rePermFooter.MatchString(joinWrapped(lines[last-n+1 : last+1])) {
			foot = last - n + 1
			break
		}
	}
	if foot < 0 {
		return permScreen{}, false
	}

	// The rows, bottom-up, each with any lines its label wrapped onto. The
	// bottom row fixes the label column the others and the wraps share.
	var rows []planRowAt
	var cont []string
	labelCol := -1
	i := skipBlankUp(lines, foot-1)
	for ; i >= 0; i-- {
		line := lines[i]
		if strings.TrimSpace(line) == "" {
			break
		}
		if n, label, focused, col, ok := planRow(line); ok && (labelCol < 0 || col == labelCol) {
			if labelCol < 0 {
				// Lines already collected sit under the bottom row: its
				// words wrapped, which an amended No row's do. They have to
				// start at its label column or deeper to be part of it.
				for _, c := range cont {
					if leadingSpace(c) < col {
						return permScreen{}, false
					}
				}
			}
			labelCol = col
			parts := []string{label}
			for j := len(cont) - 1; j >= 0; j-- {
				parts = append(parts, strings.TrimSpace(cont[j]))
			}
			rows = append(rows, planRowAt{n: n, parts: parts, focused: focused})
			cont = nil
			continue
		}
		if labelCol >= 0 && leadingSpace(line) >= labelCol {
			cont = append(cont, strings.TrimSpace(line))
			continue
		}
		if labelCol < 0 && leadingSpace(line) >= minPermLabelCol {
			// Kept whole until the row over it fixes the label column.
			cont = append(cont, line)
			continue
		}
		break
	}
	if len(cont) > 0 || len(rows) < 2 {
		return permScreen{}, false
	}
	d := &Dialog{Kind: DialogKindPermission}
	s := permScreen{dialog: d}
	focused := 0
	for k := len(rows) - 1; k >= 0; k-- {
		r := rows[k]
		if r.n != len(d.Options)+1 {
			return permScreen{}, false
		}
		if r.focused {
			focused++
			s.cursor = r.n
		}
		d.Options = append(d.Options, PlanOption{Number: r.n, Label: joinWrapped(r.parts)})
	}
	if focused != 1 {
		return permScreen{}, false
	}

	// The question, wrapped over as many lines as it needs.
	i = skipBlankUp(lines, i)
	var q []string
	for ; i >= 0 && len(q) < maxQuestionLines; i-- {
		if strings.TrimSpace(lines[i]) == "" || isRuleLine(lines[i]) || reDottedRule.MatchString(lines[i]) {
			break
		}
		q = append([]string{lines[i]}, q...)
	}
	d.Prompt = joinWrapped(q)
	if !strings.HasSuffix(d.Prompt, "?") {
		return permScreen{}, false
	}

	// What is over the question, up to the rule that opens the prompt: the
	// title, then what the tool will do. Without the rule on screen (a prompt
	// taller than the pane) there is no telling where the prompt starts, so
	// none of it is read.
	var head []string
	for j := 0; i >= 0 && j < maxRegionLines; i, j = i-1, j+1 {
		line := lines[i]
		if isRuleLine(line) {
			d.Title, d.Detail = permissionHead(head)
			return s, true
		}
		// Blank lines are kept, as "", because they end the tip's paragraph.
		if !reDottedRule.MatchString(line) {
			head = append([]string{strings.TrimSpace(line)}, head...)
		}
	}
	return s, true
}

// permissionHead splits the lines between the rule and the question into the
// title and what the tool will do, leaving out the CLI's own tip. The tip runs
// to the next blank line, since a narrow pane wraps it.
func permissionHead(head []string) (string, []string) {
	title := ""
	var detail []string
	tip := false
	for _, l := range head {
		switch {
		case l == "":
			tip = false
		case title == "":
			title = l
		case tip || strings.HasPrefix(l, "Tip:"):
			tip = true
		case len(detail) < maxPermissionDetail:
			detail = append(detail, l)
		}
	}
	return title, detail
}
