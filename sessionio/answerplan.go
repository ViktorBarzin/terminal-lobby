package sessionio

import (
	"errors"
	"strconv"
	"strings"
	"unicode"
)

// The pure half of answering an AskUserQuestion: which question the pane is
// drawing, which keys answer it, whether this is the review screen, and how
// far back a chip is. Nothing here touches tmux, so all of it runs against the
// captures under testdata/.
//
// WHY IT IS PURE AND WHY IT LIVES HERE. This is the logic that used to run in
// the browser (frontend-v2 answer.logic.ts), where it planned a whole walk
// before typing anything and predicted what each next screen would say. Over
// 10 days of field data four-question answers failed 4 times in 5, every
// failure a `desync`: the prediction missed
// (docs/plans/2026-09-10-text-mode-answers-dialogs-design.md). Moving it next
// to the parser means the keystroke, the capture and the check are one local
// sequence, and the only thing ever compared is a reading against a reading.
//
// EVERY COMPARISON IS SCOPED TO THE DIALOG REGION. The shipped landed()
// searched the whole capture, conversation scrollback included, so a check
// could pass on text that was on screen before anything was typed — a session
// that has already answered three questions carries all three in its history.
// answerRegion is that fix, and every function below takes the region rather
// than the pane.

// maxRegionLines bounds a region that has no option list to derive its shape
// from: a screen carrying the footer and a top edge but nothing numbered
// between them, which ParseDialog refuses and only the marker fingerprint ever
// reads. The widest real capture here is dialog-narrow-footer.txt at 58
// columns, where wrapping puts 27 lines between the tab bar and the footer.
//
// It is NOT how an answerable dialog is bounded. It used to be: with no tab bar
// and no header the region was "the 48 lines above the footer", which on a
// short pane is the whole capture, conversation included — the whole-capture
// comparison this file exists to remove, reintroduced by the fallback. The
// dialog's own shape says where it starts, and dialogTop reads that instead.
const maxRegionLines = 48

// footerWrapLines is how many lines the footer may occupy. It mirrors the bound
// inside footerAt (dialog.go), which is a local constant there and cannot be
// referenced; the two have to move together. 60 characters of footer wrap into
// at most three lines at any width somebody could read a dialog in.
const footerWrapLines = 3

// minPrefixMatch is how much of a question has to be on screen before a prefix
// is treated as evidence that the question is the one being drawn. A question
// longer than the dialog is wide is truncated with an ellipsis, so the exact
// string is not there to find; twelve characters is short enough for a real
// truncation and long enough that "Push, then?" cannot match a question about
// package delivery.
const minPrefixMatch = 12

// maxPrefixMatch is how much of it to compare. Beyond 40 characters a
// truncation on a narrow pane starts failing the comparison it exists to
// rescue.
const maxPrefixMatch = 40

// answerRegion narrows a capture to the lines the dialog owns: from its top
// edge — the tab bar of a multi-question call, or the ☐ header of a
// single-question one — down to the footer the select widget draws.
//
// It carries the WHOLE footer, both lines where a narrow pane has wrapped it,
// which is what makes the region SELF-CONTAINED: ParseDialog reads it on its
// own, with no second attempt over the whole capture. read() had such an
// attempt until 2026-09-11 and it undid the scoping — on the 58-column capture
// the footer wraps, the region ended on "Esc to", the parse failed, and the
// fallback then found reviewScreen() in the conversation and reported "Ready
// to submit your answers?" with no options while the pane drew a question.
//
// A capture with a top edge and NO footer still has a region: the CLI draws a
// footer under every dialog, so its absence is a restyle, and the marker
// fingerprint (dialogmarkers.go) exists to report exactly that — it needs the
// lines the dialog owns in order to say that everything except the footer is
// intact. The answer path does not drive such a screen; read() requires the
// footer before it calls anything a dialog.
func answerRegion(pane string) []string {
	lines := strings.Split(pane, "\n")
	end := footerAt(lines)
	if end < 0 {
		top := anchorTop(lines, len(lines)-1)
		if top < 0 {
			return nil
		}
		return lines[top:]
	}
	top := dialogTop(lines, end)
	if top < 0 {
		return nil
	}
	return lines[top : end+footerSpan(lines, end)]
}

