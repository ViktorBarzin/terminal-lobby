package sessionio

import "strings"

// The wire contract for answering an AskUserQuestion from the text view.
//
// ONE ACTION, ONE REQUEST. The reader acts, that goes to the server, the
// server applies it to the question the pane is drawing and returns whatever
// the pane draws next. Nothing is planned ahead of time.
//
// A single-select question is one request: the pick answers it. A multi-select
// is several. Each click is a TOGGLE, a request with Stay that names every
// label the question should hold and leaves the cursor on the question, and a
// COMMIT is the same request without Stay, which also presses the question's
// own commit row. Until 2026-09-23 every multi-select request was a commit, so
// the first click left the question and a reader could never pick two. Each is
// still no prediction, because the set is diffed against the boxes the pane is
// drawing at the time.
//
// The design this replaces planned the whole walk in the browser: each step's
// expectation was the NEXT question's text, and the last step's was the review
// screen's title. Measured over 10 days of field data, four-question answers
// failed 4 times in 5, always as a `desync` — the plan predicted a screen and
// did not find it (docs/plans/2026-09-10-text-mode-answers-dialogs-design.md).
// Predicting is the part that was wrong, so this contract has no prediction in
// it: every reply is a reading, not a forecast.
//
// WHAT ADDRESSES A QUESTION. The header, never an index. An ordered list is
// what let choice 0 land in whatever question happened to be drawn.
//
// How well that header is checked depends on whether the driver was given the
// call's question list. WITH it, the server places the pane and refuses any
// header but the drawn one, so a stale client cannot answer the wrong question.
// WITHOUT it — the window before Claude Code writes the record, measured
// 2026-08-28 at 3-8 s for some calls and not until the answer for others — the
// pane cannot be placed, and three weaker checks stand in: the header must be
// one the tab bar carries, its box there must not already be ticked, and the
// drawn question must offer the label. Refusing instead would make every tap in
// that window come back not-drawn, on exactly the call shape the field data says
// fails most, so the looser rule is deliberate (TextView.tsx callAddress).
type AnswerRequest struct {
	// Header of the question this choice belongs to, as the tab bar draws it.
	// Required for Choice; ignored for Submit.
	Header string `json:"header,omitempty"`
	// Choice is the option label the reader picked. Shorthand for a Choices of
	// exactly one, and what every single-select client sends.
	Choice string `json:"choice,omitempty"`
	// Choices is the set of labels the question should be left holding.
	//
	// A MULTI-SELECT REQUEST IS THE DESIRED FINAL STATE, NOT A DELTA. Space is
	// a toggle, so the keys that answer a multi-select are a diff against the
	// boxes the pane already has ticked (DialogOption.Checked), and a reader
	// adding a second fruit sends both of them. That is what makes the second
	// pick ADD rather than replace: measured 2026-09-11 with Apple ticked and
	// the cursor on its row, a request naming Pear alone plans
	// [Space Down Space] and the first Space lands on Apple.
	//
	// Sending one label is still how a pick is REPLACED, which is what the
	// revisit flow is for, so the difference between adding and replacing is
	// the request rather than a mode. A delta ("also Pear") would have been
	// ambiguous the moment anything else moved the dialog — a keystroke in the
	// terminal, an Esc, a re-ask — which is the class of drift this whole
	// contract avoids by reading the screen instead of remembering it.
	//
	// Choice and Choices may both be sent only when they say the same one
	// thing. A request that fills in both and means two different things is
	// refused, because there is no reading of it that is not a guess.
	//
	// ON A MULTI-SELECT THE SET COVERS THE FREE-TEXT ROW TOO. That row is an
	// inline field there, which ticks itself as it is typed into (measured on
	// CLI 2.1.280, 2026-09-23), so free text is one more pick: the set names
	// "Type something" beside the option labels and Text carries the words.
	// A set that leaves it out asks for the row to be emptied, and the server
	// clears it with C-e and then Backspace, never Space, which on that row
	// types a space (clearFieldKeys says why the C-e).
	Choices []string `json:"choices,omitempty"`
	// Text is the free-text row's words, whenever the set names that row. The
	// CLI labels it "Type something" (optionOther); a client may also send the
	// label "Other", which older builds used. It must not be blank.
	//
	// On a single-select it is typed and committed with Enter. On a
	// multi-select it is typed into the inline field, read back and left
	// there with no Enter, because Enter on that row flips the box the typing
	// has just ticked.
	Text string `json:"text,omitempty"`
	// Stay makes a multi-select request a TOGGLE: bring the question to the
	// set and do not leave it. No walk to the commit row, no Enter.
	//
	// Applied means a fresh reading shows every option box as the set asks
	// and the free-text row as the set asks; otherwise the reply is
	// unverified. Either way it carries that reading, which is what the card
	// redraws its ticks from. An empty set is a valid toggle: it unticks
	// everything.
	//
	// Without Stay a multi-select request is the COMMIT, carrying the set the
	// card shows: the same diff (normally nothing to do), checked the same
	// way, then Enter on the commit row in a batch of its own, checked as any
	// answer is (the review screen, another question, or the dialog gone). A
	// commit with an empty set is refused as unknown-option with nothing
	// typed. The CLI would take one and leave the question unanswered, and no
	// card asks for that.
	//
	// Stay on a single-select is refused as unknown-option with nothing
	// typed: its digit answers and moves on, which is the opposite.
	Stay bool `json:"stay,omitempty"`
	// Back navigates to the question with this header instead of answering
	// anything, so a reader can revisit and change an earlier choice. The CLI
	// shows the previous pick on that question as a trailing "✔".
	Back string `json:"back,omitempty"`
	// Submit presses the review screen's Submit. Valid only when the pane is
	// showing the review screen.
	Submit bool `json:"submit,omitempty"`
	// Keys is the escape hatch for a screen the parser could not read: raw key
	// names, sent as-is, subject to the same allowlist and MaxKeys cap as
	// POST /keys. The card offers this when it can only show the pane itself.
	Keys []string `json:"keys,omitempty"`
}

