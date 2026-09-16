package main

// The task endpoints: the poll, and the cancel.

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
// Writing is checked in the same two places it always was: postMessage and
// cancelTask.
func (s *Server) getTask(c *call) (any, error) {
	id := c.r.PathValue("id")
	c.taskID = id
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