// footerSpan is how many lines the footer at `at` occupies: one on a wide pane,
// two or three where the terminal has wrapped it.
func footerSpan(lines []string, at int) int {
	for n := 1; n <= footerWrapLines && at+n <= len(lines); n++ {
		if reFooter.MatchString(joinWrapped(lines[at : at+n])) {
			return n
		}
	}
	return 1
}

// dialogTop is the line the dialog starts on, derived from its own shape:
// the option list, the question wrapped above it, and the tab bar or header
// immediately above that.
//
// WHY NOT JUST THE TOP LANDMARK. A tab bar or a ☐ header is the top edge when
// one is on screen, and searching for it alone was the first cut. Two panes
// break it. On a phone-sized pane a long question and its option list push the
// tab bar off the top, and "the 48 lines above the footer" then reaches up into
// the conversation, which is where the free-text read-back and the review check
// both start matching on scrollback. And a session that QUOTES a tab bar — this
// feature's own design doc does — puts a landmark on the pane that belongs to
// no dialog.
//
// The option list is a better anchor because the dialog cannot exist without
// it, and ParseDialog bounds the question above it exactly this way: skip the
// blank the CLI leaves under it, then take the contiguous run of lines, at most
// maxQuestionLines of them. Anything above that run is the conversation.
func dialogTop(lines []string, end int) int {
	first := optionListTop(lines, end)
	if first < 0 {
		// No numbered row between the top edge and the footer. ParseDialog
		// refuses such a screen, so nothing is ever answered on it; the marker
		// fingerprint still wants the lines the dialog would own, so the old
		// landmark search stands in, bounded.
		return anchorTop(lines, end)
	}
	top := first
	i := first - 1
	for ; i >= 0 && blankDialogLine(lines[i]); i-- {
	}
	for n := 0; i >= 0 && n < maxQuestionLines; i, n = i-1, n+1 {
		if blankDialogLine(lines[i]) || reRule.MatchString(lines[i]) || dialogAnchor(lines[i]) {
			break
		}
		top = i
	}
	// The tab bar or header sits above the question, past the blank the CLI
	// leaves between them. Only an ADJACENT one counts: a landmark further up,
	// with conversation in between, belongs to something else — a session
	// discussing this feature quotes a tab bar like any other line of text.
	//
	// The review screen is why this is a loop. It draws two title lines with a
	// blank between them on CLI 2.1.267 ("Review your answers" over "Ready to
	// submit your answers?"), which the question run above stops at, and
	// leaving the tab bar outside the region turns reviewOnScreen false and
	// refuses Submit on the one screen Submit is for.
	for i >= 0 {
		for ; i >= 0 && (blankDialogLine(lines[i]) || reRule.MatchString(lines[i])); i-- {
		}
		if i < 0 {
			break
		}
		if t := strings.TrimSpace(stripDialogBorder(lines[i])); t == reviewTitle || t == readyPrompt {
			top, i = i, i-1
			continue
		}
		if dialogAnchor(lines[i]) {
			top = i
		}
		break
	}
	return top
}

// dialogAnchor reports whether a line is a dialog's top edge: the tab bar of a
// multi-question call, or the ☐ header of a single-question one.
func dialogAnchor(line string) bool {
	return reTabBar.MatchString(line) || reHeader.MatchString(stripDialogBorder(line))
}

