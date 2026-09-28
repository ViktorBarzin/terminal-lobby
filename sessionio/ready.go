package sessionio

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// promptMark is the character Claude Code draws at its input line. It is the
// cheapest available evidence that the TUI has finished starting and is reading
// keys, and it is only ever used to decide whether to WAIT — never to decide
// what to send — so a future redesign of the prompt costs a bounded wait and a
// log line, not a lost prompt.
const promptMark = "❯"

// codexPromptMark is the same evidence for codex, which draws › where Claude
// draws ❯. Read by PromptMark rather than assumed anywhere, so a caller that
// does not know the harness still gets Claude's, which is what every caller
// before the model picker existed was already asking for.
const codexPromptMark = "›"

// PromptMark is the character a harness draws at its input line, and "" for
// pi, which draws no fixed one: pi's readiness is its pane title instead
// (AwaitReady, pi.go). A caller that does not know the harness gets Claude's,
// which is what every caller before the model picker existed was asking for.
func PromptMark(h Harness) string {
	switch h {
	case HarnessClaude:
		return promptMark
	case HarnessCodex:
		return codexPromptMark
	case HarnessPi:
		return ""
	}
	return promptMark
}

// readyStable is how long the pane must hold still, on top of showing a prompt,
// before input is sent. Claude Code paints the prompt and then keeps drawing
// (the restored conversation, the status line); a capture taken mid-repaint is
// a moving target, and typing into one is how the Enter went missing.
const readyStable = 300 * time.Millisecond

// CapturePane returns the visible text of the session's active pane.
func (in *Injector) CapturePane(osUser, session string) (string, error) {
	out, err := in.Command(osUser, "capture-pane", "-p", "-t", exactPane(session)).Output()
	if err != nil {
		return "", fmt.Errorf("capture-pane %s: %w", session, err)
	}
	return string(out), nil
}

// AwaitInputReady blocks until the session's pane is drawn, showing a prompt,
// and has stopped changing — or gives up.
//
// WHY THIS EXISTS. A resurrected session is created and its Claude starts, but
// `claude --resume` spends about a second loading the transcript before it
// paints anything, and the SessionStart hook fires at the START of that window.
// So the transcript stamp — everything else in the bridge waits on it — says
// "there is a Claude here" well before that Claude is reading keys.
//
// What happens if you type into the gap is worse than losing the input outright,
// because it half-works. Measured on 2026-08-16 against a real resumed session:
// the bracketed paste survived and appeared on the input line intact, and the
// Enter that should have submitted it did not — leaving the prompt sitting
// there unsent, the turn never running, and the thread showing a user message
// that Claude never saw. A later Enter submitted the same text and it answered
// normally, which is what pinned the cause to readiness rather than to the
// paste.
//
// Giving up is reported, never swallowed. The caller decides whether to type
// anyway: for a resurrection, typing into a pane that never drew a prompt is
// strictly better than dropping the prompt, and the operator can see both the
// session and the log line.
func (in *Injector) AwaitInputReady(ctx context.Context, osUser, session string, wait, poll time.Duration) error {
	return in.AwaitPromptMark(ctx, osUser, session, promptMark, wait, poll)
}

// AwaitPromptMark is AwaitInputReady against a harness other than Claude — the
// same wait, watching for whatever that TUI draws at its input line
// (see PromptMark).
func (in *Injector) AwaitPromptMark(ctx context.Context, osUser, session, mark string, wait, poll time.Duration) error {
	if mark == "" {
		mark = promptMark
	}
	return in.awaitSettled(ctx, osUser, session, func(text string) bool {
		return strings.Contains(text, mark)
	}, wait, poll)
}

// AwaitCodexReady is AwaitInputReady for codex, which draws its › in two
// places: at the head of its input line, and as the cursor of every menu it
// raises. Measured on codex-cli 0.158.0 on 2026-09-28: a fresh session drew
// "› Ask Codex to do anything" at 0.8 s and, 0.2 s later on this box, a
// "Cannot use the background server" dialog with "› 2. Cancel". A prompt and
// Enter typed while such a menu is up pick its highlighted row, so the wait
// holds for the input line alone (CodexInputReady).
func (in *Injector) AwaitCodexReady(ctx context.Context, osUser, session string, wait, poll time.Duration) error {
	return in.awaitSettled(ctx, osUser, session, CodexInputReady, wait, poll)
}

// CodexInputReady reports whether a codex pane shows its input line and no
// menu: a line opening with › that is not a numbered row, and no line where
// › marks one.
func CodexInputReady(pane string) bool {
	input := false
	for _, line := range strings.Split(pane, "\n") {
		t := strings.TrimSpace(stripDialogBorder(line))
		rest, ok := strings.CutPrefix(t, codexPromptMark)
		if !ok {
			continue
		}
		if reCodexMenuRow.MatchString(strings.TrimSpace(rest)) {
			return false
		}
		input = true
	}
	return input
}

// CodexMenuOpen reports whether a codex pane has a menu up: a line where
// codex's › marks a numbered row. A prompt's paste and Enter there pick the
// highlighted row; on 2026-09-28 every codex start on the devvm opened the
// "Cannot use the background server" menu with its cursor on "2. Cancel",
// and a Text view send quit codex. A pane that shows Claude's ❯ anywhere is
// Claude's, whose menus other readers handle, so it is never a codex menu
// here, whatever its conversation quotes.
func CodexMenuOpen(pane string) bool {
	if strings.Contains(pane, promptMark) {
		return false
	}
	for _, line := range strings.Split(pane, "\n") {
		t := strings.TrimSpace(stripDialogBorder(line))
		rest, ok := strings.CutPrefix(t, codexPromptMark)
		if ok && reCodexMenuRow.MatchString(strings.TrimSpace(rest)) {
			return true
		}
	}
	return false
}

// reCodexMenuRow is a numbered menu row, the text after codex's cursor in a
// dialog ("2. Cancel", "1. Yes, continue").
var reCodexMenuRow = regexp.MustCompile(`^[0-9]+\.\s`)

// awaitSettled blocks until ready holds for the pane and the pane has stopped
// changing for readyStable, or gives up.
func (in *Injector) awaitSettled(ctx context.Context, osUser, session string, ready func(string) bool, wait, poll time.Duration) error {
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
	var last string
	var lastAt time.Time

	for {
		text, err := in.CapturePane(osUser, session)
		// A read that fails is treated as not-ready rather than fatal: a pane
		// can be momentarily unreadable while the session is being set up, and
		// the deadline already bounds how long that can go on.
		if err == nil && ready(text) {
			switch {
			case text != last:
				last, lastAt = text, time.Now()
			case time.Since(lastAt) >= readyStable:
				return nil
			}
		}

		if err := ctx.Err(); err != nil {
			return fmt.Errorf("waiting for session %s to accept input: %w", session, err)
		}
		if !time.Now().Before(deadline) {
			return fmt.Errorf("session %s drew no settled prompt within %s", session, wait)
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("waiting for session %s to accept input: %w", session, ctx.Err())
		case <-time.After(poll):
		}
	}
}
