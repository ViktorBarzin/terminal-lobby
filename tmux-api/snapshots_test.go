package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// --- handler gates -------------------------------------------------------------
// Mirroring the existing restore-gate tests: the wrong method or a missing
// identity must be refused BEFORE anything privileged is shelled out.

func TestSnapshotsRejectsPost(t *testing.T) {
	rec := httptest.NewRecorder()
	handleSnapshots(rec, httptest.NewRequest(http.MethodPost, "/snapshots", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /snapshots: got %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}
}

func TestSnapshotsRequiresAuth(t *testing.T) {
	argv := withSudoStub(t, "exit 0")
	rec := httptest.NewRecorder()
	handleSnapshots(rec, httptest.NewRequest(http.MethodGet, "/snapshots", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("GET /snapshots without %s: got %d, want %d", authHeader, rec.Code, http.StatusUnauthorized)
	}
	if got := recordedArgv(t, argv); got != "" {
		t.Fatalf("unauthenticated request still shelled out: %q", got)
	}
}

func TestSnapshotByTSRequiresAuth(t *testing.T) {
	rec := httptest.NewRecorder()
	handleSnapshotByTS(rec, httptest.NewRequest(http.MethodGet, "/snapshots/20260814T125000", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("got %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

// A snapshot id reaches a root wrapper as argv. A malformed one is refused
// here, and must not be handed on even though the wrapper validates too.
func TestSnapshotByTSRejectsBadID(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osSelf+"\n")
	argv := withSudoStub(t, "exit 0")

	for _, bad := range []string{"../../etc/passwd", "20260814", "20260814T12500", "x20260814T125000", ""} {
		rec := httptest.NewRecorder()
		handleSnapshotByTS(rec, sessionReq(http.MethodGet, "/snapshots/"+bad, "", "alice"))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("GET /snapshots/%q: got %d, want %d", bad, rec.Code, http.StatusBadRequest)
		}
	}
	if got := recordedArgv(t, argv); got != "" {
		t.Fatalf("a malformed snapshot id still reached the wrapper: %q", got)
	}
}

func TestSnapshotByTSPassesValidID(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osSelf+"\n")
	argv := withSudoStub(t, `printf 'a\t/tmp\t-\tmissing\tnew\ta\ton\t-\n'`)

	rec := httptest.NewRecorder()
	handleSnapshotByTS(rec, sessionReq(http.MethodGet, "/snapshots/20260814T125000", "", "alice"))
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 (body %q)", rec.Code, rec.Body.String())
	}
	want := "-n\n" + restoreWrapper + "\n" + osSelf + "\nshow\n20260814T125000\n"
	if got := recordedArgv(t, argv); got != want {
		t.Fatalf("wrapper invocation:\ngot  %q\nwant %q", got, want)
	}
}

// --- list annotation -----------------------------------------------------------

func TestParseSnapshotListAnnotatesAgainstLive(t *testing.T) {
	// The shape of this morning's incident: 9 live now, older snapshots hold more.
	out := "20260814T130500\t9\tnewest\n" +
		"20260814T130049\t10\t-\n" +
		"20260814T125900\t13\t-\n" +
		"20260814T125000\t18\t-\n" +
		"20260814T112000\t17\t-\n"
	got := parseSnapshotList(out, 9)

	if len(got) != 5 {
		t.Fatalf("got %d snapshots, want 5", len(got))
	}
	if !got[0].Newest || got[0].DeltaVsLive != 0 {
		t.Fatalf("newest row wrong: %+v", got[0])
	}
	if got[3].DeltaVsLive != 9 {
		t.Fatalf("12:50 delta: got %d, want 9", got[3].DeltaVsLive)
	}
	if !got[3].LastFull {
		t.Fatalf("12:50 (18 sessions) should be labelled last-full: %+v", got[3])
	}
	for i, s := range got {
		if i != 3 && s.LastFull {
			t.Fatalf("only one row may be last-full; row %d also was: %+v", i, s)
		}
	}
}

// With nothing lost there is no fuller version to point at, so the label is
// withheld rather than pointing at the row you are already on.
func TestParseSnapshotListNoLastFullWhenNothingLost(t *testing.T) {
	out := "20260814T130500\t9\tnewest\n20260814T125000\t9\t-\n"
	for _, s := range parseSnapshotList(out, 9) {
		if s.LastFull {
			t.Fatalf("nothing was lost, yet a row is labelled last-full: %+v", s)
		}
	}
}

// Ties go to the most recent snapshot at the high-water mark.
func TestParseSnapshotListLastFullPrefersMostRecent(t *testing.T) {
	out := "20260814T130000\t5\tnewest\n20260814T125000\t18\t-\n20260814T120000\t18\t-\n"
	got := parseSnapshotList(out, 5)
	if !got[1].LastFull || got[2].LastFull {
		t.Fatalf("last-full should be the newer of the tied rows: %+v", got)
	}
}

func TestParseSnapshotListSkipsJunk(t *testing.T) {
	out := "not-a-timestamp\t9\tnewest\n20260814T125000\tnot-a-number\t-\n20260814T120000\t3\t-\n"
	got := parseSnapshotList(out, 0)
	if len(got) != 1 || got[0].TS != "20260814T120000" {
		t.Fatalf("junk rows should be dropped, got %+v", got)
	}
}

// --- row resolution ------------------------------------------------------------

func TestParseSnapshotRows(t *testing.T) {
	out := strings.Join([]string{
		"T3\t/home/wizard/code\ta4154a1d-0000-0000-0000-000000000001\tmissing\tnew\tT3\ton\t-",
		"chesscom\t/home/wizard/code\t993c7cb2-0000-0000-0000-000000000002\tlive_other_conv\tsuffixed\tchesscom-1250\ton\t-",
		"tripit-casia\t/home/wizard/code/tripit\t8791a4d9-0000-0000-0000-000000000003\tlive_no_claude\tin_place\ttripit-casia\ton\t-",
		"Wrongmove\t/home/wizard/code\te5d5c16e-0000-0000-0000-000000000004\tmissing\tnew\tWrongmove\toff\tkilled@1786711920",
		"portal\t-\t-\tlive_same\tskip\tportal\toff\t-",
	}, "\n") + "\n"

	rows := parseSnapshotRows(out)
	if len(rows) != 5 {
		t.Fatalf("got %d rows, want 5", len(rows))
	}
	if rows[0].Action != "new" || !rows[0].Default {
		t.Fatalf("a missing session should be a pre-checked new restore: %+v", rows[0])
	}
	if rows[1].Target != "chesscom-1250" {
		t.Fatalf("a name conflict should restore alongside: %+v", rows[1])
	}
	if rows[2].Action != "in_place" {
		t.Fatalf("a live session with no claude should resume in place: %+v", rows[2])
	}
	if rows[3].Default || rows[3].KilledAt != 1786711920 {
		t.Fatalf("a deliberately-killed session should be offered unchecked, with when: %+v", rows[3])
	}
	if rows[4].Default || rows[4].Cwd != "" || rows[4].UUID != "" {
		t.Fatalf("'-' placeholders should decode to empty, and a live row stays unticked: %+v", rows[4])
	}
}

func TestParseSnapshotRowsSkipsShortLines(t *testing.T) {
	if got := parseSnapshotRows("too\tfew\tfields\n"); len(got) != 0 {
		t.Fatalf("a short line should be dropped, got %+v", got)
	}
}

// --- selection restore ---------------------------------------------------------

// The selection is validated before it can become argv to a root wrapper.
func TestRestoreFromSelectionRejectsBadInput(t *testing.T) {
	argv := withSudoStub(t, "exit 0")
	cases := []struct {
		name string
		sel  restoreSelection
	}{
		{"bad snapshot id", restoreSelection{Snapshot: "../../etc", Sessions: []string{"a"}}},
		{"no sessions", restoreSelection{Snapshot: "20260814T125000"}},
		{"bad session name", restoreSelection{Snapshot: "20260814T125000", Sessions: []string{"ok", "has space"}}},
		{"session name too long", restoreSelection{Snapshot: "20260814T125000", Sessions: []string{strings.Repeat("x", 33)}}},
	}
	for _, c := range cases {
		if status, _ := restoreFromSelection("alice", c.sel); status != http.StatusBadRequest {
			t.Fatalf("%s: got %d, want %d", c.name, status, http.StatusBadRequest)
		}
	}
	if got := recordedArgv(t, argv); got != "" {
		t.Fatalf("an invalid selection still reached the wrapper: %q", got)
	}
}

func TestRestoreFromSelectionInvokesWrapper(t *testing.T) {
	argv := withSudoStub(t, "exit 0")
	sel := restoreSelection{Snapshot: "20260814T125000", Sessions: []string{"T3", "repowise"}}
	if status, msg := restoreFromSelection("alice", sel); status != http.StatusOK {
		t.Fatalf("got %d (%s), want 200", status, msg)
	}
	// The snapshot is read first — that resolved view is what tells the
	// placement which name each row comes back under — and then restored.
	want := "-n\n" + restoreWrapper + "\nalice\nshow\n20260814T125000\n" +
		"-n\n" + restoreWrapper + "\nalice\nselect\n20260814T125000\nT3\nrepowise\n"
	if got := recordedArgv(t, argv); got != want {
		t.Fatalf("wrapper invocation:\ngot  %q\nwant %q", got, want)
	}
}

// --- POST /restore keeps both shapes -------------------------------------------

// A body naming a snapshot restores that selection…
func TestHandleRestoreWithSelectionBody(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osSelf+"\n")
	argv := withSudoStub(t, "exit 0")

	rec := httptest.NewRecorder()
	body := `{"snapshot":"20260814T125000","sessions":["T3"]}`
	handleRestore(rec, sessionReq(http.MethodPost, "/restore", body, "alice"))

	if rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 (body %q)", rec.Code, rec.Body.String())
	}
	want := "-n\n" + restoreWrapper + "\n" + osSelf + "\nshow\n20260814T125000\n" +
		"-n\n" + restoreWrapper + "\n" + osSelf + "\nselect\n20260814T125000\nT3\n"
	if got := recordedArgv(t, argv); got != want {
		t.Fatalf("selection restore:\ngot  %q\nwant %q", got, want)
	}
}

