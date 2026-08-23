package main

// Speculative pre-warming.
//
// Opening the lobby's create input is a strong hint that a session is about to
// exist, and it happens seconds before the name is typed — while the DIRECTORY
// is already known, because it belongs to the project whose input was opened.
// That gap is worth about as much as Claude's whole ~2.4s boot, so we start a
// slot on the guess and let the ordinary claim in tmux-user-attach adopt it when
// the create lands.
//
// The standing pool (tl-pool-warm@, enabled per user) and this are the same
// mechanism with different lifetimes: a standing slot is replaced when claimed
// and lives forever, a speculative one is claimed or collected. What separates
// them is the @tl_speculative option tmux-user-attach stamps, which is also what
// keeps a reaper from ever touching the standing slot.
//
// Waste is bounded three ways, because each slot is a real ~530MB Claude:
// the lobby releases explicitly when its input closes; a cap refuses runaway
// requests; and a TTL collects what a closed tab could never release.

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	// poolSlotPrefix must match POOL_PREFIX in devvm/tmux-user-attach. It is
	// longer than sessionNameRe allows, which is what makes a slot impossible
	// for any client to address — see prewarmSlotName.
	poolSlotPrefix = "__terminal_lobby_prewarmed_pool_slot_"

	// speculativeOption is the tmux session option tmux-user-attach stamps on a
	// slot warmed on a guess, holding the unix time the guess was made.
	speculativeOption = "@tl_speculative"

	// maxSpeculativeSlots caps how many guesses one user can have outstanding.
	// Each is a real Claude process, so this is a memory bound before it is
	// anything else. Over the cap we REFUSE rather than evict: the slots in
	// flight are backed by inputs the user actually opened, and evicting to
	// admit a newcomer would thrash boots between two open inputs and deliver
	// nothing. A refusal costs only the speculative benefit — that create falls
	// back to starting Claude at attach time, exactly as it did before.
	maxSpeculativeSlots = 4

	// speculativeTTL collects a slot the lobby never released. The explicit
	// release covers cancelling and navigating away; this is for the cases a
	// browser cannot report, above all a closed tab.
	speculativeTTL = 2 * time.Minute

	// prewarmReapInterval is how often the sweep runs. Well under the TTL so a
	// slot is collected close to when it expires rather than a tick later.
	prewarmReapInterval = 30 * time.Second
)

// prewarmSlotName derives a slot's session name from the directory it serves.
//
// It MUST agree exactly with pool_slot_name() in devvm/tmux-user-attach: the
// shell warms and claims under its own derivation, so a name computed even
// slightly differently here targets a session that does not exist and the only
// symptom is that pre-warming quietly stops working.
// TestPrewarmSlotNameMatchesShell pins the two together.
//
// The path is resolved first because one directory reaches us spelled several
// ways — the lobby's project store holds `/home/wizard/code/terminal-lobby/`
// with a trailing slash next to `/home/wizard/code/tripit` without one — and
// each spelling would otherwise get a slot of its own.
func prewarmSlotName(dir string) string {
	// EvalSymlinks and not just Clean, because the shell side uses realpath,
	// which resolves links as well as tidying the text. Clean alone would agree
	// on every ordinary path and disagree on a symlinked one — the worst shape
	// for a bug, since it would work everywhere it was tried. Clean is the
	// fallback for a path that does not resolve, matching `realpath -m`.
	clean := filepath.Clean(dir)
	if resolved, err := filepath.EvalSymlinks(clean); err == nil {
		clean = resolved
	}
	var b strings.Builder
	b.WriteString(poolSlotPrefix)
	// Byte-wise, not rune-wise, because the shell side folds with `tr`, which
	// works on bytes: a two-byte character becomes TWO underscores there and
	// would become one here. Only non-ASCII paths differ, so ranging over runes
	// agrees on everything anyone is likely to try and disagrees exactly where
	// nobody would look.
	for i := 0; i < len(clean); i++ {
		c := clean[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') {
			b.WriteByte(c)
		} else {
			b.WriteByte('_')
		}
	}
	return b.String()
}

