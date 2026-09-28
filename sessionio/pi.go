package sessionio

import (
	"context"
	"fmt"
	"log"
	"regexp"
	"strings"
	"time"
)

// Pi, the third harness (docs/plans/2026-09-25-pi-harness-design.md): when
// its pane can take a prompt, how a model switch typed into it is confirmed,
// and what interrupting it sends.
//
// Pi does not draw a fixed mark at its input line the way Claude draws ❯, and
// it draws neither its model nor its thinking level anywhere a capture could
// read reliably. Two things stand in. Pi titles its terminal `π - <dir>` once
// its interactive mode is up, which is the readiness signal. The lobby's pi
// extension (devvm/pi-extension.js) stamps the model and level into pane
// options, which is how a switch is read back.
//
// Measured against pi 0.87.1 on 2026-09-25.

// piTitlePrefix is how pi's terminal title starts: `π - <dir>`, or
// `π - <session name> - <dir>` once the session is named (interactive mode's
// updateTerminalTitle). Pi writes it after startup has finished, which
// includes after any project-trust question has been answered.
const piTitlePrefix = "π - "

// piTrustQuestion heads pi's project-trust dialog, and piTrustRefusal is the
// option only that dialog offers. The dialog is a list, so a pasted line and an
// Enter would answer it: with its first row, which is "Trust".
const (
	piTrustQuestion = "Trust project folder?"
	piTrustRefusal  = "Do not trust"
)

// piSwitchWait bounds how long a typed `/model` or `/thinking` gets to show up
// in the extension's stamps. Pi applies either in well under a second when the
// model is in its cached catalogue; the ceiling is for a loaded box, and
// reaching it is an error that says what the pane options read instead.
const piSwitchWait = 3 * time.Second

