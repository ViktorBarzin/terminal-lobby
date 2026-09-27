package sessionio

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"
)

// Putting a running Claude Code session into a permission mode, from the Text
// view's mode dial (POST /model/{session} with a "mode").
//
// There is no command for it. Shift+Tab is the only way the CLI changes mode in
// a running session, one stop per press, so the dial becomes a walk: press
// once, read the status line, and stop the moment the mode asked for shows.
// Until 2026-09-24 the dial pressed Shift+Tab once per click and read the pane
// back in the browser, so a reader who wanted plan clicked until it showed.
//
// THE CYCLE, measured on CLI 2.1.281 on 2026-09-24 (memory #13911), one
// Shift+Tab per send-keys run and the status line read after each:
//
//	plain `claude`                        manual > acceptEdits > plan > auto > manual
//	--dangerously-skip-permissions        bypassPermissions > auto > manual > acceptEdits > plan > bypassPermissions
//	--allow-dangerously-skip-permissions  manual > acceptEdits > plan > bypassPermissions > auto > manual
//	--permission-mode dontAsk             dontAsk > manual > acceptEdits > plan > auto > manual > …
//	disableAutoMode: "disable"            plan > manual > acceptEdits > plan
//
// So every session walks one order, manual, acceptEdits, plan,
// bypassPermissions, auto, and skips the stops it does not offer: bypass unless
// a flag allows it, auto where it is disabled. dontAsk is not a stop at all. A
// session can start in it, and the first press leaves it for manual and never
// comes back. The lobby starts its sessions with --dangerously-skip-permissions
// (devvm/start-claude.sh, skills-api restart), so bypass is on the cycle of
// nearly every session the dial will drive. The press works mid-turn too: a
// session at @claude_state running went manual > acceptEdits on one press.
//
// THE SAFETY RULE. While Claude works, a walk must not pass THROUGH bypass or
// dontAsk on its way somewhere else: a stop held for the 120 ms between two
// presses is that mode for whatever tool call lands in those 120 ms. Choosing
// one of them as the target is the reader's decision and is allowed. Which
// stops a given session offers cannot be read off the pane, so the check
// counts the bypass stop wherever the measured order puts it, and a walk from
// plan or acceptEdits back to manual, or from manual to auto, waits for the turn
// to end. A mode that shows where the order says it cannot, mid-walk while
// Claude works, ends the walk right there.

// The permission modes, by the CLI's own identifiers (`claude --help`).
const (
	ModeManual      = "manual"
	ModeAcceptEdits = "acceptEdits"
	ModePlan        = "plan"
	ModeBypass      = "bypassPermissions"
	ModeAuto        = "auto"
	ModeDontAsk     = "dontAsk"
)

// modeCycle is the order Shift+Tab walks, with every stop any session offers.
// See the table above; dontAsk is off it.
var modeCycle = []string{ModeManual, ModeAcceptEdits, ModePlan, ModeBypass, ModeAuto}

// maxModePresses bounds a walk: once round the whole cycle and one more. A walk
// that has not shown its target by then is not going to.
var maxModePresses = len(modeCycle) + 1

// modeVerify is how long the status line gets to show a press. It repaints in
// about 40 ms (measured 2026-08-17 for the chip, and the same on 2.1.281); the
// rest is a loaded box.
const modeVerify = time.Second

// ModeResult is the reply to a mode request.
type ModeResult struct {
	// Applied is true when the status line shows the mode asked for.
	Applied bool `json:"applied"`
	// Reason is one of the Mode* reasons below, empty when Applied.
	Reason string `json:"reason,omitempty"`
	// Mode is the mode the status line shows at the end, "" when it shows
	// none.
	Mode string `json:"mode"`
	// Presses is how many times Shift+Tab went in.
	Presses int `json:"presses"`
	// From is the mode the walk started from, for the server's own records.
	// It never goes on the wire.
	From string `json:"-"`
}

// ModeResult reasons.
const (
	// ModeUnavailable: the walk went round without showing the mode. The
	// session does not offer it, and the walk has come back to a mode it had
	// already shown, normally where it started.
	ModeUnavailable = "unavailable"
	// ModeUnsafePath: the walk would pass through bypass or dontAsk while
	// Claude works, refused before any press, or one of them showed mid-walk.
	ModeUnsafePath = "unsafe-path"
	// ModeDialogOpen: a dialog is drawn, or the hooks say one is about to be,
	// where Shift+Tab means something else. On the plan approval's feedback
	// row it approves the plan.
	ModeDialogOpen = "dialog-open"
	// ModeUnreadable: the pane shows no permission mode, so there is nothing
	// to walk from and nothing to check a press against.
	ModeUnreadable = "unreadable"
	// ModeUnverified: a press did not move the status line, and nothing
	// further is pressed.
	ModeUnverified = "unverified"
	// ModeRefused: tmux would not take the key.
	ModeRefused = "refused"
)