// …and no body keeps the blanket restore the boot path and older clients use.
func TestHandleRestoreWithoutBodyStaysBlanket(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osSelf+"\n")
	argv := withSudoStub(t, "exit 0")

	rec := httptest.NewRecorder()
	handleRestore(rec, sessionReq(http.MethodPost, "/restore", "", "alice"))

	if rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", rec.Code)
	}
	want := "-n\n" + restoreWrapper + "\n" + osSelf + "\n"
	if got := recordedArgv(t, argv); got != want {
		t.Fatalf("blanket restore:\ngot  %q\nwant %q", got, want)
	}
}

func TestHandleRestoreRejectsMalformedBody(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osSelf+"\n")
	argv := withSudoStub(t, "exit 0")

	rec := httptest.NewRecorder()
	handleRestore(rec, sessionReq(http.MethodPost, "/restore", "{not json", "alice"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got %d, want %d", rec.Code, http.StatusBadRequest)
	}
	if got := recordedArgv(t, argv); got != "" {
		t.Fatalf("a malformed body still shelled out: %q", got)
	}
}

// The snapshot list is JSON the frontends can render directly.
func TestSnapshotsEncodesJSON(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osSelf+"\n")
	withSudoStub(t, `printf '20260814T125000\t18\tnewest\n'`)
	withTmuxStub(t, "exit 1") // no live sessions; delta is the full 18

	rec := httptest.NewRecorder()
	handleSnapshots(rec, sessionReq(http.MethodGet, "/snapshots", "", "alice"))
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 (%q)", rec.Code, rec.Body.String())
	}
	var got SnapshotList
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("response is not JSON: %v (%q)", err, rec.Body.String())
	}
	if len(got.Snapshots) != 1 || got.Snapshots[0].TS != "20260814T125000" || got.Snapshots[0].Count != 18 {
		t.Fatalf("unexpected payload: %+v", got)
	}
	if got.PerSessionMB != perSessionMB {
		t.Fatalf("per-session estimate: got %d, want %d", got.PerSessionMB, perSessionMB)
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("the list must not be cached by the browser, or the picker goes stale")
	}
}

