package sessionio

// The wire contract for POST /answer.
//
// An AskUserQuestion is answered AS DATA (ADR-0034): the lobby's
// PermissionRequest hook holds the call, and the request carries the whole
// call's answers, or declines it with Chat. Nothing is typed into the pane for
// it. Claude Code's plan approval is still answered by keys (ADR-0010), one
// request per reader action, read off the pane before and after.
type AnswerRequest struct {
	// ToolID names the dialog the answer is for. Empty means the oldest open
	// dialog of the answer's kind, which is what the web sends. A program that
	// read the dialog first names it, so an answer never lands on a dialog that
	// opened in its place meanwhile.
	ToolID string `json:"toolId,omitempty"`
	// Answers is a whole AskUserQuestion call answered at once, keyed by each
	// question's text, for a call the lobby's hook is holding. A single-select
	// question carries one label, a multi-select the labels picked, and a
	// free-text answer its words.
	Answers map[string][]string `json:"answers,omitempty"`
	// Chat declines a held call and hands Claude these words instead, the
	// card's "Chat about this". Present and empty declines with no words.
	Chat *string `json:"chat,omitempty"`
	// Call names the held call that Answers or Chat is for, by its question
	// texts in order. Claude can ask several calls at once and each is held
	// on its own. Without it, Answers goes to the call its keys belong to and
	// Chat to the oldest.
	Call []string `json:"call,omitempty"`
	// Plan answers Claude Code's plan approval (plandialog.go).
	Plan *PlanAnswer `json:"plan,omitempty"`
	// Permission answers Claude Code's tool permission prompt, through the
	// lobby's mod (session-events/mod.go):
	// a row picked by its number, or a decline with words.
	Permission *PermissionAnswer `json:"permission,omitempty"`
}

// PermissionAnswer answers the tool permission prompt: a row
// picked by its number, or the card's "Type your own answer", which declines
// and tells Claude what to do instead. Exactly one of Option and Decline.
//
// Option is the row's number and Label the label the reader saw on it, which
// must be the label drawn now, as for the plan approval's rows. The digit picks
// the row at once, except with the cursor in the No row's open field, where it
// is typed into the field ("No, 1"); so the cursor walks off the field first,
// read back, and only then does the digit go in (measured on CLI 2.1.283,
// 2026-09-28). The reply waits for the prompt to go.
//
// Decline is typed into the No row's field: the cursor walks onto the row,
// Tab opens its field, whatever the field holds is cleared, the words are
// pasted and read back off the row, and only then does Enter go in. Claude
// gets the tool call rejected with "the user said: <words>" and carries on in
// the same turn (measured on CLI 2.1.283, 2026-09-27). The words must not be
// blank, and nothing presses Enter on an empty field.
type PermissionAnswer struct {
	Option  int    `json:"option,omitempty"`
	Label   string `json:"label,omitempty"`
	Decline string `json:"decline,omitempty"`
}

// PlanAnswer is one answer to the plan approval: an approve row, or words for
// the feedback row. Exactly one of Option and Feedback.
//
// ONE REQUEST, ONE ACTION, AS FOR A QUESTION. The server reads the dialog
// before any key, refuses what the drawn dialog does not offer with nothing
// typed, and reports what the pane shows afterwards. The dialog going away is
// the evidence an answer landed; for feedback, Claude goes on planning and
// draws a new dialog some seconds later (about 8 s on 2.1.281), which the
// pane watcher then reports like any other.
type PlanAnswer struct {
	// Option is the number of an approve row, the digit that selects it, and
	// Label the label the reader saw on it. The labels change between
	// sessions and while one runs ("(6% used)" climbs), so a label that is
	// not the one drawn now is refused as unknown-option with nothing typed,
	// rather than approving with whatever row carries that number today. The
	// feedback row is not an approve option.
	Option int    `json:"option,omitempty"`
	Label  string `json:"label,omitempty"`
	// Feedback is typed into the feedback row: its digit focuses the row,
	// whatever the field already holds is cleared, the words are pasted and
	// read back off the row, and only then does the committing key go in.
	// Approve false presses Enter, which sends the words back and Claude keeps
	// planning; Approve true presses Shift+Tab, the CLI's "approve with this
	// feedback". The words must not be blank, and nothing presses Enter on an
	// empty feedback row, where it rejects the plan outright.
	Feedback string `json:"feedback,omitempty"`
	Approve  bool   `json:"approve,omitempty"`
}