// anchorTop is the last top edge at or above the footer, bounded. Used only for
// a screen with no option list under it.
func anchorTop(lines []string, end int) int {
	top := -1
	for i := 0; i <= end && i < len(lines); i++ {
		if dialogAnchor(lines[i]) {
			top = i
		}
	}
	if top < 0 {
		return -1
	}
	if top < end-maxRegionLines {
		return end - maxRegionLines
	}
	return top
}

// optionListTop is the first numbered row of the list above the footer, or -1
// when there is none.
//
// It walks up from the footer the way ParseDialog does, and stops where
// ParseDialog stops: at the first line that is neither a numbered row nor an
// indented description belonging to the row above it. That line is the question,
// and everything above it is somebody's conversation.
func optionListTop(lines []string, end int) int {
	first, rows := -1, 0
	for i := end - 1; i >= 0; i-- {
		line := stripDialogBorder(lines[i])
		if strings.TrimSpace(line) == "" || reRule.MatchString(lines[i]) {
			continue
		}
		if reOption.MatchString(line) {
			first, rows = i, rows+1
			continue
		}
		if rows == 0 {
			continue // still between the footer and the list
		}
		if numbered(lines, i) {
			continue // a description under the row above it
		}
		break
	}
	if rows == 0 {
		return -1
	}
	return first
}

// answerNormalize puts a line of dialog into the form comparisons happen in:
// box-drawing glyphs out, whitespace collapsed, lowercased.
//
// The glyphs go FIRST. The dialog paints a border down the left of every line
// it owns, so leaving them in turns "Where should the │ parse live?" into
// fragments that match nothing — and the terminal wraps a long question across
// the dialog's width, which is why the whitespace collapse has to follow.
func answerNormalize(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	gap := true // true at the start so a leading run of space is dropped
	for _, r := range s {
		if isDialogGlyph(r) || unicode.IsSpace(r) {
			if !gap {
				b.WriteRune(' ')
				gap = true
			}
			continue
		}
		gap = false
		b.WriteRune(unicode.ToLower(r))
	}
	return strings.TrimSpace(b.String())
}

// isDialogGlyph reports whether a rune is the terminal's drawing rather than
// the question's text: the box-drawing block, the cursor mark, and the ASCII
// pipe some widths fall back to (the set reBorder matches, plus the rules and
// corners around them).
func isDialogGlyph(r rune) bool {
	return (r >= '─' && r <= '╿') || r == '❯' || r == '|'
}

// answerRegionHas reports whether the dialog region is showing `want`.
//
// Exact first, then a distinctive prefix: a question longer than the dialog is
// wide is truncated with an ellipsis as well as wrapped, so the whole string
// is not on screen to find.
func answerRegionHas(region []string, want string) bool {
	w := answerNormalize(want)
	if w == "" || len(region) == 0 {
		return false
	}
	hay := answerNormalize(strings.Join(region, "\n"))
	if strings.Contains(hay, w) {
		return true
	}
	head := prefixOf(w)
	return head != "" && strings.Contains(hay, head)
}

// answerRegionGained reports whether the region has one MORE of `want` than it
// had before — which is what "the text I just typed landed in the field" looks
// like from outside the field.
//
// Presence alone cannot say it. The region holds the question, every option
// label and every description, and a reader answering in the question's own
// words types something that is already on the screen: on dialog-multi.txt,
// "Include apples." is option one's description, so a read-back that only asks
// "is it there now" confirms an empty field and the Enter after it answers the
// question with nothing. Counting is the cheapest check that distinguishes the
// two, and it needs no knowledge of where the CLI draws the field.
//
// The needle is chosen against the AFTER reading and then counted in both, so a
// long answer that the field truncated is compared as its prefix on both sides
// rather than as an exact string on one and a prefix on the other.
func answerRegionGained(before, after []string, want string) bool {
	w := answerNormalize(want)
	if w == "" {
		return false
	}
	hayAfter := answerNormalize(strings.Join(after, "\n"))
	needle := w
	if !strings.Contains(hayAfter, needle) {
		if needle = prefixOf(w); needle == "" || !strings.Contains(hayAfter, needle) {
			return false
		}
	}
	return strings.Count(hayAfter, needle) >
		strings.Count(answerNormalize(strings.Join(before, "\n")), needle)
}