// prewarmAllowedDir answers whether this user may ask for a slot in dir.
//
// The endpoint starts a process on request, so the directory is not taken on
// trust: it has to be one this user's own lobby would actually create a session
// in — a dir on one of their layout projects, or their home. That keeps the
// request to "warm a place I can already open a session in" rather than "run
// Claude anywhere on the box", and it means a compromised or buggy client cannot
// widen its own reach.
//
// Comparison is on cleaned paths, for the same spelling reasons as the slot
// name: a project stored with a trailing slash must still match.
func prewarmAllowedDir(osUser, dir string) bool {
	want := filepath.Clean(dir)
	if !filepath.IsAbs(want) {
		return false
	}
	if home := homeOfUser(osUser); home != "" && want == filepath.Clean(home) {
		return true
	}
	l, err := layoutStoreInstance.load(osUser)
	if err != nil {
		return false
	}
	for _, p := range l.Projects {
		if p.Dir != "" && filepath.Clean(p.Dir) == want {
			return true
		}
	}
	return false
}

// speculativeSlots lists this user's outstanding guesses as name -> stamp.
//
// Only sessions carrying the marker are returned, so the standing pool slot —
// which has none — can never be counted against the cap nor collected.
func speculativeSlots(osUser string) map[string]int64 {
	out, err := tmuxCmd(osUser, "list-sessions", "-F",
		"#{session_name}\t#{"+speculativeOption+"}").Output()
	if err != nil {
		// No server, or no sessions at all. Both mean nothing to report; a
		// transient tmux failure must not look like "the cap is free".
		return nil
	}
	slots := map[string]int64{}
	for _, line := range strings.Split(strings.TrimRight(string(out), "\n"), "\n") {
		name, stamp, ok := strings.Cut(line, "\t")
		if !ok || stamp == "" || !strings.HasPrefix(name, poolSlotPrefix) {
			continue
		}
		ts, err := strconv.ParseInt(stamp, 10, 64)
		if err != nil {
			continue
		}
		slots[name] = ts
	}
	return slots
}

// startPrewarm asks the user's own systemd manager for a speculative slot.
//
// Delegated to systemd rather than started here so the tmux server lands in the
// user's manager and not in this service's cgroup — the same reason
// tmux-user-attach exists. --no-block because a ~2.4s Claude boot must not hold
// the HTTP request open; the point is that it runs while the user types.
func startPrewarm(osUser, dir string) error {
	inst := fmt.Sprintf("tl-prewarm@%s.service", systemdEscapePath(dir))
	return userSystemctl(osUser, "start", "--no-block", inst).Run()
}