// The warning must stay silent rather than guess when the number is unknown.
func TestMemAvailableIsRealOrUnknown(t *testing.T) {
	got := memAvailableMB()
	if got == 0 {
		t.Fatalf("memAvailableMB returned 0; unknown must be -1 so the UI can stay quiet")
	}
	if got < -1 {
		t.Fatalf("memAvailableMB returned %d", got)
	}
}

// Every row carries the project a restore would put it in, resolved by the same
// function the restore itself uses — so the picker previews the destination
// rather than each frontend guessing at it.
func TestSnapshotRowsCarryTheirDestinationProject(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osSelf+"\n")
	withTempLayoutStore(t)
	withTempAssignmentStore(t)
	swapProjectStore(t)
	withSudoStub(t, `printf 'repowise\t/home/x/code\tu1\tmissing\tnew\trepowise\ton\t-\nloose\t/home/x\t-\tmissing\tnew\tloose\ton\t-\n'`)

	if err := layoutStoreInstance.save(osSelf, Layout{
		Version: 1, Projects: []Project{{Name: "code", Sessions: []string{"repowise"}}}, Ungrouped: []string{},
	}); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	handleSnapshotByTS(rec, sessionReq(http.MethodGet, "/snapshots/20260814T125000", "", "alice"))
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 (%q)", rec.Code, rec.Body.String())
	}
	var rows []SnapshotRow
	if err := json.Unmarshal(rec.Body.Bytes(), &rows); err != nil {
		t.Fatalf("response is not JSON: %v (%q)", err, rec.Body.String())
	}
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2", len(rows))
	}
	if rows[0].Project != "code" {
		t.Fatalf("row %q: project %q, want code", rows[0].Name, rows[0].Project)
	}
	if rows[1].Project != "" {
		t.Fatalf("row %q: project %q, want \"\" — nothing places it", rows[1].Name, rows[1].Project)
	}
}

