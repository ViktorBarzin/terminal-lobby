package main

import (
	"encoding/json"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

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
	// A session is created with an opaque id for a name, and nobody types a
	// title any more. Claude Code's own conversation summary arrives in the pane
	// title a few seconds after the first prompt, and this is where it becomes
	// the session's title (autotitle.go). Runs AFTER clearDeadStates, so a
	// claude that died at launch leaves its session untitled rather than taking
	// whatever the dead pane last wrote.
	autoTitleSessions(osUser, sessions, time.Now())
	// …and the title carries the tmux NAME with it (ADR-0022), so `tmux ls` and
	// the status bar read as words. autoTitleSessions renames what it titles;
	// this catches a session titled before the rule existed, and one restored
	// under an id. Both are fixed points, so a poll with nothing to do costs a
	// comparison per session.
	backfillDerivedNames(osUser, sessions)
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
		// @tl_created is parsed leniently for the same reason and wins when it
		// is there: Created means when the session became SOMEBODY'S, not when
		// the tmux session was made. A create that claims a pre-warmed slot
		// does it with `rename-session`, which leaves #{session_created}
		// reading the slot's own age — hours for a fresh slot, days for a
		// standing one — so a claimed session would otherwise sort that far
		// down a newest-first list. tmux-user-attach stamps the option at the
		// moment of the claim; anything it did not stamp (every session that
		// predates the stamp, every cold create, every session renamed by hand)
		// renders empty here and keeps session_created.
		if claimed, err := strconv.ParseInt(parts[12], 10, 64); err == nil && claimed > 0 {
			created = claimed
		}
		state := parts[6]
		if !knownStates[state] {
			state = ""
		}
		panePID, _ := strconv.Atoi(parts[8])
		sessions = append(sessions, Session{
			ID:           parts[0],
			Name:         parts[1],
			Attached:     attached,
			LastActivity: activity,
			LastDrive:    lastDrive,
			Created:      created,
			State:        state,
			Background:   parseBackground(parts[7]),
			PanePID:      panePID,
			Command:      parts[9],
			Title:        parts[10],
			BornAs:       parts[11],
			PaneTitle:    parts[13],
		})
	}
	return sessions
}
