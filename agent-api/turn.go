package main

// Running one turn, and watching it to the end.
//
// This is the only part of the service that is not request/response, and the
// only part that can get a wrong answer quietly. Two mistakes are easy here
// and both were designed against:
//
// Reading @claude_state too early. A prompt lands and the state still says
// "done" from the PREVIOUS turn for the moment it takes the hook to fire, so a
// watcher that trusted the first read would report the turn finished before it
// started and hand back the previous answer as this one's result.
//
// Reading the transcript from the top. The result must be this turn's final
// message, so the watcher records how long the transcript was BEFORE it
// injected and reads only what arrived after.

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"terminal-lobby/sessionio"
)

// paneQuestionLimit caps the text lifted off a pane when a session is waiting
// on a human and no dialog could be parsed. Enough to see what is being asked,
// short enough that a task view is not a screenshot.
const paneQuestionLimit = 1200

// runTurn is the Runner's Turn function: one message, start to finish.
func (s *Server) runTurn(t *Task) {
	cancelled := s.Tasks.Cancelled(t.ID)
	select {
	case <-cancelled:
		// Cancelled while queued. Nothing has been injected, so there is
		// nothing to interrupt and nothing to clean up.
		return
	default:
	}

	// Whatever happens below, the turn happened as far as the suspend sweep
	// is concerned: the Caller was using this conversation.
	defer s.stampTurnOf(t)

	if !s.wake(t) {
		return
	}

	// How much history there is BEFORE this turn, once the session is ready
	// to take one.
	mark, ok := s.awaitReady(t, cancelled)
	if !ok {
		return // cancelled while waiting
	}

	// Resolved again here rather than reused from the wait above, because the
	// wait can take a minute and a rename during it would send this message
	// to a name that no longer exists.
	live, err := s.find(t.OSUser, t.ConversationID)
	if err != nil {
		s.fail(t, "conversation %s is no longer live, so the message was not sent", t.ConversationID)
		return
	}
	send := s.Sessions.Prompt
	if t.uncleared {
		send = s.Sessions.PromptUncleared
	}
	// Taken before the paste, so every record this turn writes is stamped
	// at or after it (the transcript and this clock are the same machine's).
	t.sentAt = s.now()
	// A dialog that took the input box's place at the Enter leaves the pane
	// unable to say whether the message went (sessionio.ErrSubmitUnconfirmed).
	// The transcript can, and the watcher below reads it: a turn that never
	// starts fails there, one that does is followed as usual.
	if err := send(t.OSUser, live.Name, t.Text); err != nil && !errors.Is(err, sessionio.ErrSubmitUnconfirmed) {
		s.fail(t, "sending the message to %s failed: %v", t.ConversationID, err)
		return
	}
	// running only once the paste has landed, so "accepted" keeps meaning
	// what its docstring says: nothing has reached Claude.
	s.Tasks.Update(t.ID, StatusRunning, nil)

	s.watchTurn(t, mark, cancelled)
}

// wake resumes the conversation when tmux-api's idle sweep suspended it, and
// reports whether the turn may go on.
//
// Here rather than in the request, for two reasons. The runner holds one turn
// per conversation at a time, so two messages to a sleeping conversation
// resume it once: the second finds it awake. And the wait that follows,
// awaitReady, is exactly the wait a cold `claude --resume` needs (1.7-3.1 s
// measured), so the paste lands on a drawn prompt rather than into the boot.
//
// A session that is no longer there is left for runTurn to report, and one
// that turns out to be awake already — a person clicked it in the lobby in
// the meantime — is what the turn wanted anyway.
func (s *Server) wake(t *Task) bool {
	live, err := s.find(t.OSUser, t.ConversationID)
	if err != nil || !live.Suspended {
		return true
	}
	err = s.Sessions.Resume(t.OSUser, live.Name)
	if err == nil || errors.Is(err, sessionio.ErrNotSuspended) {
		return true
	}
	s.fail(t, "conversation %s was suspended after sitting idle and could not be resumed (%v), "+
		"so the message was not sent; its transcript is still on disk", t.ConversationID, err)
	return false
}

// stampTurnOf stamps the turn clock under the name the session has now. A
// session that has gone (deleted while the turn ran) has nothing to stamp.
func (s *Server) stampTurnOf(t *Task) {
	if live, err := s.find(t.OSUser, t.ConversationID); err == nil {
		s.stampTurn(t.OSUser, live.Name)
	}
}

