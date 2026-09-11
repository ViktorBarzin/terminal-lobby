package sessionio

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// gridNameRe bounds a session name that will be embedded in a shell command
// inside a tmux hook. It is deliberately the same charset tmux-attach.sh and
// tmux-api already enforce on session names, so a name that reaches here has
// been through three independent checks and still cannot carry a quote, a
// space, a newline or a shell metacharacter.
var gridNameRe = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,32}$`)

// gridHooks are the events that should move a grid: someone starts driving,
// someone's terminal changes shape, or someone stops driving.
//
// tmux has no hook for a client being USED, which is the fourth thing that
// moves an unpinned window and the gap SizeGrid fills from the browser side.
var gridHooks = []string{"client-attached", "client-resized", "client-detached"}

// gridHookMark is a version stamp carried inside the hook, as an inert `:`
// argument the shell discards.
//
// A pin laid down by an older build names the right session and still resizes,
// so nothing about it reads as stale — and it would keep an old hook for the
// life of the session, since a pin is never reverted. Marking the text lets
// GridPinStale tell "pinned by a build that thought differently" from "pinned
// correctly", which turns repairStaleGridPins into the deploy path for a hook
// change. Bump it whenever gridHook's behaviour changes.
const gridHookMark = "tl-grid-v2"

// gridSizeMax bounds a grid a client may ask for. tmux's own limit is far
// higher; this is only here so a browser reporting nonsense mid-layout cannot
// reach a tmux command with it.
const gridSizeMax = 10000

// PinGrid makes a session's size belong exclusively to its READ-WRITE clients.
// After it runs, a read-only client can attach, resize, or be the only client
// left, and the window does not move.
//
// WHY THIS IS NEEDED AT ALL. tmux already ignores read-only clients when it
// sizes a window — `attach -r` implies the ignore-size client flag — but only
// while at least one read-write client is attached (resize.c: ignore_client_size
// skips read-only clients "if there are any attached clients that aren't
// read-only"). When the last read-write client goes, that skip lapses and the
// window snaps to the watcher's terminal. On this box that is not an edge case:
// term.html drops its WebSocket after the tab has been hidden 60s to spare the
// radio, so an owner who pockets their phone hands their grid to whoever is
// watching, and has it reflowed back on their return.
//
// HOW. Take the size out of tmux's hands (window-size manual) and give it back
// to read-write clients explicitly, via hooks that resize the window to the
// last read-write client each time the client set changes.
//
// Idempotent, because every read-only attach calls it. Never reverted: a
// session that has been watched keeps its pin for life, since unpinning would
// mean tracking watcher liveness to decide when it is safe, and the pinned
// behaviour differs from tmux's default only in the cases this exists to change.
func (in *Injector) PinGrid(osUser, session string) error {
	if !gridNameRe.MatchString(session) {
		return fmt.Errorf("pin grid: unsafe session name %q", session)
	}
	// Exact target, never a prefix match: tmux resolves an absent name by
	// unambiguous prefix and exits 0 doing it, so without `=` a pin meant for a
	// dead session would silently reconfigure a live neighbour.
	target := exactPane(session)

	// Read the size BEFORE pinning, and put it back afterwards.
	//
	// Switching a live window to `manual` does not freeze it where it is — it
	// reverts it to the size the window was CREATED at, discarding whatever
	// `latest` had negotiated since. Measured on 3.4: a window born 80x24, with
	// a 190x56 client attached and sitting at 190x55, snaps straight back to
	// 80x24 the moment the option is set. In production that is a session
	// jumping to its birth size the instant somebody starts watching it, which
	// is the opposite of this function's whole purpose.
	//
	// A pin must be invisible to the person driving. Capture, pin, restore.
	size, err := in.Command(osUser, "display", "-p", "-t", target,
		"#{window_width} #{window_height}").Output()
	if err != nil {
		return fmt.Errorf("pin grid %s: read size: %w", session, err)
	}
	var w, h int
	if _, serr := fmt.Sscanf(strings.TrimSpace(string(size)), "%d %d", &w, &h); serr != nil || w <= 0 || h <= 0 {
		return fmt.Errorf("pin grid %s: unreadable size %q", session, strings.TrimSpace(string(size)))
	}

	if out, err := in.Command(osUser, "set-option", "-t", target,
		"window-size", "manual").CombinedOutput(); err != nil {
		return fmt.Errorf("pin grid %s: window-size: %v: %s",
			session, err, strings.TrimSpace(string(out)))
	}
	if out, err := in.Command(osUser, "resize-window", "-t", target,
		"-x", fmt.Sprint(w), "-y", fmt.Sprint(h)).CombinedOutput(); err != nil {
		return fmt.Errorf("pin grid %s: restore %dx%d: %v: %s",
			session, w, h, err, strings.TrimSpace(string(out)))
	}
	hook := in.gridHook(session)
	for _, name := range gridHooks {
		if out, err := in.Command(osUser, "set-hook", "-t", target,
			name, hook).CombinedOutput(); err != nil {
			return fmt.Errorf("pin grid %s: %s: %v: %s",
				session, name, err, strings.TrimSpace(string(out)))
		}
	}
	return nil
}

// RepinGrid re-points a pinned session's hooks at the name it has NOW.
//
// PinGrid bakes the session name into all three hooks, so a rename leaves them
// naming a session that no longer resolves. Each one then fails into its own
// `|| true` and nothing resizes the window, while `window-size` stays `manual` —
// the one combination that freezes a grid permanently.
//
// Found live 2026-09-05: session `hjtedz8zrn7h`, renamed from `ux` by the
// ADR-0019 id migration, sat at 58x38 with a 92x58 client attached and hooks
// reading `resize-window -t =ux:` against a server holding no session `ux`. It
// had stopped following the phone it was being read on.
//
// A session that was NEVER pinned is left alone: pinning one here would take its
// sizing away from tmux on nothing more than a rename, and the pin exists for
// watched sessions only.
//
// The unpin before the repin is deliberate. `window-size manual` is already set,
// so PinGrid's capture-pin-restore would faithfully preserve the FROZEN size;
// clearing the option first lets tmux snap the window back onto its read-write
// client, and PinGrid then captures that.
func (in *Injector) RepinGrid(osUser, session string) error {
	if !gridNameRe.MatchString(session) {
		return fmt.Errorf("repin grid: unsafe session name %q", session)
	}
	pinned, err := in.gridPinned(osUser, session)
	if err != nil {
		return err
	}
	if !pinned {
		return nil
	}
	if out, err := in.Command(osUser, "set-option", "-u", "-t", exactPane(session),
		"window-size").CombinedOutput(); err != nil {
		return fmt.Errorf("repin grid %s: unpin: %v: %s",
			session, err, strings.TrimSpace(string(out)))
	}
	return in.PinGrid(osUser, session)
}

// GridPinStale reports a pin that is not the pin this build would lay down.
//
// Three ways that happens, and the sweep in tmux-api/repair_grid_pins.go repairs
// all three the same way:
//
//   - The hooks name a session that is no longer this one, which is what a
//     rename leaves behind: every hook fails into its own `|| true` and the
//     window can never resize again.
//   - The hooks carry no resizer at all: the same freeze by a shorter route.
//   - The hooks predate gridHookMark's current value, so they are a working pin
//     from a build that decided differently. Nothing about one is broken, but a
//     pin is never reverted, so without this it would keep an old hook for the
//     life of the session.
//
// `window-size manual` is required for all three: it alone is just a pin, and
// none of the hook states above can happen without it.
func (in *Injector) GridPinStale(osUser, session string) (bool, error) {
	if !gridNameRe.MatchString(session) {
		return false, fmt.Errorf("grid pin: unsafe session name %q", session)
	}
	pinned, err := in.gridPinned(osUser, session)
	if err != nil || !pinned {
		return false, err
	}
	out, err := in.Command(osUser, "show-hooks", "-t", exactPane(session)).Output()
	if err != nil {
		return false, fmt.Errorf("grid pin %s: read hooks: %w", session, err)
	}
	hooks := string(out)
	if !strings.Contains(hooks, "resize-window") {
		return true, nil
	}
	if !strings.Contains(hooks, gridHookMark) {
		return true, nil
	}
	return !strings.Contains(hooks, "-t "+exactPane(session)+" "), nil
}

// SizeGrid points a PINNED session's window at one client's terminal grid, and
// answers whether it moved anything.
//
// THE GAP THIS FILLS. A pinned window moves on three hooks and nothing else
// (gridHooks), and none of them fires for the case that matters most in the
// lobby: a session you switch BACK to. Every session you open stays mounted and
// CSS-hidden (frontend-v2/src/store/keepalive.ts), so its ttyd client never
// detaches and its pty keeps the size it always had. No attach, no detach, no
// resize — and the kernel skips SIGWINCH for a TIOCSWINSZ that changes nothing,
// so even a resize the browser sends anyway reaches no hook. The window
// therefore keeps whatever the last client to attach left it at, which is how a
// desktop ends up reading a 60-column window in a 220-column pane after a phone
// joined the same session. Reloading the page is the only thing that fixed it,
// because that is an attach.
//
// So the client being READ says so explicitly, and this is what it says.
//
// AN UNPINNED SESSION IS LEFT ALONE, and that is load-bearing rather than
// polite: `resize-window` sets `window-size manual` as a side effect, so sizing
// one here would pin every session the lobby was pointed at, taking it out of
// tmux's hands for good. An unpinned session already follows the client being
// used, which is the behaviour this call is trying to give a pinned one back.
//
// WHO MAY CALL IT. Nothing here checks that the caller is not a watcher — a
// read-only client asking to be the size is exactly what PinGrid exists to
// refuse, so that decision belongs to the caller, and tmux-api's handler makes
// it. The guard here is the narrower one: a name that can reach a tmux target
// safely, and a grid with a window left in it.
//
// `rows` is the size of the CLIENT'S TERMINAL, not of the window. The status
// lines come off the height here, the same arithmetic gridHook does, so callers
// send what they measured and nothing has to know about tmux's chrome.
func (in *Injector) SizeGrid(osUser, session string, cols, rows int) (bool, error) {
	if !gridNameRe.MatchString(session) {
		return false, fmt.Errorf("size grid: unsafe session name %q", session)
	}
	if cols < 1 || cols > gridSizeMax || rows < 1 || rows > gridSizeMax {
		return false, fmt.Errorf("size grid %s: grid %dx%d out of range", session, cols, rows)
	}
	pinned, err := in.gridPinned(osUser, session)
	if err != nil || !pinned {
		return false, err
	}

	target := exactPane(session)
	n, err := in.statusLines(osUser, target)
	if err != nil {
		return false, fmt.Errorf("size grid %s: read status: %w", session, err)
	}
	h := rows - n
	if h < 1 {
		return false, fmt.Errorf("size grid %s: %d rows leaves no window under %d status line(s)",
			session, rows, n)
	}

	if out, err := in.Command(osUser, "resize-window", "-t", target,
		"-x", fmt.Sprint(cols), "-y", fmt.Sprint(h)).CombinedOutput(); err != nil {
		return false, fmt.Errorf("size grid %s: %dx%d: %v: %s",
			session, cols, h, err, strings.TrimSpace(string(out)))
	}
	return true, nil
}

// statusLines is how many rows the status bar takes off a client's height.
//
// The same reading gridHook does in shell, and deliberately the same fallbacks:
// tmux 3.4 has no `#{status_lines}`, so `#{status}` yields the option's word —
// `off`, `on`, or a count 2..5 — and anything unrecognised counts as one,
// matching tmux's own default rather than reaching the arithmetic with a
// surprise.
func (in *Injector) statusLines(osUser, target string) (int, error) {
	out, err := in.Command(osUser, "display", "-p", "-t", target, "#{status}").Output()
	if err != nil {
		return 0, err
	}
	s := strings.TrimSpace(string(out))
	if s == "off" {
		return 0, nil
	}
	if len(s) == 1 {
		if n, err := strconv.Atoi(s); err == nil {
			return n, nil
		}
	}
	return 1, nil
}