// prefixOf is the leading run of a normalised question that is long enough to
// identify it, or "" when there is not enough of it to be evidence.
func prefixOf(s string) string {
	r := []rune(s)
	if len(r) < minPrefixMatch {
		return ""
	}
	if len(r) > maxPrefixMatch {
		r = r[:maxPrefixMatch]
	}
	return string(r)
}

// answerSameQuestion reports whether the question the pane is drawing and a
// question from the call's own list are the same one.
//
// The drawn side loses a trailing ellipsis before comparing, because that is
// the CLI's mark for "there was more of this", not part of the question.
func answerSameQuestion(drawn, known string) bool {
	d := strings.TrimRight(answerNormalize(drawn), "… .")
	k := answerNormalize(known)
	if d == "" || k == "" {
		return false
	}
	if strings.Contains(k, d) || strings.Contains(d, k) {
		return true
	}
	dh, kh := prefixOf(d), prefixOf(k)
	return dh != "" && dh == kh
}

// questionOnScreen reports which of the call's questions the pane is drawing,
// as an index into `known`, or ok=false when the capture cannot say.
//
// IT NEVER READS THE ANSWERED COUNT. Measured against CLI 2.1.267 on
// 2026-09-10: a multi-select question's tab-bar box flips to ☒ on the FIRST
// Space, before the Enter that leaves the question, so `☒ Fruit  ☐ Drink` is
// what the pane shows while it is still drawing "Pick fruits". Answered is a
// progress signal and one ahead of the position whenever a multi-select is
// half-answered or a reader has walked back with ←. Using it as an index is
// how a choice for question 1 lands in question 2.
//
// What it reads instead: the header the dialog draws for itself when there is
// one (a single-question call draws ` ☐ Font`), and otherwise the question
// text, matched against the call as the transcript records it. A
// multi-question dialog draws no per-question header and marks the current tab
// in colour, which `capture-pane -p` does not carry, so with no known list
// there is nothing here to match and the honest answer is "cannot say".
func questionOnScreen(d *Dialog, known []DialogQuestion) (int, bool) {
	if d == nil || len(d.Questions) == 0 || len(known) == 0 {
		return 0, false
	}
	q := d.Questions[0]
	if q.Header != "" {
		if at, ok := onlyMatch(known, func(k DialogQuestion) bool {
			return k.Header != "" && strings.EqualFold(strings.TrimSpace(k.Header), q.Header)
		}); ok {
			return at, true
		}
	}
	return onlyMatch(known, func(k DialogQuestion) bool {
		return answerSameQuestion(q.Question, k.Question)
	})
}

// onlyMatch returns the single index that satisfies `is`. Two matches are no
// match: a call with two identically worded questions cannot be placed by its
// text, and guessing between them is the failure this whole file exists to
// stop.
func onlyMatch(known []DialogQuestion, is func(DialogQuestion) bool) (int, bool) {
	at := -1
	for i := range known {
		if !is(known[i]) {
			continue
		}
		if at >= 0 {
			return 0, false
		}
		at = i
	}
	if at < 0 {
		return 0, false
	}
	return at, true
}

// answerDrawn is what a capture can prove about the question a request names.
type answerDrawn int

const (
	// drawnUnsure: the capture cannot place itself. A multi-question dialog
	// with no known question list is always this — the header is not on
	// screen. The caller does not treat it as a refusal, because refusing it
	// would refuse every multi-question answer; the option check that follows
	// is what stands in its place.
	drawnUnsure answerDrawn = iota
	// drawnHere: the pane is drawing the question the request names.
	drawnHere
	// drawnElsewhere: it is drawing a different one, or one from another call.
	drawnElsewhere
)

