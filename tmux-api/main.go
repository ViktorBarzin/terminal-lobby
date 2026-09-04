package main

import (
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"regexp"
	"strconv"
	"strings"
	"time"

	"terminal-lobby/authuser"
	"terminal-lobby/sessionio"
	"terminal-lobby/slug"
	"terminal-lobby/telemetry"
)

const (
	listenAddr     = "0.0.0.0:7684"
	restoreWrapper = "/usr/local/bin/tmux-restore-user"
	// @claude_state is stamped by the claude-tmux-state hook script
	// (ADR-0001). pane_pid feeds the liveness backstop (proc.go): state
	// survives only while a claude process is alive under the pane —
	// catches a claude killed without firing SessionEnd. pane_current_
	// command + pane_title (Task 2.5, live-command chip) come for free
	// the same way — tmux tracks both natively, zero polling. All four
	// pane_* fields resolve against the session's active pane, matching
	// the one-claude-per-session usage pattern.
	//
	// @title is the DISPLAY TITLE a person chose (session-titles design,
	// 2026-08-16) — arbitrary text, stored on the session exactly as
	// @claude_state is, so it costs no extra call here and a guest attaching
	// a shared session reads the same title its owner set.
	//
	// The separator is TAB, not '|'. TWO fields now carry arbitrary text —
	// pane_title, which applications set freely via OSC 2, and @title — and
	// only one field can be last, which is all '|' ever protected.
	//
	// Tab rather than a unit separator, measured on tmux 3.4: tmux ESCAPES
	// non-printable bytes on output, in the format literal and inside values
	// alike, so a \x1f separator comes back as the four characters \037 — and
	// so does a \x1f inside a value, leaving the two indistinguishable. Tab
	// passes through raw on both sides.
	//
	// What makes tab safe is the same argument that made '|' safe for one
	// field, now good for two: a title cannot contain one, because CleanTitle
	// strips every control character before a title is ever stored, and
	// pane_title stays LAST so an embedded tab is soaked into the trailing
	// field rather than shifting the row.
	//
	// session_id leads. It is the one field with a guaranteed shape ($N) and
	// it SURVIVES A RENAME, which is what lets a second tab follow a session
	// whose name changed instead of holding a stale name whose iframe would
	// resurrect it as an empty session.
	tmuxListFmt = "#{session_id}" + listSep + "#{session_name}" + listSep +
		"#{session_attached}" + listSep + "#{session_activity}" + listSep +
		"#{session_created}" + listSep + "#{" + lastDriveOption + "}" + listSep +
		"#{@claude_state}" + listSep +
		"#{pane_pid}" + listSep + "#{pane_current_command}" + listSep +
		"#{" + sessionTitleOption + "}" + listSep + "#{pane_title}"

	// listSep separates tmuxListFmt's fields; listFields is how many there are.
	listSep    = "\t"
	listFields = 11

	// sessionTitleOption is where a display title lives, alongside
	// @claude_state. Named in sessionio so this service, t3-sync and anything
	// else reading a session's options agree on the spelling. Options die with
	// the session that holds them, which is right for state and wrong for a
	// title someone chose — the titles store (titles.go) is what carries a
	// title across a restore.
	sessionTitleOption = sessionio.OptionTitle

	// sessionsTTL coalesces repeat GET /sessions polls for the same OS
	// user. Foolery / lobby pollers hit at ~5 s cadence, so the TTL
	// matches that interval — every other poll lands inside the window
	// and skips the `sudo tmux list-sessions` fork. Concurrent
	// pollers (e.g. two browser tabs open by the same identity) also
	// coalesce. Mutations (kill / rename) invalidate per-user, so a
	// user's own action shows up immediately. New sessions created
	// outside the API (via ttyd / shell) can lag by up to one TTL.
	sessionsTTL = 5 * time.Second
)

var sessionsCacheInstance = newSessionsCache(sessionsTTL)

// mapPath is the identity→OS-user map. A var (not const) purely as a test
// seam: handler tests point it at a fixture so the real header→user path runs
// hermetically (see prefs_test.go). setMapPath keeps the gate in step, since
// the gate is what actually reads it.
var mapPath = authuser.DefaultMapPath

func setMapPath(p string) {
	mapPath = p
	actAsGate.MapPath = p
}

// authHeader is the identity header this build resolves by default. The name is
// configuration now (TL_AUTH_HEADER); this constant exists so tests can set the
// header the running gate is actually reading.
const authHeader = authuser.DefaultAuthHeader

// tmuxBinary is a var (not const) for the same reason as mapPath: endpoint
// tests swap it for a stub that records its argv and mimics tmux exit
// codes/stderr, so the full HTTP→tmuxCmd path runs hermetically without a
// live tmux server (see copymode_test.go). Production never reassigns it.
var tmuxBinary = "/usr/bin/tmux"

// sudoBinary and persistForgetWrapper are vars for the same reason as
// tmuxBinary: a test seam. The forget path always needs sudo (its target is
// root, not the caller), so unlike tmuxCmd it has no sudo-less branch to test
// through — main_test.go swaps sudoBinary for a stub that records its argv.
// Production never reassigns either.
var sudoBinary = "/usr/bin/sudo"

