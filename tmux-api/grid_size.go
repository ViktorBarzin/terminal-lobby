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
// WHO IS ALLOWED TO CLAIM THE GRID. A pin exists to keep read-only clients
// from moving the window, so a watcher must not take it, and SessionView
// declines to call while watching. Two clients of the same user used to be
// indistinguishable here, since both arrive with the same identity header; the
// request now carries the per-connection client id the browser minted and
// devvm/tmux-attach.sh recorded against its pty (clientreg.go), so the server
// can name the tmux client asking and refuse the ones it must not act on — a
// read-only client, and a client sitting on another session.
//
// Two rules are enforced here regardless of who is asking. With no read-write
// client attached, nobody is driving and nobody may claim the size: that is
// exactly the case PinGrid was built for (an owner pockets their phone, ttyd
// drops the socket after 60s hidden, and the watcher is left alone with the
// session). And an id that does not resolve changes nothing at all, so a
// socket opened before this shipped behaves as it always did.
//
// LAST ACTIVE WINS. Nobody holds the window. The browser claims on focus, on a
// keystroke and on a pointer move, so the most recent activity across every
// device decides, every time — and a device that loses is not demoted, it
// simply takes the window back the moment somebody touches it.
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

// switchClient points a session's window at one client, for the UNPINNED case.
//
// `switch-client -c <client>` is the only verb measured to do this. Measured on
// tmux 3.4 here 2026-09-13 with two read-write clients on one session: it took
// the window from 100x30 to 200x50 and back, repeatably, and left `window-size`
// unset — so the session goes on following its clients afterwards, which is
// what last-active-wins needs. `resize-window` moves the window too, but it
// sets `window-size manual` as a side effect and would pin every session the
// lobby was pointed at, which is why sessionio.SizeGrid refuses an unpinned
// session in the first place.
//
// The client MUST already be attached to this session. The same measurement
// showed `switch-client -c <tty> -t =other:` MOVING that client onto the named
// session, so naming a client that is somewhere else would drag a person's
// terminal to a session they never opened. matchClient is what guarantees it,
// and clientreg.go says so where it refuses.
var switchClient = func(osUser, clientName, session string) error {
	return tmuxCmd(osUser, "switch-client", "-c", clientName, "-t", exactPane(session)).Run()
}

