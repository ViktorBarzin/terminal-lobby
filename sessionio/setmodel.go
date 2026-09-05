package sessionio

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// Driving a running TUI's own model picker. The parsing this leans on, and why
// a picker rather than a flag or a typed line, are in model.go.

const (
	// How long a picker gets to appear after the command that opens it, and how
	// often the pane is read while waiting. Measured on this box, both CLIs
	// draw in well under a second; the ceiling is for a session that is busy or
	// on a loaded box, and reaching it is an error rather than a longer wait.
	pickerWait = 8 * time.Second
	pickerPoll = 150 * time.Millisecond
	// How long the pane gets to settle after one keystroke before it is read
	// back. The TUIs repaint in ~40ms (the same figure the permission-mode chip
	// was measured at); this is generous enough that a read never catches a
	// half-drawn list.
	keySettle = 120 * time.Millisecond
	// How far the cursor may walk before the walk is called lost. Both lists
	// are five or six rows today; the bound exists so a picker that stops
	// responding ends the walk rather than the deadline.
	maxWalk = 16
	// How long to look for the "Switch model?" confirmation after a model has
	// been committed. Most switches raise none — it needs a conversation with a
	// warm cache — so this is a glance rather than a wait, and finding nothing
	// is the expected answer.
	switchWait = 1500 * time.Millisecond
	// How many times a saturating key is sent to pin a list at its first row or
	// a slider at its first step. Neither control wraps (measured), so this is
	// simply more presses than either has rows.
	saturate = 12
)

// SetModel puts a running session on a model, an effort level, or both, and
// answers with what the session reports afterwards.
//
// An empty field in `want` means "leave this one alone", which is not the same
// as asking for a level named default: codex's own picker always asks both
// questions, so leaving the effort alone there means confirming the row it is
// already on.
//
// Nothing is sent blind. Every step waits for the screen it expects, and the
// walk reads the cursor's own row back before pressing the key that commits —
// so a picker that opened somewhere unexpected ends as an error with the pane's
// own words in it, rather than as a keystroke in somebody's conversation.
func (in *Injector) SetModel(ctx context.Context, osUser, session string, h Harness, want ModelState) (ModelState, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if want.Model == "" && want.Effort == "" {
		return ModelState{}, fmt.Errorf("set model: nothing to set")
	}
	switch h {
	case HarnessClaude:
		return in.setClaudeModel(ctx, osUser, session, want)
	case HarnessCodex:
		return in.setCodexModel(ctx, osUser, session, want)
	}
	return ModelState{}, fmt.Errorf("set model: %q has no model to pick", h)
}

// setClaudeModel drives Claude Code's two separate pickers. They are separate
// commands and separate screens, so asking for both is two passes; asking for
// one leaves the other exactly as it was.
func (in *Injector) setClaudeModel(ctx context.Context, osUser, session string, want ModelState) (ModelState, error) {
	if want.Model != "" {
		if err := in.openPicker(ctx, osUser, session, "/model", "Select model"); err != nil {
			return ModelState{}, err
		}
		if err := in.walkTo(ctx, osUser, session, want.Model); err != nil {
			in.escape(osUser, session)
			return ModelState{}, err
		}
		// `s` is "use this session only". Enter here would write the choice as
		// the account's default for every session started afterwards.
		if err := in.rawKeys(osUser, session, "s"); err != nil {
			return ModelState{}, fmt.Errorf("set model: %w", err)
		}
		if err := in.awaitClosed(ctx, osUser, session, "Select model"); err != nil {
			return ModelState{}, err
		}
		if err := in.confirmSwitch(ctx, osUser, session); err != nil {
			return ModelState{}, err
		}
	}
	if want.Effort != "" {
		if err := in.setClaudeEffort(ctx, osUser, session, want.Effort); err != nil {
			return ModelState{}, err
		}
	}
	pane, err := in.CapturePane(osUser, session)
	if err != nil {
		return ModelState{}, fmt.Errorf("set model: reading the pane back: %w", err)
	}
	// The model is deliberately echoed rather than read: a stock Claude pane
	// says nothing about which model it is on, and the line under the input
	// belongs to whatever statusLine command the account configured. What the
	// walk confirmed — the cursor sat on this row before `s` was pressed — is
	// the evidence. The effort DOES have a hint of its own, so it is read.
	return ModelState{Model: want.Model, Effort: ClaudeEffortHint(pane)}, nil
}

// confirmSwitch answers the "Switch model?" dialog, when there is one.
//
// It appears only when the conversation already has a warm cache — a session
// that has taken a turn — and it appears AFTER the picker has committed, so
// nothing before this point can see it. Left unanswered it sits on the pane
// blocking the session, with the driver having reported success: measured on
// 2026-09-05, driving a session from Haiku to Opus from the chip.
//
// A short look, not a wait. Most switches raise nothing at all, and spending
// the picker's whole deadline on every one of them would make the common case
// the slow one.
func (in *Injector) confirmSwitch(ctx context.Context, osUser, session string) error {
	deadline := time.Now().Add(switchWait)
	for {
		pane, err := in.CapturePane(osUser, session)
		if err == nil {
			yes, ok := SwitchPrompt(pane)
			if ok {
				if err := in.walkTo(ctx, osUser, session, yes); err != nil {
					in.escape(osUser, session)
					return fmt.Errorf("confirming the switch: %w", err)
				}
				if err := in.rawKeys(osUser, session, "Enter"); err != nil {
					return fmt.Errorf("confirming the switch: %w", err)
				}
				return in.awaitClosed(ctx, osUser, session, "Switch model?")
			}
		}
		if !time.Now().Before(deadline) || ctx.Err() != nil {
			return nil // no confirmation was raised, which is the common case
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(pickerPoll):
		}
	}
}