// persistForgetWrapper drops one session from the caller's tmux-persist
// manifest (devvm/tmux-persist-forget).
var persistForgetWrapper = "/usr/local/bin/tmux-persist-forget"

var sessionNameRe = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,32}$`)

var selfUser = func() string {
	if u, err := user.Current(); err == nil {
		return u.Username
	}
	return ""
}()

type Session struct {
	// ID is tmux's own session id ($0, $1, …). It survives a rename, which
	// nothing else about a session does, so a client that had this session
	// selected can follow it to its new name rather than holding a name whose
	// attach would create a fresh empty session. omitempty keeps the old wire
	// shape for consumers that predate it.
	ID       string `json:"id,omitempty"`
	Name     string `json:"name"`
	Attached int    `json:"attached"`
	// Driven is true when at least one attached client is READ-WRITE.
	// Distinct from Attached, which counts watchers too: the lobby joins a
	// new device as a viewer only when someone is actually driving.
	Driven       bool  `json:"driven"`
	LastActivity int64 `json:"lastActivity"`
	// LastDrive is when a human last had hands on this session: the newest
	// moment a READ-WRITE client was attached, kept in @last_drive (lastdrive.go).
	// This is what the session list shows, NOT LastActivity — tmux bumps
	// session_activity on any attach, a read-only one included, so a viewer used
	// to reset the number just by looking. Seeded from Created for a session that
	// has not been driven since the option existed, so it is never empty.
	LastDrive int64 `json:"lastDrive"`
	Created   int64 `json:"created"`
	// State of the Claude conversation inside the session: "running",
	// "awaiting", "done", or "" when no live Claude. omitempty keeps the
	// old wire shape for stateless sessions (external /sessions pollers).
	State string `json:"state,omitempty"`
	// Project the session is assigned to (global project store); "" =
	// ungrouped.
	Project string `json:"project,omitempty"`
	// Owner is the OS user whose server the session runs on. For the caller's
	// own sessions this is the caller; for a foreign session surfaced via a
	// shared project or a direct share it is the real owner. omitempty keeps
	// the old wire shape for external pollers of their own sessions.
	Owner string `json:"owner,omitempty"`
	// Access is how the CALLER may attach a foreign session: "ro" (watch) or
	// "rw" (drive-as-owner). Empty for the caller's own sessions (full control).
	Access string `json:"access,omitempty"`
	// Command/PaneTitle mirror the active pane's #{pane_current_command} /
	// #{pane_title} (Task 2.5): the lobby's live-command chip and the
	// attached-tab title read them. omitempty keeps the old wire shape
	// for consumers that predate the fields.
	Command   string `json:"pane_current_command,omitempty"`
	PaneTitle string `json:"pane_title,omitempty"`
	// Title is the DISPLAY TITLE a person chose — arbitrary text, up to 64
	// runes, read from the session's @title option. Distinct from PaneTitle,
	// which whatever is running in the pane sets for itself. Empty means the
	// session has no title and its name is what gets shown, which is where
	// every session that predates the feature sits.
	Title string `json:"title,omitempty"`
	// Tool is WHICH command the session runs — "claude", "codex" or "shell"
	// — resolved from the pane's process tree (proc.go), never from Command:
	// both agents launch through non-exec wrapper scripts, so the pane's
	// foreground pgroup leader is a shell while the agent runs underneath.
	// The lobby renders it as a brand mark beside the state dot. Empty when
	// the /proc scan failed (no mark) — omitempty keeps the old wire shape.
	Tool string `json:"tool,omitempty"`
	// PanePID is the session's active-pane process — internal input to
	// the claude-liveness backstop (proc.go), never serialized.
	PanePID int `json:"-"`
}

// Claude state values as stamped into @claude_state by the hook script.
const (
	stateRunning  = "running"
	stateAwaiting = "awaiting"
	stateDone     = "done"
)

var knownStates = map[string]bool{stateRunning: true, stateAwaiting: true, stateDone: true}

// actAsGate resolves every request: the proxy secret, the identity header, the
// mode, and the act-as switch. A var only as a test seam (actas_test.go points
// it at a fixture admin list); production configures it in main.
var actAsGate = authuser.Default

// actAsTarget is the query parameter carrying the switch. It rides the URL
// rather than a header because two of the surfaces it has to reach are not
// fetch() calls at all — file previews and gallery thumbnails are <img src> —
// and a parameter is the only form all of them can carry.
const actAsTarget = "as"

// resolveRealOSUser → the CALLER's own mapped OS user from the identity
// header, or "" after writing the appropriate 401/403/500 to w. Ignores ?as=
// entirely.
//
// Two callers want this rather than resolveOSUser: the push-subscription
// endpoints, whose writes must never land under an act-as target (see
// handlePushSubscriptions), and resolveOSUser itself, which starts here and
// then applies the switch.
func resolveRealOSUser(w http.ResponseWriter, r *http.Request) string {
	return actAsGate.ResolveRealOSUser(w, r)
}

// No OnActAs hook here on purpose: tmux-api is polled every five seconds, so
// a line per act-as request would be noise rather than a record.
func resolveOSUser(w http.ResponseWriter, r *http.Request) string {
	return actAsGate.ResolveOSUser(w, r)
}

// tmuxCmd builds an exec.Cmd that runs `tmux <args...>` AS osUser. When
// osUser is the current process owner, sudo is skipped; otherwise we use
// `sudo -n -u <user> tmux ...` (passwordless grant via /etc/sudoers.d/ttyd-users).
// exactSession names one session and nothing else.
//
// tmux resolves an ABSENT session name by unambiguous prefix match and exits 0
// doing it (measured on 3.4: with only `agent-2` alive, `kill-session -t agent`
// kills it). The lobby manufactures that state routinely — a name is freed when
// a session dies, and siblings like `agent-2` are ordinary — so a kill or a
// rename for a session that has already gone would land on a stranger, and the
// notice this then posts would name the session the caller ASKED about rather
// than the one that died. `=` makes tmux fail closed instead.
func exactSession(name string) string { return "=" + name }

// exactPane is the same rule for the verbs whose -t takes a PANE rather than a
// session — set-option among them, which is how @title is stamped. `=name`
// alone is rejected there even for a session that exists (measured on 3.4);
// the trailing colon makes it a window target, and the window's session is the
// one the option lands on.
//
// The prefix-match hazard exactSession describes is sharper here, not milder:
// deriving names from titles makes pairs like `deploy` and `deploy-the-thing`
// ordinary, and stamping a title onto the wrong one of those would be silent.
// sessionio/tmux.go carries the same helper for the same reason.
func exactPane(name string) string { return "=" + name + ":" }

func tmuxCmd(osUser string, args ...string) *exec.Cmd {
	if osUser == selfUser {
		return exec.Command(tmuxBinary, args...)
	}
	full := append([]string{"-n", "-u", osUser, tmuxBinary}, args...)
	return exec.Command(sudoBinary, full...)
}

func main() {
	// CLI mode (not the HTTP service): `tmux-api sanitize-resurrect
	// [archive...]` strips terminal query replies from tmux-resurrect's
	// saved pane contents before they are replayed into a pty — wired as
	// @resurrect-hook-pre-restore-all by devvm/setup-user-persistence.sh.
	// It lives inside this binary so the per-user hook needs no extra
	// deployed artifact (sanitize.go has the full rationale).
	if len(os.Args) > 1 && os.Args[1] == "sanitize-resurrect" {
		os.Exit(runSanitizeResurrect(os.Args[2:], os.Stderr))
	}

	// One-shot: seed the global project store from existing per-user layouts
	// the first time the service starts after this feature ships. Non-fatal —
	// the service must come up even if migration hits a snag.
	if migrated, err := migrateAllLayouts(layoutStoreInstance, projectStoreInstance, mappedOSUsers()); err != nil {
		log.Printf("project store migration failed (continuing without it): %v", err)
	} else if migrated {
		log.Printf("seeded global project store from per-user layouts")
	}

	// One-shot, in the background: every session that was already running when
	// ids shipped carries a name a person chose, and a name stopped being the
	// thing anyone reads (ADR-0019). This renames them to ids, keeping each old
	// name as the session's @title. In a goroutine because it forks tmux once
	// per user and the listener must not wait on that — nothing serves worse
	// for the migration having not finished yet, and the lobby's five-second
	// poll picks up each new name as it lands.
	go migrateSessionNamesToIDs(mappedOSUsers(), userSessions)

	// Localhost token the devvm attach path uses to record a shared attach's
	// client tty (for kick-on-revoke). Non-fatal if it can't be set up.
	if err := ensureInternalToken(); err != nil {
		log.Printf("internal token init failed (shared-attach kick recording disabled): %v", err)
	}

	http.HandleFunc("/sessions", handleSessions)
	// Registered ahead of "/sessions/" so the more specific path wins: Go's mux
	// prefers the longer pattern, but stating the order makes the intent plain.
	http.HandleFunc("/new-commands", handleNewCommands)
	http.HandleFunc("/sessions/prewarm", handlePrewarm)
	http.HandleFunc("/sessions/", handleSessionByName)
	http.HandleFunc("/whoami", handleWhoami)
	http.HandleFunc("/restore", handleRestore)
	http.HandleFunc("/snapshots", handleSnapshots)
	http.HandleFunc("/snapshots/", handleSnapshotByTS)
	http.HandleFunc("/layout", handleLayout)
	http.HandleFunc("/projects", handleProjects)
	http.HandleFunc("/projects/", handleProjectByID)
	http.HandleFunc("/shares", handleShares)
	http.HandleFunc("/shares/", handleShareByPath)
	http.HandleFunc("/internal/attach", handleInternalAttach)
	http.HandleFunc("/users", handleUsers)
	http.HandleFunc("/dirs", handleDirs)
	http.HandleFunc("/prefs", handlePrefs)
	http.HandleFunc("/netinfo", handleNetinfo)
	http.HandleFunc("/telemetry", handleTelemetry)
	http.HandleFunc("/push-subscriptions", handlePushSubscriptions)
	http.HandleFunc("/push/vapid-public", handlePushVAPIDPublic)
	http.HandleFunc("/push/test", handlePushTest)
	http.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("ok"))
	})

	// Background Web Push sender (Notifications Part 2): a no-op unless a full
	// VAPID config is in the environment, so a devvm without keys behaves
	// exactly as before.
	maybeStartPushSender()

	// Collects speculative pre-warm slots the lobby never released — a closed
	// tab cannot tell us it is done with one, and each slot is a real Claude.
	// Started unconditionally: with nothing outstanding it costs one
	// `tmux list-sessions` per mapped user per sweep, the same call the sessions
	// poll already makes. Runs for the life of the process, like the sender.
	go runPrewarmReaper(make(chan struct{}))

	// TMUX_API_ADDR: scratch-build override for the dev harness
	// (dev-harness.py --tmux-api-port documents testing a local build,
	// which can't bind 7684 while the production service holds it).
	// The systemd unit sets no environment — production stays :7684.
	addr := listenAddr
	// TL_BIND narrows the listener. The default is unchanged; an operator who
	// puts the proxy on the same host can set 127.0.0.1 and remove the LAN
	// path entirely without needing a shared secret.
	if b := strings.TrimSpace(os.Getenv("TL_BIND")); b != "" {
		if _, port, err := net.SplitHostPort(addr); err == nil {
			addr = net.JoinHostPort(b, port)
		}
	}
	// Restore the event a refused act-as used to emit. The gate does the
	// refusing now, so the emitter is wired in rather than re-implemented per
	// handler; without it an administrator probing targets they are not
	// entitled to leaves a journald line and nothing the dashboards query.
	actAsGate.OnActAsRefused = func(realOSUser, target, reason string) {
		events.Emit("admin.actas.refused", realOSUser, telemetry.Attrs{
			"tl.to": target, "tl.kind": reason,
		})
	}
	actAsGate.Configure("tmux-api", addr)
	if a := os.Getenv("TMUX_API_ADDR"); a != "" {
		addr = a
	}
	log.Printf("tmux-api listening on %s (self=%s)", addr, selfUser)
	go timing.Run(nil)
	log.Fatal(http.ListenAndServe(addr, timing.Wrap(http.DefaultServeMux)))
}

