package main

// Session-snapshot endpoints behind the lobby's restore picker.
//
// tmux-persist keeps a short SERIES of snapshots per user rather than one
// live manifest, because a partial loss (tmux server alive, the processes
// inside sessions killed) used to be overwritten by the next 5-minute save
// before anyone could restore from it. These endpoints expose that series:
// which versions exist, what restoring one would do, and restoring a chosen
// subset of it.
//
// All three read through the same validated root wrapper as POST /restore
// (tmux-restore-user), which re-checks the OS user against /etc/ttyd-user-map.
// The caller can only ever see and restore their OWN snapshots — osUser comes
// from resolveOSUser, never from the request body.

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os/exec"
	"regexp"
	"strconv"
	"strings"

	"terminal-lobby/telemetry"
)

// Snapshot timestamps are the snapshot FILENAMES (YYYYMMDDTHHMMSS) and reach a
// root wrapper as argv, so they are validated here as well as in the wrapper.
var snapshotTSRe = regexp.MustCompile(`^[0-9]{8}T[0-9]{6}$`)

// Snapshot is one row of the picker's version list.
type Snapshot struct {
	TS    string `json:"ts"`
	Count int    `json:"count"`
	// Newest marks the snapshot the plain Restore button would use, and the
	// one the picker opens on.
	Newest bool `json:"newest"`
	// DeltaVsLive is how many more sessions this snapshot holds than are
	// running now — the column that points at an older version after a loss.
	DeltaVsLive int `json:"deltaVsLive"`
	// LastFull labels the most recent snapshot at the high-water mark. It is a
	// hint only: the picker never auto-selects it (predictable beats clever).
	LastFull bool `json:"lastFull"`
}

// SnapshotRow is one session inside a snapshot, already resolved against what
// is live right now. Resolution happens server-side so both frontends share
// one rule set rather than re-deriving it in two idioms.
type SnapshotRow struct {
	Name string `json:"name"`
	Cwd  string `json:"cwd"`
	UUID string `json:"uuid,omitempty"`
	// State: missing | live_same | live_other_conv | live_no_claude
	State string `json:"state"`
	// Action: new | suffixed | in_place | skip
	Action string `json:"action"`
	// Target is the session name this row would produce — the same name, or a
	// -HHMM suffixed one when the name is taken by another conversation.
	Target string `json:"target"`
	// Default is whether the row starts ticked. False for anything already
	// live, and for a session the user deliberately killed after this snapshot.
	Default bool `json:"default"`
	// KilledAt is set when a deliberate kill is why Default is false.
	KilledAt int64 `json:"killedAt,omitempty"`
}

// persistCmd runs the root wrapper with the caller's own OS user.
func persistCmd(osUser string, args ...string) *exec.Cmd {
	return exec.Command(sudoBinary, append([]string{"-n", restoreWrapper, osUser}, args...)...)
}

// handleSnapshots (GET /snapshots) lists the caller's snapshot series, newest
// first, annotated with how each compares to what is running now.
func handleSnapshots(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}
	out, err := persistCmd(osUser, "list").Output()
	if err != nil {
		log.Printf("snapshots list for %s failed: %v", osUser, err)
		http.Error(w, "could not read snapshots", http.StatusInternalServerError)
		return
	}

	liveCount := len(userSessions(osUser))
	snaps := parseSnapshotList(string(out), liveCount)

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(snaps)
}

// parseSnapshotList turns the wrapper's TSV into the picker's list. Split out
// from the handler so the annotation rules are directly testable.
func parseSnapshotList(out string, liveCount int) []Snapshot {
	snaps := []Snapshot{}
	for _, line := range strings.Split(strings.TrimRight(out, "\n"), "\n") {
		if line == "" {
			continue
		}
		f := strings.Split(line, "\t")
		if len(f) < 3 || !snapshotTSRe.MatchString(f[0]) {
			continue
		}
		n, err := strconv.Atoi(f[1])
		if err != nil {
			continue
		}
		snaps = append(snaps, Snapshot{
			TS:          f[0],
			Count:       n,
			Newest:      f[2] == "newest",
			DeltaVsLive: n - liveCount,
		})
	}
	// "Last full" = the most recent snapshot at the high-water mark, and only
	// when that mark is above what is running — with nothing lost there is no
	// full-er version to point at.
	best := -1
	for i, s := range snaps {
		if best == -1 || s.Count > snaps[best].Count {
			best = i // list is newest-first, so > (not >=) keeps the most recent
		}
	}
	if best >= 0 && snaps[best].Count > liveCount {
		snaps[best].LastFull = true
	}
	return snaps
}

