package sessionio

import (
	"regexp"
	"strings"
)

// A blocking AskUserQuestion read off the pane.
//
// WHY THE PANE AT ALL. The transcript records the call losslessly, and that is
// what the Text view renders — but Claude Code does not always write the record
// while the dialog is up. Measured 2026-08-28 across five consecutive calls in
// one session: two landed within 3-8 seconds and two were not written until the
// question was ANSWERED, 112 seconds later in one case. For as long as the
// record is missing, the Text view has nothing to show while the terminal sits
// on a dialog — the reader sees "Working…" and the session sits blocked.
//
// So the pane is a FALLBACK, never the source of record: whenever the transcript
// holds the call, the client prefers it (options, descriptions and multi-select
// flags come back exactly as the tool was called). This only fills the window
// where the alternative is showing nothing at all.
type Dialog struct {
	// Questions the pane can actually see: the one on screen. Shaped like the
	// tool's own input so a client renders it with no special case.
	Questions []DialogQuestion `json:"questions"`
	// Headers of every question in the call, from the dialog's tab bar.
	Headers []string `json:"headers,omitempty"`
	// Count is how many questions the call carries.
	Count int `json:"count"`
	// Partial says the pane cannot show the whole call — a multi-question
	// dialog shows one question at a time, so the call is answered one question
	// at a time, each drawn only once the one before it is answered.
	Partial bool `json:"partial,omitempty"`
	// Answered is how many of the call's questions the tab bar marks done: it
	// draws `☒` for a question already answered and `☐` for one still open.
	//
	// This is the walk's only honest progress signal. A client that counted its
	// own answers would drift the moment anything else moved the dialog on — a
	// keystroke in the terminal, an Esc, a re-ask — whereas this is read from
	// what the terminal is showing at the moment of the read.
	Answered int `json:"answered,omitempty"`
}

// DialogQuestion mirrors one question of an AskUserQuestion call.
//
// The last three fields are the pane's alone: the tool's recorded input never
// carries them, so a question read out of the transcript leaves them empty.
type DialogQuestion struct {
	Question    string         `json:"question"`
	Header      string         `json:"header,omitempty"`
	MultiSelect bool           `json:"multiSelect,omitempty"`
	Options     []DialogOption `json:"options"`
	// Commit is the label of the unnumbered row a multi-select draws under
	// its free-text row, "Next" or "Submit", and empty when none is drawn.
	//
	// Enter on that row is what leaves a multi-select question: on every
	// numbered row Enter is a toggle. Measured on CLI 2.1.280 on 2026-09-23,
	// it reads "Next" on every question but the last and "Submit" on the
	// last, so a one-question call says "Submit". The card labels its commit
	// button with this rather than a word of its own, because the pane's word
	// is the one that says whether the next screen is another question or the
	// review.
	Commit string `json:"commit,omitempty"`
	// Typed is the text in a multi-select's free-text row, empty while the
	// row reads "Type something".
	//
	// That row is an inline field on a multi-select: keys go straight into it,
	// typing ticks it, and the row then draws the text where the label was
	// ("4. [✔] Mango", measured 2026-09-23). Free text is one more pick on
	// such a question, so the card needs to see what the row holds in order
	// to show it, and the server needs to in order to replace or clear it.
	Typed string `json:"typed,omitempty"`
	// TypedChecked is the free-text row's box. It is separate from Typed
	// because the two move apart: Enter toggles the box and keeps the text,
	// and Enter on the empty row ticks it with nothing typed, a pick the CLI
	// drops at commit.
	TypedChecked bool `json:"typedChecked,omitempty"`
}

// DialogOption is one answer the question offers.
type DialogOption struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
	// Checked is the multi-select box drawn filled — `[✔]` rather than `[ ]`.
	// Always false on a single-select question, which draws no boxes.
	//
	// It is what a client needs to ADD a pick rather than replace one. Space
	// is a toggle, so answering a multi-select is a diff against what the CLI
	// is already holding, and the desired final state a request carries
	// (AnswerRequest.Choices) can only be worked out by a card that can see
	// the current one. Without it a second tap could only name the label it
	// tapped, which on a question holding another pick clears that pick.
	//
	// The rule is answerRows': anything between the brackets but blank is a
	// filled box. Matching on "✔" instead would make a restyle to "x" read as
	// "nothing picked" here while the planner still read it as picked, and the
	// two disagreeing is exactly how an answer gets deleted.
	Checked bool `json:"checked,omitempty"`
}

