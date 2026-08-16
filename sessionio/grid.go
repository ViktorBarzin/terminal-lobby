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

	if out, err := in.Command(osUser, "set-option", "-t", target,
		"window-size", "manual").CombinedOutput(); err != nil {
		return fmt.Errorf("pin grid %s: window-size: %v: %s",
			session, err, strings.TrimSpace(string(out)))
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
func (in *Injector) gridHook(session string) string {
	sock := ""
	if in.socket != "" {
		sock = "-L " + in.socket + " "
	}
	target := exactPane(session)
	return fmt.Sprintf(
		`run-shell -b 'tmux %slist-clients -t %s `+
			`-F "##{client_flags} ##{client_width} ##{client_height}" `+
			`| grep -v read-only | tail -1 `+
			`| while read f w h; do tmux %sresize-window -t %s -x $w -y $h; done'`,
		sock, target, sock, target)
}
