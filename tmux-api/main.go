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
	"strings"
	"time"

	"terminal-lobby/authuser"
	"terminal-lobby/sessionio"
	"terminal-lobby/telemetry"
)

const (
	// Loopback by default: with no config file present, the identity header
	// is all that authenticates a request, so the port must not be on the
	// network until an operator says so (TL-3).
	listenAddr     = "127.0.0.1:7684"
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
	// field rather than shifting the row. @tl_created goes immediately BEFORE
	// it and not after, so the stamp is never the field a stray tab lands in:
	// measured on tmux 3.4, both OSC 2 and `select-pane -T` strip a tab out of
	// a pane title, but a claimed session silently falling back to
	// session_created is the very bug the stamp exists to fix, so it should not
	// rest on stripping tmux does not document.
	//
	// session_id leads. It is the one field with a guaranteed shape ($N) and
	// it SURVIVES A RENAME, which is what lets a second tab follow a session
	// whose name changed instead of holding a stale name whose iframe would
	// resurrect it as an empty session.
	tmuxListFmt = "#{session_id}" + listSep + "#{session_name}" + listSep +
		"#{session_attached}" + listSep + "#{session_activity}" + listSep +
		"#{session_created}" + listSep + "#{" + lastDriveOption + "}" + listSep +
		"#{@claude_state}" + listSep +
		"#{" + sessionBackgroundOption + "}" + listSep +
		"#{pane_pid}" + listSep + "#{pane_current_command}" + listSep +
		"#{" + sessionTitleOption + "}" + listSep +
		"#{" + sessionBornAsOption + "}" + listSep +
		"#{" + createdStampOption + "}" + listSep +
		"#{" + originOption + "}" + listSep + "#{pane_title}"

	// listSep separates tmuxListFmt's fields; listFields is how many there are.
	listSep    = "\t"
	listFields = 15

	// bgColumn is where the outstanding-work option sits in tmuxListFmt. It
	// goes immediately after @claude_state and BEFORE pane_title, because
	// pane_title is application-controlled text and has to stay last: SplitN
	// gives the final field whatever separators are left over, which is the
	// only thing protecting the row from a title that contains one.
	bgColumn = 7

	// bornColumn is where the birth name sits in tmuxListFmt: after @title and
	// before pane_title, which stays last for the reason bgColumn gives.
	bornColumn = 11

	// createdColumn is where the claim stamp sits: the last column before
	// pane_title, for the same reason bgColumn gives. Only the row builders in
	// the tests address it by name; parseSessions reads it positionally like
	// every other field.
	createdColumn = 12

	// originColumn is where the origin stamp sits: the last column before
	// pane_title, which pushed pane_title from 13 to 14 and moved nothing
	// ahead of it. Same reason bgColumn gives, and here it is load-bearing
	// rather than tidy — pane_title is text an application writes for itself
	// via OSC 2, and SplitN hands the LAST field every separator left over, so
	// an origin parsed out of the tail would be whatever the pane last said. A
	// session could then talk itself out of the System group by printing a tab
	// and the word `user`. Only the row builders in the tests address this by
	// name; parseSessions reads it positionally like every other field.
	originColumn = 13

	// sessionTitleOption is where a display title lives, alongside
	// @claude_state. Named in sessionio so this service, t3-sync and anything
	// else reading a session's options agree on the spelling. Options die with
	// the session that holds them, which is right for state and wrong for a
	// title someone chose — the titles store (titles.go) is what carries a
	// title across a restore.
	sessionTitleOption = sessionio.OptionTitle

	// sessionBornAsOption carries the name a session was created with, stamped
	// by the first rename that moves it. It rides this format for the same
	// reason @title does — the option is already on the session, so reading it
	// costs nothing — and sits before pane_title, which has to stay last.
	sessionBornAsOption = sessionio.OptionBornAs

	// sessionBackgroundOption holds the session's outstanding background work
	// as `<kind>:<id>` tokens, written by the same hook script as
	// @claude_state. It rides the list format rather than costing a second
	// tmux call, exactly as @claude_state does.
	sessionBackgroundOption = sessionio.OptionBackground

	// createdStampOption is when a session became somebody's, as opposed to
	// when the tmux session was made. The SHELL writes it and this service only
	// reads it: tmux-user-attach stamps it at the moment a create claims a
	// pre-warmed slot, because that claim is a `rename-session` and a rename
	// leaves #{session_created} reading the slot's own age (measured 4h33m
	// stale on 2026-09-04, and days stale for a standing slot). Spelled as a
	// literal rather than via sessionio for the same reason @last_drive is —
	// nothing in Go sets it, so there is no writer to agree with; the guard
	// that keeps the two spellings together is a test against the script.
	//
	// It sits ahead of pane_title, which keeps pane_title the field that soaks
	// up a stray tab. That cost one index when it landed: pane_title moved from
	// 12 to 13, and every column ahead of it, bgColumn and bornColumn included,
	// stayed where it was. @tl_origin has since taken the slot immediately
	// before pane_title for the same reason, moving pane_title again to 14 and
	// leaving this stamp at 12.
	createdStampOption = "@tl_created"

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

// tmuxCmd runs tmux as osUser: directly when that is this service's own user,
// through `sudo -n -u` otherwise. The rule itself is sessionio.Injector.Command,
// which this service already depends on and already builds an Injector from
// (shares.go); re-deriving it here is how the two copies drifted. The Injector
// is built per call, not once at startup, because tmuxBinary and sudoBinary are
// test seams and a captured copy would ignore a stub.
//
// No -H, matching what this function has always sent. The two calls that do
// pass one (newcommands.go's attach probe, dirs.go's dirlist wrapper) build
// their own argv for a different binary and do not come through here.
func tmuxCmd(osUser string, args ...string) *exec.Cmd {
	in := sessionio.NewInjector(selfUser)
	in.Binary, in.Sudo = tmuxBinary, sudoBinary
	return in.Command(osUser, args...)
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
	// One goroutine, in order: the rename pass makes a pin stale, so the sweep
	// that repairs stale pins has to follow it rather than race it. The origin
	// grandfather goes LAST for the same reason — it lists sessions itself, and
	// listing after the renames means it stamps the names the sessions will
	// keep rather than ones the pass above is about to change underneath it.
	go func() {
		migrateSessionNamesToIDs(mappedOSUsers(), userSessions)
		repairStaleGridPins(mappedOSUsers(), userSessions)
		grandfatherSessionOrigins(mappedOSUsers(), userSessions)
	}()

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
	http.HandleFunc("/agent-spend", handleAgentSpend)
	http.HandleFunc("/telemetry", handleTelemetry)
	http.HandleFunc("/push-subscriptions", handlePushSubscriptions)
	http.HandleFunc("/push/focus", handlePushFocus)
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
	// TL_BIND is the listen address. The compiled default is loopback, so a
	// process that reaches no configuration at all stays off the network;
	// the shipped conffile says the same. Widening to 0.0.0.0 for a proxy on
	// another host is the operator's explicit act, made in the file where
	// TL_PROXY_SECRET is set alongside it.
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
