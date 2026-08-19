package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"terminal-lobby/telemetry"
)

// Restarting a session's Claude.
//
// A skill is loaded when a session starts, so an install reaches only new
// sessions. The panel offers a restart for the ones that are idle, and this is
// what it calls.
//
// It respawns the pane rather than quitting Claude: devvm/start-claude.sh
// deliberately lets the pane's command END on a clean exit, so with
// remain-on-exit off, telling Claude to quit would close the tmux session
// instead of restarting it. `claude --continue` in the pane's current directory
// keeps the conversation, which is the whole point — the skill should arrive
// without costing the thread.
//
// No new privilege: the sudoers grant every attach already depends on covers
// /usr/bin/tmux for these users.

// tmuxBinary and claudeName are test seams, as in tmux-api: tests swap the
// binary for a stub that records its argv. Production never reassigns them.
var tmuxBinary = "/usr/bin/tmux"

// sessionNameRe is tmux-api's session-name charset, repeated here because this
// service must not accept anything that one would not have created.
var sessionNameRe = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,32}$`)

// runningState is the @claude_state value that means a turn is in flight
// (devvm/claude-tmux-state, ADR-0001). A session in that state is never offered
// a restart, and asking for one anyway is refused rather than obeyed.
const runningState = "running"

// handleRestart respawns one of the caller's sessions with `claude --continue`.
func handleRestart(w http.ResponseWriter, r *http.Request) {
	me := resolveOSUser(w, r)
	if me == "" {
		return
	}
	var body struct {
		Session string `json:"session"`
	}
	if !decode(w, r, &body) {
		return
	}
	if !sessionNameRe.MatchString(body.Session) {
		http.Error(w, "invalid session name", http.StatusBadRequest)
		return
	}

	// One tmux read for both facts: where the pane is, and whether Claude is
	// mid-turn there. A missing session fails here rather than being respawned
	// into existence.
	out, err := tmuxCmd(me, "display-message", "-p", "-t", body.Session,
		"#{pane_current_path}\t#{@claude_state}").Output()
	if err != nil {
		http.Error(w, "no such session", http.StatusNotFound)
		return
	}
	cwd, state := splitPaneInfo(string(out))
	if state == runningState {
		http.Error(w, "that session is mid-turn; let it finish first", http.StatusConflict)
		return
	}

	cmd := claudeCommand(me, body.Session)
	args := []string{"respawn-pane", "-k", "-t", body.Session}
	if cwd != "" {
		// --continue resumes the most recent conversation for the working
		// directory, so respawning somewhere else would resume the wrong thread.
		args = append(args, "-c", cwd)
	}
	args = append(args, cmd)
	if err := tmuxCmd(me, args...).Run(); err != nil {
		log.Printf("restart %s/%s: %v", me, body.Session, err)
		http.Error(w, "could not restart that session", http.StatusInternalServerError)
		return
	}
	events.Emit("session.claude_restarted", me, telemetry.Attrs{"tl.session": body.Session})
	log.Printf("restart: %s respawned %s in %s", me, body.Session, cwd)
	writeJSON(w, map[string]any{"session": body.Session, "restarted": true})
}

// splitPaneInfo parses the tab-separated display-message answer. A session with
// no @claude_state yields an empty state, which is not "running" and so does not
// block a restart.
func splitPaneInfo(out string) (cwd, state string) {
	line := strings.TrimRight(out, "\n")
	cwd, state, _ = strings.Cut(line, "\t")
	return strings.TrimSpace(cwd), strings.TrimSpace(state)
}

// claudeCommand is what the pane runs after the respawn. The user's own binary
// by absolute path: tmux runs this through a non-interactive shell, where the
// zsh wrapper function some accounts define is not loaded, so relying on the
// name alone would find nothing.
//
// The flags mirror devvm/start-claude.sh, which is how every session on this box
// already starts, plus --continue.
func claudeCommand(osUser, session string) string {
	bin := "claude"
	if u, err := user.Lookup(osUser); err == nil && u.HomeDir != "" {
		bin = filepath.Join(u.HomeDir, ".local", "bin", "claude")
	}
	return fmt.Sprintf("%s --dangerously-skip-permissions --continue --name %s", bin, session)
}

// tmuxCmd runs tmux as osUser: directly when that is this service's own user,
// through the same `sudo -n -H -u` the attach path uses otherwise.
func tmuxCmd(osUser string, args ...string) *exec.Cmd {
	if osUser == selfUser || selfUser == "" {
		return exec.Command(tmuxBinary, args...)
	}
	return exec.Command(sudoBinary, append([]string{"-n", "-H", "-u", osUser, tmuxBinary}, args...)...)
}

// --- the plugin update, which runs in the privileged child -------------------

// pluginUpdateTimeout bounds the CLI call. It is a real program doing a git
// fetch, so seconds rather than milliseconds, but a hung one must not hold a
// request open indefinitely.
const pluginUpdateTimeout = 90 * time.Second

// maxOutput caps what the CLI's output contributes to a response.
const maxOutput = 8 << 10

// updatePlugin runs `claude plugin update <plugin>` as the user this process is
// already running as.
//
// HOME is set explicitly: `sudo -u <user>` without -H leaves the invoking user's
// HOME in the environment, and the CLI would then update the wrong account's
// plugins. The binary is looked up in this user's own ~/.local/bin first, which
// is where the fleet's per-user install lives.
func updatePlugin(home, plugin string) (string, error) {
	if !pluginIDRe.MatchString(plugin) {
		return "", fmt.Errorf("invalid plugin id")
	}
	bin := filepath.Join(home, ".local", "bin", "claude")
	if _, err := exec.LookPath(bin); err != nil {
		found, err := exec.LookPath("claude")
		if err != nil {
			return "", fmt.Errorf("no claude binary for this account")
		}
		bin = found
	}
	ctx, cancel := context.WithTimeout(context.Background(), pluginUpdateTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "plugin", "update", plugin)
	cmd.Env = append(environWithout("HOME"), "HOME="+home)
	out, err := cmd.CombinedOutput()
	text := string(out)
	if len(text) > maxOutput {
		text = text[:maxOutput] + "\n… output truncated"
	}
	if err != nil {
		return text, fmt.Errorf("claude plugin update failed: %w", err)
	}
	return text, nil
}

// environWithout copies the environment minus one variable, so a replacement can
// be appended without leaving the original in place for the CLI to pick either.
func environWithout(key string) []string {
	var out []string
	for _, kv := range os.Environ() {
		if k, _, _ := strings.Cut(kv, "="); k == key {
			continue
		}
		out = append(out, kv)
	}
	return out
}
