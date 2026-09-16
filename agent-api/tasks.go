package main

// The task endpoints: the poll, and the cancel.

// getTask serves GET /v1/tasks/{id}.
//
// Readable by any authenticated caller, which is consistent with the rest of
// the surface rather than an omission: every conversation on this OS user's
// box is already listable and readable, so a task's result carries nothing a
// caller could not reach through the transcript. Writing is where ownership
// bites, and that is postMessage and cancelTask.
func (s *Server) getTask(c *call) (any, error) {
	id := c.r.PathValue("id")
	c.taskID = id
	v, ok := s.Tasks.Get(id)
	if !ok {
		// Worth saying WHY an id can vanish: tasks live in memory, so a
		// restart of the service loses them while the conversation itself
		// survives in tmux. A caller that gets this has not lost the work.
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
	if !ok {
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
