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
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

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
	// Title is what a person reads for this row. A name is an opaque id since
	// ADR-0019, so without this the picker is a list of 12-character strings
	// nobody can choose between. Empty when the session was never titled, or
	// when its title is the id itself; the picker then falls back to the name.
	Title string `json:"title,omitempty"`
	Cwd   string `json:"cwd"`
	UUID  string `json:"uuid,omitempty"`
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
	// Project is where restoring this row would put the session — resolved by
	// the same function the restore uses, so the picker's preview and the
	// placement cannot disagree. "" is Ungrouped. See assignments.go.
	Project string `json:"project,omitempty"`
}

// persistCmd runs the root wrapper with the caller's own OS user.
func persistCmd(osUser string, args ...string) *exec.Cmd {
	return exec.Command(sudoBinary, append([]string{"-n", restoreWrapper, osUser}, args...)...)
}

// persistCmdContext is persistCmd with a deadline: the process is killed when
// ctx is done. Only the pre-kill snapshot uses it, because it is the only
// wrapper call a person is waiting on with a request already half-run.
func persistCmdContext(ctx context.Context, osUser string, args ...string) *exec.Cmd {
	c := exec.CommandContext(ctx, sudoBinary, append([]string{"-n", restoreWrapper, osUser}, args...)...)
	// Without this the deadline does not bind. The wrapper is a shell script,
	// so killing it on ctx leaves its CHILDREN holding the pipes this call is
	// reading, and CombinedOutput blocks until the last of them exits: a save
	// that hangs for ten seconds still costs ten seconds. WaitDelay closes the
	// pipes shortly after the kill and returns.
	c.WaitDelay = 500 * time.Millisecond
	return c
}

// preKillSnapshotBudget is how long the whole pre-kill snapshot may take —
// waiting for a turn plus the save plus the list.
//
// Well under the 8s the browser abandons a request at (frontend-v2
// lib/http.ts REQUEST_TIMEOUT_MS), because past that deadline the client gives
// up and toasts a failed kill while this handler carries on and kills the
// session anyway: the card then says the kill failed, the session is gone, and
// the undo entry has no record to work from. A snapshot that costs more than
// the kill is not worth the kill, so it is dropped and the session dies
// undoable-from-nothing, which is the same outcome as any other failed save.
//
// A var so a test can shorten it.
var preKillSnapshotBudget = 4 * time.Second

// saveSlot lets ONE pre-kill snapshot run at a time.
//
// `save` is not per-user work however it is called: the wrapper validates the
// user it is handed and then snapshots every mapped user on the box
// (tmux-persist save), walking each one's panes with tmux, ps, and for a claude
// pane with no stamp a find over that user's transcripts. Two of those at once
// duplicate all of it, and handlers run one per request, so without this a
// burst of DELETEs fans out into as many concurrent root runs as there are
// requests. A caller that cannot get the slot inside the budget goes without a
// record rather than queueing, which is the same best-effort answer every
// other snapshot failure gets.
var saveSlot = make(chan struct{}, 1)

// SnapshotList is the GET /snapshots payload. MemAvailableMB rides along so the
// picker can warn before a large restore without a second round trip: restoring
// is unpaced by choice, and each restored session settles at roughly 530-560 MB
// once its MCP servers are up, so the case worth flagging is recovering while
// the box is still under memory pressure.
type SnapshotList struct {
	Snapshots []Snapshot `json:"snapshots"`
	// MemAvailableMB is -1 when /proc/meminfo could not be read, which the UI
	// treats as "say nothing" rather than "plenty of room".
	MemAvailableMB int `json:"memAvailableMb"`
	// PerSessionMB is the estimate behind the warning, so the copy the user
	// reads and the number the server measured cannot drift apart.
	PerSessionMB int `json:"perSessionMb"`
	// NewestTS names the snapshot Rows was resolved from — the one the picker
	// opens on. Empty when this box's tmux-persist predates the one-call open,
	// or when the user has no snapshots yet.
	NewestTS string `json:"newestTs,omitempty"`
	// Rows is that snapshot already resolved against live state, so the picker
	// renders from THIS response instead of waiting on a second round trip.
	// Absent means "ask for it", which is what the picker did before.
	Rows []SnapshotRow `json:"rows,omitempty"`
}

// perSessionMB is measured from the 2026-08-14 OOM dump: claude 305-334 MB,
// workspace-mcp python 107-118 MB, context7 ~56 MB, plus ~57 MB.
const perSessionMB = 550

// memAvailableMB reads MemAvailable from /proc/meminfo. Returns -1 when it
// cannot be read, so callers can distinguish "unknown" from "none left".
func memAvailableMB() int {
	raw, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return -1
	}
	for _, line := range strings.Split(string(raw), "\n") {
		rest, ok := strings.CutPrefix(line, "MemAvailable:")
		if !ok {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			return -1
		}
		kb, err := strconv.Atoi(fields[0])
		if err != nil {
			return -1
		}
		return kb / 1024
	}
	return -1
}