// AnswerResult reasons. Empty means the request was applied.
const (
	// AnswerNotDrawn: the pane is not showing the question the request names.
	// The reply still carries the current reading, so the card re-renders
	// against what IS on screen rather than latching.
	AnswerNotDrawn = "not-drawn"
	// AnswerNoDialog: no dialog on the pane at all.
	AnswerNoDialog = "no-dialog"
	// AnswerUnknownOption: the question does not offer that label.
	AnswerUnknownOption = "unknown-option"
	// AnswerRefused: tmux would not take the keys.
	AnswerRefused = "refused"
	// AnswerUnverified: the keys went in and the pane did not change the way
	// answering that question changes it, or, for a toggle, did not come to
	// show the set it asked for. Nothing further is typed.
	AnswerUnverified = "unverified"
)

// AnswerResponse is what the pane shows once the request has been applied, or
// once it has been refused.
//
// The card renders `Dialog` and nothing else when it is present. `Pane` is the
// fallback for a screen the parser could not read: the card shows the text and
// makes the lines that look like numbered rows tappable, so a reader is never
// sent to the Terminal by a screen we do not recognise.
type AnswerResponse struct {
	// Applied is true when the request changed the dialog.
	Applied bool `json:"applied"`
	// Reason is one of the Answer* constants, empty when Applied.
	Reason string `json:"reason,omitempty"`
	// Dialog is the reading taken AFTER the request, nil when the parser could
	// not read the screen.
	Dialog *Dialog `json:"dialog,omitempty"`
	// Review is true when the pane is on the review screen, where the only
	// remaining action is Submit.
	Review bool `json:"review,omitempty"`
	// Done is true when the dialog is gone, which is how a successful Submit
	// reports itself. The transcript carries the answers from here.
	Done bool `json:"done,omitempty"`
	// Pane is the raw capture, sent only when Dialog is nil and Done is false.
	Pane string `json:"pane,omitempty"`
	// Markers is the drift fingerprint for a screen the parser could not fully
	// read: which known markers were present. Structure only, never screen
	// text, so it stays inside ADR-0008's content-free rule.
	Markers *DialogMarkers `json:"markers,omitempty"`
	// Action is what kind of request the driver took this to be, one of the
	// Action* words, for the server's own records. It never goes on the wire.
	//
	// The driver fills it because it is the one that saw the question: a
	// request naming one label is a single-select pick or a one-label
	// multi-select commit, and only the drawn question, or the call's record
	// when the transcript has one, says which.
	Action string `json:"-"`
}