// /whoami → {authentik, osUser}. Used by the lobby HTML to render the
// current identity and to preflight access before opening a session.
//
// Side effect: invalidates the per-user /sessions cache. /whoami is
// called on every page load — both the outer lobby AND each iframe
// in terminal-mode (the iframe loads the same index.html with
// ?arg=<name>, which re-runs the preflight). So when the user clicks
// "Create & Open" and the iframe loads, the iframe's /whoami clears
// the outer lobby's stale cache for that user, and the lobby's next
// periodic poll shows the new session within one cycle — without
// having to drop the TTL or push a client-side invalidate call.
func handleWhoami(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	id, ok := actAsGate.Authorize(w, r)
	if !ok {
		return
	}
	authUser, real, osUser := id.Header, id.RealOSUser, id.OSUser
	if osUser != real {
		// One of the two audit points. /whoami is called once per page load
		// (the lobby AND each terminal iframe), so this fires when a tab
		// starts acting as someone — the granularity the record wants, unlike
		// the 5 s /sessions poll.
		log.Printf("act-as: %s acting as %s (auth=%q)", real, osUser, authUser)
		events.Emit("admin.actas", real, telemetry.Attrs{
			"tl.to": osUser, "tl.client": "whoami",
		})
	}
	log.Printf("whoami: auth=%q -> os=%q", authUser, osUser)
	sessionsCacheInstance.invalidate(osUser)
	// no-store: the browser MUST hit the server every page load, otherwise
	// the iframe's call gets served from the HTTP cache and the
	// invalidate side-effect above never fires — at which point the outer
	// lobby keeps polling its 5 s tmux-api cache and the freshly-created
	// session doesn't appear until the user manually refreshes.
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	// realUser is present ONLY while acting as someone else, so the SPA's
	// "am I switched?" test is simply "is realUser present" — it never has to
	// trust its own URL for that. admin drives whether Settings offers the
	// picker at all; the server refuses regardless, this just avoids showing a
	// control that could only fail.
	// multiUser tells the SPA which features exist on this box. Without it the
	// frontend would have to infer the mode from an empty /users list, and a
	// Share dialog with nobody in it reads as a defect rather than as a mode.
	body := map[string]any{
		"authentik": authUser,
		"osUser":    osUser,
		"admin":     id.Admin,
		"multiUser": id.MultiUser,
	}
	if osUser != real {
		body["realUser"] = real
	}
	json.NewEncoder(w).Encode(body)
}

