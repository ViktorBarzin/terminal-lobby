package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// The new-session dropdown offers a command per key, and a key only starts
// something if the box actually has the tool behind it. Offering one it does
// not have hands the user a session that closes the instant it opens, with
// nothing on screen to say why — which is what the container did with Claude
// before Claude was in the image, and still does with Codex.
//
// The question "would this key run" is answered by tmux-user-attach --probe
// rather than here, because the rules for it are the ones that build a real
// session: a per-user override file first, a built-in map second, and the
// answer tested inside the login+interactive shell the session gets. That last
// part is why this cannot be a PATH lookup in Go — on the devvm `claude` is a
// shell function from a user's rc file, and nothing outside that shell can see
// it.

// builtinCommandKeys mirrors BUILTIN_KEYS in devvm/tmux-user-attach. The script
// is the source of truth; newcommands_test.go fails if the two drift.
var builtinCommandKeys = []string{"claude", "codex", "shell"}

// attachScript is the probe's home. A var so a test can point it elsewhere.
var attachScript = "/usr/local/bin/tmux-user-attach"

// commandsTTL is long next to sessionsTTL on purpose. What a box has installed
// changes when someone installs something, not every five seconds, and each
// miss costs a login shell — the expensive kind, sourcing a full profile.
const commandsTTL = 2 * time.Minute

var commandsCacheInstance = newSessionsCache(commandsTTL)

// probeTimeout bounds somebody else's login shell. It runs whatever their rc
// file runs, which on a bad day waits on a network mount or an update check,
// and a request must not wait with it. Measured on the devvm: 3.9s for a cold
// full zsh profile, 0.2s warm — so this is generous rather than tight, and
// giving up produces the same harmless {} as any other failure. A var so the
// test can shorten it.
var probeTimeout = 10 * time.Second

// probeLine is one answer. Anchored and narrow because the probe's stdout is a
// login+interactive shell's stdout, which an rc file may also have written to.
var probeLine = regexp.MustCompile(`^([a-z0-9_-]{1,16})\t([01])$`)

// runProbe executes the probe as the given OS user. Same self/sudo split as
// tmuxCmd, plus -H: the override file lives at $HOME/.config/terminal-lobby/
// commands, so sudo has to hand over the target user's home and not keep ours.
var runProbe = func(osUser string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	var c *exec.Cmd
	if osUser == selfUser {
		c = exec.CommandContext(ctx, attachScript, "--probe")
	} else {
		c = exec.CommandContext(ctx, sudoBinary, "-n", "-H", "-u", osUser, attachScript, "--probe")
	}
	// The deadline alone is not enough. It kills the shell, but Output() waits
	// on the stdout pipe, and anything the shell started holds that pipe open
	// after its parent is gone — so a hung `sleep` in an rc file would keep the
	// handler waiting for the full sleep with the context long expired.
	// WaitDelay closes the pipes shortly after the kill and lets the read
	// return, which is the difference between a bounded probe and a bounded
	// intention.
	c.WaitDelay = time.Second
	return c.Output()
}

// stubProbe swaps the runner for a test and returns the undo. The cache goes
// with it: a test that changes what the probe says and then reads a previous
// test's cached answer is testing nothing, and the failure looks like a bug in
// the handler rather than in the fixture.
func stubProbe(fn func(string) ([]byte, error)) func() {
	prevFn, prevCache := runProbe, commandsCacheInstance
	runProbe, commandsCacheInstance = fn, newSessionsCache(commandsTTL)
	return func() { runProbe, commandsCacheInstance = prevFn, prevCache }
}

func parseProbe(out []byte) map[string]bool {
	avail := map[string]bool{}
	for _, line := range strings.Split(string(out), "\n") {
		m := probeLine.FindStringSubmatch(strings.TrimRight(line, "\r"))
		if m == nil {
			continue
		}
		avail[m[1]] = m[2] == "1"
	}
	return avail
}

// handleNewCommands answers GET /new-commands with {key: canRun}.
//
// A key the caller does not see in the answer is one this box has no opinion
// about, and the lobby leaves those enabled. That is what makes every failure
// here harmless: a probe that errors, times out, or returns noise yields {},
// and the dropdown behaves exactly as it did before it could grey anything out.
// The opposite default would let a broken probe take a working tool away.
func handleNewCommands(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	id, ok := actAsGate.Authorize(w, r)
	if !ok {
		return
	}
	w.Header().Set("Content-Type", "application/json")

	if body, hit := commandsCacheInstance.get(id.OSUser); hit {
		w.Write(body)
		return
	}

	avail := map[string]bool{}
	if out, err := runProbe(id.OSUser); err != nil {
		log.Printf("new-commands probe for %s failed (offering everything): %v", id.OSUser, err)
	} else {
		avail = parseProbe(out)
	}

	body, err := json.Marshal(avail)
	if err != nil { // a map[string]bool cannot fail to marshal; belt and braces
		body = []byte("{}")
	}
	commandsCacheInstance.put(id.OSUser, body)
	w.Write(body)
}
