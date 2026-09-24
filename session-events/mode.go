package main

import (
	"context"
	"errors"
	"net/http"

	"terminal-lobby/sessionio"
	"terminal-lobby/telemetry"
)

// The mode dial: POST /model/{session} with {"mode": "<identifier>"}.
//
// ON THE EXISTING ROUTE, NOT A NEW ONE. Every path this service serves is
// allow-listed one by one in the infra repo's IngressRoute (DEPLOY.md has the
// list), so a new prefix would need a change in another repository before a
// single request could reach it. /model already carries the other settings
// the dial's neighbours change, and a body field is additive.
//
// The walk itself, one Shift+Tab at a time with the status line read back and
// never through bypass or don't ask while Claude works, is
// sessionio.Injector.SetMode. This file is the route's half: check the
// identifier, run the walk, answer with what it reports, record it.

// modeSetter is the half of sessionio.Injector the mode dial uses. An
// interface so the route is tested without tmux, as answerDriver is.
type modeSetter interface {
	SetMode(ctx context.Context, osUser, session, target string) (sessionio.ModeResult, error)
}

// serveMode answers a mode request.
//
// A REFUSAL IS A 200, as on POST /answer: applied false, a reason, and the mode
// the status line shows, which is what the dial redraws from. Non-200 is kept
// for a malformed request, which types nothing, and for a pane that cannot be
// read at all.
func serveMode(w http.ResponseWriter, r *http.Request, drv modeSetter, osUser, session, mode string) {
	target, ok := sessionio.NormalizeMode(mode)
	if !ok {
		http.Error(w, "bad mode (one of manual, acceptEdits, plan, auto, bypassPermissions, dontAsk)",
			http.StatusBadRequest)
		return
	}
	res, err := drv.SetMode(r.Context(), osUser, session, target)
	if err != nil {
		http.Error(w, "cannot read the pane", http.StatusBadGateway)
		// A reader who navigated away mid-walk is not a failure of the walk,
		// for the reason handleAnswer gives.
		if r.Context().Err() == nil && !errors.Is(err, context.Canceled) {
			emitMode(osUser, session, target, sessionio.ModeResult{Reason: answerUnreadable})
		}
		return
	}
	emitMode(osUser, session, target, res)
	writeJSON(w, res)
}

// emitMode records one mode request in the two names the Text view's answers
// use, text.answer_sent and text.answer_failed, with tl.action mode.
//
// The same two names rather than one of its own because it is the same kind of
// record: the Text view driving the pane for a reader, applied or refused with
// a reason, one record per request. tl.client api-mode keeps it out of any
// query over answers, which reads tl.client api-answer. No claude.answered: a
// mode change answers no blocking prompt.
//
// tl.from is the mode the walk started from and tl.to the one asked for, both
// the CLI's own identifiers, never anything from the conversation; tl.count is
// the Shift+Tab presses it took.
func emitMode(osUser, session, target string, res sessionio.ModeResult) {
	event := "text.answer_sent"
	if !res.Applied {
		event = "text.answer_failed"
	}
	attrs := telemetry.Attrs{
		"tl.session": session, "tl.client": "api-mode", "tl.action": sessionio.ActionMode,
		"tl.to": target, "tl.count": res.Presses,
	}
	if res.From != "" {
		attrs["tl.from"] = res.From
	}
	if res.Reason != "" {
		attrs["tl.reason"] = res.Reason
	}
	events.Emit(event, osUser, attrs)
}
