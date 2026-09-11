package sessionio

import "strings"

// The two lines the review screen draws at the end of a multi-question call.
//
// reviewScreen() in dialog.go holds the same two strings inline and matches
// them for exact equality on a trimmed line; these are a second reference to
// the same wording, which is a duplicate worth removing the next time dialog.go
// is open. They must move together: if the CLI renames one, the parser stops
// recognising the review screen AND the marker goes dark on the same capture,
// and it is the pair that says which. Which is why the marker below compares
// the way the parser does rather than by substring.
const (
	reviewTitle = "Review your answers"
	readyPrompt = "Ready to submit your answers?"
)

// ParseDialogMarkers reports which of the CLI's landmarks a capture carried.
//
// WHY. Claude Code ships roughly daily; the captures under testdata/ do not.
// A restyle that moves one of the strings the parser hangs off changes nothing
// visible in CI — the fixtures still parse, the tests still pass — and shows up
// as a reader stuck on a dialog. One marker was already stale when this was
// written: the free-text row is "Type something." on CLI 2.1.267 and the
// frontend had called it "Other" since the feature shipped. It caused no harm
// only because the digit position happened to be unchanged. Recording which
// landmarks a screen carried turns the next such move into a signal from real
// traffic, at the cost of nothing: it rides on dialogs that are happening
// anyway. The alternative, a nightly test that makes the CLI draw a real
// AskUserQuestion, was declined because it needs a real model call every night.
//
// STRUCTURE ONLY. Nine booleans, never a fragment of what was on screen. A
// dialog quotes whatever the session was working on — file paths, a customer
// name, the contents of a diff — and this reading is destined for telemetry
// that ADR-0008 keeps free of user content. There is no field here that could
// carry any.
//
// IT READS THE DIALOG'S OWN LINES, never the capture — markerScope below says
// which those are, and every comparison on the answer path is scoped the same
// way for the same reason (answerplan.go). Reading the whole capture lets the
// conversation light a marker: a session that has already answered a question
// carries the rows it answered in its own transcript, so a build that RENAMED
// those rows fingerprints as though nothing had moved. A false present is the
// one answer this reading must never give, because a marker going dark is the
// whole signal. It read the capture until 2026-09-11, and three panes in the
// corpus are there because it did.
//
// WHERE THE READING GOES. emitAnswer (session-events/main.go) turns it into one
// attribute on the text.answer_sent / text.answer_failed events,
// tl.markers_missing, holding the dark names comma-joined in the order
// DialogMarkers declares them: "reviewTitle,chatOption". The names are the JSON
// field names, so the query, the response body a stuck reader is looking at and
// the field the client declares (answer-api.ts) all spell a marker the same way.
// No component renders it, so the full nine booleans are visible only in that
// response body.
//
// WHICH READINGS REACH THE SERIES is decided at that emit site, not here, and
// not by the reason. One is recorded when the transcript has a question open
// and unresolved (len(known) > 0) and the fingerprint is partial, at least one
// landmark dark and at least one lit.
//
// Filtering on tl.reason was the first cut and it dropped the readings this
// exists for. AnswerNoDialog is returned for before.dialog == nil
// (answerdrive.go), which is both "no dialog on the pane" and "a dialog the
// parser could not read", and the second is drift itself; the constant's own
// comment describes only the first. An operator menu is the noise the gate has
// to exclude, and no rule over the landmarks excludes it, because the pickers
// are the same select widget and light numberedList exactly as a dialog does.
// What separates them is that nobody is waiting on an AskUserQuestion while a
// picker is up. The cost is a reading lost in the window before Claude Code has
// written the tool record, measured 2026-08-28 at up to 112 s, which a
// multi-day signal can afford.
//
// The two ends are dropped as well. All nine dark is markerScope finding no
// dialog at all, and none dark is every landmark present with the parse still
// failing, which is a parser bug tl.reason already names. Neither is a landmark
// going missing.
//
// The series answers "which landmark has been missing since Tuesday", never "how
// often is it missing". The call site takes a fingerprint only when the parse
// failed, so a healthy dialog contributes no reading at all and the denominator
// a rate would need is not in this series; it is countable separately, as answer
// events whose reason is not AnswerNoDialog.
//
// It never fails, so it returns a value rather than the *Dialog-shaped nil that
// ParseDialog uses for "not a dialog": every capture has a fingerprint, and an
// empty one is a finding rather than an absence.
func ParseDialogMarkers(pane string) DialogMarkers {
	scope := markerScope(pane)
	if len(scope) == 0 {
		return DialogMarkers{}
	}
	// Read off the same lines as everything else, so "the footer is missing"
	// means the scope has none rather than "the capture has none somewhere".
	// True for every region, which is what answerRegion is anchored to; false
	// exactly in the fallback below, which is the footer-rename signal.
	m := DialogMarkers{Footer: footerAt(scope) >= 0}

	rows := 0
	for _, line := range scope {
		if reTabBar.MatchString(line) {
			m.TabBar = true
		}
		// tabAnswered already owns the ☒ glyph, counting it across a tab bar;
		// run over one line at a time it answers "was there one at all". ☐ has
		// no such counterpart — reTabBar and reHeader carry both glyphs inside
		// a character class, and a match cannot say which one it found — so
		// that half is a plain search for the glyph.
		if tabAnswered(line) > 0 {
			m.AnsweredBox = true
		}
		if strings.Contains(line, "☐") {
			m.OpenBox = true
		}
		// Equality on the trimmed line: the test reviewOnScreen makes
		// (answerplan.go), which is reviewScreen's with the dialog's border
		// taken off first. A substring test lit reviewTitle on "Review your
		// answers before you submit" — a retitle the parser refuses — so the
		// one capture that proves the wording moved reported it intact, and
		// the pair the constants above promise came apart.
		switch strings.TrimSpace(stripDialogBorder(line)) {
		case reviewTitle:
			m.ReviewTitle = true
		case readyPrompt:
			m.ReadyPrompt = true
		}
		opt := reOption.FindStringSubmatch(line)
		if opt == nil {
			continue
		}
		rows++
		// The trailing period is the CLI's, not the label's: it draws "3. Type
		// something." in a single-question dialog and "4. [ ] Type something"
		// in a multi-select one. dialog.go trims it the same way before
		// comparing.
		switch strings.TrimRight(opt[3], ".") {
		case optionOther:
			m.FreeText = true
		case optionChat:
			m.ChatOption = true
		}
	}
	// Two is ParseDialog's own floor (len(opts) < 2 → nil), so a screen whose
	// numberedList is dark is a screen it would have refused for that reason.
	// One numbered row is a line that starts with a digit, which the narrow
	// model picker and the codex advanced menu both draw without being a list.
	m.NumberedList = rows >= 2

	return m
}