// drawnHeader answers "is the pane drawing the question this header names?".
func drawnHeader(d *Dialog, region []string, header string, known []DialogQuestion) answerDrawn {
	header = strings.TrimSpace(header)
	if d == nil || len(d.Questions) == 0 || header == "" {
		return drawnUnsure
	}
	if own := d.Questions[0].Header; own != "" {
		if strings.EqualFold(own, header) {
			return drawnHere
		}
		return drawnElsewhere
	}
	if at, ok := questionOnScreen(d, known); ok {
		if strings.EqualFold(strings.TrimSpace(known[at].Header), header) {
			return drawnHere
		}
		return drawnElsewhere
	}
	// The tab bar still says which questions this CALL has, which is enough to
	// refuse a client that is holding a reading of a different one.
	for _, h := range d.Headers {
		if !strings.EqualFold(h, header) {
			continue
		}
		// And it says which of them already have an answer. A question whose
		// box is ☒ is not the one the dialog is waiting on, so a request naming
		// it is a card that has fallen behind — the commonest shape of this
		// being two questions that offer the same labels ("Yes"/"No",
		// "Staging"/"Production"), where the option check below cannot tell
		// them apart either and the choice lands in whichever question happens
		// to be drawn. Reaching this question again means walking back to it
		// with ←, which needs the call's question list, and with that list this
		// branch is not reached at all.
		if tabBoxes(region)[strings.ToLower(header)] {
			return drawnElsewhere
		}
		return drawnUnsure
	}
	if len(d.Headers) > 0 {
		return drawnElsewhere
	}
	return drawnUnsure
}

// tabBoxes pairs each tab-bar header with its box: true for ☒, false for ☐,
// keyed by the lowercased header.
//
// dialog.go reports the two halves separately — tabHeaders() drops the glyphs
// and tabAnswered() counts them — because a count is all the card needs to draw
// the bar. Which particular question is ticked is what a refusal needs, and it
// is only in the pairing.
func tabBoxes(region []string) map[string]bool {
	boxes := map[string]bool{}
	for _, line := range region {
		if !reTabBar.MatchString(line) {
			continue
		}
		var name strings.Builder
		open, ticked := false, false
		flush := func() {
			if open {
				if h := strings.TrimSpace(name.String()); h != "" && h != "Submit" {
					boxes[strings.ToLower(h)] = ticked
				}
			}
			name.Reset()
			open = false
		}
		for _, r := range line {
			switch r {
			case '☐', '☒':
				flush()
				open, ticked = true, r == '☒'
			case '✔', '←', '→':
				flush()
			default:
				name.WriteRune(r)
			}
		}
		flush()
	}
	return boxes
}

// reviewOnScreen reports whether the dialog region is the review screen at the
// end of a multi-question call: every question answered, waiting for a Submit.
//
// Region-scoped on purpose. Both wordings are ordinary English that a session
// discussing this feature puts on the pane — this repository's own design doc
// quotes them — and treating a question as a Submit would press Enter on the
// wrong screen. The constants are dialogmarkers.go's, so the wording lives in
// one place.
func reviewOnScreen(region []string) bool {
	asks, tabs := false, false
	for _, line := range region {
		if t := strings.TrimSpace(stripDialogBorder(line)); t == reviewTitle || t == readyPrompt {
			asks = true
		}
		if reTabBar.MatchString(line) {
			tabs = true
		}
	}
	return asks && tabs
}

// leftPresses is how many ← presses reach the question `header` names from the
// question at index `from`, where the review screen counts as one past the
// last question.
//
// ok is false when the header is not in this call, or is ahead of `from`: ←
// only walks backwards, and a later question is reached by answering the ones
// before it. Being already there is 0 presses and ok.
func leftPresses(headers []string, from int, header string) (int, bool) {
	to := -1
	for i, h := range headers {
		if !strings.EqualFold(strings.TrimSpace(h), strings.TrimSpace(header)) {
			continue
		}
		if to >= 0 {
			return 0, false // two chips with the same name: which one is meant?
		}
		to = i
	}
	if to < 0 || from < 0 || from > len(headers) || from < to {
		return 0, false
	}
	return from - to, true
}