// handleRestore (POST /restore) recreates the caller's saved-but-dead tmux
// sessions by invoking the validated root wrapper tmux-restore-user via the
// passwordless sudo grant in /etc/sudoers.d/ttyd-users. The wrapper
// re-validates the OS user against /etc/ttyd-user-map and runs
// `tmux-persist restore <user>`. Idempotent: already-live sessions are left
// alone, so this only fills in what an OOM/crash killed (the boot-only
// tmux-persist-restore.service never fires without a reboot).
//
// "only what an OOM/crash killed" holds because killSession forgets: restore
// recreates every row of the manifest that is not live, and a deliberate kill
// removes its row on the way out. Drop that and this button silently undoes
// kills for the up-to-5-minutes until tmux-persist-save.timer next rewrites
// the manifest — including other agents' dead sessions, since one press
// restores the caller's whole manifest.
func handleRestore(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}

	// An optional body selects specific rows of a specific snapshot (the
	// picker). No body keeps the blanket behaviour the boot path and the
	// plain button rely on, so old clients are unaffected.
	var sel restoreSelection
	body, _ := io.ReadAll(io.LimitReader(r.Body, 64<<10))
	if len(strings.TrimSpace(string(body))) > 0 {
		if err := json.Unmarshal(body, &sel); err != nil {
			http.Error(w, "bad request body", http.StatusBadRequest)
			return
		}
	}

	if sel.Snapshot != "" {
		status, msg := restoreFromSelection(osUser, sel)
		if status != http.StatusOK {
			http.Error(w, msg, status)
			return
		}
		sessionsCacheInstance.invalidate(osUser)
		emitRestored(osUser, "picker")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
		return
	}

	out, err := exec.Command(sudoBinary, "-n", restoreWrapper, osUser).CombinedOutput()
	if err != nil {
		log.Printf("restore for %s failed: %v: %s", osUser, err, strings.TrimSpace(string(out)))
		http.Error(w, "restore failed", http.StatusInternalServerError)
		return
	}
	log.Printf("restore for %s: %s", osUser, strings.TrimSpace(string(out)))
	sessionsCacheInstance.invalidate(osUser)
	emitRestored(osUser, "api")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func handleSessions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}
	// Same reason as /whoami: prevent the browser from caching the list,
	// otherwise the periodic poll never refreshes from the server's
	// (already-invalidated) cache.
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	// The network this caller is on, stamped on the poll they already make so
	// "Data used" can attribute a window without a request of its own. Set
	// BEFORE the cache lookup and never stored with it: the body cache is
	// shared across one user's devices, and two devices on different networks
	// must not read each other's answer (netinfo.go).
	setNetworkHeader(w, r)

	if body, ok := sessionsCacheInstance.get(osUser); ok {
		w.Write(body)
		return
	}
	body := buildSessionsBody(osUser)
	sessionsCacheInstance.put(osUser, body)
	w.Write(body)
}