// unknownMark means the transcript could not be read, which is a different
// answer from knowing it is empty. The watcher needs the difference: an empty
// history makes any new line evidence that this turn started, while an
// unreadable one makes no line evidence of anything.
const unknownMark = -1

// awaitReady waits until a prompt can actually be sent, and returns how many
// transcript lines exist at that moment. ok=false means the caller cancelled
// while waiting.
//
// It waits on the PANE and not on the transcript, and the distinction is the
// whole function. The obvious version waited for @claude_transcript to point
// at a readable file before sending, on the reasoning that a turn whose
// history cannot be read cannot be reported. Measured against a real Claude
// on 2026-09-16, that deadlocks: the SessionStart hook stamps the path within
// a second, and Claude Code does not CREATE the file until the first message
// arrives — so the gate waited for a file that only sending would produce,
// and every first message to a new conversation failed after the timeout.
// The same measurement found 7 of 25 stamped sessions on this box pointing at
// a file that is not there, so the state is ordinary rather than exotic.
//
// What is waited for instead is the pane: drawn, showing a prompt, and still.
// sessionio measured the cost of skipping that one — the bracketed paste
// lands on the input line and the Enter does not, so the turn never runs and
// the conversation shows a message the agent never saw. A pane that never
// settles is logged and the message is sent anyway, which is sessionio's own
// reasoning: typing into a pane that never drew a prompt is a gamble, and
// dropping the caller's message is a certainty.
//
// The session is resolved TWICE, and the second one is not redundant. See the
// comment on the second call.
func (s *Server) awaitReady(t *Task, cancelled <-chan struct{}) (int, bool) {
	live, err := s.find(t.OSUser, t.ConversationID)
	if err != nil {
		// Not a failure here: the caller's message has not been sent, and
		// runTurn resolves again and reports it properly.
		return unknownMark, true
	}
	if err := s.Sessions.WaitReady(t.OSUser, live.Name,
		s.readyTimeout(), s.pollInterval()); err != nil {
		// Sending anyway is right: dropping the message outright is worse, and
		// a busy pane queues it. But HOW it is sent has to change. Prompt's
		// C-e C-u prelude needs something running that reads them as line
		// editing, and a pane that never drew a prompt has nothing that does,
		// so they arrive as literal text glued to the front of the message.
		// Nothing is on that input line to clear either, which is what makes
		// dropping the prelude safe here and only here.
		t.uncleared = true
		logf("agent-api: %s never settled at its prompt (%v); sending without "+
			"the line-clearing prelude, which it could not interpret yet",
			t.ConversationID, err)
	}
	// The wait above can take a minute, so the cancel is re-checked before
	// anything is injected.
	select {
	case <-cancelled:
		return 0, false
	default:
	}

	// Resolved AGAIN, because the name above is up to readyTimeout old and
	// tmux-api renames a session from the content of its first turn. Reading
	// the transcript under a name that has moved does not fail loudly: the
	// option read misses, SessionMap.Get says no, and TranscriptLines answers
	// errNoTranscript — which is indistinguishable from an empty history and
	// would mark a conversation with hundreds of lines as starting at 0.
	// watchTurn would then find a transcript longer than 0 on its first tick,
	// take that as proof this turn had started, believe the PREVIOUS turn's
	// leftover "done", and hand the caller the previous turn's final message
	// as this one's answer. Reachable on the sequence this service was built
	// for: a queued message drained the moment the turn ahead of it ends,
	// which is when the rename lands.
	live, err = s.find(t.OSUser, t.ConversationID)
	if err != nil {
		// Gone while we waited, or renamed to something this service can no
		// longer resolve. NOT a mark of zero: an unknown mark is what stops a
		// leftover "done" from being believed, and runTurn resolves once more
		// and reports the failure properly.
		return unknownMark, true
	}

	lines, err := s.Sessions.TranscriptLines(t.OSUser, live.Name)
	switch {
	case err == nil:
		return len(lines), true
	case errors.Is(err, errNoTranscript) && strings.TrimSpace(live.State) != "":
		// A Claude has already run a turn here (something stamped its
		// state), so there IS history; only the stamp saying where it is
		// is missing. Measured live on 2026-10-02: the mod could not name
		// the transcript during a conversation's first turn, and reading
		// this as an empty history handed the second message the first
		// one's answer. Unknown, not zero.
		return unknownMark, true
	case errors.Is(err, errNoTranscript):
		// Nothing written yet, which for a conversation created a moment ago
		// is the normal state. The whole file, when it appears, is this turn.
		return 0, true
	default:
		// A real read failure. Not knowing how much history there is is not
		// a reason to refuse to send; it is a reason not to treat a line
		// count as evidence.
		logf("agent-api: %s: cannot read the transcript before this turn (%v); "+
			"sending anyway and reading the answer from the whole file", t.ConversationID, err)
		return unknownMark, true
	}
}