// handleSnapshotByTS (GET /snapshots/{ts}) resolves one snapshot against the
// live session set: per row, what restoring it would do and whether it should
// start ticked.
func handleSnapshotByTS(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}
	ts := strings.TrimPrefix(r.URL.Path, "/snapshots/")
	if !snapshotTSRe.MatchString(ts) {
		http.Error(w, "bad snapshot id", http.StatusBadRequest)
		return
	}
	out, err := persistCmd(osUser, "show", ts).Output()
	if err != nil {
		log.Printf("snapshot %s for %s failed: %v", ts, osUser, err)
		http.Error(w, "no such snapshot", http.StatusNotFound)
		return
	}

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(parseSnapshotRows(string(out)))
}

func parseSnapshotRows(out string) []SnapshotRow {
	rows := []SnapshotRow{}
	for _, line := range strings.Split(strings.TrimRight(out, "\n"), "\n") {
		if line == "" {
			continue
		}
		// name, cwd, uuid, state, action, target, default, note
		f := strings.Split(line, "\t")
		if len(f) < 8 {
			continue
		}
		row := SnapshotRow{
			Name:    f[0],
			Cwd:     dashToEmpty(f[1]),
			UUID:    dashToEmpty(f[2]),
			State:   f[3],
			Action:  f[4],
			Target:  f[5],
			Default: f[6] == "on",
		}
		if k, ok := strings.CutPrefix(f[7], "killed@"); ok {
			if n, err := strconv.ParseInt(k, 10, 64); err == nil {
				row.KilledAt = n
			}
		}
		rows = append(rows, row)
	}
	return rows
}

// tmux-persist writes "-" rather than an empty field: tab is IFS-whitespace, so
// an empty field would collapse and shift every column after it.
func dashToEmpty(s string) string {
	if s == "-" {
		return ""
	}
	return s
}

// restoreSelection is the optional POST /restore body. An empty body keeps the
// blanket behaviour the boot path and the old button rely on.
type restoreSelection struct {
	Snapshot string   `json:"snapshot"`
	Sessions []string `json:"sessions"`
}

// restoreFromSelection performs a picker restore. Returns an HTTP status and a
// message for the caller; the osUser is always the authenticated one.
func restoreFromSelection(osUser string, sel restoreSelection) (int, string) {
	if !snapshotTSRe.MatchString(sel.Snapshot) {
		return http.StatusBadRequest, "bad snapshot id"
	}
	if len(sel.Sessions) == 0 {
		return http.StatusBadRequest, "no sessions selected"
	}
	// Names reach a root wrapper as argv. The wrapper re-validates, but a bad
	// name is a client bug worth reporting as 400 rather than a 500 from deeper
	// in the stack.
	for _, n := range sel.Sessions {
		if !sessionNameRe.MatchString(n) {
			return http.StatusBadRequest, fmt.Sprintf("bad session name: %q", n)
		}
	}
	args := append([]string{"select", sel.Snapshot}, sel.Sessions...)
	out, err := persistCmd(osUser, args...).CombinedOutput()
	if err != nil {
		log.Printf("restore-selection %s for %s failed: %v: %s",
			sel.Snapshot, osUser, err, strings.TrimSpace(string(out)))
		return http.StatusInternalServerError, "restore failed"
	}
	log.Printf("restore-selection %s for %s: %s", sel.Snapshot, osUser, strings.TrimSpace(string(out)))
	return http.StatusOK, ""
}

// emitRestored records a restore for the usage telemetry, tagged with whether
// it came from the picker or the plain button.
func emitRestored(osUser, client string) {
	events.Emit("session.restored", osUser, telemetry.Attrs{"tl.client": client})
}