// piModelRefRe is the launch gate's pattern for a pi model reference, the same
// literal as PI_MODEL_RE in devvm/tmux-user-attach. It admits no whitespace, so
// nothing typed through it can carry a second line.
var piModelRefRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@/~-]{0,95}$`)

// PiThinkingLevels are pi's levels, in pi's order. Which of them a model
// supports is the extension's to stamp (OptionPiLevels); this is the whole set.
var PiThinkingLevels = []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"}

// ValidPiModelRef reports whether ref is a pi model reference the lobby would
// launch or type.
func ValidPiModelRef(ref string) bool { return piModelRefRe.MatchString(ref) }

// ValidPiThinking reports whether level is one of pi's levels.
func ValidPiThinking(level string) bool {
	for _, l := range PiThinkingLevels {
		if level == l {
			return true
		}
	}
	return false
}

// IsPiTitle reports whether a pane title is one pi wrote.
func IsPiTitle(title string) bool { return strings.HasPrefix(title, piTitlePrefix) }

// PiAsksForTrust reports whether a pane shows pi's project-trust dialog: its
// question on a line of its own and, below it, the refusal the dialog offers.
// Both, because the question alone can turn up in a conversation about pi.
func PiAsksForTrust(pane string) bool {
	asked := false
	for _, line := range strings.Split(pane, "\n") {
		text := strings.TrimSpace(stripDialogBorder(line))
		if text == piTrustQuestion {
			asked = true
			continue
		}
		if asked && strings.Contains(text, piTrustRefusal) {
			return true
		}
	}
	return false
}

// PaneTitle is the session's active pane title, ok=false when the session
// could not be read.
func (in *Injector) PaneTitle(osUser, session string) (string, bool) {
	return in.Option(osUser, session, "pane_title")
}

// HarnessOf says which harness a session is running, as far as its pane says
// so, and "" when it does not. Only pi says so: its title is its own and needs
// no extension. Claude and Codex are left to the caller, who knows them from
// the process tree; this is for a route that was not told.
func (in *Injector) HarnessOf(osUser, session string) Harness {
	if title, ok := in.PaneTitle(osUser, session); ok && IsPiTitle(title) {
		return HarnessPi
	}
	return ""
}

// AwaitReady waits until the session can take a prompt, by whatever the
// harness offers as evidence: Claude's and Codex's input marks, pi's title. A
// harness nobody named gets Claude's wait, which is what AwaitInputReady has
// always been.
func (in *Injector) AwaitReady(ctx context.Context, osUser, session string, h Harness, wait, poll time.Duration) error {
	switch h {
	case HarnessPi:
		return in.AwaitPiReady(ctx, osUser, session, wait, poll)
	case HarnessCodex:
		return in.AwaitCodexReady(ctx, osUser, session, wait, poll)
	case HarnessClaude:
		return in.AwaitPromptMark(ctx, osUser, session, PromptMark(h), wait, poll)
	}
	return in.AwaitInputReady(ctx, osUser, session, wait, poll)
}

// AwaitPiReady blocks until pi has titled its pane and no trust question is on
// screen, and has held that for readyStable, or gives up.
//
// The title is written after startup has finished and after a trust question
// raised at startup has been answered, so it covers the start of every
// session. The pane check covers the one case the title cannot: a trust
// question raised later, by a session switched to in another folder, while the
// title from before still stands.
//
// Giving up is reported, never swallowed, and the caller decides what to do,
// exactly as for AwaitPromptMark.
func (in *Injector) AwaitPiReady(ctx context.Context, osUser, session string, wait, poll time.Duration) error {
	if wait <= 0 {
		wait = 30 * time.Second
	}
	if poll <= 0 {
		poll = 200 * time.Millisecond
	}
	if ctx == nil {
		ctx = context.Background()
	}
	deadline := time.Now().Add(wait)
	var since time.Time
	for {
		if in.piReady(osUser, session) {
			if since.IsZero() {
				since = time.Now()
			} else if time.Since(since) >= readyStable {
				return nil
			}
		} else {
			since = time.Time{}
		}
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("waiting for session %s to accept input: %w", session, err)
		}
		if !time.Now().Before(deadline) {
			return fmt.Errorf("session %s: pi was not ready for input within %s", session, wait)
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("waiting for session %s to accept input: %w", session, ctx.Err())
		case <-time.After(poll):
		}
	}
}

// piReady is one look: pi's title stands and the trust question is not up. A
// read that fails is not-ready, for the reason AwaitPromptMark gives.
func (in *Injector) piReady(osUser, session string) bool {
	title, ok := in.PaneTitle(osUser, session)
	if !ok || !IsPiTitle(title) {
		return false
	}
	pane, err := in.CapturePane(osUser, session)
	return err == nil && !PiAsksForTrust(pane)
}

// PiTrustPending reports whether the session's pane is showing pi's trust
// question now. A pane that cannot be read is not reported as asking: the
// callers use this to refuse, and refusing on a failed read would refuse every
// prompt to a session that is merely slow to answer.
func (in *Injector) PiTrustPending(osUser, session string) bool {
	pane, err := in.CapturePane(osUser, session)
	return err == nil && PiAsksForTrust(pane)
}

// CancelHarness interrupts the session's turn with the key its harness takes.
// Pi's is Escape: Ctrl-C clears pi's editor, and a second one exits pi, which
// closes the session. Claude and Codex keep Cancel, Ctrl-C and all, as does a
// harness nobody named.
func (in *Injector) CancelHarness(osUser, session string, h Harness) error {
	switch h {
	case HarnessPi:
		return in.cancelPi(osUser, session)
	case HarnessClaude, HarnessCodex:
		return in.Cancel(osUser, session)
	}
	return in.Cancel(osUser, session)
}

// cancelPi sends Escape and settles a running turn.
//
// The extension stamps done when pi reports a turn settled, and an aborted run
// is expected to report it too; the stamp here is the fallback that keeps the
// dot off running if it does not, the way Cancel covers Claude's Stop hook not
// firing on an interrupt. Only RUNNING is settled. An awaiting pi has a dialog
// up, which Escape dismisses without ending the turn, and the extension
// re-stamps that from ui_prompt_end; stamping done over it would report a
// working session as finished.
func (in *Injector) cancelPi(osUser, session string) error {
	if err := in.Command(osUser, "send-keys", "-t", exactPane(session), "Escape").Run(); err != nil {
		return err
	}
	if in.State(osUser, session) != StateRunning {
		return nil
	}
	if err := in.Command(osUser, "set-option", "-t", exactPane(session), OptionState, StateDone).Run(); err != nil {
		log.Printf("cancel %s/%s: stamping %s failed: %v", osUser, session, OptionState, err)
	}
	return nil
}

// setPiModel types pi's own commands, `/model <provider/id>` and `/thinking
// <level>`, and reads the result back from the extension's stamps.
//
// Typed lines rather than pi's pickers, because pi's lines switch directly and
// for this session only: `/model` with an argument calls setModel with
// persist:false, and `/thinking` applies the level without saving it. Each is
// confirmed before the next is typed. An unknown model makes pi open its model
// selector with the reference as the search, so a model that never lands is
// followed by an Escape, and the thinking line is not typed into that selector.
func (in *Injector) setPiModel(ctx context.Context, osUser, session string, want ModelState) (ModelState, error) {
	if want.Model != "" && !ValidPiModelRef(want.Model) {
		return ModelState{}, fmt.Errorf("set model: %q is not a pi model reference", want.Model)
	}
	if want.Effort != "" && !ValidPiThinking(want.Effort) {
		return ModelState{}, fmt.Errorf("set thinking: %q is not one of pi's levels (%s)",
			want.Effort, strings.Join(PiThinkingLevels, ", "))
	}
	if want.Model != "" {
		if err := in.Prompt(osUser, session, "/model "+want.Model); err != nil {
			return ModelState{}, fmt.Errorf("set model: %w", err)
		}
		if err := in.awaitPiStamp(ctx, osUser, session, OptionPiModel, want.Model); err != nil {
			in.escape(osUser, session)
			return ModelState{}, err
		}
	}
	if want.Effort != "" {
		if err := in.Prompt(osUser, session, "/thinking "+want.Effort); err != nil {
			return ModelState{}, fmt.Errorf("set thinking: %w", err)
		}
		if err := in.awaitPiStamp(ctx, osUser, session, OptionPiThinking, want.Effort); err != nil {
			return ModelState{}, err
		}
	}
	return in.piModelState(osUser, session), nil
}

// awaitPiStamp polls one of the extension's options until it reads want.
// Matching ignores case: pi resolves a reference case-insensitively and stamps
// the catalogue's own spelling.
func (in *Injector) awaitPiStamp(ctx context.Context, osUser, session, option, want string) error {
	deadline := time.Now().Add(piSwitchWait)
	for {
		if got, ok := in.Option(osUser, session, option); ok && strings.EqualFold(got, want) {
			return nil
		}
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("waiting for pi to switch: %w", err)
		}
		if !time.Now().Before(deadline) {
			st := in.piModelState(osUser, session)
			return fmt.Errorf("pi did not switch to %q within %s: the pane reads model %q, thinking %q",
				want, piSwitchWait, st.Model, st.Effort)
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("waiting for pi to switch: %w", ctx.Err())
		case <-time.After(pickerPoll):
		}
	}
}

// piModelState is what the extension last stamped: the model as provider/id
// and the thinking level. Empty fields mean nothing was stamped, which is a
// pi without the lobby's extension.
func (in *Injector) piModelState(osUser, session string) ModelState {
	model, _ := in.Option(osUser, session, OptionPiModel)
	effort, _ := in.Option(osUser, session, OptionPiThinking)
	return ModelState{Model: model, Effort: effort}
}
