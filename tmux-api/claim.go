package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// POST /sessions/claim: claim a warm pre-warm slot for a session the
// New-session composer is creating, at the moment Send is pressed
// (docs/plans/2026-10-03-first-prompt-latency-design.md).
//
// Until this, the claim happened only inside the browser's terminal attach
// (tmux-user-attach, run by ttyd), so the first prompt waited for the browser to
// save the layout, load the terminal, fetch a token and open a WebSocket.
// Measured on iPhones over 7 days to 2026-10-03: the WebSocket handshake alone
// was 1.2s at p90, and /token ran past 1.5s 55 times. This claims the slot
// straight away with the script's own rules, run in its claim-only mode, so
// those rules live in one place. The attach still runs and still claims when
// this did not: tmux rename-session is atomic, so whichever comes first wins
// and the other finds the session there. A create therefore still works with
// this service down (ADR-0019).
//
// The answer is always 200 {"claimed": bool}, and a refusal is just false: the
// browser fires this and moves on, and its attach covers every case this does
// not.

// claimTimeout bounds the script. A claim is a rename and a few stamps, about
// 135ms of sudo and bash on the box; the bound is for a wedged tmux.
const claimTimeout = 5 * time.Second

// runClaim runs tmux-user-attach in claim-only mode as osUser, with the same
// self/sudo split and -H as runPiModels. A seam for tests.
var runClaim = func(osUser string, args []string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), claimTimeout)
	defer cancel()
	var c *exec.Cmd
	if osUser == selfUser {
		c = exec.CommandContext(ctx, attachScript, args...)
	} else {
		c = exec.CommandContext(ctx, sudoBinary, append([]string{"-n", "-H", "-u", osUser, attachScript}, args...)...)
	}
	c.WaitDelay = time.Second
	return c.Output()
}

// resizeClaimed gives a claimed session the browser's terminal size, then
// unpins it. A slot is created detached at tmux's default 80x24, and with the
// claim made before any terminal attaches, Claude would write its first reply
// wrapped at 80 columns into a phone's 45. resize-window sets the window's
// size to manual, which would pin it against every later attach, so the
// option is unset straight after: with no client attached the window keeps
// the size, and the first attach resizes it as usual (measured on tmux 3.4).
// A seam for tests.
var resizeClaimed = func(osUser, name string, cols, rows int) error {
	target := exactPane(name)
	if out, err := tmuxCmd(osUser, "resize-window", "-t", target,
		"-x", strconv.Itoa(cols), "-y", strconv.Itoa(rows)).CombinedOutput(); err != nil {
		log.Printf("claim: resizing %s for %s: %v (%s)", name, osUser, err, strings.TrimSpace(string(out)))
		return err
	}
	return tmuxCmd(osUser, "set-window-option", "-t", target, "-u", "window-size").Run()
}

func handleClaim(w http.ResponseWriter, r *http.Request) {
	id, ok := actAsGate.Authorize(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Name   string `json:"name"`
		Dir    string `json:"dir"`
		Cmd    string `json:"cmd"`
		Model  string `json:"model"`
		Effort string `json:"effort"`
		Cols   int    `json:"cols"`
		Rows   int    `json:"rows"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&body); err != nil {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	osUser := id.OSUser
	answer := func(claimed bool) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]bool{"claimed": claimed})
	}
	// An administrator acting as someone attaches to their sessions and never
	// creates one (tmux-attach.sh's foreign branch); a claim would create one.
	if osUser != id.RealOSUser {
		answer(false)
		return
	}
	// Only a minted id becomes a claimed session's birth name, and only the
	// claude key with no model or effort is pooled: anything else would fail
	// the script's own checks, so it is not worth a sudo to find out.
	if !mintedNameRe.MatchString(body.Name) || body.Cmd != "claude" || body.Model != "" || body.Effort != "" {
		answer(false)
		return
	}
	dir := body.Dir
	if dir == "" {
		dir = homeOfUser(osUser)
	}
	if !prewarmAllowedDir(osUser, dir) {
		log.Printf("claim: %s asked to claim in %q, which is not one of their project dirs", osUser, dir)
		answer(false)
		return
	}
	out, err := runClaim(osUser, []string{body.Name, dir, body.Cmd, "", "", "claim"})
	if err != nil {
		log.Printf("claim: %s for %s: %v", body.Name, osUser, err)
		answer(false)
		return
	}
	claimed := strings.TrimSpace(string(out)) == "claimed"
	// The status line takes a row of the browser's terminal.
	if claimed && body.Cols >= 10 && body.Cols <= 1000 && body.Rows >= 3 && body.Rows <= 1000 {
		_ = resizeClaimed(osUser, body.Name, body.Cols, body.Rows-1)
	}
	answer(claimed)
}