// gridPinned reports whether this session's size is under PinGrid's control.
//
// `show-options -qv` without `-g` reads the SESSION-scoped value only, so an
// unpinned session answers empty even though the global default is `latest`.
// Nothing else on this box sets `window-size` at session scope.
func (in *Injector) gridPinned(osUser, session string) (bool, error) {
	out, err := in.Command(osUser, "show-options", "-qv", "-t", exactPane(session),
		"window-size").Output()
	if err != nil {
		return false, fmt.Errorf("repin grid %s: read window-size: %w", session, err)
	}
	return strings.TrimSpace(string(out)) == "manual", nil
}

// gridHook is the command all three hooks run: resize the window to the
// read-write client that was USED most recently, or leave it exactly as it is
// when there is none.
//
// WHY ACTIVITY AND NOT ATTACH ORDER. This took `tail -1` until 2026-09-06, and
// tmux's client list is attach order — measured on 3.4, a client attaching into
// a slot freed by a detach still lands at the end — so the last device to
// attach owned the grid for as long as the session lived. An unpinned window
// does better than that for free: `window-size latest` follows
// `client_activity`, so the desktop being typed into takes the window back from
// the phone that joined after it (measured on 3.4 with two read-write clients
// at 200x50 and 100x30). Pinning was quietly trading that away, and a desktop
// reading a session a phone had joined stayed squeezed until somebody reloaded.
// `client_activity` puts it back.
//
// The `tac` before the sort is the tie-break: activity has one-second
// resolution, and `sort -s` is stable, so clients stamped in the same second
// come out in reverse attach order and `head -1` picks the one that attached
// last. That is exactly what `tail -1` did, so a session nobody has typed into
// behaves as it did before.
//
// It reads the LIVE CLIENT LIST rather than the client that triggered the hook,
// because a hook's own `#{client_*}` is the server's *current* client, not the
// one the event happened to — measured on 3.4: with a watcher attached, the
// owner resizing their terminal fires client-resized with the WATCHER's flags
// and size. Guarding on those would skip the owner's resize and honour the
// watcher's, i.e. precisely backwards. list-clients has no such ambiguity.
//
// Two escaping rules make this work, and both are load-bearing:
//
//  1. The command is SINGLE-quoted at the tmux level, so tmux's parser performs
//     no `$` expansion — `$w` and `$h` reach the shell intact. Nothing inside
//     may contain a single quote; there is no way to escape one.
//  2. `##{...}` for the inner format. run-shell expands formats in its command
//     string before running it, so a bare `#{client_width}` would be replaced
//     with the current client's width and every listed row would come out
//     identical. Doubling the `#` defers evaluation to the inner tmux, which is
//     the one actually iterating clients.
//
// Backgrounded (-b) so a hook can issue a tmux command without waiting on the
// server that is running it. The socket is threaded through explicitly because
// the hook's shell cannot know which server invoked it — without -L, a test on
// an isolated socket would reach across to the user's real one.
//
//  3. The hook says NOTHING and FAILS AT NOTHING, because run-shell reports
//     either one by drawing over the pane. Measured on 3.4, and `-b` prevents
//     neither: a backgrounded run-shell puts the pane into view-mode if its
//     command writes to stdout OR if it merely exits non-zero — the latter
//     with an empty overlay, which covers the conversation just as completely
//     and explains even less. It stays up until somebody presses q.
//
//     This is what reached production. A watched session showed four lines of
//     `'tmux list-clients -t =video_support: -F "` and read as dead, while
//     claude was alive underneath the whole time. Those lines are tmux's own
//     `'<command>' returned <status>` message, quoted and then cut off at the
//     pane's width — the session was 42 columns wide, so that is all of it
//     that fitted. The status being reported was `resize-window` refusing a
//     computed height of zero or less ("height too small") for a client whose
//     own height had not settled yet.
//
//     Hence the brace group (so the redirect covers the whole pipeline — a
//     failing `list-clients` writes from the FIRST stage) and hence `|| true`.
//     Silencing alone is not enough: the exit status alone is sufficient to
//     paint. A hook firing on every attach, detach and resize has no business
//     reporting anything to the person driving, so it reports nothing.
func (in *Injector) gridHook(session string) string {
	sock := ""
	if in.socket != "" {
		sock = "-L " + in.socket + " "
	}
	target := exactPane(session)
	// The status line is NOT part of the window. tmux sizes a window to the
	// client's height MINUS its status lines, so resizing to the raw
	// client_height makes the window one row taller than the visible area and
	// hides its bottom row behind the status bar. Measured on 3.4 with a 190x56
	// client: tmux chooses 190x55 with `status on`, 190x54 with `status 2`.
	//
	// The subtraction is done here rather than in a format because 3.4 has no
	// #{status_lines}; #{status} yields the option's word — off, on, or a count
	// 2..5. An unrecognised value falls back to 1, matching tmux's default,
	// rather than reaching the arithmetic and breaking the resize entirely.
	return fmt.Sprintf(
		`run-shell -b '{ : %s; tmux %slist-clients -t %s `+
			`-F "##{client_activity} ##{client_flags} ##{client_width} ##{client_height}" `+
			`| grep -v read-only | tac | sort -s -k1,1rn | head -1 `+
			`| while read a f w h; do `+
			`s=$(tmux %sdisplay -p -t %s "##{status}"); `+
			`case $s in off) n=0;; [0-9]) n=$s;; *) n=1;; esac; `+
			`tmux %sresize-window -t %s -x $w -y $((h-n)); done; `+
			`} >/dev/null 2>&1 || true'`,
		gridHookMark, sock, target, sock, target, sock, target)
}