// userSessions runs `tmux list-sessions` as osUser and returns the parsed,
// liveness-corrected sessions — the shared core behind both GET /sessions
// (buildSessionsBody) and the background push sender (pushsender.go), so the
// tmux read + parse + dead-state backstop live in exactly one place. Returns
// nil when tmux errors (no server / not reachable); a healthy server with no
// sessions returns a non-nil empty slice.
func userSessions(osUser string) []Session {
	sessions, _ := userSessionsAndActivity(osUser)
	return sessions
}

// userSessionsAndActivity is userSessions plus the client-activity reading the
// push sender gates on, which comes out of the same `list-clients` call. The
// two used to be separate forks a few milliseconds apart, once per subscribed
// user per tick, for two halves of one answer.
//
// The activity map is nil when tmux could not be reached or nothing is
// attached; the gate reads that as "no data" and fails open, as before.
func userSessionsAndActivity(osUser string) ([]Session, map[string]int64) {
	out, err := tmuxCmd(osUser, "list-sessions", "-F", tmuxListFmt).Output()
	if err != nil {
		return nil, nil
	}
	sessions := parseSessions(out)
	var activity map[string]int64
	// Who is DRIVING, as opposed to merely attached (Watch mode), and when each
	// session last saw a keystroke. One extra fork per list build, behind the
	// same sessionsTTL cache as the rest; a failure here just leaves every
	// session undriven, which is the safe way round — the lobby then attaches
	// read-write exactly as it did before.
	if raw, cerr := tmuxCmd(osUser, "list-clients", "-F", clientsListFmt).Output(); cerr == nil {
		clients := parseClients(raw)
		markDriven(sessions, clients)
		activity = latestActivity(clients)
		// Driven is what "last driven" is derived from, so the stamp is written
		// here, while the client list is in hand. A read-only client reaches
		// markDriven and is skipped by it, which is exactly why watching a
		// session no longer moves its clock.
		stampDrives(osUser, sessions, time.Now().Unix())
	}
	// One /proc snapshot serves two readers: the liveness backstop (drop
	// states whose claude died without a SessionEnd hook) and the tool mark
	// (which command each session runs). A failed scan fails open — states
	// are kept as-is and tools stay empty. The snapshot is machine-global,
	// so it comes from procCacheInstance and is shared by every user looked
	// at in the same request or push tick.
	if tree, err := procCacheInstance.get(); err == nil {
		clearDeadStates(sessions, tree)
		annotateTools(sessions, tree)
	} else {
		log.Printf("proc scan failed (keeping hook states as-is): %v", err)
	}
	// A session's name is an opaque id, so a title is the only readable thing
	// about it — and nobody types one any more. Claude Code's own conversation
	// summary arrives in the pane title a few seconds after the first prompt,
	// and this is where it becomes the session's title (autotitle.go). Runs
	// AFTER clearDeadStates, so a claude that died at launch leaves its session
	// untitled rather than taking whatever the dead pane last wrote.
	autoTitleSessions(osUser, sessions, time.Now())
	return sessions, activity
}