// setClaudeEffort drives the slider. It is pinned at its first step and then
// walked forward, rather than counted from where it happens to be: the ▲ marks
// a column rather than a row, so its position is a pixel measurement of a
// proportional bar and not something to arithmetic on.
func (in *Injector) setClaudeEffort(ctx context.Context, osUser, session, effort string) error {
	if err := in.openPicker(ctx, osUser, session, "/effort", "←/→ to adjust"); err != nil {
		return err
	}
	pane, err := in.CapturePane(osUser, session)
	if err != nil {
		in.escape(osUser, session)
		return fmt.Errorf("set effort: reading the slider: %w", err)
	}
	ladder, ok := EffortLadder(pane)
	if !ok {
		in.escape(osUser, session)
		return fmt.Errorf("set effort: this build's effort slider is not the one expected (%v)", ClaudeEfforts)
	}
	steps, ok := effortSteps(ladder, effort)
	if !ok {
		in.escape(osUser, session)
		return fmt.Errorf("set effort: %q is not one of %v", effort, ladder)
	}
	if err := in.rawKeys(osUser, session, repeat("Left", saturate)...); err != nil {
		return fmt.Errorf("set effort: %w", err)
	}
	if steps > 0 {
		time.Sleep(keySettle)
		if err := in.rawKeys(osUser, session, repeat("Right", steps)...); err != nil {
			return fmt.Errorf("set effort: %w", err)
		}
	}
	time.Sleep(keySettle)
	if err := in.rawKeys(osUser, session, "s"); err != nil {
		return fmt.Errorf("set effort: %w", err)
	}
	return in.awaitClosed(ctx, osUser, session, "←/→ to adjust")
}

// setCodexModel drives codex's one flow, which asks both questions in a row:
// the model, then the reasoning level, with Max and Ultra behind a third
// screen. There is no "this session only" key — codex writes the choice to
// ~/.codex/config.toml either way — so the caller is expected to have said so.
func (in *Injector) setCodexModel(ctx context.Context, osUser, session string, want ModelState) (ModelState, error) {
	if err := in.openPicker(ctx, osUser, session, "/model", "Select Model"); err != nil {
		return ModelState{}, err
	}
	if want.Model != "" {
		if err := in.walkTo(ctx, osUser, session, want.Model); err != nil {
			in.escape(osUser, session)
			return ModelState{}, err
		}
	}
	if err := in.rawKeys(osUser, session, "Enter"); err != nil {
		return ModelState{}, fmt.Errorf("set model: %w", err)
	}
	if err := in.awaitPane(ctx, osUser, session, "Select Reasoning Level"); err != nil {
		return ModelState{}, err
	}
	if want.Effort != "" {
		row, ok := CodexEffortLabel(want.Effort)
		if !ok {
			in.escape(osUser, session)
			return ModelState{}, fmt.Errorf("set effort: %q is not one of %v", want.Effort, CodexEfforts)
		}
		if CodexEffortIsAdvanced(want.Effort) {
			// Max and Ultra are not on this screen. "More reasoning…" is the
			// row that opens the one they are on.
			if err := in.walkTo(ctx, osUser, session, "More reasoning…"); err != nil {
				in.escape(osUser, session)
				return ModelState{}, err
			}
			if err := in.rawKeys(osUser, session, "Enter"); err != nil {
				return ModelState{}, fmt.Errorf("set effort: %w", err)
			}
			if err := in.awaitPane(ctx, osUser, session, "Advanced Reasoning"); err != nil {
				return ModelState{}, err
			}
		}
		if err := in.walkTo(ctx, osUser, session, row); err != nil {
			in.escape(osUser, session)
			return ModelState{}, err
		}
	}
	if err := in.rawKeys(osUser, session, "Enter"); err != nil {
		return ModelState{}, fmt.Errorf("set model: %w", err)
	}
	if err := in.awaitClosed(ctx, osUser, session, "Press enter to confirm"); err != nil {
		return ModelState{}, err
	}
	pane, err := in.CapturePane(osUser, session)
	if err != nil {
		return ModelState{}, fmt.Errorf("set model: reading the pane back: %w", err)
	}
	return CodexState(pane), nil
}

// openPicker types the command that opens a picker and waits for the screen it
// names. The command goes through Prompt — a bracketed paste rather than typed
// keystrokes — which is also what keeps codex's slash-command popup out of the
// way: typed, `/model` raises a completion list that eats the first Enter.
func (in *Injector) openPicker(ctx context.Context, osUser, session, command, screen string) error {
	if err := in.Prompt(osUser, session, command); err != nil {
		return fmt.Errorf("opening %s: %w", command, err)
	}
	return in.awaitPane(ctx, osUser, session, screen)
}