// NormalizeMode checks a mode identifier and maps the old name for manual,
// "default", onto it.
func NormalizeMode(s string) (string, bool) {
	if s == "default" {
		return ModeManual, true
	}
	switch s {
	case ModeManual, ModeAcceptEdits, ModePlan, ModeBypass, ModeAuto, ModeDontAsk:
		return s, true
	}
	return "", false
}

// The status line's phrase for each mode, as CLI 2.1.281 draws it, after its
// glyph: "⏸ manual mode on · ← for agents", "⏵⏵ accept edits on (shift+tab to
// cycle) · ← for agents". dontAsk reads "don't ask on", not "don't ask mode
// on". The older spelling is kept in case a build draws it.
var reModeLine = regexp.MustCompile(`^[^\pL\pN]*(bypass permissions on|accept edits on|auto mode on|manual mode on|plan mode on|don't ask on|don't ask mode on)\b`)

var modePhrases = map[string]string{
	"bypass permissions on": ModeBypass,
	"accept edits on":       ModeAcceptEdits,
	"auto mode on":          ModeAuto,
	"manual mode on":        ModeManual,
	"plan mode on":          ModePlan,
	"don't ask on":          ModeDontAsk,
	"don't ask mode on":     ModeDontAsk,
}

// PaneMode is the permission mode the pane's status line shows, or "" when it
// shows none.
//
// ONLY THE STATUS LINE. It sits under the input box, below the rule that
// closes it, and nothing but the status lines is drawn there. The same words
// anywhere above are the conversation, and a session discussing modes puts
// them there; reading them would walk from a mode the session is not in. When
// a dialog is up there is no input box and no status line, which is the
// answer "none" should give. The phrase has to open its line, after the glyph.
func PaneMode(pane string) string {
	lines := strings.Split(pane, "\n")
	below := -1
	for i := len(lines) - 1; i >= 0; i-- {
		if isRuleLine(lines[i]) {
			below = i
			break
		}
	}
	if below < 0 {
		return ""
	}
	for i := len(lines) - 1; i > below; i-- {
		if m := reModeLine.FindStringSubmatch(strings.TrimSpace(lines[i])); m != nil {
			return modePhrases[m[1]]
		}
	}
	return ""
}

// modePath is the stops a walk from `from` shows before it reaches `to`, in
// the measured order. From dontAsk the first stop is manual. A target that is
// not on the cycle is never reached, so the walk shows every stop.
func modePath(from, to string) []string {
	start := -1
	for i, m := range modeCycle {
		if m == from {
			start = i
		}
	}
	var path []string
	for k := 1; k <= len(modeCycle); k++ {
		stop := modeCycle[(start+k+len(modeCycle))%len(modeCycle)]
		if stop == to {
			return path
		}
		path = append(path, stop)
	}
	return path
}

// passesDanger reports whether a walk from `from` to `to` passes through bypass
// or dontAsk on its way.
func passesDanger(from, to string) bool {
	for _, m := range modePath(from, to) {
		if modeDangerous(m) {
			return true
		}
	}
	return false
}

// modeDangerous is a mode in which the session does not ask before acting.
func modeDangerous(m string) bool {
	return m == ModeBypass || m == ModeDontAsk
}