// handlePrewarm serves POST/DELETE /sessions/prewarm {"dir": "..."}.
//
// POST is a HINT, not a promise: every refusal (unknown dir, cap reached, a
// systemd hiccup) answers 204 alongside a success, because the caller has
// nothing to do differently either way — the create it precedes still works,
// just without the head start. Reporting an error would invite a client to
// retry a thing that is meant to be cheap and optional.
func handlePrewarm(w http.ResponseWriter, r *http.Request) {
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		http.Error(w, "POST or DELETE only", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Dir string `json:"dir"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&body); err != nil {
		http.Error(w, "bad body (need {\"dir\": \"...\"})", http.StatusBadRequest)
		return
	}
	if !prewarmAllowedDir(osUser, body.Dir) {
		// Not this user's directory to warm. Logged because a legitimate client
		// never asks for one, so it is worth seeing.
		log.Printf("prewarm: %s asked for a slot in %q, which is not one of their project dirs", osUser, body.Dir)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	slot := prewarmSlotName(body.Dir)

	if r.Method == http.MethodDelete {
		// Release only ever kills a MARKED slot. Without that check a release
		// arriving for a directory that also has a standing pool slot would
		// collect the standing one, and the lobby would have quietly deleted a
		// slot it is supposed to be feeding.
		if _, ok := speculativeSlots(osUser)[slot]; ok {
			if out, err := tmuxCmd(osUser, "kill-session", "-t", exactSession(slot)).CombinedOutput(); err != nil {
				log.Printf("prewarm: releasing %s for %s: %v (%s)", slot, osUser, err, strings.TrimSpace(string(out)))
			}
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// Already warm for this dir — whether speculative or the standing slot —
	// leaves it strictly alone. tmux-user-attach is idempotent too, so this is
	// belt and braces; doing it here also keeps a repeat off the cap.
	if hasSession(osUser, slot) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if n := len(speculativeSlots(osUser)); n >= maxSpeculativeSlots {
		log.Printf("prewarm: %s already holds %d speculative slots — refusing a new one for %q", osUser, n, body.Dir)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err := startPrewarm(osUser, body.Dir); err != nil {
		// The unit may simply not be deployed for this user yet. Nothing for
		// the client to do; the create it precedes still works.
		log.Printf("prewarm: starting a slot for %s in %q: %v", osUser, body.Dir, err)
	}
	w.WriteHeader(http.StatusNoContent)
}

// reapSpeculativeSlots collects expired guesses for every mapped user.
//
// Only marked slots are considered, so the standing pool slot is untouchable
// here by construction. A CLAIMED slot has had its mark cleared by
// tmux-user-attach before the attach proceeds, so live work is never a
// candidate either — the mark is the whole safety property, in both directions.
func reapSpeculativeSlots(now time.Time) {
	for _, osUser := range mappedOSUsers() {
		for name, stamp := range speculativeSlots(osUser) {
			age := now.Sub(time.Unix(stamp, 0))
			if age < speculativeTTL {
				continue
			}
			out, err := tmuxCmd(osUser, "kill-session", "-t", exactSession(name)).CombinedOutput()
			if err != nil {
				log.Printf("prewarm: reaping %s for %s: %v (%s)", name, osUser, err, strings.TrimSpace(string(out)))
				continue
			}
			log.Printf("prewarm: reaped %s for %s (unclaimed for %s)", name, osUser, age.Round(time.Second))
		}
	}
}

// runPrewarmReaper sweeps until ctx is done. Started unconditionally: with no
// speculative slots anywhere it is one `tmux list-sessions` per mapped user per
// interval, which is the same call the sessions poll already makes.
func runPrewarmReaper(stop <-chan struct{}) {
	t := time.NewTicker(prewarmReapInterval)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case now := <-t.C:
			reapSpeculativeSlots(now)
		}
	}
}

// systemdEscapePath mirrors `systemd-escape --path`: strip the leading and
// trailing slashes, then replace each remaining '/' with '-' and escape
// anything outside the safe set as \xNN. Done in-process rather than by
// shelling out because it is on the request path, and because the escaping
// rules are fixed.
func systemdEscapePath(p string) string {
	s := strings.Trim(filepath.Clean(p), "/")
	if s == "" {
		return "-"
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '/':
			b.WriteByte('-')
		case (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_':
			b.WriteByte(c)
		case c == '.' && i > 0:
			// A leading dot must be escaped; elsewhere it is literal.
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, `\x%02x`, c)
		}
	}
	return b.String()
}

// homeOfUser is the user's home directory, or "" when they cannot be resolved.
func homeOfUser(osUser string) string {
	u, err := user.Lookup(osUser)
	if err != nil {
		return ""
	}
	return u.HomeDir
}

// uidOfUser is the user's numeric uid as a string, or "" when unresolvable.
// Used to address their systemd manager's runtime dir.
func uidOfUser(osUser string) string {
	u, err := user.Lookup(osUser)
	if err != nil {
		return ""
	}
	return u.Uid
}

// hasSession reports whether osUser's tmux server holds this exact session.
func hasSession(osUser, name string) bool {
	return tmuxCmd(osUser, "has-session", "-t", exactSession(name)).Run() == nil
}

// userSystemctl runs systemctl --user against osUser's own manager. For another
// user that means sudo plus the runtime dir their manager listens on, which is
// the same shape tmux-user-attach sets up before calling systemd-run.
func userSystemctl(osUser string, args ...string) *exec.Cmd {
	full := append([]string{"--user"}, args...)
	uid := uidOfUser(osUser)
	runtime := "/run/user/" + uid
	if osUser == selfUser {
		c := exec.Command("systemctl", full...)
		// Set even for ourselves. This service runs AS wizard but under the
		// SYSTEM manager, so it inherits no XDG_RUNTIME_DIR and `systemctl
		// --user` cannot find the bus at all — it fails with "Failed to connect
		// to bus: No medium found". Pointing it at the user manager explicitly
		// is what makes the self case work, and it is easy to assume a matching
		// user needs no environment.
		c.Env = append(os.Environ(),
			"XDG_RUNTIME_DIR="+runtime,
			"DBUS_SESSION_BUS_ADDRESS=unix:path="+runtime+"/bus")
		return c
	}
	pre := []string{"-n", "-u", osUser,
		"env", "XDG_RUNTIME_DIR=" + runtime,
		"DBUS_SESSION_BUS_ADDRESS=unix:path=" + runtime + "/bus",
		"systemctl"}
	return exec.Command(sudoBinary, append(pre, full...)...)
}
