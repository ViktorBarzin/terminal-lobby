package main

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os/exec"
	"strings"

	"terminal-lobby/telemetry"
)

// Touch copy (Task M.2): soft-key touch clients have no way to drive tmux
// copy-mode from the keyboard side — synthesizing the prefix key
// client-side is broken by design (the prefix is a user binding; wizard's
// own remap to M-x breaks a hardcoded \x02), so the lobby asks the server
// instead. `tmux copy-mode`, `send-keys -X <copy-mode-command>` and
// `capture-pane` are binding-table-independent: they work identically no
// matter how the user rebound their keys.
//
//	POST /sessions/{name}/copy-mode            → tmux copy-mode -t {name}
//	POST /sessions/{name}/copy-mode {command}  → tmux send-keys -t {name} -X {command}
//	GET  /sessions/{name}/capture              → tmux capture-pane -p -J -t {name}
//
// The -X command is whitelisted to the two the Mark/Yank soft keys need —
// this endpoint must never grow into a generic tmux command runner.

const maxCopyModeBody = 1024

// copyModeCommands are the only `send-keys -X` copy-mode commands the
// endpoint will relay: Mark (start a selection at the copy cursor) and
// Yank (copy the selection to a tmux buffer — with `set-clipboard on`
// tmux then emits OSC52, which the frontend's clipboard provider puts on
// the browser clipboard — and leave copy-mode).
var copyModeCommands = map[string]bool{
	"begin-selection":           true,
	"copy-selection-and-cancel": true,
}

// isNoSuchTarget classifies tmux stderr for the 404 mapping. Pane-target
// commands (copy-mode, send-keys, capture-pane) report "can't find pane:"
// — NOT the "can't find session" that kill/rename match on (verified
// against tmux 3.4) — so match the broader "can't find" plus the
// server-down message.
func isNoSuchTarget(msg string) bool {
	return strings.Contains(msg, "can't find") || strings.Contains(msg, "no server running")
}

// copyModeSession handles POST /sessions/{name}/copy-mode. No body (or an
// empty one) enters copy-mode; {"command": <whitelisted>} relays a
// copy-mode -X command. 204 on success, 404 unknown session, 409 when a
// -X command lands outside copy-mode ("not in a mode" — e.g. Mark tapped
// before Sel), 400 for garbage.
func copyModeSession(w http.ResponseWriter, r *http.Request, osUser, name string) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxCopyModeBody))
	if err != nil {
		http.Error(w, "body unreadable or too large", http.StatusBadRequest)
		return
	}

	args := []string{"copy-mode", "-t", name}
	if len(strings.TrimSpace(string(raw))) > 0 {
		var body struct {
			Command string `json:"command"`
		}
		if err := json.Unmarshal(raw, &body); err != nil {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
		if !copyModeCommands[body.Command] {
			http.Error(w, "unsupported copy-mode command", http.StatusBadRequest)
			return
		}
		args = []string{"send-keys", "-t", name, "-X", body.Command}
	}

	out, err := tmuxCmd(osUser, args...).CombinedOutput()
	if err != nil {
		msg := string(out)
		if isNoSuchTarget(msg) {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}
		if strings.Contains(msg, "not in a mode") {
			http.Error(w, "not in copy mode", http.StatusConflict)
			return
		}
		log.Printf("copy-mode %v as %s failed: %v: %s", args, osUser, err, msg)
		http.Error(w, "copy-mode failed", http.StatusInternalServerError)
		return
	}
	// args[0] distinguishes entering copy-mode from relaying a -X command,
	// which is the interesting split: how often selection is actually driven.
	events.Emit("terminal.copied", osUser, telemetry.Attrs{
		"tl.session": name, "tl.kind": args[0], "tl.client": "api",
	})
	w.WriteHeader(http.StatusNoContent)
}

// captureSession handles GET /sessions/{name}/capture: the session's
// visible screen as plain text (`-p` print, `-J` join wrapped lines) — the
// Copy soft key's no-xterm-selection fallback (touch drag scrolls instead
// of selecting, by design, so there is never an xterm selection to copy).
// Output() keeps stdout (the body) strictly apart from stderr — tmux
// chatter must never land on the user's clipboard.
func captureSession(w http.ResponseWriter, osUser, name string) {
	out, err := tmuxCmd(osUser, "capture-pane", "-p", "-J", "-t", name).Output()
	if err != nil {
		var msg string
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			msg = string(exitErr.Stderr)
		}
		if isNoSuchTarget(msg) {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}
		log.Printf("capture-pane %s as %s failed: %v: %s", name, osUser, err, msg)
		http.Error(w, "capture failed", http.StatusInternalServerError)
		return
	}
	// no-store: a capture is a point-in-time snapshot; a cached copy would
	// hand the user a stale screen on the next tap.
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write(out)
}
