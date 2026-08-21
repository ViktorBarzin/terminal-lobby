package sessionio

import (
	"fmt"
	"regexp"
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
var gridHooks = []string{"client-attached", "client-resized", "client-detached"}

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

// gridHook is the command all three hooks run: resize the window to the last
// read-write client attached, or leave it exactly as it is when there is none.
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
		`run-shell -b '{ tmux %slist-clients -t %s `+
			`-F "##{client_flags} ##{client_width} ##{client_height}" `+
			`| grep -v read-only | tail -1 `+
			`| while read f w h; do `+
			`s=$(tmux %sdisplay -p -t %s "##{status}"); `+
			`case $s in off) n=0;; [0-9]) n=$s;; *) n=1;; esac; `+
			`tmux %sresize-window -t %s -x $w -y $((h-n)); done; `+
			`} >/dev/null 2>&1 || true'`,
		sock, target, sock, target, sock, target)
}