// awaitPane waits for the pane to show a phrase, or gives up saying what it
// was showing instead.
func (in *Injector) awaitPane(ctx context.Context, osUser, session, phrase string) error {
	deadline := time.Now().Add(pickerWait)
	for {
		pane, err := in.CapturePane(osUser, session)
		if err == nil && strings.Contains(pane, phrase) {
			return nil
		}
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("waiting for %q: %w", phrase, err)
		}
		if !time.Now().Before(deadline) {
			return fmt.Errorf("session %s never showed %q — is it mid-turn?", session, phrase)
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("waiting for %q: %w", phrase, ctx.Err())
		case <-time.After(pickerPoll):
		}
	}
}

// awaitClosed is the other half: the picker committed and went away. A screen
// that is still up after the commit key means the key was not taken, which is
// the difference between "set" and "asked to set".
func (in *Injector) awaitClosed(ctx context.Context, osUser, session, phrase string) error {
	deadline := time.Now().Add(pickerWait)
	for {
		pane, err := in.CapturePane(osUser, session)
		if err == nil && !strings.Contains(pane, phrase) {
			return nil
		}
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("waiting for %q to close: %w", phrase, err)
		}
		if !time.Now().Before(deadline) {
			in.escape(osUser, session)
			return fmt.Errorf("session %s kept the picker open after the choice was made", session)
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("waiting for %q to close: %w", phrase, ctx.Err())
		case <-time.After(pickerPoll):
		}
	}
}

// walkTo moves the picker's cursor onto a row by NAME.
//
// It pins the list at its first row and then steps down one at a time, reading
// the cursor's own row back after each step. Two reasons it is not a jump to an
// index: a list taller than the pane shows a window of itself, so the row that
// is wanted may not be on screen to count to — and pressing a digit is not a
// move in Claude Code, it is a commit, and the thing it commits is the account
// default.
func (in *Injector) walkTo(ctx context.Context, osUser, session, label string) error {
	if err := in.rawKeys(osUser, session, repeat("Up", saturate)...); err != nil {
		return fmt.Errorf("walking to %q: %w", label, err)
	}
	// Every row the cursor has stood on. Coming back to one is how the walk
	// knows it has seen the whole list, and it covers both shapes: Claude's
	// picker saturates at its last row, codex's wraps to its first.
	seen := map[string]bool{}
	for step := 0; step < maxWalk; step++ {
		time.Sleep(keySettle)
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("walking to %q: %w", label, err)
		}
		pane, err := in.CapturePane(osUser, session)
		if err != nil {
			return fmt.Errorf("walking to %q: %w", label, err)
		}
		opts := PickerOptions(pane)
		if len(opts) == 0 {
			return fmt.Errorf("walking to %q: the picker closed", label)
		}
		cur, ok := CursorOption(opts)
		if !ok {
			return fmt.Errorf("walking to %q: the picker shows no cursor", label)
		}
		if strings.EqualFold(cur.Label, label) {
			return nil
		}
		if seen[cur.Label] {
			return fmt.Errorf("%q is not offered here — this session lists %s", label, labels(opts))
		}
		seen[cur.Label] = true
		if err := in.rawKeys(osUser, session, "Down"); err != nil {
			return fmt.Errorf("walking to %q: %w", label, err)
		}
	}
	return fmt.Errorf("walking to %q: gave up after %d steps", label, maxWalk)
}

// escape backs out of whatever is on screen. Best-effort by design: it runs on
// the failure paths, where the error the caller is about to see is the thing
// worth reporting.
func (in *Injector) escape(osUser, session string) {
	_ = in.rawKeys(osUser, session, "Escape")
}

// rawKeys sends keys the answerKeys allowlist does not carry — `s`, and long
// runs of arrows.
//
// It bypasses Keys deliberately and is NOT reachable from a browser: the
// vocabulary here is fixed by the code above, one keystroke per verified
// screen, whereas Keys is a channel a client fills in. Widening that allowlist
// to spell `s` would make every letter sendable, which is the boundary it
// exists to hold (see answerKeys).
func (in *Injector) rawKeys(osUser, session string, keys ...string) error {
	if len(keys) == 0 {
		return fmt.Errorf("keys: nothing to send")
	}
	args := append([]string{"send-keys", "-t", exactPane(session)}, keys...)
	return in.Command(osUser, args...).Run()
}

// repeat is one key, n times, as the separate arguments send-keys takes.
// `send-keys -N <n>` looks like it would do this and does not: measured on tmux
// 3.4 against a live picker, `-N 12 Up` moved the cursor no rows at all while
// the same key twelve times over moved it to the top.
func repeat(key string, n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = key
	}
	return out
}

// labels names what a picker was showing, for an error a person has to act on.
func labels(opts []PickerOption) string {
	names := make([]string, 0, len(opts))
	for _, o := range opts {
		names = append(names, o.Label)
	}
	return strings.Join(names, ", ")
}