// answerRow is one numbered row as the dialog DREW it, which is not the same
// list ParseDialog reports: the parser drops the CLI's own free-text and chat
// rows, and the digit we press has to be the digit on screen.
type answerRow struct {
	digit   int
	label   string
	focused bool
	// checked is the multi-select box filled in: `[✔]` rather than `[ ]`.
	// It is the state the CLI is holding for this question, and the only way
	// to know whether a Space on this row would set a pick or clear one.
	checked bool
}

// answerRows reads the numbered rows out of the dialog region.
//
// The numbering has to be the widget's own — 1, 2, 3 in order — for the same
// reason ParseDialog checks it: a line of prose that happens to start with a
// digit is not an option, and counting it would shift every digit after it.
func answerRows(region []string) []answerRow {
	var rows []answerRow
	for _, line := range region {
		clean := stripDialogBorder(line)
		m := reOption.FindStringSubmatch(clean)
		if m == nil || atoi(m[1]) != len(rows)+1 {
			continue
		}
		rows = append(rows, answerRow{
			digit:   atoi(m[1]),
			label:   trimLabel(m[3]),
			focused: strings.ContainsRune(clean, '❯'),
			// Anything inside the brackets but blank is a filled box. The CLI
			// draws "✔" today; matching on the glyph would make a restyle to
			// "x" or "*" read as "nothing picked", which plans a toggle that
			// clears the reader's answer.
			checked: strings.TrimSpace(m[2]) != "",
		})
	}
	return rows
}

// trimLabel puts an option label into the form labels are compared in.
//
// Two decorations are the CLI's rather than the label's. The trailing period:
// it draws "3. Type something." in a single-question dialog and "4. [ ] Type
// something" in a multi-select one. And the trailing tick: measured
// 2026-09-10, a question revisited with ← draws the pick it already has as
// "2. Pear ✔". Without trimming that one, going back and changing an answer
// fails on the option the reader is most likely to be looking at — the one
// they chose last time — because the row no longer matches the label the card
// is offering.
func trimLabel(s string) string {
	return strings.TrimSpace(strings.TrimRight(strings.TrimSpace(s), ".✔✓"))
}

func sameLabel(a, b string) bool { return trimLabel(a) == trimLabel(b) }

// optionOtherLegacy is what the frontend called the free-text row until
// 2026-09-10, while CLI 2.1.267 drew "Type something." The mismatch was
// harmless only because the digit position happened to be unchanged. Both
// labels are accepted so a client and a server on different builds still mean
// the same row.
const optionOtherLegacy = "Other"

// isFreeTextLabel reports whether a label names the row that opens a text
// field rather than answering the question.
func isFreeTextLabel(label string) bool {
	l := trimLabel(label)
	return l == optionOther || l == optionOtherLegacy
}

var (
	// errUnknownOption: the drawn question does not offer that label. The
	// driver turns it into AnswerUnknownOption, and nothing is typed.
	errUnknownOption = errors.New("the question on screen does not offer that option")
	// errNoText: the free-text row was chosen with nothing to type. Refused
	// before the digit goes in, because the digit focuses the field and an
	// Enter on an empty field answers the question with nothing.
	errNoText = errors.New("the free-text option needs something to type")
	// errBothChoices: the request spelled its picks both ways and the two say
	// different things. The driver turns it into AnswerUnknownOption, and
	// nothing is typed.
	errBothChoices = errors.New("choice and choices name different answers")
)