// AnswerResult reasons. Empty means the request was applied.
const (
	// AnswerNotDrawn: the pane is not showing the dialog the request answers.
	// The reply still carries the current reading, so the card re-renders
	// against what IS on screen rather than latching.
	AnswerNotDrawn = "not-drawn"
	// AnswerNoDialog: no dialog on the pane at all.
	AnswerNoDialog = "no-dialog"
	// AnswerUnknownOption: the dialog does not offer that option.
	AnswerUnknownOption = "unknown-option"
	// AnswerRefused: tmux would not take the keys.
	AnswerRefused = "refused"
	// AnswerUnverified: the keys went in and the pane did not change the way
	// answering changes it. Nothing further is typed.
	AnswerUnverified = "unverified"
	// AnswerNotHeld: the request answers an AskUserQuestion and no hook is
	// holding one for the session, so the terminal is the only place left to
	// answer it.
	AnswerNotHeld = "not-held"
	// AnswerIncomplete: the request answers a held call and leaves one of its
	// questions without an answer. Claude reads a missing answer as a skipped
	// question, so nothing is sent.
	AnswerIncomplete = "incomplete"
)

// AnswerResponse is the outcome of one request, and for the plan approval or
// the permission prompt what the pane shows once it has been applied or
// refused.
type AnswerResponse struct {
	// Applied is true when the request took effect.
	Applied bool `json:"applied"`
	// Reason is one of the Answer* constants, empty when Applied.
	Reason string `json:"reason,omitempty"`
	// Dialog is the plan approval or the permission prompt as read AFTER the
	// request, nil when there is none on screen.
	Dialog *Dialog `json:"dialog,omitempty"`
	// Done is true when the dialog is gone, which is how an answer that landed
	// reports itself. The transcript carries the result from here.
	Done bool `json:"done,omitempty"`
	// Action is what kind of request this was, one of the Action* words, for
	// the server's own records. It never goes on the wire.
	Action string `json:"-"`
}

// The kinds of request, as the text.answer_* events record them in tl.action.
const (
	// A held call (ADR-0034): every question answered in one request, or the
	// call declined with "Chat about this". Each is one answer.
	ActionAnswers = "answers"
	ActionChat    = "chat"
	// The plan approval. An approve option is plan-approve; words typed into
	// the feedback row are plan-feedback, whether they go back for more
	// planning or approve the plan with them (docs/adr/0006, the 2026-09-24
	// amendment). Each is one answer.
	ActionPlanApprove  = "plan-approve"
	ActionPlanFeedback = "plan-feedback"
	// The permission prompt declined with words (since 2026-09-27), or a row
	// of it picked by its number (since 2026-09-28, through POST /keys before
	// that). Each is one answer.
	ActionPermissionDecline = "permission-decline"
	ActionPermissionPick    = "permission-pick"
	// The mode dial (setmode.go), which session-events records into the same
	// two event names. Answer never returns it.
	ActionMode = "mode"
)

// AnswerAction names the kind of request, or "" for one that asks nothing.
func AnswerAction(req AnswerRequest) string {
	switch {
	case req.Chat != nil:
		return ActionChat
	case req.Answers != nil:
		return ActionAnswers
	case req.Plan != nil && req.Plan.Option != 0:
		return ActionPlanApprove
	case req.Plan != nil:
		return ActionPlanFeedback
	case req.Permission != nil && req.Permission.Option != 0:
		return ActionPermissionPick
	case req.Permission != nil:
		return ActionPermissionDecline
	}
	return ""
}