// SetMode walks a running session's permission mode to `target` with
// Shift+Tab, one press at a time, reading the status line after each, and
// answers with what the status line shows at the end.
//
// Nothing is pressed when the mode is already `target`, when a dialog is up or
// about to be, when the pane shows no mode, or when the walk would pass through
// bypass or dontAsk while Claude works. Before every press after the first the
// hooks' options are read again, because a turn can start mid-walk and a
// dialog can be announced: the PreToolUse that marks one fires about a second
// before it is drawn.
//
// The error is for a pane that could not be read at all; every refusal is a
// ModeResult.
func (in *Injector) SetMode(ctx context.Context, osUser, session, target string) (ModeResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	target, ok := NormalizeMode(target)
	if !ok {
		return ModeResult{}, errUnknownMode
	}
	// One walk at a time per session, and not while a plan answer types: two
	// walks interleaving their presses would each read the other's stops as
	// their own.
	unlock, err := in.lockSession(ctx, osUser, session)
	if err != nil {
		return ModeResult{}, err
	}
	defer unlock()
	stale, up, err := in.dialogPending(ctx, osUser, session)
	if err != nil {
		return ModeResult{}, err
	}
	if up {
		return ModeResult{Reason: ModeDialogOpen}, nil
	}
	pane, err := in.CapturePane(osUser, session)
	if err != nil {
		return ModeResult{}, err
	}
	from := PaneMode(pane)
	res := ModeResult{From: from, Mode: from}
	if from == "" {
		// No status line. A dialog in its place is the likely reason, and the
		// one worth naming, since Shift+Tab over a dialog is an answer.
		res.Reason = ModeUnreadable
		if ParsePlanDialog(pane) != nil || ParseDialog(pane) != nil {
			res.Reason = ModeDialogOpen
		}
		return res, nil
	}
	if from == target {
		res.Applied = true
		return res, nil
	}
	seen := map[string]bool{from: true}
	cur := from
	for res.Presses < maxModePresses {
		if res.Presses > 0 && in.dialogMarked(osUser, session, stale) {
			res.Reason = ModeDialogOpen
			return res, nil
		}
		busy := in.busy(osUser, session)
		if busy && passesDanger(cur, target) {
			res.Reason = ModeUnsafePath
			return res, nil
		}
		if err := in.Keys(osUser, session, []string{"BTab"}); err != nil {
			res.Reason = ModeRefused
			return res, nil
		}
		res.Presses++
		next, err := in.awaitModeChange(ctx, osUser, session, cur)
		if err != nil {
			return res, err
		}
		res.Mode = next
		switch {
		case next == "":
			res.Reason = ModeUnreadable
			return res, nil
		case next == cur:
			res.Reason = ModeUnverified
			return res, nil
		case next == target:
			res.Applied = true
			return res, nil
		case busy && modeDangerous(next):
			res.Reason = ModeUnsafePath
			return res, nil
		case seen[next]:
			res.Reason = ModeUnavailable
			return res, nil
		}
		seen[next], cur = true, next
	}
	res.Reason = ModeUnavailable
	return res, nil
}

// errUnknownMode is SetMode's answer to a mode the CLI does not have. The route
// checks with NormalizeMode first, so reaching it is a caller's mistake.
var errUnknownMode = errors.New("set mode: not a permission mode")

// awaitModeChange reads the status line until it shows something other than
// `was`, or modeVerify runs out, and returns what it shows then.
func (in *Injector) awaitModeChange(ctx context.Context, osUser, session, was string) (string, error) {
	deadline := time.Now().Add(modeVerify)
	for {
		if err := answerWait(ctx, keySettle); err != nil {
			return "", err
		}
		pane, err := in.CapturePane(osUser, session)
		if err != nil {
			return "", err
		}
		if m := PaneMode(pane); m != was || !time.Now().Before(deadline) {
			return m, nil
		}
	}
}

// busy reports whether Claude is working in the session, in the sense the
// safety rule means: a turn running or waiting on a person, or a background
// agent still going after the turn ended (OptionBackground).
func (in *Injector) busy(osUser, session string) bool {
	if st := in.State(osUser, session); st == StateRunning || st == StateAwaiting {
		return true
	}
	bg, _ := in.Option(osUser, session, OptionBackground)
	return strings.TrimSpace(bg) != ""
}

// dialogDraw is how long the hooks' marker (OptionAsk) may stand over a pane
// that still shows the status line before the marker is taken to be one no
// dialog followed. The PreToolUse that sets it fires about a second before the
// dialog is drawn (measured 2026-09-13). Nothing clears it when a question is
// escaped: Esc interrupts the turn, and none of the hooks the box wires fires
// for that (measured 2026-09-26, the pane back at its prompt and the marker
// still naming the escaped call). A var so a test can shorten it.
var dialogDraw = 3 * time.Second

// dialogPending reports whether a blocking dialog is up or about to be: the
// hooks' marker is set and the status line has gone, which a drawn dialog
// takes the place of. A marker whose status line stays drawn for dialogDraw is
// returned as `stale`, for the walk to ignore from then on. A marker that
// changes while it is watched is watched afresh, since a new id is a new
// dialog on its way.
func (in *Injector) dialogPending(ctx context.Context, osUser, session string) (stale string, up bool, err error) {
	ask, _ := in.Option(osUser, session, OptionAsk)
	deadline := time.Now().Add(dialogDraw)
	for ask != "" {
		pane, err := in.CapturePane(osUser, session)
		if err != nil {
			return "", false, err
		}
		if PaneMode(pane) == "" {
			return "", true, nil
		}
		if !time.Now().Before(deadline) {
			return ask, false, nil
		}
		if err := answerWait(ctx, keySettle); err != nil {
			return "", false, err
		}
		if now, _ := in.Option(osUser, session, OptionAsk); now != ask {
			ask, deadline = now, time.Now().Add(dialogDraw)
		}
	}
	return "", false, nil
}

// dialogMarked reports whether the hooks say a blocking dialog is up
// (OptionAsk), other than the marker dialogPending found stale.
func (in *Injector) dialogMarked(osUser, session, stale string) bool {
	ask, _ := in.Option(osUser, session, OptionAsk)
	return ask != "" && ask != stale
}