// The two options the CLI adds to every AskUserQuestion, whatever the caller
// asked: free text, and deferring the question to chat. Requiring one of them is
// what separates a question Claude asked from a menu the operator opened —
// /model, /effort and the resume picker all draw with the same select widget and
// the same footer, and none of them carries these.
const (
	optionOther = "Type something"
	optionChat  = "Chat about this"
)

var (
	// "❯ 1. Label" / "  2. [ ] Label" / "  3. [✔] Label"
	reOption = regexp.MustCompile(`^\s*[❯>]?\s*(\d+)\.\s+(?:\[([^\]]*)\]\s+)?(.*\S)\s*$`)
	// The footer the select widget draws under every dialog.
	reFooter = regexp.MustCompile(`Enter to select .* Esc to cancel`)
	// The tab bar of a multi-question call: "←  ☐ Fruit  ☒ Drink  ✔ Submit  →"
	reTabBar = regexp.MustCompile(`^\s*←.*[☐☒].*→\s*$`)
	// The header line of a single-question call: " ☐ Colour"
	reHeader = regexp.MustCompile(`^\s*[☐☒]\s*(\S.*?)\s*$`)
	// The rule tmux draws for the composer's top border, which the dialog
	// overlaps.
	reRule = regexp.MustCompile(`^[\s─━-]+$`)
	// The box-drawing the dialog paints down the left of every line it owns.
	// Stripped before the question is read, for the reason answer.logic.ts gives
	// on the other side of the wire: leaving it in turns "Where should the │
	// parse live?" into fragments that match nothing — and a line carrying only
	// the border reads as a line of text rather than as the blank it looks like.
	reBorder = regexp.MustCompile(`[│┃|┆┊╎╏║]`)
	// An unnumbered row with the cursor on it. The one the CLI draws is the
	// commit row under a multi-select's free-text row: "❯    Submit", the
	// cursor and then the indent the label column sits at. Three spaces or
	// more is what separates it from "❯ Call the tool…", the composer's echo
	// of a prompt, which has one.
	reCursorRow = regexp.MustCompile(`^[❯>] {3,}\S`)
	// A free-text row whose field holds only whitespace, "4. [✔]". Space on a
	// multi-select's free-text row types a literal space and ticks the box,
	// and the capture trims the space, so what is left is a box with nothing
	// after it. reOption then reads the box as the label, because it wants
	// whitespace between the box and a label.
	reBoxOnly = regexp.MustCompile(`^\[([^\]]*)\]$`)
)

// How many wrapped lines of question to accept. A question is prose written by
// a model, so it has no fixed length; this is a guard against walking the whole
// pane into the question when the dialog's shape is not what we think, not a
// statement about how long a question can be.
const maxQuestionLines = 12

// stripDialogBorder removes the dialog's left-hand box-drawing from one line.
func stripDialogBorder(line string) string {
	return reBorder.ReplaceAllString(line, " ")
}

// blankDialogLine reports whether a line carries nothing but the dialog's own
// border and whitespace — which is what separates the header from the question
// and the question from the options.
func blankDialogLine(line string) bool {
	return strings.TrimSpace(stripDialogBorder(line)) == ""
}

// footerAt reports the line the select widget's footer starts on, or -1 when
// the pane is not showing one.
//
// The footer is a single logical line and the terminal wraps it. It runs to 60
// characters, so any pane narrower than that puts "Esc to cancel" on the line
// below — a phone, or a narrow split. Matching one line at a time missed those
// entirely: ParseDialog returned nil, no answer card docked, and the Text view
// drew "Working…" with a running clock over a session that was stopped waiting
// for an answer. Measured 2026-09-04 on a live 58x16 pane.
//
// Three lines is the whole range that matters. 60 characters wrap into at most
// three at any width somebody could actually read a dialog in, and joining more
// only widens the chance of reading two unrelated lines as a footer.
func footerAt(lines []string) int {
	const wrap = 3
	for i := len(lines) - 1; i >= 0; i-- {
		for n := 1; n <= wrap && i+n <= len(lines); n++ {
			if reFooter.MatchString(joinWrapped(lines[i : i+n])) {
				return i
			}
		}
	}
	return -1
}

