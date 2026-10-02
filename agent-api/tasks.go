package main

// The task endpoints: the poll, the cancel, and the answer.

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"terminal-lobby/sessionio"
)

// getTask serves GET /v1/tasks/{id}.
//
// Readable by any credential that resolves to the SAME OS user, and by no
// other. Within one OS user it is deliberately open — every conversation on
// that account is already listable and readable, so a task's result carries
// nothing the caller could not read out of the transcript — and that argument
// stops at the account boundary. A credentials line names an OS user per
// caller, this box has more than one terminal account, and a task's result is
// the agent's final message, so without this check a credential for emo could
// read what a conversation of wizard's produced. Ids are not guessable, but
// every request writes one to trace.jsonl and promtail ships that to Loki, so
// they are not secret either.
//
// A task belonging to another account answers exactly like an id that was
// never issued. Two answers would tell a caller which ids exist elsewhere,
// and there is nothing it could do with the difference.
//
// Writing is checked in the three write routes: postMessage, cancelTask and
// answerTask.
//
// ?wait=N makes it a long-poll: held until the status differs from the one it
// had when the request arrived, or N seconds pass, and answered with the task
// either way. A task that is finished, or blocked on a question, will not move
// by itself, so it is answered at once.
func (s *Server) getTask(c *call) (any, error) {
	id := c.r.PathValue("id")
	c.taskID = id
	wait, err := waitSeconds(c.r.URL.Query())
	if err != nil {
		return nil, err
	}
	_, osUser, ok := s.Tasks.Meta(id)
	if !ok || osUser != c.id.OSUser {
		// Worth saying WHY an id can vanish: tasks live in memory, so a
		// restart of the service loses them while the conversation itself
		// survives in tmux. A caller that gets this has not lost the work.
		return nil, notFound("no task %q (task ids do not survive a restart of this service; "+
			"the conversation and its transcript do)", id)
	}
	v, ok := s.Tasks.Get(id)
	if !ok {
		// Pruned between the two reads. Same answer as an id nobody issued.
		return nil, notFound("no task %q (task ids do not survive a restart of this service; "+
			"the conversation and its transcript do)", id)
	}
	c.conversationID = v.ConversationID
	if wait == 0 || settledOrBlocked(v.Status) {
		return v, nil
	}
	from := v.Status
	if moved, ok := s.Tasks.Wait(c.r.Context(), id, time.Duration(wait)*s.waitUnit(),
		func(st TaskStatus) bool { return st != from }); ok {
		v = moved
	}
	return v, nil
}

// cancelTask serves POST /v1/tasks/{id}/cancel.
//
// Two different things depending on where the task is. Queued: it is dropped
// before anything is injected, and the conversation never sees it. Running:
// the session gets an interrupt, which is Ctrl-C through sessionio.Cancel —
// the same path the lobby's Stop button takes, including its re-derivation of
// @claude_state, without which the session would latch at "running" and every
// later turn gate would stay shut.
func (s *Server) cancelTask(c *call) (any, error) {
	id := c.r.PathValue("id")
	c.taskID = id

	actor, osUser, ok := s.Tasks.Meta(id)
	// The account check the read path makes, first and for the same reason:
	// two credentials may carry the same NAME while naming different OS
	// users, and the actor comparison below would let the second one stop the
	// first one's turn. Another account's task answers like an absent id.
	if !ok || osUser != c.id.OSUser {
		return nil, notFound("no task %q", id)
	}
	v, _ := s.Tasks.Get(id)
	c.conversationID = v.ConversationID

	// Cancelling is a write, so it follows the same ownership rule messages
	// do: the credential that sent the message is the one that may stop it.
	if actor != c.id.Header {
		return nil, forbidden("task %q was sent by %q, so it cannot be cancelled by %q",
			id, actor, c.id.Header)
	}

	cancelled, wasLive := s.Tasks.Cancel(id)
	if !cancelled {
		// Already finished, or already cancelled. Both are the same answer to
		// the caller, and the status says which.
		v, _ = s.Tasks.Get(id)
		return nil, conflict("task %q is already %s", id, v.Status)
	}

	// Interrupt only a turn that had actually started. Sending Ctrl-C for a
	// queued task would interrupt whatever ELSE is running in that
	// conversation, which is somebody's turn that nobody asked to stop.
	var interruptErr string
	if wasLive {
		// Resolved rather than reused: the conversation id is the name the
		// session was born with, and tmux answers to the one it has now.
		live, ferr := s.find(osUser, v.ConversationID)
		if ferr != nil {
			interruptErr = ferr.Error()
		} else if err := s.Sessions.Cancel(osUser, live.Name); err != nil {
			// The task is cancelled either way — this service has stopped
			// following it. The session may still be working, which the
			// caller needs told rather than discovering from the transcript.
			interruptErr = err.Error()
			logf("agent-api: cancel %s: interrupting %s failed: %v", id, v.ConversationID, err)
		}
	}

	out, _ := s.Tasks.Get(id)
	res := map[string]any{
		"task_id": id,
		"status":  out.Status,
		// Whether a turn was actually interrupted, as opposed to a queued
		// message being dropped before it was sent. A caller deciding what to
		// tell a person needs the difference.
		"interrupted": wasLive && interruptErr == "",
	}
	if interruptErr != "" {
		res["warning"] = "the task is cancelled and no longer followed, but the interrupt did not reach " +
			v.ConversationID + ": " + interruptErr
	}
	return res, nil
}