// requestChoices is the set of labels a request wants the question left
// holding, out of the two ways it can be spelled.
//
// Choice is shorthand for a one-element Choices, kept because every
// single-select client sends it and because a one-label answer is also how a
// multi-select pick is REPLACED. Both together are allowed only when they name
// the same single row — the CLI's own decoration makes "Type something." and
// "Type something" the same row, which is why the comparison is sameLabel
// rather than == (trimLabel, measured 2026-09-10).
//
// Anything else is refused rather than resolved. Preferring one field over the
// other would type keys the caller did not unambiguously ask for, and every
// keystroke on this screen is an answer somebody has to live with.
func requestChoices(req AnswerRequest) ([]string, error) {
	switch {
	case len(req.Choices) == 0 && req.Choice == "":
		return nil, nil
	case len(req.Choices) == 0:
		return []string{req.Choice}, nil
	case req.Choice == "":
		return req.Choices, nil
	case len(req.Choices) == 1 && sameLabel(req.Choices[0], req.Choice):
		return req.Choices, nil
	}
	return nil, errBothChoices
}

// choicePlan is one question's worth of typing.
type choicePlan struct {
	// Batches are key runs, each within MaxKeys, sent in order with a settle
	// between them.
	Batches [][]string
	// Text is typed with AnswerText once the batches have landed, for the
	// free-text row. Empty for an ordinary choice.
	Text string
	// After are the keys sent once the text has been READ BACK off the pane —
	// the Enter that commits the field, which is deliberately not part of
	// AnswerText.
	After []string
}

// planChoice turns a reader's picks into the keys that produce them, against
// the question the pane is currently drawing.
//
// Single-select uses the digit, which selects and moves on in one press.
// Multi-select walks the cursor and presses Space, because the digit path and
// the space path are not the same call inside the CLI and only the latter is a
// toggle; the Enter that leaves the question follows.
//
// THE PICKS REPLACE WHAT THE QUESTION IS HOLDING. Space is a toggle, not a
// set, so the keys depend on the boxes already ticked on screen: a row that is
// wanted and unticked gets one, a row that is ticked and not wanted gets one to
// clear it, and a row that is already how the reader wants it gets none. Only
// "choosing again replaces it" (the design) survives a reader tapping their own
// answer — planning a Space per chosen row regardless UNTICKED the pick they
// tapped, left the question with nothing chosen so the Enter could not leave
// it, and reported back that the screen had not moved.
//
// The walk starts from the row the pane says the cursor is on rather than
// assuming row one: a question revisited with ← opens on the row that was
// chosen, and walking from the top would toggle whatever sat that far down.
func planChoice(d *Dialog, region []string, choices []string, text string) (choicePlan, error) {
	if d == nil || len(d.Questions) == 0 || len(d.Questions[0].Options) == 0 {
		return choicePlan{}, errUnknownOption
	}
	q := d.Questions[0]
	rows := answerRows(region)
	if len(rows) == 0 {
		return choicePlan{}, errUnknownOption
	}

	if len(choices) == 1 && isFreeTextLabel(choices[0]) {
		at := rowIndex(rows, optionOther)
		if at < 0 {
			return choicePlan{}, errUnknownOption
		}
		if strings.TrimSpace(text) == "" {
			return choicePlan{}, errNoText
		}
		// The digit FOCUSES a free-text row rather than answering with it,
		// which is exactly what is wanted here: focus, type, read back, commit.
		return choicePlan{
			Batches: selectRow(rows, at),
			Text:    strings.TrimSpace(text),
			After:   []string{"Enter"},
		}, nil
	}

	wanted := make([]int, 0, len(choices))
	for _, c := range choices {
		if c == "" || !offers(q, c) {
			return choicePlan{}, errUnknownOption
		}
		at := rowIndex(rows, c)
		if at < 0 {
			return choicePlan{}, errUnknownOption
		}
		wanted = append(wanted, at)
	}
	if len(wanted) == 0 {
		return choicePlan{}, errUnknownOption
	}

	if !q.MultiSelect {
		if len(wanted) != 1 {
			return choicePlan{}, errUnknownOption
		}
		return choicePlan{Batches: selectRow(rows, wanted[0])}, nil
	}

	pick := make(map[int]bool, len(wanted))
	for _, at := range wanted {
		pick[at] = true
	}
	// Ascending, so each hop is the distance between two rows and after the
	// first the cursor only walks down. The first can go up: a revisited
	// question opens the cursor on the row it already holds, which may sit
	// below a row that has to be cleared.
	at := focusedRow(rows)
	var keys []string
	for i := range rows {
		if rows[i].checked == pick[i] {
			continue // already how the reader wants it
		}
		if !pick[i] && !offers(q, rows[i].label) {
			// A ticked row that is not one of the question's own options is
			// the CLI's free-text row, which carries a box in a multi-select
			// list. Space there opens the field rather than clearing a pick,
			// so it is left exactly as it is.
			continue
		}
		keys = append(keys, walkTo(at, i)...)
		keys = append(keys, "Space")
		at = i
	}
	// Space only toggles. Enter is what leaves a multi-select question, and it
	// goes in a batch of its own so a settle lands between the last toggle and
	// the commit — the model picker on this same TUI has done that since it was
	// written (setmodel.go:173-183, keySettle before the key that commits) and
	// the answer path allowed nothing, which is one of the four candidates the
	// field data could not rule out. An Enter that outruns its toggle leaves the
	// question with no pick at all.
	return choicePlan{Batches: append(chunkKeys(keys), []string{"Enter"})}, nil
}