// --- the picker's one call -----------------------------------------------------
// GET /snapshots answers the whole open: the series, the live count behind the
// deltas, and the newest snapshot already resolved. Two sequential calls (and
// two sudo/bash/tmux round trips) were ~295 ms of server work before the picker
// could show anything.

func TestParsePickerSections(t *testing.T) {
	out := strings.Join([]string{
		"#live\t9",
		"#snapshots",
		"20260814T130500\t9\tnewest",
		"20260814T125000\t18\t-",
		"#rows\t20260814T130500",
		"T3\t/home/wizard/code\t-\tmissing\tnew\tT3\ton\t-",
		"ux\t/home/wizard\t-\tlive_same\tskip\tux\toff\t-",
		"",
	}, "\n")

	got, ok := parsePicker(out)
	if !ok {
		t.Fatalf("well-formed picker output was rejected")
	}
	if got.live != 9 {
		t.Fatalf("live count: got %d, want 9", got.live)
	}
	if got.rowsTS != "20260814T130500" {
		t.Fatalf("row section timestamp: got %q", got.rowsTS)
	}
	snaps := parseSnapshotList(got.series, got.live)
	if len(snaps) != 2 || !snaps[0].Newest || snaps[1].DeltaVsLive != 9 {
		t.Fatalf("series section parsed wrong: %+v", snaps)
	}
	rows := parseSnapshotRows(got.rows)
	if len(rows) != 2 || rows[0].Name != "T3" || rows[1].Action != "skip" {
		t.Fatalf("row section parsed wrong: %+v", rows)
	}
}

// A user with no snapshots yet: the series is empty and there is nothing to
// resolve, which is a valid answer and not a failure to fall back from.
func TestParsePickerWithNoSnapshots(t *testing.T) {
	got, ok := parsePicker("#live\t0\n#snapshots\n")
	if !ok {
		t.Fatalf("an empty series should still parse")
	}
	if got.rowsTS != "" || got.rows != "" {
		t.Fatalf("nothing to resolve, yet rows came back: %+v", got)
	}
}