// joinWrapped puts wrapped pane lines back together. The terminal breaks on a
// word boundary and tmux strips the space that break consumed, so it goes back.
func joinWrapped(lines []string) string {
	parts := make([]string, 0, len(lines))
	for _, l := range lines {
		parts = append(parts, strings.TrimSpace(l))
	}
	return strings.Join(parts, " ")
}

// ParseDialog reads a blocking AskUserQuestion off the visible pane, or returns
// nil when the pane is not showing one.
//
// It is deliberately strict: a false positive docks an answer card over
// something that is not a question, and the card types keys. Everything it needs
// has to be on screen — the footer, a numbered option list, and one of the two
// options the CLI adds to every AskUserQuestion.
func ParseDialog(pane string) *Dialog {
	lines := strings.Split(pane, "\n")
	if d := reviewScreen(lines); d != nil {
		return d
	}

	// Work from the footer up: it is the bottom of the dialog, and anything
	// below it belongs to the composer.
	end := footerAt(lines)
	if end < 0 {
		return nil
	}

	type parsed struct {
		listRow
		n    int
		desc string
	}
	var opts []parsed
	first := end
	for i := end - 1; i >= 0; i-- {
		line := lines[i]
		if strings.TrimSpace(line) == "" || reRule.MatchString(line) {
			continue
		}
		m := reOption.FindStringSubmatch(line)
		if m == nil {
			// Not an option: either a description belonging to the option
			// above it, or the top of the dialog. Descriptions are attached in
			// the second pass; stop as soon as the numbering has started and a
			// non-option, non-description line appears.
			if len(opts) > 0 && numbered(lines, i) {
				continue
			}
			if len(opts) > 0 {
				first = i + 1
				break
			}
			continue
		}
		opts = append(opts, parsed{listRow: listRow{line: i, box: m[2], label: m[3]}, n: atoi(m[1])})
		first = i
	}
	if len(opts) < 2 {
		return nil
	}
	// Bottom-up collection reversed the list.
	for l, r := 0, len(opts)-1; l < r; l, r = l+1, r-1 {
		opts[l], opts[r] = opts[r], opts[l]
	}
	// The numbering must be the widget's own: 1..n, in order.
	for i, o := range opts {
		if o.n != i+1 {
			return nil
		}
	}

	// A description is the line under an option that is not itself an option.
	for i := range opts {
		next := end
		if i+1 < len(opts) {
			next = opts[i+1].line
		}
		var desc []string
		for j := opts[i].line + 1; j < next; j++ {
			t := strings.TrimSpace(lines[j])
			if t == "" || reRule.MatchString(lines[j]) {
				continue
			}
			desc = append(desc, t)
		}
		opts[i].desc = strings.Join(desc, " ")
	}

	rows := make([]listRow, len(opts))
	for i, o := range opts {
		rows[i] = o.listRow
	}
	shape := shapeList(lines, rows, end)

	// The CLI's own options identify the widget, and are then dropped: the card
	// offers its own free-text and chat rows, so carrying these would double
	// them. The free-text row is dropped by POSITION as well as by label,
	// because on a multi-select typing replaces its label (shapeList).
	var kept []DialogOption
	sawChat, sawOther, multi := false, false, false
	for i, o := range opts {
		label := strings.TrimRight(o.label, ".")
		switch {
		case i == shape.chat || label == optionChat:
			sawChat = true
			continue
		case i == shape.free || label == optionOther:
			sawOther = true
			continue
		}
		if o.box != "" {
			multi = true
		}
		// The box being PRESENT is what makes the list multi-select; the box
		// being non-blank is what makes this row a pick. Two different reads
		// of the same capture group, and conflating them would report every
		// row of a fresh multi-select as already chosen.
		kept = append(kept, DialogOption{
			Label:       o.label,
			Description: o.desc,
			Checked:     strings.TrimSpace(o.box) != "",
		})
	}
	if !sawChat && !sawOther {
		return nil // a menu, not a question
	}
	if len(kept) == 0 {
		return nil
	}
	// "Next" is the multi-select widget's own advance row, not an answer. The
	// row as 2.1.250 and 2.1.280 draw it, unnumbered under the free-text row,
	// is read by shapeList and never reaches here; these two catch it drawn
	// any other way.
	if n := len(kept); n > 0 && kept[n-1].Label == "Next" {
		kept = kept[:n-1]
	}
	for i := range kept {
		if kept[i].Description == "Next" {
			kept[i].Description = ""
		}
	}

	d := &Dialog{Count: 1}
	q := DialogQuestion{MultiSelect: multi, Options: kept}
	if multi {
		q.Commit, q.Typed, q.TypedChecked = shape.commit, shape.typed, shape.checked
	}

	// Above the options: the question, a blank, and above that either a tab bar
	// (several questions) or the header of the only one.
	//
	// The question is the CONTIGUOUS RUN of lines above the options, not one
	// line. The CLI wraps a question over as many lines as it needs and draws its
	// border glyph down the left of each, and taking a single line handed the
	// card the last visual line — a fragment starting mid-sentence and ending on
	// a bracket opened by a line that never arrived — or, when the border ran
	// lower than the text, the glyph on its own and nothing else. The card cannot
	// tell a fragment from a question, so it offered a live Send on something the
	// reader could only partly read.
	i := first - 1
	// The blank the CLI leaves between the question and the option list.
	for ; i >= 0 && blankDialogLine(lines[i]); i-- {
	}
	var qLines []string
	for ; i >= 0 && len(qLines) < maxQuestionLines; i-- {
		// A blank ABOVE the question is where it starts — the header is beyond
		// it, and swallowing that would empty the chip and lengthen the question
		// with a word that is not part of it.
		if blankDialogLine(lines[i]) || reRule.MatchString(lines[i]) ||
			reTabBar.MatchString(lines[i]) || reHeader.MatchString(lines[i]) {
			break
		}
		qLines = append(qLines, strings.TrimSpace(stripDialogBorder(lines[i])))
	}
	for l, r := 0, len(qLines)-1; l < r; l, r = l+1, r-1 {
		qLines[l], qLines[r] = qLines[r], qLines[l]
	}
	q.Question = strings.Join(qLines, " ")

	// Past the blank: the tab bar, or this question's own header.
	for ; i >= 0 && i >= first-maxQuestionLines-4; i-- {
		line := lines[i]
		if blankDialogLine(line) || reRule.MatchString(line) {
			continue
		}
		if reTabBar.MatchString(line) {
			d.Headers = tabHeaders(line)
			d.Count = len(d.Headers)
			d.Answered = tabAnswered(line)
			d.Partial = d.Count > 1
			break
		}
		if m := reHeader.FindStringSubmatch(stripDialogBorder(line)); m != nil {
			q.Header = m[1]
		}
		break
	}
	if q.Question == "" {
		return nil
	}
	// The review screen at the end of a call is not a question.
	if strings.HasPrefix(q.Question, "Ready to submit") || strings.HasPrefix(q.Question, "Review your answers") {
		return nil
	}
	if q.Header == "" && len(d.Headers) > 0 {
		// Which tab is on screen is drawn in colour, which a text capture does
		// not carry; the headers are still worth showing.
		q.Header = ""
	}
	d.Questions = []DialogQuestion{q}
	return d
}