// markerScope is the block of lines the fingerprint reads: the dialog's own,
// and nothing the conversation above it wrote.
//
// answerRegion first, because that is the block the answer path itself decides
// on, and a fingerprint taken from different lines than the decision would
// describe a different screen than the one the reader is stuck on.
//
// THE FALLBACK IS FOR A TOTAL RESTYLE, which is the drift most worth naming and
// the one answerRegion cannot describe. It is anchored to the footer, and since
// 2026-09-11 it falls back to the dialog's top edge when the footer is not
// recognisable (answerplan.go), so a renamed footer on its own no longer
// reaches this path. What does is a capture that has lost BOTH — no footer the
// parser knows and no tab bar or ☐ header either — which would otherwise
// fingerprint as every marker dark, "we recognised nothing", when the reading
// we want is "the rows and the boxes are intact and the frame moved". dialogTop
// derives the block from the option list instead, with the bottom of the
// capture standing in for the footer, which is the use its own comment
// anticipates. It stops at the first line above the question that is neither a
// row nor a row's description, so the conversation stays out on this path too.
//
// The two fallbacks overlap and could be one: answerRegion's uses anchorTop
// where this uses dialogTop, which tries the option list first and anchorTop
// second, so moving answerRegion onto dialogTop would make this branch
// redundant and markerScope a synonym for answerRegion. That belongs in
// answerplan.go rather than here.
//
// Nothing lit when that finds nothing either. A capture with no footer, no
// option list and no ☐ header is not a dialog we can place, and the honest
// fingerprint of a screen we cannot find is an empty one. The last N lines of
// the capture was the other candidate and is worse at exactly the job: on a
// short pane N lines reach into the conversation, which is what this scoping
// removes.
func markerScope(pane string) []string {
	if region := answerRegion(pane); len(region) > 0 {
		return region
	}
	lines := strings.Split(pane, "\n")
	top := dialogTop(lines, len(lines)-1)
	if top < 0 {
		return nil
	}
	return lines[top:]
}