// Anything that is not the picker's own format is refused, so the handler can
// fall back rather than serve a payload it half-understood.
func TestParsePickerRejectsForeignOutput(t *testing.T) {
	for _, bad := range []string{
		"",
		"20260814T130500\t9\tnewest\n",        // the old `list` output
		"tmux-restore-user: unknown action\n", // an older wrapper
	} {
		if _, ok := parsePicker(bad); ok {
			t.Fatalf("parsePicker accepted %q", bad)
		}
	}
}

// The handler asks the wrapper ONCE, with `open`, and never touches tmux: the
// live count rides along in the payload. That mattered under load — the tmux
// path also takes the shared /proc snapshot lock and stamps @last_drive, all
// for one integer.
func TestSnapshotsOpensInOneCall(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osSelf+"\n")
	sudoArgv := withSudoStub(t, `printf '#live\t2\n#snapshots\n20260814T130500\t5\tnewest\n#rows\t20260814T130500\nT3\t/home/wizard\t-\tmissing\tnew\tT3\ton\t-\n'`)
	tmuxArgv := withTmuxStub(t, "exit 0")

	rec := httptest.NewRecorder()
	handleSnapshots(rec, sessionReq(http.MethodGet, "/snapshots", "", "alice"))
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 (%q)", rec.Code, rec.Body.String())
	}
	want := "-n\n" + restoreWrapper + "\n" + osSelf + "\nopen\n"
	if got := recordedArgv(t, sudoArgv); got != want {
		t.Fatalf("wrapper invocation:\ngot  %q\nwant %q", got, want)
	}
	if got := recordedArgv(t, tmuxArgv); got != "" {
		t.Fatalf("opening the picker still shelled out to tmux: %q", got)
	}

	var body SnapshotList
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not JSON: %v (%q)", err, rec.Body.String())
	}
	if len(body.Snapshots) != 1 || body.Snapshots[0].DeltaVsLive != 3 {
		t.Fatalf("delta should be 5 saved minus 2 live: %+v", body.Snapshots)
	}
	if body.NewestTS != "20260814T130500" {
		t.Fatalf("newest ts: got %q", body.NewestTS)
	}
	if len(body.Rows) != 1 || body.Rows[0].Name != "T3" {
		t.Fatalf("the newest snapshot should come back resolved: %+v", body.Rows)
	}
}

// An older wrapper on the box does not know `open`. The list still has to
// arrive — the picker then fetches the rows itself, as it always did.
func TestSnapshotsFallsBackToListWhenOpenIsUnknown(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osSelf+"\n")
	sudoArgv := withSudoStub(t, `case "$4" in
  open) echo "tmux-restore-user: unknown action 'open'" >&2; exit 2 ;;
  *) printf '20260814T125000\t18\tnewest\n' ;;
esac`)
	withTmuxStub(t, "exit 1") // no live sessions

	rec := httptest.NewRecorder()
	handleSnapshots(rec, sessionReq(http.MethodGet, "/snapshots", "", "alice"))
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 (%q)", rec.Code, rec.Body.String())
	}
	argv := recordedArgv(t, sudoArgv)
	if !strings.Contains(argv, "\nopen\n") || !strings.Contains(argv, "\nlist\n") {
		t.Fatalf("expected an `open` attempt then a `list` fallback, got %q", argv)
	}
	var body SnapshotList
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not JSON: %v", err)
	}
	if len(body.Snapshots) != 1 || body.Snapshots[0].Count != 18 {
		t.Fatalf("the series should still arrive: %+v", body.Snapshots)
	}
	if len(body.Rows) != 0 || body.NewestTS != "" {
		t.Fatalf("the fallback has no rows to offer: %+v", body)
	}
}

// Both paths failing is a real failure, not an empty picker.
func TestSnapshotsFailsWhenBothPathsFail(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osSelf+"\n")
	withSudoStub(t, "exit 2")
	withTmuxStub(t, "exit 1")

	rec := httptest.NewRecorder()
	handleSnapshots(rec, sessionReq(http.MethodGet, "/snapshots", "", "alice"))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("got %d, want 500", rec.Code)
	}
}