// buildSessionsBody returns the JSON body to write on the wire for GET
// /sessions. Mirrors the historic encoder output: success → marshaled slice +
// trailing newline; tmux error → "[]" without a newline.
func buildSessionsBody(osUser string) []byte {
	own := userSessions(osUser) // nil on tmux error, non-nil (maybe empty) when healthy
	ps, perr := projectStoreInstance.load()
	ss, serr := shareStoreInstance.load()
	if perr != nil {
		log.Printf("project load for %s failed (serving without projects): %v", osUser, perr)
	}
	if serr != nil {
		log.Printf("share load for %s failed (serving without shared sessions): %v", osUser, serr)
	}

	result := make([]Session, 0, len(own))
	for i := range own {
		own[i].Owner = osUser
		if perr == nil {
			own[i].Project = projectNameOf(ps, osUser, own[i].Name)
		}
	}
	result = append(result, own...)

	// Foreign sessions: those owned by others that the caller may see via a
	// shared project or a direct share. Store trouble must not take the list
	// down — foreign sessions just don't appear until the stores recover.
	if perr == nil && serr == nil {
		byOwner := map[string]map[string]Session{}
		for _, r := range foreignRefsFor(osUser, ps, ss) {
			if _, ok := byOwner[r.Owner]; !ok {
				m := map[string]Session{}
				for _, s := range userSessions(r.Owner) {
					m[s.Name] = s
				}
				byOwner[r.Owner] = m
			}
			s, live := byOwner[r.Owner][r.Name]
			if !live {
				continue // only surface foreign sessions that actually exist now
			}
			s.Owner = r.Owner
			s.Access = r.Access
			s.Project = r.Project
			result = append(result, s)
		}
	}

	// Preserve the historic "tmux down and nothing to show" signal.
	if own == nil && len(result) == 0 {
		return []byte("[]")
	}
	body, err := json.Marshal(result)
	if err != nil {
		return []byte("[]")
	}
	return append(body, '\n')
}

// sessionIDRe is the shape tmux guarantees for #{session_id}. Used as the
// row's validity anchor — see parseSessions.
var sessionIDRe = regexp.MustCompile(`^\$[0-9]+$`)

// parseSessions decodes `tmux list-sessions -F tmuxListFmt` output. Short
// lines are skipped (a tmux hiccup must not 500 the list); SplitN keeps a
// pane_title containing the separator intact in the trailing field instead
// of hiding the whole session.
//
// The row is validated from two directions. session_id leads and must look
// like $N: a separator smuggled into a SESSION name (possible outside the
// API's NAME_RE) shifts every field left, and the id anchor catches that
// before anything else has to. The three numeric columns then parse strictly
// as a second line of defence. Skipping such a row beats serving a garbage
// session the UI can't act on.
//
// Unknown state values are dropped; whether the claude behind a state is
// still alive is decided later by clearDeadStates (proc.go).
func parseSessions(out []byte) []Session {
	sessions := make([]Session, 0)
	for _, line := range strings.Split(strings.TrimRight(string(out), "\n"), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, listSep, listFields)
		if len(parts) != listFields {
			continue
		}
		if !sessionIDRe.MatchString(parts[0]) {
			continue
		}
		// Only list what a client could actually address. Every endpoint that
		// takes a session name validates it against sessionNameRe, so a name
		// this rejects can be shown but never attached, renamed, or killed —
		// a card that does nothing. Pre-warmed pool slots are named beyond the
		// 32-char limit precisely so they land here and stay out of the lobby.
		if !sessionNameRe.MatchString(parts[1]) {
			continue
		}
		attached, errA := strconv.Atoi(parts[2])
		activity, errB := strconv.ParseInt(parts[3], 10, 64)
		created, errC := strconv.ParseInt(parts[4], 10, 64)
		if errA != nil || errB != nil || errC != nil {
			continue
		}
		// Parsed leniently on purpose: @last_drive renders EMPTY when unset,
		// which is every session predating the option — dropping those rows
		// would empty the sidebar on the deploy that introduced the field.
		lastDrive, _ := strconv.ParseInt(parts[5], 10, 64)
		state := parts[6]
		if !knownStates[state] {
			state = ""
		}
		panePID, _ := strconv.Atoi(parts[7])
		sessions = append(sessions, Session{
			ID:           parts[0],
			Name:         parts[1],
			Attached:     attached,
			LastActivity: activity,
			LastDrive:    lastDrive,
			Created:      created,
			State:        state,
			PanePID:      panePID,
			Command:      parts[8],
			Title:        parts[9],
			PaneTitle:    parts[10],
		})
	}
	return sessions
}

