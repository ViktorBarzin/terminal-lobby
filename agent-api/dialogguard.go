package main

// Keeping a Caller's keystrokes out of an open dialog.
//
// An Enter typed while Claude Code or the lobby's mod has a dialog up picks
// the dialog's highlighted row, and for a permission prompt that row is
// "1. Allow". Measured live on 2026-10-02 (rv-mf2-perm, rv-mf4-perm): a task
// blocked at a permission prompt was cancelled, Ctrl-C left the mod's dialog
// drawn and stamped the session done, the next message waited a minute for a
// settled prompt and was typed anyway, and the tool call nobody approved ran.
// Two changes close it. A cancel at a dialog declines the dialog through the
// mod before it interrupts, and checks that the dialog went. A message whose
// pane never settled is not typed while anything says a dialog is open.

import (
	"context"
	"fmt"
	"time"

	"terminal-lobby/sessionio"
)

// dialogSettle caps how long a cancel watches for a declined dialog, or a
// menu on the pane, to go. The mod's ack is immediate on a live box and the
// pane redraws within a frame, so this only runs out when something is wrong.
const dialogSettle = 3 * time.Second

// cancelWords is what Claude is told when a Caller cancels a turn that was
// waiting on a person.
const cancelWords = "The caller cancelled this turn. Do not run this and do not continue; stop here."

// settleWait is dialogSettle, or the start grace when that is shorter, which
// is what keeps the tests fast.
func (s *Server) settleWait() time.Duration {
	return min(s.startGrace(), dialogSettle)
}

// dialogInTheWay names the dialog that makes typing into the session unsafe,
// or "" when nothing says one is open. Three witnesses, any one enough: the
// mod reports one, @claude_state says the session waits on a person, or the
// pane draws a menu.
func (s *Server) dialogInTheWay(osUser, session, state string) string {
	if q := s.readQuestion(osUser, session); q.Kind != KindUnknown {
		return fmt.Sprintf("the lobby's mod reports a %s question open", q.Kind)
	}
	if state == sessionio.StateAwaiting {
		return "@claude_state says it is waiting on a person"
	}
	if pane, err := s.Sessions.Pane(osUser, session); err == nil && sessionio.ClaudeMenuOpen(pane) {
		return "the pane shows a menu"
	}
	return ""
}

// declineFor is the answer that turns a dialog down: a permission denied
// with words, a plan sent back with words, a question declined to chat.
// Never a row, so it cannot approve anything.
func declineFor(q questionReading) sessionio.AnswerRequest {
	out := sessionio.AnswerRequest{ToolID: q.ToolID}
	switch q.Kind {
	case KindPermission:
		out.Permission = &sessionio.PermissionAnswer{Decline: cancelWords}
	case KindPlan:
		out.Plan = &sessionio.PlanAnswer{Feedback: cancelWords}
	case KindChoice:
		words := cancelWords
		out.Chat = &words
	}
	return out
}

// interrupt stops the turn in a session for a cancel, and returns why it
// could not, or "". A dialog the mod holds is declined first and must be
// seen to go, because Ctrl-C does not take the mod's dialog down and its
// stamp of "done" would make the session look ready for the next message.
// Whatever Ctrl-C leaves drawn as a menu on the pane is reported too.
func (s *Server) interrupt(ctx context.Context, osUser, session, state string) string {
	if q := s.readQuestion(osUser, session); q.Kind != KindUnknown && q.ToolID != "" {
		resp, err := s.Sessions.AnswerDialog(ctx, osUser, session, declineFor(q))
		if !s.dialogGoes(osUser, session, q.ToolID) {
			why := resp.Reason
			if err != nil {
				why = err.Error()
			}
			return fmt.Sprintf("a %s dialog is still open in the session and declining it did not take it down (%s); "+
				"it is still waiting, so answer it in the lobby", q.Kind, why)
		}
	}
	if err := s.Sessions.Cancel(osUser, session); err != nil {
		return err.Error()
	}
	if s.menuStays(osUser, session) {
		if state == sessionio.StateAwaiting {
			// Cancel stamped done over a dialog that is still up; put the
			// state back, so nothing reads the session as ready.
			_ = s.Sessions.SetOption(osUser, session, sessionio.OptionState, sessionio.StateAwaiting)
		}
		return "a dialog is still drawn on the session's pane after the interrupt; " +
			"it is still waiting, so answer it in the lobby"
	}
	return ""
}

// dialogGoes reports whether the dialog toolID names closes within
// settleWait.
func (s *Server) dialogGoes(osUser, session, toolID string) bool {
	deadline := s.now().Add(s.settleWait())
	for {
		if q := s.readQuestion(osUser, session); q.Kind == KindUnknown || q.ToolID != toolID {
			return true
		}
		if !s.now().Before(deadline) {
			return false
		}
		time.Sleep(s.pollInterval())
	}
}

// menuStays reports whether the pane still draws a menu after settleWait.
func (s *Server) menuStays(osUser, session string) bool {
	deadline := s.now().Add(s.settleWait())
	for {
		pane, err := s.Sessions.Pane(osUser, session)
		if err != nil || !sessionio.ClaudeMenuOpen(pane) {
			return false
		}
		if !s.now().Before(deadline) {
			return true
		}
		time.Sleep(s.pollInterval())
	}
}