// reviewScreen recognises the last step of a call: every question committed,
// waiting for a Submit. A one-question call reaches it too on CLI 2.1.280
// (measured 2026-09-23), where a multi-select's "Submit" row leads here.
//
// It is not a question — mirroring its "Submit answers / Cancel" as one would
// offer an answer nobody asked for — but the session IS blocked on it, and
// reporting nothing would leave the Text view on "Working…" while the terminal
// waits for a keystroke. So it comes back partial, with the headers, and the
// card says where to finish it.
func reviewScreen(lines []string) *Dialog {
	asks, tabs := false, ""
	for _, line := range lines {
		t := strings.TrimSpace(line)
		if t == "Ready to submit your answers?" || t == "Review your answers" {
			asks = true
		}
		if reTabBar.MatchString(line) {
			tabs = line
		}
	}
	if !asks || tabs == "" {
		return nil
	}
	headers := tabHeaders(tabs)
	return &Dialog{
		Questions: []DialogQuestion{{Question: "Ready to submit your answers?"}},
		Headers:   headers,
		Count:     len(headers),
		Answered:  tabAnswered(tabs),
		Partial:   true,
	}
}

// numbered reports whether the line is a description belonging to an option —
// i.e. it sits inside the option list rather than above it.
//
// An unnumbered row with the cursor on it is inside the list too. The CLI draws
// the cursor over a multi-select's commit row as "❯    Submit", which does not
// start with the two spaces a description does, and until 2026-09-23 this read
// it as the top of the list: the walk up from the footer kept the chat row
// alone, one row is not a list, and every pane parked on the commit row came
// back unreadable. That is where the cursor sits after a commit that did not
// take.
func numbered(lines []string, i int) bool {
	if i <= 0 || reTabBar.MatchString(lines[i]) {
		return false
	}
	return strings.HasPrefix(lines[i], "  ") || reCursorRow.MatchString(lines[i])
}