// answerRequest is the POST /v1/tasks/{id}/answer body: exactly one of a row
// number and words. Pointers, so "absent" and "zero" are different answers.
type answerRequest struct {
	Option *int    `json:"option"`
	Text   *string `json:"text"`
}

// answerResult is the task after an answer, plus what the caller needs told
// when the answer was typed but could not be seen to land.
type answerResult struct {
	TaskView
	Warning string `json:"warning,omitempty"`
}

// answerTask serves POST /v1/tasks/{id}/answer.
//
// It answers the question that put a task in needs_input, through the lobby's
// mod, the way the Text view's cards do (question.go, dialog.go): an
// AskUserQuestion menu by a row or words, the plan approval by Approve plan,
// Keep planning or feedback words, and the tool permission prompt by Allow,
// Deny or words that deny the call and say why.
//
// The dialog is read again first, and the answer names it by its tool call
// id, so it settles that dialog or nothing: if the dialog was answered in the
// terminal meanwhile, or another opened in its place, nothing is sent and the
// caller is told to look again.
func (s *Server) answerTask(c *call) (any, error) {
	id := c.r.PathValue("id")
	c.taskID = id

	// The same two checks cancelTask makes, in the same order and for the
	// same reasons: another account's task answers like an absent id, and
	// only the credential that sent the message may act on its turn.
	actor, osUser, ok := s.Tasks.Meta(id)
	if !ok || osUser != c.id.OSUser {
		return nil, notFound("no task %q", id)
	}
	v, _ := s.Tasks.Get(id)
	c.conversationID = v.ConversationID
	if actor != c.id.Header {
		return nil, forbidden("task %q was sent by %q, so it cannot be answered by %q",
			id, actor, c.id.Header)
	}

	var req answerRequest
	if err := c.decode(&req); err != nil {
		return nil, err
	}
	text, err := checkAnswer(req)
	if err != nil {
		return nil, err
	}
	if v.Status != StatusNeedsInput {
		return nil, conflict("task %q is %s, not waiting on a question", id, v.Status)
	}

	// Resolved rather than reused, as everywhere: the conversation id is the
	// name the session was born with, and tmux answers to the one it has now.
	live, err := s.find(osUser, v.ConversationID)
	if err != nil {
		return nil, err
	}
	if live.Suspended && live.Owner == c.id.Header {
		// The sweep never suspends a session waiting on an answer, so this is
		// a mark that arrived some other way. Resumed for the reason a message
		// resumes one; the fresh Claude has no dialog open, so the comparison
		// below then reports, truthfully, that the question has gone.
		if err := s.Sessions.Resume(osUser, live.Name); err != nil && !errors.Is(err, sessionio.ErrNotSuspended) {
			return nil, serverError("conversation %s was suspended and could not be resumed: %v", v.ConversationID, err)
		}
		if live, err = s.find(osUser, v.ConversationID); err != nil {
			return nil, err
		}
	}
	s.stampTurn(osUser, live.Name)
	now := s.readQuestion(osUser, live.Name)
	asked := s.Tasks.QuestionTool(id)
	if now.Kind == KindUnknown && v.Kind == KindUnknown {
		return nil, unprocessable("%v", errNotAnswerable(now))
	}
	if now.Kind != v.Kind || now.ToolID != asked {
		s.Tasks.SetQuestion(id, s.withPaneText(osUser, live.Name, now))
		return nil, conflict("the session is not waiting on the question this task reported, so nothing was sent. "+
			"The task now shows what it is waiting on (a %s question); read it and answer again", now.Kind)
	}
	if len(now.AnswerWith) == 0 {
		return nil, unprocessable("%v", errNotAnswerable(now))
	}

	areq, err := answerFor(now, req, text)
	if err != nil {
		return nil, err
	}
	c.event = "answer " + now.Kind + " " + now.ToolID
	resp, err := s.Sessions.AnswerDialog(c.r.Context(), osUser, live.Name, areq)
	switch {
	case errors.Is(err, errDialogGone), errors.Is(err, errNoMod):
		s.Tasks.SetQuestion(id, s.withPaneText(osUser, live.Name, s.readQuestion(osUser, live.Name)))
		return nil, conflict("the question went while the answer was being sent, so nothing was sent (%v). "+
			"Read the task again", err)
	case err != nil:
		return nil, serverError("session-events could not be reached to answer %s: %v", v.ConversationID, err)
	}
	c.reason = resp.Reason

	var warning string
	switch {
	case resp.Applied:
	case resp.Reason == sessionio.AnswerUnverified:
		// Sent to the mod, which did not confirm in time. Reported as
		// running anyway: if the dialog is still open the watcher finds it on
		// its next poll and puts the task back to needs_input.
		warning = "the answer was sent but the session did not confirm it in time. " +
			"If the question is still open, the task goes back to needs_input within a few seconds; " +
			"read the task again before answering again"
	case resp.Reason == sessionio.AnswerNotHeld, resp.Reason == sessionio.AnswerNotDrawn,
		resp.Reason == sessionio.AnswerUnknownOption:
		// Answered in the terminal a moment ago, or replaced.
		s.Tasks.SetQuestion(id, s.withPaneText(osUser, live.Name, s.readQuestion(osUser, live.Name)))
		return nil, conflict("the question changed while the answer was being sent, so it did not land (%s). "+
			"Read the task again", resp.Reason)
	case resp.Reason == sessionio.AnswerIncomplete:
		return nil, unprocessable("the answer leaves a question of this menu unanswered")
	default:
		return nil, serverError("the answer for %s did not land (%s); read the task again before retrying",
			v.ConversationID, resp.Reason)
	}

	// A refused transition is fine here: a cancel that landed while the
	// answer was being sent wins, and the task says so.
	s.Tasks.Update(id, StatusRunning, nil)
	out, _ := s.Tasks.Get(id)
	return answerResult{TaskView: out, Warning: warning}, nil
}

