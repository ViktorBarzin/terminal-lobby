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

// The tmux-touching seams, as vars so the handler's tests stay pure units.
var sizeGrid = func(osUser, name string, cols, rows int) (bool, error) {
	return gridInjector.SizeGrid(osUser, name, cols, rows)
}

// sessionClients lists the clients attached to ONE session, in the format and
// with the parse the session list already uses (driven.go). One fork answers
// both questions below: who is driving, and which client a hover left behind.
//
// A tmux that cannot be read at all answers with no clients, which fails closed
// at both readers: nobody is driving, so the window keeps the size it has, and
// there is nothing to promote.
var sessionClients = func(osUser, name string) []client {
	out, err := tmuxCmd(osUser, "list-clients", "-t", exactSession(name),
		"-F", clientsListFmt).Output()
	if err != nil {
		return nil
	}
	return parseClients(out)
}

// promoteClient turns ONE client's ignore-size flag off. The leading `!` is
// tmux's own syntax for clearing a flag, and this is what makes a hover's
// preload client start driving the window size. Measured on tmux 3.4 here on
// 2026-09-11: a 200x50 client attached with `-f ignore-size` left an 80x39
// window alone, and this call moved the window to 200x49.
var promoteClient = func(osUser, clientName string) error {
	return tmuxCmd(osUser, "refresh-client", "-t", clientName, "-f", "!ignore-size").Run()
}

// makeLatest tells tmux that ONE client is the one being used, which is how an
// UNPINNED window is pointed at the device reading it.
//
// WHY NOT resize-window, WHICH IS WHAT THE PINNED PATH DOES. `resize-window`
// sets `window-size manual` on whatever it touches, so sizing an unpinned
// session here would pin every session the lobby is ever pointed at and take
// it out of tmux's hands for good (sessionio.SizeGrid says the same). Putting
// the option back afterwards does not work either: measured on tmux 3.4 here
// 2026-09-19, with a 200x50 and a 100x30 client attached, `resize-window -x 200
// -y 50` moved the window and `set-option -w -u window-size` snapped it
// straight back to 100x30, because unsetting hands the size back to `latest`
// and latest was still the other client.
//
// So move `latest` instead. `switch-client -c <client> -t <its own session>` is
// a no-op for everything a person can see — the client is already on that
// session — but tmux's `server_client_set_session` sets the window's latest
// client and recalculates the size, which is exactly what it does for itself
// when somebody presses a key. Measured on tmux 3.4 here 2026-09-19: the same
// two clients, window at 100x30, and this call moved it to 200x50 with
// `window-size` still reading `latest`.
//
// A PINNED session is not sent through here. Its window ignores `latest`
// entirely — that is what the pin means — so this would be a fork that changes
// nothing.
var makeLatest = func(osUser, session, clientName string) error {
	return tmuxCmd(osUser, "switch-client", "-c", clientName, "-t", exactSession(session)).Run()
}

// anyoneDriving reports whether the list holds at least one READ-WRITE client.
// Same question markDriven answers for the session list, asked of one session:
// a session nobody is driving must not have its grid claimed.
//
// It counts a preload client, where markDriven does not, and the difference is
// deliberate. By the time this runs the preload has just been promoted, so it
// IS the driving client — but the flags in hand were read before that call, so
// judging on them would 409 the very request that promoted it.
func anyoneDriving(clients []client) bool {
	for _, c := range clients {
		if !isReadOnly(c.Flags) {
			return true
		}
	}
	return false
}

// preloadClientName picks the client a hover left attached, by name, or "" when
// the session has none. There is normally at most one: the lobby keeps a single
// preload slot per tab, and a hover replaces it.
//
// Only the first is returned when two tabs have hovered the same session at
// once. This endpoint cannot tell which tmux client the caller is (the header
// comment above says why), so promoting all of them would hand the window size
// to a client nobody is looking at; promoting one keeps that to the smallest
// possible mistake, and the other tab's next click promotes its own.
//
// A client tmux did not name cannot be a `-t` target, so it is skipped rather
// than promoted blind.
//
// The FLAGS decide this, not whether anyone has typed into the client, which is
// where it parts company with the driven mark (driven.go). A ttyd reconnect
// re-attaches with `-f ignore-size` for a session already being driven, so a
// client carrying the flag can have hands on it and no hover anywhere in sight
// — and that client is precisely the one whose window is not following it. It
// asking for its grid is what promotion is for, so it is promoted like any
// other; tmux gates the window on the flag, whoever is behind it.
func preloadClientName(clients []client) string {
	for _, c := range clients {
		if c.Name != "" && hasPreloadFlags(c.Flags) {
			return c.Name
		}
	}
	return ""
}