// picker is the wrapper's `open` output, split into the sections the existing
// parsers already understand.
type picker struct {
	live   int
	series string
	rowsTS string
	rows   string
}

// parsePicker splits `tmux-restore-user <user> open`. Returns false for
// anything that is not that format — an older wrapper answering "unknown
// action", or the plain `list` output — so the caller falls back rather than
// serving half an answer. Section headers start with '#', which no snapshot
// timestamp and no addressable session name can.
func parsePicker(out string) (picker, bool) {
	var p picker
	var series, rows []string
	seenLive, seenSeries, inRows := false, false, false
	for _, line := range strings.Split(strings.TrimRight(out, "\n"), "\n") {
		switch {
		case strings.HasPrefix(line, "#live\t"):
			n, err := strconv.Atoi(strings.TrimPrefix(line, "#live\t"))
			if err != nil {
				return picker{}, false
			}
			p.live, seenLive = n, true
		case line == "#snapshots":
			seenSeries = true
		case strings.HasPrefix(line, "#rows\t"):
			p.rowsTS, inRows = strings.TrimPrefix(line, "#rows\t"), true
		case line == "":
			continue
		case strings.HasPrefix(line, "#"):
			return picker{}, false
		case inRows:
			rows = append(rows, line)
		case seenSeries:
			series = append(series, line)
		default:
			return picker{}, false // a row before any section header
		}
	}
	if !seenLive || !seenSeries {
		return picker{}, false
	}
	p.series = strings.Join(series, "\n")
	p.rows = strings.Join(rows, "\n")
	return p, true
}

// handleSnapshots (GET /snapshots) answers everything the restore picker needs
// to open: the caller's snapshot series newest first, annotated with how each
// compares to what is running now, plus the newest snapshot already resolved.
//
// One call. It used to take two — this list, then GET /snapshots/{ts} for the
// rows — which could not overlap, since the second needs the first's answer to
// know which snapshot to ask for. Each was its own sudo, bash, user-map parse
// and tmux round trip: ~295 ms of server work on an idle box on 2026-09-01,
// and 1.9-48 s in the log when the box was short of memory, which is when
// people restore sessions.
func handleSnapshots(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}

	body := SnapshotList{MemAvailableMB: memAvailableMB(), PerSessionMB: perSessionMB}
	if p, ok := openPicker(osUser); ok {
		body.Snapshots = parseSnapshotList(p.series, p.live)
		if p.rowsTS != "" {
			body.NewestTS = p.rowsTS
			body.Rows = annotateRows(osUser, parseSnapshotRows(p.rows))
		}
	} else {
		// A box whose tmux-persist or wrapper predates `open`. The series alone
		// still opens the picker; it fetches the rows itself, as it used to.
		out, err := persistCmd(osUser, "list").Output()
		if err != nil {
			log.Printf("snapshots list for %s failed: %v", osUser, err)
			http.Error(w, "could not read snapshots", http.StatusInternalServerError)
			return
		}
		body.Snapshots = parseSnapshotList(string(out), len(userSessions(osUser)))
	}

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(body)
}

