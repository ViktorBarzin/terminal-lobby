package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"

	"terminal-lobby/telemetry"
)

// POST /sessions/{name}/grid {"cols":N,"rows":N} — the client being READ says
// what size it is, so a pinned window can follow it.
//
// WHY THE BROWSER HAS TO SAY THIS AT ALL. A pinned session's window moves on
// three tmux hooks and nothing else: a client attaching, detaching, or resizing
// (sessionio.PinGrid). The lobby keeps every session you open mounted and
// CSS-hidden, so switching back to one fires none of them — the ttyd client
// never detached, and its pty is the size it always was, which the kernel
// answers with no SIGWINCH. The window keeps whatever the last device to attach
// left it at. Measured on this box 2026-09-06: a desktop reading `f1` at 231x62
// sat inside a 60-column window because a phone had joined the session, and
// reloading the page was the only thing that fixed it, because a reload is an
// attach.
//
// 204 whether or not anything moved: an unpinned session is left to tmux on
// purpose (sessionio.SizeGrid says why), and the caller has nothing to do
// differently either way. 404 for a session this user does not have, 400 for a
// grid outside the bounds below, 409 when nobody is driving.
//
// WHO IS ALLOWED TO CLAIM THE GRID, and the part this cannot decide. A pin
// exists to keep read-only clients from moving the window, so a watcher must
// not reach this. Two clients of the SAME user are indistinguishable here —
// both arrive with the same identity header, and neither carries the tmux
// client it belongs to — so the watching device declining to call is what keeps
// Watch mode's promise, and SessionView is where that decision is made. What is
// enforced here is the half the server can see: with no read-write client
// attached, nobody is driving and nobody may claim the size. That is exactly
// the case PinGrid was built for (an owner pockets their phone, ttyd drops the
// socket after 60s hidden, and the watcher is left alone with the session), so
// it is the one that matters most.
//
// This endpoint grants no authority the API did not already give the same
// caller: /sessions/{name}/copy-mode sends keys into the pty.
const maxGridBody = 256

// gridBounds is the widest and narrowest grid this will pass to tmux. A browser
// mid-layout can report 0, and xterm's own fit computes ~13x7 against a
// display:none host — neither is a size anybody is reading.
const (
	gridMinCells = 1
	gridMaxCells = 10000
)

// The tmux-touching seam, as a var so the handler's tests stay pure units.
var sizeGrid = func(osUser, name string, cols, rows int) (bool, error) {
	return gridInjector.SizeGrid(osUser, name, cols, rows)
}

// sessionDriven reports whether the session has at least one READ-WRITE client
// attached. Same question markDriven answers for the session list, asked of one
// session: a session nobody is driving must not have its grid claimed.
//
// A tmux that cannot be read at all answers false, which fails closed: the
// window keeps the size it has.
var sessionDriven = func(osUser, name string) bool {
	out, err := tmuxCmd(osUser, "list-clients", "-t", exactSession(name),
		"-F", clientsListFmt).Output()
	if err != nil {
		return false
	}
	for _, c := range parseClients(out) {
		if !isReadOnly(c.Flags) {
			return true
		}
	}
	return false
}

func sizeSessionGrid(w http.ResponseWriter, r *http.Request, osUser, name string) {
	var body struct {
		Cols int `json:"cols"`
		Rows int `json:"rows"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxGridBody)).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if body.Cols < gridMinCells || body.Cols > gridMaxCells ||
		body.Rows < gridMinCells || body.Rows > gridMaxCells {
		http.Error(w, "grid out of range", http.StatusBadRequest)
		return
	}
	if !sessionExists(osUser, name) {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}
	if !sessionDriven(osUser, name) {
		http.Error(w, "nobody is driving this session", http.StatusConflict)
		return
	}

	sized, err := sizeGrid(osUser, name, body.Cols, body.Rows)
	if err != nil {
		log.Printf("size grid %s as %s to %dx%d failed: %v", name, osUser, body.Cols, body.Rows, err)
		http.Error(w, "resize failed", http.StatusInternalServerError)
		return
	}
	if sized {
		// Only the pinned case is worth a line: an unpinned session reaching
		// here is the ordinary majority, and recording every view switch of
		// every session would say nothing.
		events.Emit("session.grid_sized", osUser, telemetry.Attrs{
			"tl.session": name, "tl.client": "lobby-v2",
			"tl.kind": fmt.Sprintf("%dx%d", body.Cols, body.Rows),
		})
	}
	w.WriteHeader(http.StatusNoContent)
}

// isReadOnly reads the client flag list tmux prints for `#{client_flags}`.
// Named rather than inlined because markDriven asks the same question of the
// same string, and the two must not drift.
func isReadOnly(flags string) bool {
	return strings.Contains(flags, "read-only")
}