// readingClientName picks the client this request is speaking FOR, by the one
// thing the request says about it: how big it is.
//
// The endpoint cannot be told which tmux client a caller is — one identity
// header per user, and no client on the request (the header comment above).
// For the pinned path that does not matter, because the window is resized
// directly. For the unpinned path it does: `switch-client` needs a `-c`.
//
// The size is enough to act on. A read-write client measuring exactly what the
// caller reported either IS the caller, or is a second device at exactly the
// same grid — in which case pointing the window at it produces the size the
// caller asked for anyway, so the two answers cannot be told apart from the
// outside either.
//
// NO MATCH MEANS NO MOVE, and that is the right way to fail. A claim can reach
// here a moment before the caller's own client has reported its new size, and
// the resize that is on its way is itself a tmux event; guessing at a client of
// some other size would hand the window to somebody else's device.
//
// A WATCHER IS NEVER PICKED, even when it is the size that was claimed. tmux
// ignores a read-only client's size, so making one latest would move nothing —
// but a pin exists precisely to keep watchers away from the window, and this
// must not be the one place that forgets it.
//
// A CLIENT WITH NO SIZE IS NOT A CANDIDATE. A tmux that answers without the
// size columns reports 0x0, and matching that against a claim of 0x0 would
// pick a client on the strength of two numbers neither side supplied. The
// handler's own bounds already refuse a zero grid on the way in; this is the
// same refusal, held where the choice is made.
func readingClientName(clients []client, cols, rows int) string {
	if cols < 1 || rows < 1 {
		return ""
	}
	for _, c := range clients {
		if c.Name == "" || isReadOnly(c.Flags) {
			continue
		}
		if c.Width == cols && c.Height == rows {
			return c.Name
		}
	}
	return ""
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

	clients := sessionClients(osUser, name)
	// A session this tab hovered is already attached, with ignore-size on so the
	// early attach did not take the window from whoever was reading it
	// (ADR-0026). Reporting a size is what the click looks like from here, so
	// this is where that client stops ignoring size. Best-effort: the sizing
	// below is the point of the request, and a client that failed to promote is
	// exactly as it was a moment ago.
	if c := preloadClientName(clients); c != "" {
		if err := promoteClient(osUser, c); err != nil {
			log.Printf("promote preload client %s on %s as %s failed: %v", c, name, osUser, err)
		}
	}
	if !anyoneDriving(clients) {
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
		// every session would say nothing. The unpinned arm below is silent
		// for the same reason.
		events.Emit("session.grid_sized", osUser, telemetry.Attrs{
			"tl.session": name, "tl.client": "lobby-v2",
			"tl.kind": fmt.Sprintf("%dx%d", body.Cols, body.Rows),
		})
	} else if c := readingClientName(clients, body.Cols, body.Rows); c != "" {
		// `sized` is false for exactly one reason the caller cannot see: the
		// session is not pinned, so SizeGrid left it to tmux on purpose. tmux
		// then sizes the window from its `latest` client, which it moves on a
		// keystroke and on an attach — and reading a session is neither, so
		// without this the claim does nothing at all for every session nobody
		// has ever watched. That is most of them: a pin is laid down by the
		// first read-only attach, and 18 of the 20 sessions on this box on
		// 2026-09-19 had never had one.
		//
		// Best-effort, like the promotion above: the client may have gone away
		// between the list and this call, and the request has already done
		// everything else it came to do.
		if err := makeLatest(osUser, name, c); err != nil {
			log.Printf("point unpinned %s as %s at client %s failed: %v", name, osUser, c, err)
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// isReadOnly reads the client flag list tmux prints for `#{client_flags}`.
// Named rather than inlined because markDriven asks the same question of the
// same string, and the two must not drift.
func isReadOnly(flags string) bool {
	return strings.Contains(flags, "read-only")
}