// watchTurn polls the session until the turn ends, the caller cancels, or the
// ceiling is reached.
func (s *Server) watchTurn(t *Task, mark int, cancelled <-chan struct{}) {
	start := s.now()
	graceEnd := start.Add(s.startGrace())
	deadline := start.Add(s.turnTimeout())

	tick := time.NewTicker(s.pollInterval())
	defer tick.Stop()

	sawRunning := false
	asked := false // the pane has been read for this needs_input episode
	// doneSince is when the state last turned "done" without the transcript
	// holding this turn's answer yet; bgSince is when the turn first came to
	// rest with background work outstanding.
	var doneSince, bgSince time.Time

	for {
		select {
		case <-cancelled:
			// The cancel endpoint has already stamped the status and sent the
			// interrupt. Letting go of the session here is the whole job.
			return
		case <-tick.C:
		}

		// Re-resolved every tick rather than held, because tmux-api renames a
		// session from the content of its first turn and that lands MID-TURN
		// on anything that takes longer than about twenty seconds. A watcher
		// holding the old name would report the conversation as gone at the
		// moment it started being useful.
		live, err := s.find(t.OSUser, t.ConversationID)
		if err != nil {
			s.fail(t, "the tmux session for conversation %s is gone; the turn cannot be followed",
				t.ConversationID)
			return
		}

		state := strings.TrimSpace(live.State)
		if state == "" {
			state = s.stateFromTranscript(t, live.Name, mark)
		}
		switch state {
		case sessionio.StateRunning:
			sawRunning, asked = true, false
			doneSince = time.Time{}
			s.Tasks.Update(t.ID, StatusRunning, nil)

		case sessionio.StateAwaiting:
			sawRunning = true
			doneSince = time.Time{}
			if !asked {
				// Read the pane once per episode, not once per poll: a
				// capture is a fork, and the question does not change while
				// the dialog stands.
				asked = true
				q := s.readQuestion(t.OSUser, live.Name)
				s.Tasks.Update(t.ID, StatusNeedsInput, func(tk *Task) { tk.setQuestion(q) })
			} else if v, _ := s.Tasks.Get(t.ID); v.Status == StatusRunning {
				// Answered through POST /v1/tasks/{id}/answer, which put the
				// task back to running while @claude_state still says
				// awaiting. It goes on saying so for as long as an approved
				// tool runs, because nothing stamps running until the next
				// tool call or prompt (devvm/claude-tmux-state). So the pane
				// is read on every poll in this window, and only a dialog a
				// parser recognises counts as the next question: the bottom
				// of a pane that is busy working is not one.
				if q := s.readQuestion(t.OSUser, live.Name); q.Kind != KindUnknown {
					s.Tasks.Update(t.ID, StatusNeedsInput, func(tk *Task) { tk.setQuestion(q) })
				}
			}

		case sessionio.StateDone:
			// The race this whole function exists for. "done" before the hook
			// has stamped this turn is the PREVIOUS turn's state, so it is
			// only believed once the turn has visibly started — or once the
			// transcript proves it did. And started is not finished: the
			// answer is read from this turn's own records, and only once one
			// has been written after the last thing said to Claude.
			lines, readErr := s.Sessions.TranscriptLines(t.OSUser, live.Name)
			if readErr == nil && mark != unknownMark && mark > len(lines) {
				// The transcript shrank, which means it was rotated or
				// replaced under us. Anything read now belongs to a
				// different conversation.
				s.fail(t, "the transcript for %s was replaced while the turn ran; "+
					"the answer cannot be attributed to this message", t.ConversationID)
				return
			}
			var turn [][]byte
			if readErr == nil {
				turn = turnLines(lines, mark, t.sentAt)
			}
			answer, settled := turnAnswer(turn)
			started := sawRunning ||
				(readErr == nil && mark != unknownMark && len(lines) > mark) ||
				(mark == unknownMark && answer != "")
			if !started {
				if s.now().After(graceEnd) {
					s.fail(t, "the message was sent to %s but no turn started within %s "+
						"(is a Claude running in that session?)", t.ConversationID, s.startGrace())
					return
				}
				break
			}
			if !settled {
				// The state can say done a moment before the answer's line
				// is on disk, and a turn can end without one (an abort). A
				// grace tells the two apart.
				if doneSince.IsZero() {
					doneSince = s.now()
				}
				if s.now().Sub(doneSince) > s.startGrace() {
					if readErr != nil {
						s.fail(t, "the turn in %s finished but its transcript could not be read: %v",
							t.ConversationID, readErr)
					} else {
						s.fail(t, "the turn in %s finished without an assistant message", t.ConversationID)
					}
					return
				}
				break
			}
			// Background work this turn started re-enters the session when it
			// ends (a <task-notification> starts a new turn), and that turn
			// carries the real answer. Measured live on 2026-10-02: settling
			// here handed a Caller "I'm waiting for the background command"
			// as the result.
			if bg := backgroundOutstanding(turn); len(bg) > 0 {
				if bgSince.IsZero() {
					bgSince = s.now()
				}
				if s.now().Sub(bgSince) < s.backgroundHold() {
					s.Tasks.Update(t.ID, StatusRunning, nil)
					break
				}
				s.settle(t, answer, true)
				return
			}
			s.settle(t, answer, false)
			return

		default:
			// Unstamped, and the transcript shows no turn either. sessionio
			// is firm that this is not "finished" — it means no Claude ever
			// ran here, which for a session that was just prompted means the
			// text went to a shell.
			if s.now().After(graceEnd) {
				s.fail(t, "conversation %s has no Claude in it (@claude_state is unset), "+
					"so the message reached a plain shell", t.ConversationID)
				return
			}
		}

		if s.now().After(deadline) {
			s.fail(t, "the turn in %s has run for more than %s and is no longer being followed; "+
				"the session is untouched and its transcript still has the answer",
				t.ConversationID, s.turnTimeout())
			return
		}
	}
}