// windowGrid is the window's size right now, "WxH", or "" when tmux cannot be
// read. One fork, and only on a claim that has already passed every guard: it
// is the `tl.from` half of session.grid_claimed, and an event that says only
// where a window ended up cannot answer whether anything moved.
var windowGrid = func(osUser, name string) string {
	out, err := tmuxCmd(osUser, "display", "-p", "-t", exactPane(name),
		"#{window_width}x#{window_height}").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// gridClaimReasons is the CLOSED vocabulary of what made a device claim the
// window, one word per claim site in the browser:
//
//	focus         the tab or the terminal took focus
//	input         a keystroke, a paste, or a pointer move over the terminal
//	socket-open   a fresh ttyd connection attached
//	take-control  a watching view switched to driving
//	fit           the terminal re-fitted to its host and reported a new grid
//	visible-set   a workspace's visible tiles changed and each re-claimed
//
// Closed because the value arrives from a browser and lands in a telemetry
// attribute: an open vocabulary there is a series any tab can invent. A word
// this build does not know is recorded as "unknown" rather than dropped, so
// the count of claims stays right even when the two ends are mid-deploy.
var gridClaimReasons = map[string]bool{
	"focus": true, "input": true, "socket-open": true,
	"take-control": true, "fit": true, "visible-set": true,
}

func gridClaimReason(v string) string {
	if gridClaimReasons[v] {
		return v
	}
	return "unknown"
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

func sizeSessionGrid(w http.ResponseWriter, r *http.Request, osUser, name string) {
	var body struct {
		Cols int `json:"cols"`
		Rows int `json:"rows"`
		// Which tmux client is asking (clientreg.go), and what made it ask.
		// Both optional: an older socket sends neither, and neither can do
		// anything the request could not already do without them.
		Client string `json:"client"`
		Reason string `json:"reason"`
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

	// Which client is asking. "" whenever the id is absent, unknown, stale, or
	// names a client this claim may not act on — and every one of those falls
	// back to exactly what this endpoint did before ids existed.
	caller := claimingClient(body.Client, name, clients)

	// A session this tab hovered is already attached, with ignore-size on so the
	// early attach did not take the window from whoever was reading it
	// (ADR-0026). Reporting a size is what the click looks like from here, so
	// this is where that client stops ignoring size. Best-effort: the sizing
	// below is the point of the request, and a client that failed to promote is
	// exactly as it was a moment ago.
	//
	// The CALLER is promoted when the request named one, and the first preload
	// on the session otherwise. Naming one is the better answer for the reason
	// preloadClientName apologises for: with two tabs hovering, promoting the
	// first found hands the window to a client nobody is looking at.
	promote := caller
	if promote == "" {
		promote = preloadClientName(clients)
	}
	if promote != "" {
		if err := promoteClient(osUser, promote); err != nil {
			log.Printf("promote client %s on %s as %s failed: %v", promote, name, osUser, err)
		}
	}
	if !anyoneDriving(clients) {
		http.Error(w, "nobody is driving this session", http.StatusConflict)
		return
	}

	// The size before anything moves, for the event below. Only read when a
	// client was named, because that is the only case where something is
	// certain to be worth reporting, and it costs a fork.
	before := ""
	if caller != "" {
		before = windowGrid(osUser, name)
	}

	sized, err := sizeGrid(osUser, name, body.Cols, body.Rows)
	if err != nil {
		log.Printf("size grid %s as %s to %dx%d failed: %v", name, osUser, body.Cols, body.Rows, err)
		http.Error(w, "resize failed", http.StatusInternalServerError)
		return
	}
	moved := sized
	if sized {
		// Only the pinned case is worth this line: it says a PIN was resized,
		// which is a narrower thing than a claim, and the series predates the
		// claim event below.
		events.Emit("session.grid_sized", osUser, telemetry.Attrs{
			"tl.session": name, "tl.client": "lobby-v2",
			"tl.kind": fmt.Sprintf("%dx%d", body.Cols, body.Rows),
		})
	} else if caller != "" {
		// UNPINNED, and somebody named themselves: sessionio.SizeGrid answers
		// (false, nil) for exactly that, by design, because resizing an
		// unpinned window would pin it. switch-client moves it without pinning.
		// Best-effort for the same reason the promotion is: the browser
		// swallows every failure of this request, so a 500 would buy nothing
		// and cost a journal line per pointer sweep.
		if err := switchClient(osUser, caller, name); err != nil {
			log.Printf("switch client %s to %s as %s failed: %v", caller, name, osUser, err)
		} else {
			moved = true
		}
	}
	if moved {
		conn := body.Client
		if caller == "" {
			// Says outright that this claim landed WITHOUT knowing which
			// client made it. `Defaults use_pty` means a sudo'd attach records
			// a tty its tmux client does not run on, so "how often does
			// resolution work here" is a question the journal has to be able
			// to answer.
			conn = "none"
		}
		attrs := telemetry.Attrs{
			"tl.session": name, "tl.client": "lobby-v2", "tl.conn": conn,
			"tl.to":     fmt.Sprintf("%dx%d", body.Cols, body.Rows),
			"tl.reason": gridClaimReason(body.Reason),
		}
		if before != "" {
			attrs["tl.from"] = before
		}
		events.Emit("session.grid_claimed", osUser, attrs)
	}
	w.WriteHeader(http.StatusNoContent)
}

// isReadOnly reads the client flag list tmux prints for `#{client_flags}`.
// Named rather than inlined because markDriven asks the same question of the
// same string, and the two must not drift.
func isReadOnly(flags string) bool {
	return strings.Contains(flags, "read-only")
}