// listRow is one numbered row of an option list as the widget drew it. It is
// the part ParseDialog and answerRows share, so the two cannot disagree about
// which row is the CLI's own.
type listRow struct {
	line  int    // index into the lines the row was read from
	box   string // between the brackets, "" when the row draws no box
	label string // the rest of the row
}

// listShape says where the CLI's own rows sit in an option list, and what the
// free-text and commit rows are showing.
type listShape struct {
	chat  int  // index of "Chat about this" in the rows, -1 when absent
	free  int  // index of the free-text row, -1 when absent
	multi bool // the question's own rows draw boxes

	// The free-text row on a multi-select, where it is an inline field.
	typed     string // what it holds, "" while it reads "Type something"
	holdsText bool   // it holds text, which may be whitespace the capture trimmed
	checked   bool   // its box

	// The commit row under the free-text row, on a multi-select only.
	commitLine    int    // index into the lines, -1 when none is drawn
	commit        string // its label, "Next" or "Submit"
	commitFocused bool   // the cursor is on it
}

// shapeList finds the CLI's own rows in an option list. `end` bounds the last
// row's lines: the footer, or the end of what was read.
//
// THE FREE-TEXT ROW IS FOUND BY POSITION. On a multi-select it is an inline
// field, and typing replaces its label: measured on CLI 2.1.280 on 2026-09-23,
// "4. [ ] Type something" becomes "4. [✔] Mango" as the reader types. Matching
// on the label handed the card "Mango" as an option the caller never offered,
// with the commit row under it as its description. What does not move is where
// the row is: the last numbered row above the separator the CLI draws over
// "Chat about this". The label is the fallback for a list drawn without that
// separator, which nothing captured here does.
//
// THE COMMIT ROW is the last line under the free-text row before that
// separator. It carries no digit, so reOption never sees it. Any lines between
// the two are the typed text running on, which no capture shows yet; they are
// joined back onto the text the way a wrapped description is.
func shapeList(lines []string, rows []listRow, end int) listShape {
	s := listShape{chat: -1, free: -1, commitLine: -1}
	for i, r := range rows {
		if strings.TrimRight(strings.TrimSpace(r.label), ".") == optionChat {
			s.chat = i
		}
	}
	s.free = freeTextRow(lines, rows, s.chat)
	for i, r := range rows {
		if i != s.chat && i != s.free && r.box != "" {
			s.multi = true
		}
	}
	if s.free < 0 || !s.multi {
		return s
	}

	next := end
	if s.free+1 < len(rows) {
		next = rows[s.free+1].line
	}
	var below []int
	for i := rows[s.free].line + 1; i < next && i < len(lines); i++ {
		if strings.TrimSpace(stripDialogBorder(lines[i])) == "" || reRule.MatchString(lines[i]) {
			continue
		}
		below = append(below, i)
	}
	if n := len(below); n > 0 {
		s.commitLine = below[n-1]
		s.commit, s.commitFocused = cutCursor(stripDialogBorder(lines[s.commitLine]))
		below = below[:n-1]
	}

	fr := rows[s.free]
	s.checked = strings.TrimSpace(fr.box) != ""
	label := strings.TrimSpace(fr.label)
	switch m := reBoxOnly.FindStringSubmatch(label); {
	case fr.box == "" && m != nil:
		// "4. [✔]": the field holds whitespace the capture trimmed. It is
		// still text, and a Backspace is what takes it out; reading it as the
		// placeholder would leave it there.
		s.checked = strings.TrimSpace(m[1]) != ""
		s.holdsText = true
	case placeholderLabel(label):
	default:
		parts := []string{label}
		for _, i := range below {
			parts = append(parts, strings.TrimSpace(stripDialogBorder(lines[i])))
		}
		s.typed = strings.Join(parts, " ")
		s.holdsText = true
	}
	return s
}