// stateFromTranscript stands in for @claude_state while nothing has stamped
// it, reading this turn's records instead: "" when they show no turn, running
// while one is under way, done once it has ended.
//
// @claude_state is written by session-events when the lobby's mod reports,
// and a mod can be late or never come at all. Measured live on 2026-10-02:
// of 172 conversations created that day, 21 took more than 10 s to say hello
// and five near 60 s, each of those failed its first message after the 15 s
// start grace; rv-me-upload's mod never said hello in its 3 min 20 s life.
// Every one of those Claudes ran its turn and wrote the answer to its
// transcript. So the transcript decides, and the grace below only fails a
// session that shows no sign of a turn in either place.
//
// The end of a turn is Claude Code's own turn-end record (system
// "turn_duration"), never the last assistant line: a turn says "Let me look"
// before its first tool call, and settling there would hand the caller the
// turn's opening words as its answer.
func (s *Server) stateFromTranscript(t *Task, session string, mark int) string {
	lines, err := s.Sessions.TranscriptLines(t.OSUser, session)
	if err != nil {
		return ""
	}
	if mark != unknownMark && mark > len(lines) {
		// Replaced under us; the done branch reports it.
		return sessionio.StateDone
	}
	turn := turnLines(lines, mark, t.sentAt)
	if len(turn) == 0 {
		return ""
	}
	if turnEnded(turn) {
		return sessionio.StateDone
	}
	return sessionio.StateRunning
}

// settle records this turn's answer.
func (s *Server) settle(t *Task, answer string, background bool) {
	s.Tasks.Update(t.ID, StatusDone, func(tk *Task) {
		tk.Result = answer
		tk.BackgroundRunning = background
	})
}

// paneTail is the last of a pane's visible text, trimmed of the blank lines a
// terminal pads with and capped at limit bytes.
func paneTail(pane string, limit int) string {
	text := strings.TrimRight(pane, " \t\r\n")
	if len(text) <= limit {
		return strings.TrimSpace(text)
	}
	cut := text[len(text)-limit:]
	// Start at a line boundary so the tail does not open mid-word.
	if i := strings.IndexByte(cut, '\n'); i >= 0 && i < len(cut)-1 {
		cut = cut[i+1:]
	}
	return strings.TrimSpace(cut)
}

// fail records a terminal failure. The refusal of an already-terminal task is
// expected and ignored: a cancel landing first wins, by design.
func (s *Server) fail(t *Task, format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	s.Tasks.Update(t.ID, StatusFailed, func(tk *Task) { tk.Error = msg })
}