// openPicker runs the one-call open. A failure is reported rather than logged
// as fatal: the caller has a working older path to fall back to.
func openPicker(osUser string) (picker, bool) {
	out, err := persistCmd(osUser, "open").Output()
	if err != nil {
		log.Printf("snapshots open for %s failed, falling back to list: %v", osUser, err)
		return picker{}, false
	}
	p, ok := parsePicker(string(out))
	if !ok {
		log.Printf("snapshots open for %s returned an unrecognised format, falling back to list", osUser)
	}
	return p, ok
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

// newestSnapshotTS picks the snapshot a restore would use out of the wrapper's
// `list` output. tmux-persist prints the series newest-first and marks the first
// row `newest` (snapshots_rows), and parseSnapshotList already reads that
// format, so this only chooses a row. The liveCount it takes feeds DeltaVsLive
// and LastFull, neither of which is read here.
func newestSnapshotTS(out string) string {
	snaps := parseSnapshotList(out, 0)
	for _, s := range snaps {
		if s.Newest {
			return s.TS
		}
	}
	if len(snaps) > 0 {
		return snaps[0].TS
	}
	return ""
}

// resurrectRecordFor snapshots the box and returns what would bring `name`
// back, in POST /restore's own body shape.
//
// WHY A KILL SNAPSHOTS AT ALL. Snapshots are written by tmux-persist-save.timer
// on OnCalendar=*:0/5, and restore-selection refuses a name that is absent from
// the snapshot it is handed (tmux-persist restore_selection). So a session
// created and killed inside one five-minute tick is in no snapshot anywhere and
// nothing can bring it back, and a session killed minutes after it was made is
// exactly the one killed by mistake. Asking for a save first is what closes
// that, and it is why the lobby can offer undo past its grace window.
//
// The tombstone the kill writes afterwards does not take that away again:
// snapshots are immutable files, forget only appends to the tombstone list, and
// restore-selection never consults it. Only the blanket restore skips a
// tombstoned row, which is what keeps a deliberate kill from coming back on its
// own; the picker still shows it, unticked.
//
// BEST EFFORT THROUGHOUT. Every failure here is a log line and a nil record:
// losing the ability to bring a session back must never mean losing the ability
// to kill it. A wrapper too old to know `save` fails the same way, so a box
// mid-upgrade kills exactly as it did before.
//
// ONE COST, ACCEPTED: the save is synchronous, so a kill waits on one
// tmux-persist run, which walks every user as the timer does and writes nothing
// for a user whose session set has not changed. It is bounded at both ends —
// preKillSnapshotBudget caps how long the caller waits, and saveSlot caps how
// many of these run at once — and the caller only reaches here once tmux has
// confirmed the session exists (session_mutate.go killSession).
func resurrectRecordFor(osUser, name string) *restoreSelection {
	ctx, cancel := context.WithTimeout(context.Background(), preKillSnapshotBudget)
	defer cancel()
	select {
	case saveSlot <- struct{}{}:
		defer func() { <-saveSlot }()
	case <-ctx.Done():
		log.Printf("pre-kill snapshot for %s/%s gave up waiting for its turn, killing without one",
			osUser, name)
		return nil
	}
	if out, err := persistCmdContext(ctx, osUser, "save").CombinedOutput(); err != nil {
		log.Printf("pre-kill snapshot for %s/%s failed, killing without one: %v: %s",
			osUser, name, err, strings.TrimSpace(string(out)))
		return nil
	}
	out, err := persistCmdContext(ctx, osUser, "list").Output()
	if err != nil {
		log.Printf("snapshot list after the pre-kill save for %s/%s failed: %v", osUser, name, err)
		return nil
	}
	ts := newestSnapshotTS(string(out))
	if ts == "" {
		log.Printf("no snapshot for %s after the pre-kill save, killing %s without one", osUser, name)
		return nil
	}
	// Not checked against that snapshot's own rows. Reading them back is a
	// second privileged round trip that resolves every row against live tmux,
	// and it would answer for a box that has moved on by the time anyone
	// presses undo. The record says what to TRY, and restore reports it when
	// the name turns out not to be in there (restoreFromSelection).
	return &restoreSelection{Snapshot: ts, Sessions: []string{name}}
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
	_ = json.NewEncoder(w).Encode(annotateRows(osUser, parseSnapshotRows(string(out))))
}

// annotateRows fills in everything the picker shows that a snapshot does not
// carry: what each row is called, and where restoring it would put it.
func annotateRows(osUser string, rows []SnapshotRow) []SnapshotRow {
	return annotateRowTitles(osUser, annotateRowProjects(osUser, rows))
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
	// Resolve the snapshot BEFORE restoring. This is the view the picker showed,
	// so the name each row was promised is the name that gets placed; asking
	// afterwards would resolve every row as live and lose the -HHMM targets.
	rows := snapshotRowsFor(osUser, sel.Snapshot)

	args := append([]string{"select", sel.Snapshot}, sel.Sessions...)
	out, err := persistCmd(osUser, args...).CombinedOutput()
	if err != nil {
		log.Printf("restore-selection %s for %s failed: %v: %s",
			sel.Snapshot, osUser, err, strings.TrimSpace(string(out)))
		return http.StatusInternalServerError, "restore failed"
	}
	log.Printf("restore-selection %s for %s: %s", sel.Snapshot, osUser, strings.TrimSpace(string(out)))
	placeRestoredSessions(osUser, rows, sel.Sessions)
	return http.StatusOK, ""
}

// snapshotRowsFor reads one snapshot resolved against what is live now. Returns
// nil when it cannot be read: placement is a convenience on top of a restore
// that stands on its own.
func snapshotRowsFor(osUser, ts string) []SnapshotRow {
	out, err := persistCmd(osUser, "show", ts).Output()
	if err != nil {
		log.Printf("snapshot %s for %s unreadable, restoring without placement: %v", ts, osUser, err)
		return nil
	}
	return parseSnapshotRows(string(out))
}

// emitRestored records a restore for the usage telemetry, tagged with whether
// it came from the picker or the plain button.
func emitRestored(osUser, client string) {
	events.Emit("session.restored", osUser, telemetry.Attrs{"tl.client": client})
}