// cutCursor takes the cursor mark off the front of a row and reports whether
// it was there, returning the rest trimmed.
//
// THE MARK COUNTS ONLY IN FRONT. The widget draws it before the row the cursor
// is on, "❯ 3. [✔] Plum" and "❯    Submit", and the same glyph further along is
// the row's own text: an option label, or the words a reader typed into the
// free-text row. Sessions in this repository talk about the glyph, so neither
// is far-fetched. Until 2026-09-24 a numbered row counted as the cursor's
// whenever the glyph appeared anywhere in it. The first such row won, so a
// click on "Use ❯ only" sent its Space to the row the cursor really held, and
// words reading "a❯b" drew an Enter meant for their row onto the commit row
// under it, which left the question (both reproduced against the stand-in in
// the review that day).
//
// ">" is the fallback reOption also accepts in that position.
func cutCursor(row string) (string, bool) {
	t := strings.TrimSpace(row)
	for _, mark := range []string{"❯", ">"} {
		if rest, ok := strings.CutPrefix(t, mark); ok {
			return strings.TrimSpace(rest), true
		}
	}
	return t, false
}

// freeTextRow is the index of the CLI's free-text row among rows, or -1.
func freeTextRow(lines []string, rows []listRow, chat int) int {
	if chat > 0 {
		prev := rows[chat-1]
		if placeholderLabel(prev.label) || ruleBetween(lines, prev.line, rows[chat].line) {
			return chat - 1
		}
	}
	for i, r := range rows {
		if i != chat && placeholderLabel(r.label) {
			return i
		}
	}
	return -1
}

// placeholderLabel reports whether a row reads the free-text row's own label:
// "Type something." on a single-select, "Type something" on a multi-select.
func placeholderLabel(label string) bool {
	return strings.TrimRight(strings.TrimSpace(label), ".") == optionOther
}

// ruleBetween reports whether a separator is drawn between two lines. A
// whitespace-only line matches reRule as well, and is not one.
func ruleBetween(lines []string, from, to int) bool {
	for i := from + 1; i < to && i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) != "" && reRule.MatchString(lines[i]) {
			return true
		}
	}
	return false
}

// tabAnswered counts the questions a tab bar marks answered.
//
// `☒` is answered and `☐` is still open, and counting the glyph rather than
// reading the header text means a header that happens to contain a box
// character cannot shift the tally.
func tabAnswered(line string) int {
	return strings.Count(line, "☒")
}

// tabHeaders pulls the question headers out of a multi-question tab bar.
func tabHeaders(line string) []string {
	var out []string
	for _, part := range strings.Split(line, "☐") {
		out = append(out, splitTab(part)...)
	}
	var headers []string
	for _, h := range out {
		h = strings.TrimSpace(h)
		h = strings.TrimPrefix(h, "←")
		h = strings.TrimSuffix(h, "→")
		h = strings.TrimSpace(h)
		if h == "" || h == "✔ Submit" || h == "Submit" {
			continue
		}
		headers = append(headers, h)
	}
	return headers
}

// splitTab splits a tab-bar fragment on the answered marker, so "☒ Drink  ✔
// Submit" yields its parts.
func splitTab(part string) []string {
	var out []string
	for _, p := range strings.Split(part, "☒") {
		for _, q := range strings.Split(p, "✔") {
			out = append(out, q)
		}
	}
	return out
}

func atoi(s string) int {
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return -1
		}
		n = n*10 + int(r-'0')
	}
	return n
}