// selectRow is how to act on one row: its digit when the widget has one to
// press, and otherwise a walk and an Enter, the Enter in a batch of its own so
// the settle between batches lands before the commit.
//
// Only 1-9 are digits — answerKeys carries no others, and that allowlist is
// the whole security boundary of the keys route. A tenth option is rare
// enough that no capture here has one, so the walk runs against a synthetic
// list rather than a real one; it is the only route the allowlist leaves.
func selectRow(rows []answerRow, at int) [][]string {
	if d := rows[at].digit; d >= 1 && d <= 9 {
		return [][]string{{strconv.Itoa(d)}}
	}
	return append(chunkKeys(walkTo(focusedRow(rows), at)), []string{"Enter"})
}

// walkTo is the arrow presses that move the cursor from one row to another.
func walkTo(from, to int) []string {
	key := "Down"
	n := to - from
	if n < 0 {
		key, n = "Up", -n
	}
	keys := make([]string, 0, n)
	for i := 0; i < n; i++ {
		keys = append(keys, key)
	}
	return keys
}

// focusedRow is the row the cursor is on, and 0 when the capture does not show
// a cursor — the row a freshly drawn question opens on.
func focusedRow(rows []answerRow) int {
	for i := range rows {
		if rows[i].focused {
			return i
		}
	}
	return 0
}

// rowIndex finds a label among the rows the dialog drew.
func rowIndex(rows []answerRow, label string) int {
	for i := range rows {
		if sameLabel(rows[i].label, label) {
			return i
		}
	}
	return -1
}

// offers reports whether the drawn question has this option to give.
//
// The PARSED question is the allowlist, which is what keeps the chat row out:
// "Chat about this" abandons the question rather than answering it, so it is
// never a choice, and ParseDialog has already dropped it.
func offers(q DialogQuestion, label string) bool {
	for _, o := range q.Options {
		if sameLabel(o.Label, label) {
			return true
		}
	}
	return false
}

// chunkKeys splits a run of keys into batches the keys route will accept.
// MaxKeys exists to stop a browser typing a paragraph into somebody's shell,
// and a long walk is no reason to widen it.
func chunkKeys(keys []string) [][]string {
	var out [][]string
	for i := 0; i < len(keys); i += MaxKeys {
		end := i + MaxKeys
		if end > len(keys) {
			end = len(keys)
		}
		out = append(out, keys[i:end])
	}
	return out
}