// logAndFail logs the operator-facing detail and returns an opaque 500.
func logAndFail(w http.ResponseWriter, format string, args ...any) {
	log.Printf(format, args...)
	// Every unexpected 500 in this service funnels through here, so this is
	// where "what is breaking for people" gets counted. The format STRING is
	// the kind (a fixed literal at each call site); the args are not logged as
	// an attribute — they carry paths and names.
	events.Emit("api.error", "", telemetry.Attrs{"tl.kind": format})
	http.Error(w, "internal error", http.StatusInternalServerError)
}

func handleSessionByName(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/sessions/")
	path = strings.TrimSuffix(path, "/")
	parts := strings.Split(path, "/")
	name := parts[0]
	if !sessionNameRe.MatchString(name) {
		http.Error(w, "invalid session name", http.StatusBadRequest)
		return
	}
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}

	if len(parts) == 1 {
		if r.Method != http.MethodDelete {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		killSession(w, osUser, name)
		return
	}
	if len(parts) == 2 && parts[1] == "rename" {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		renameSession(w, r, osUser, name)
		return
	}
	if len(parts) == 2 && parts[1] == "title" {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		setSessionTitle(w, r, osUser, name)
		return
	}
	if len(parts) == 2 && parts[1] == "copy-mode" {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		copyModeSession(w, r, osUser, name)
		return
	}
	if len(parts) == 2 && parts[1] == "capture" {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		captureSession(w, osUser, name)
		return
	}
	http.Error(w, "not found", http.StatusNotFound)
}

func killSession(w http.ResponseWriter, osUser, name string) {
	out, err := tmuxCmd(osUser, "kill-session", "-t", exactSession(name)).CombinedOutput()
	if err != nil {
		msg := string(out)
		if strings.Contains(msg, "can't find session") || strings.Contains(msg, "no server running") {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}
		log.Printf("kill-session %s as %s failed: %v: %s", name, osUser, err, msg)
		http.Error(w, "kill-session failed", http.StatusInternalServerError)
		return
	}
	// Tell this user's T3 syncer, if they have one. Reaching here is the only
	// proof anywhere on the box that a session was destroyed on PURPOSE — an
	// OOM, a crashed tmux server or a reboot never does — and "kill crosses,
	// exit does not" is built on exactly that (killnotify.go).
	//
	// Only the lookup is synchronous, and it is one read of a small local file.
	// The POST goes on its own goroutine: the kill has already succeeded, so the
	// answer the user gets must not depend on a syncer that is stopped, wedged
	// or not installed.
	if url, ok := syncNotifyURL(osUser); ok {
		notice := killNotice{OSUser: osUser, Session: name, KilledAt: time.Now().UTC(), Source: killNotifySource}
		go func() {
			if err := postKillNotice(url, notice); err != nil {
				log.Printf("kill-notify for %s/%s: %v", osUser, name, err)
			}
		}()
	}
	// A UI kill is deliberate — drop the session's project assignment.
	// (Deaths outside the API keep theirs so a restore regroups them.)
	// Remember it first: the picker can restore this session from an older
	// snapshot long after the layout has forgotten where it went, and landing
	// in Ungrouped is where a recovered session is hardest to find again.
	rememberKilledAssignment(osUser, name)
	// The title goes with it, for the same reason the persist manifest row
	// does: a deliberate kill means this session is not coming back, so
	// keeping its title would only re-stamp a name someone else may reuse.
	if err := titleStoreInstance.forget(osUser, name); err != nil {
		log.Printf("title memory: forgetting %s for %s failed: %v", name, osUser, err)
	}
	if err := layoutStoreInstance.removeSession(osUser, name); err != nil {
		log.Printf("layout cleanup after killing %s for %s failed: %v", name, osUser, err)
	}
	// …and drop it from the tmux-persist manifest, for the same reason. POST
	// /restore recreates every manifest row that is not currently live, and the
	// manifest is only rewritten every 5 min by tmux-persist-save.timer — so
	// without this the Restore button resurrects a session the user just chose
	// to kill, relaunching `claude --resume <uuid>` when the row carries one.
	// Only a kill THROUGH this handler forgets: an OOM or a crashed tmux server
	// never reaches here, so the recovery restore exists for still works.
	// Best-effort — tmux is already gone, so a failed forget is a log line, not
	// a 500 the UI would render as "kill failed".
	forget := exec.Command(sudoBinary, "-n", persistForgetWrapper, osUser, name)
	if out, err := forget.CombinedOutput(); err != nil {
		log.Printf("persist-forget after killing %s for %s failed: %v: %s", name, osUser, err, strings.TrimSpace(string(out)))
	}
	sessionsCacheInstance.invalidate(osUser)
	events.Emit("session.killed", osUser, telemetry.Attrs{"tl.session": name, "tl.client": "api"})
	w.WriteHeader(http.StatusNoContent)
}

