package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// --- a kill has to leave something to come back from --------------------------
//
// The lobby holds a kill for eight seconds and lets Cmd+Z retract it before the
// DELETE goes out. Past that window the session is gone, so undo has to
// RESURRECT it through POST /restore instead (frontend-v2/src/store/undo.kill.ts).
// That only works if the session is in a snapshot, and snapshots are written by
// tmux-persist-save.timer on OnCalendar=*:0/5, so a session created and killed
// inside one five-minute tick is in none at all and tmux-persist's
// restore-selection refuses a name it cannot find in the snapshot it is handed.
// Those are exactly the sessions someone kills by mistake.
//
// So a kill asks the wrapper to save first and answers with the snapshot the
// session landed in. All of that is best effort: the kill is the promise, the
// record is not, and every failure below still destroys the session.

// killTranscript drives a real DELETE with both wrappers stubbed and returns
// the recorder plus ONE ordered transcript of what was run.
//
// Both stubs append to the same file, so the transcript shows the snapshot, the
// kill and the forget in the order they happened rather than in two files a
// reader has to interleave by hand. The tmux stub's own argv still goes to its
// own file; a marker is what lands here, since `kill-session -t =name` says
// nothing this test does not already know.
func killTranscript(t *testing.T, name, wrapperScript string) (*httptest.ResponseRecorder, string) {
	t.Helper()
	osSelf, _ := twoLocalUsers(t)        // caller == current user, so tmuxCmd skips
	withUserMap(t, "alice="+osSelf+"\n") // sudo and the stub sees only the wrappers
	withTempLayoutStore(t)
	withTempAssignmentStore(t)
	transcript := withSudoStub(t, wrapperScript)
	// Branching on the verb because the kill asks tmux TWICE now: once to check
	// the session is there at all, and once to kill it. The first of those is
	// what keeps a DELETE for a name nobody has from paying for a root snapshot
	// (session_mutate.go killSession).
	withTmuxStub(t, `case "$1" in
  has-session) printf 'tmux-has-session\n' >> '`+transcript+`' ;;
  *) printf 'tmux-kill-session\n' >> '`+transcript+`' ;;
esac`)

	rec := httptest.NewRecorder()
	handleSessionByName(rec, sessionReq(http.MethodDelete, "/sessions/"+name, "", "alice"))
	return rec, recordedArgv(t, transcript)
}

// wrapperWithSnapshots answers `save` silently and `list` with a series in the
// shape tmux-persist's snapshots_rows prints: newest first, ts / count / marker.
const wrapperWithSnapshots = `case "$4" in
  save) exit 0 ;;
  list) printf '20260910T131500\t4\tnewest\n20260910T131000\t4\t-\n' ;;
  *) exit 0 ;;
esac`

func resurrectOf(t *testing.T, rec *httptest.ResponseRecorder) *restoreSelection {
	t.Helper()
	var body killResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("kill response is not JSON: %v (%q)", err, rec.Body.String())
	}
	return body.Resurrect
}

// The happy path: 200 carrying the newest snapshot and the name to restore out
// of it, which is POST /restore's own body so the client posts it back
// unchanged.
func TestKillAnswersWithWhatWouldResurrectIt(t *testing.T) {
	rec, _ := killTranscript(t, "qa-undo", wrapperWithSnapshots)

	if rec.Code != http.StatusOK {
		t.Fatalf("DELETE /sessions/qa-undo: got %d, want %d (%q)", rec.Code, http.StatusOK, rec.Body.String())
	}
	got := resurrectOf(t, rec)
	if got == nil {
		t.Fatalf("no resurrect record in %q", rec.Body.String())
	}
	if got.Snapshot != "20260910T131500" {
		t.Errorf("snapshot = %q, want the newest one the wrapper listed", got.Snapshot)
	}
	if len(got.Sessions) != 1 || got.Sessions[0] != "qa-undo" {
		t.Errorf("sessions = %v, want exactly the session that was killed", got.Sessions)
	}
}

// The order is the whole point: a save AFTER the kill snapshots a box the
// session is already gone from, which is the same as no snapshot at all.
func TestKillSnapshotsBeforeItKills(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	_, transcript := killTranscript(t, "qa-undo", wrapperWithSnapshots)

	want := strings.Join([]string{
		"tmux-has-session",
		"-n", restoreWrapper, osSelf, "save",
		"-n", restoreWrapper, osSelf, "list",
		"tmux-kill-session",
		"-n", persistForgetWrapper, osSelf, "qa-undo",
		"",
	}, "\n")
	if transcript != want {
		t.Fatalf("kill transcript:\ngot  %q\nwant %q", transcript, want)
	}
}