// The kinds of request, as the text.answer_* events record them in tl.action.
//
// Counting answers needs the difference between a toggle and a commit: a
// multi-select answer is several toggles and one commit, and only the commit
// is an answer (session-events emitAnswered).
const (
	ActionChoose = "choose" // a single-select question answered with one pick
	ActionToggle = "toggle" // a multi-select's picks changed, question kept (Stay)
	ActionCommit = "commit" // a multi-select committed with its picks
	ActionBack   = "back"   // ← to an earlier question
	ActionSubmit = "submit" // the review screen's Submit
	ActionKeys   = "keys"   // the raw-key hatch
)

// AnswerAction names the kind of request, in the order Answer dispatches it.
//
// Choose and commit are the one pair the request cannot tell apart on its own.
// The call's record wins when it has the question the request names, because
// it describes that question whatever the pane is drawing. Otherwise the drawn
// question says, and with neither a set of more than one label can only be a
// multi-select. `drawn` and `known` may both be nil.
func AnswerAction(req AnswerRequest, drawn *Dialog, known []DialogQuestion) string {
	switch {
	case len(req.Keys) > 0:
		return ActionKeys
	case req.Submit:
		return ActionSubmit
	case req.Back != "":
		return ActionBack
	case req.Stay:
		return ActionToggle
	}
	header := strings.TrimSpace(req.Header)
	for _, q := range known {
		if header != "" && strings.EqualFold(strings.TrimSpace(q.Header), header) {
			return chooseOrCommit(q.MultiSelect)
		}
	}
	if drawn != nil && len(drawn.Questions) > 0 && len(drawn.Questions[0].Options) > 0 {
		return chooseOrCommit(drawn.Questions[0].MultiSelect)
	}
	return chooseOrCommit(len(req.Choices) > 1)
}

func chooseOrCommit(multi bool) string {
	if multi {
		return ActionCommit
	}
	return ActionChoose
}

// DialogMarkers records which of the CLI's known landmarks a capture carried.
//
// Claude Code updates roughly daily and our fixtures are static captures, so a
// restyle can move a string we depend on without anything failing loudly. One
// marker was already stale when this was written: the free-text option is
// "Type something" on CLI 2.1.267 and the frontend still called it "Other".
// Recording which landmarks a screen had turns the next such drift into a
// signal instead of a bug report.
type DialogMarkers struct {
	TabBar       bool `json:"tabBar"`       // the ← ☐ … ✔ Submit → row
	AnsweredBox  bool `json:"answeredBox"`  // at least one ☒
	OpenBox      bool `json:"openBox"`      // at least one ☐
	ReviewTitle  bool `json:"reviewTitle"`  // "Review your answers"
	ReadyPrompt  bool `json:"readyPrompt"`  // "Ready to submit your answers?"
	Footer       bool `json:"footer"`       // "Enter to select … Esc to cancel"
	NumberedList bool `json:"numberedList"` // at least two "N. " rows
	FreeText     bool `json:"freeText"`     // the "Type something" option
	ChatOption   bool `json:"chatOption"`   // the "Chat about this" option
}