func renameSession(w http.ResponseWriter, r *http.Request, osUser, oldName string) {
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	newName := strings.TrimSpace(body.Name)
	if !sessionNameRe.MatchString(newName) {
		http.Error(w, "invalid new name", http.StatusBadRequest)
		return
	}
	if newName == oldName {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if !renameTmuxSession(w, osUser, oldName, newName) {
		return
	}
	carryRenameAcrossStores(osUser, oldName, newName)
	sessionsCacheInstance.invalidate(osUser)
	events.Emit("session.renamed", osUser, telemetry.Attrs{
		"tl.from": oldName, "tl.to": newName, "tl.client": "api",
	})
	w.WriteHeader(http.StatusNoContent)
}

// setSessionTitle is POST /sessions/{name}/title — every retitle there is.
//
// A session's name is an opaque id fixed at creation (ADR-0019), so a title
// never moves anything else: no rename, no stores to carry, and no
// re-navigation of the terminal iframe for the person who typed it. PATCH
// /sessions/{name} used to carry a rename alongside the stamp and was retired
// with the derivation that produced the new name.
//
// Three callers: the lobby stamping a title onto a session it has just created
// (creation reaches no server, so this is the first the API hears of it),
// editing one from a card, and clearing a title back to nothing.
func setSessionTitle(w http.ResponseWriter, r *http.Request, osUser, name string) {
	var body struct {
		Title string `json:"title"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if !stampTitle(w, osUser, name, slug.CleanTitle(body.Title)) {
		return
	}
	sessionsCacheInstance.invalidate(osUser)
	events.Emit("session.retitled", osUser, telemetry.Attrs{
		"tl.session": name, "tl.client": "api",
	})
	w.WriteHeader(http.StatusNoContent)
}

// stampTitle writes @title onto a live session and mirrors it into the titles
// store, which is what carries it across a restore. An empty title UNSETS the
// option rather than setting it to "", so a session goes back to showing its
// name. Writes the response and returns false when it could not.
//
// The title reaches tmux as one argv element, never a shell word, so no
// escaping question arises for the arbitrary text it carries.
func stampTitle(w http.ResponseWriter, osUser, name, title string) bool {
	args := []string{"set-option", "-t", exactPane(name), sessionTitleOption, title}
	if title == "" {
		// Measured on 3.4: unsetting an option that was never set exits 0
		// silently, so clearing a title needs no "was it set" check.
		args = []string{"set-option", "-u", "-t", exactPane(name), sessionTitleOption}
	}
	if out, err := tmuxCmd(osUser, args...).CombinedOutput(); err != nil {
		msg := string(out)
		if tmuxTargetMissing(msg) {
			http.Error(w, "session not found", http.StatusNotFound)
			return false
		}
		log.Printf("set %s on %s as %s failed: %v: %s", sessionTitleOption, name, osUser, err, msg)
		http.Error(w, "set-option failed", http.StatusInternalServerError)
		return false
	}
	if err := titleStoreInstance.set(osUser, name, title); err != nil {
		// The option landed, so the title is live; only its survival across a
		// restore is at risk. Not worth failing a request the user watched
		// succeed.
		log.Printf("title memory: remembering %s/%s failed: %v", osUser, name, err)
	}
	return true
}

// renameTmuxSession performs the tmux half of a rename and maps its failures
// onto statuses. Writes the response and returns false when it did.
func renameTmuxSession(w http.ResponseWriter, osUser, oldName, newName string) bool {
	out, err := tmuxCmd(osUser, "rename-session", "-t", exactSession(oldName), newName).CombinedOutput()
	if err == nil {
		return true
	}
	msg := string(out)
	if tmuxTargetMissing(msg) {
		http.Error(w, "session not found", http.StatusNotFound)
		return false
	}
	if strings.Contains(msg, "duplicate session") || strings.Contains(msg, "session already exists") {
		http.Error(w, "target name already exists", http.StatusConflict)
		return false
	}
	log.Printf("rename-session %s→%s as %s failed: %v: %s", oldName, newName, osUser, err, msg)
	http.Error(w, "rename-session failed", http.StatusInternalServerError)
	return false
}

// tmuxTargetMissing recognises "the thing you named is not there" across the
// verbs this service runs. The spelling differs by verb and by how the server
// is missing — measured on 3.4: kill/rename say "can't find session",
// set-option says "no such session", a stopped server says "no server
// running", and a socket whose directory is gone says "error connecting to".
// All four mean the same thing to a caller: 404.
func tmuxTargetMissing(msg string) bool {
	for _, s := range []string{
		"can't find session", "no such session",
		"no server running", "error connecting to",
	} {
		if strings.Contains(msg, s) {
			return true
		}
	}
	return false
}

// carryRenameAcrossStores lives in rename_cascade.go — every store that keys
// on a session's name, moved together.