// checkAnswer validates an answer body's shape, before any state is looked
// at, and returns the words trimmed. It applies sessionio's own rule for
// words (checkAnswerText there), so a refusal comes back as a 400 naming the
// problem rather than as a driver refusal after the cursor has moved.
func checkAnswer(req answerRequest) (string, error) {
	switch {
	case (req.Option == nil) == (req.Text == nil):
		return "", badRequest(`send exactly one of "option" (a row number) or "text" (words)`)
	case req.Option != nil && *req.Option < 1:
		return "", badRequest("option must be a row number, counted from 1 as the question numbers them")
	case req.Option != nil:
		return "", nil
	}
	text := strings.TrimSpace(*req.Text)
	switch {
	case text == "":
		return "", badRequest("text must not be blank")
	case len(text) > sessionio.MaxAnswerText:
		return "", badRequest("text is %d bytes; an answer may be at most %d", len(text), sessionio.MaxAnswerText)
	case strings.ContainsAny(text, "\r\n"):
		return "", badRequest("text must be one line: a line break would submit the field halfway through the answer")
	}
	return text, nil
}

// answerFor builds the request for a reading, naming its dialog.
func answerFor(q questionReading, req answerRequest, text string) (sessionio.AnswerRequest, error) {
	out := sessionio.AnswerRequest{ToolID: q.ToolID}
	if req.Option != nil {
		n := *req.Option
		if !slices.Contains(q.AnswerWith, answerOption) {
			return out, unprocessable("this %s question takes words, not a row", q.Kind)
		}
		if n > len(q.Options) {
			return out, unprocessable("option %d is not one of the rows on offer: %s", n, rowList(q.Options))
		}
		switch q.Kind {
		case KindChoice:
			out.Answers = map[string][]string{q.question: {q.Options[n-1].Label}}
		case KindPlan:
			out.Plan = &sessionio.PlanAnswer{Option: n, Label: q.Options[n-1].Label}
		case KindPermission:
			out.Permission = &sessionio.PermissionAnswer{Option: n, Label: q.Options[n-1].Label}
		}
		return out, nil
	}
	if !slices.Contains(q.AnswerWith, answerText) {
		return out, unprocessable("this %s question takes a row, not words", q.Kind)
	}
	switch q.Kind {
	case KindChoice:
		out.Answers = map[string][]string{q.question: {text}}
	case KindPlan:
		out.Plan = &sessionio.PlanAnswer{Feedback: text}
	case KindPermission:
		out.Permission = &sessionio.PermissionAnswer{Decline: text}
	}
	return out, nil
}

// rowList is the rows on offer, for an error message.
func rowList(opts []TaskOption) string {
	parts := make([]string, 0, len(opts))
	for _, o := range opts {
		parts = append(parts, fmt.Sprintf("%d %s", o.Index, o.Label))
	}
	return strings.Join(parts, ", ")
}