// Everything that can go wrong with the snapshot, and the one answer to all of
// it: kill the session anyway, say there is nothing to resurrect from, and let
// the client report a kill it cannot take back rather than one that did not
// happen. An older wrapper on the box is in here too, the way snapshots_test.go
// covers one that does not know `open`.
func TestKillSurvivesAFailedSnapshot(t *testing.T) {
	for _, tc := range []struct {
		name   string
		script string
	}{
		{"save fails", `case "$4" in
  save) echo "[tmux-persist] save: boom" >&2; exit 1 ;;
  *) exit 0 ;;
esac`},
		{"a wrapper too old to know save", `case "$4" in
  save) echo "tmux-restore-user: unknown action 'save'" >&2; exit 2 ;;
  *) exit 0 ;;
esac`},
		{"list fails", `case "$4" in
  list) echo "tmux-restore-user: missing dependency" >&2; exit 2 ;;
  *) exit 0 ;;
esac`},
		{"nothing saved for this user", `case "$4" in
  list) printf '' ;;
  *) exit 0 ;;
esac`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			osSelf, _ := twoLocalUsers(t)
			rec, transcript := killTranscript(t, "qa-undo", tc.script)

			if rec.Code != http.StatusOK {
				t.Fatalf("got %d, want the kill to succeed anyway (%q)", rec.Code, rec.Body.String())
			}
			if got := resurrectOf(t, rec); got != nil {
				t.Errorf("resurrect record = %+v, want none: nothing snapshotted it", got)
			}
			if !strings.Contains(transcript, "\ntmux-kill-session\n") {
				t.Fatalf("the session was not killed: %q", transcript)
			}
			forget := "\n" + persistForgetWrapper + "\n" + osSelf + "\nqa-undo\n"
			if !strings.Contains(transcript, forget) {
				t.Errorf("the tombstone was not written: %q", transcript)
			}
		})
	}
}

// killTranscriptWithTmux is killTranscript with the tmux stub's script handed
// in, for the cases that need tmux to answer something other than yes.
func killTranscriptWithTmux(t *testing.T, name, wrapperScript, tmuxScript string) (*httptest.ResponseRecorder, string) {
	t.Helper()
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osSelf+"\n")
	withTempLayoutStore(t)
	withTempAssignmentStore(t)
	transcript := withSudoStub(t, wrapperScript)
	withTmuxStub(t, tmuxScript)

	rec := httptest.NewRecorder()
	handleSessionByName(rec, sessionReq(http.MethodDelete, "/sessions/"+name, "", "alice"))
	return rec, recordedArgv(t, transcript)
}

// A DELETE naming a session nobody has must cost NOTHING privileged.
//
// The save is the expensive verb on this box and the only one that is not
// per-user: the wrapper validates the user it is handed and then snapshots
// every mapped user, forking tmux and ps per pane and a find per unstamped
// claude pane (tmux-persist save). Taking it before asking tmux anything meant
// a DELETE of a name nobody has ran all of that and then answered 404, so a
// loop of those was an unbounded amount of root work driven by a caller who
// owns no session at all.
func TestKillOfAMissingSessionRunsNothingPrivileged(t *testing.T) {
	noSuchSession := "case \"$1\" in\n  has-session) exit 1 ;;\n  *) exit 0 ;;\nesac"
	rec, transcript := killTranscriptWithTmux(t, "nope", wrapperWithSnapshots, noSuchSession)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("DELETE /sessions/nope: got %d, want %d (%q)", rec.Code, http.StatusNotFound, rec.Body.String())
	}
	if transcript != "" {
		t.Fatalf("a root wrapper ran for a session nobody has: %q", transcript)
	}
}

// The snapshot is bounded, because the client is: lib/http.ts abandons any call
// at 8s while the handler carries on and kills the session regardless, so the
// card would report a failed kill for a session that is gone. A save that
// outruns the budget is therefore dropped rather than waited on, leaving the
// same "nothing to resurrect from" answer every other snapshot failure gives.
func TestKillGivesUpOnASlowSnapshot(t *testing.T) {
	old := preKillSnapshotBudget
	preKillSnapshotBudget = 150 * time.Millisecond
	t.Cleanup(func() { preKillSnapshotBudget = old })

	slowSave := "case \"$4\" in\n  save) sleep 10 ;;\n  *) exit 0 ;;\nesac"
	start := time.Now()
	rec, transcript := killTranscript(t, "qa-undo", slowSave)
	waited := time.Since(start)

	if rec.Code != http.StatusOK {
		t.Fatalf("got %d, want the kill to happen anyway (%q)", rec.Code, rec.Body.String())
	}
	if got := resurrectOf(t, rec); got != nil {
		t.Errorf("resurrect record = %+v, want none: the snapshot never finished", got)
	}
	if !strings.Contains(transcript, "\ntmux-kill-session\n") {
		t.Fatalf("the session was not killed: %q", transcript)
	}
	if waited > 5*time.Second {
		t.Errorf("the kill waited %s on a save it had already given up on", waited)
	}
}
