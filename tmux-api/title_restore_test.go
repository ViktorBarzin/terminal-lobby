package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A restore is the one moment a title can be lost. tmux options die with their
// session, and tmux-persist's snapshot carries names, cwds and claude uuids —
// none of which is a title. Without re-stamping, every reboot would hand back a
// sidebar full of slugs.

func TestRestoreReStampsRememberedTitles(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	store := swapTitleStore(t)
	mustSet(t, store, osSelf, "deploy-the-thing", "Deploy the thing 🚀")
	mustSet(t, store, osSelf, "other-work", "Other work")
	argvFile := withTmuxStub(t, "")

	restoreRememberedTitles(osSelf, []string{"deploy-the-thing", "never-titled"})

	argv := recordedArgv(t, argvFile)
	for _, want := range []string{"set-option", "=deploy-the-thing:", "@title", "Deploy the thing 🚀"} {
		if !strings.Contains(argv, want+"\n") {
			t.Errorf("argv missing %q:\n%s", want, argv)
		}
	}
	// A session with no remembered title is not stamped at all — an empty
	// set-option would be a pointless call, and a `-u` would be worse.
	if strings.Contains(argv, "never-titled") {
		t.Errorf("an untitled session was stamped:\n%s", argv)
	}
	// Only what was restored. Re-stamping every remembered title would touch
	// sessions this restore had nothing to do with.
	if strings.Contains(argv, "other-work") {
		t.Errorf("a session outside the restore was stamped:\n%s", argv)
	}
}

func TestRestoreReStampsUnderTheNameTheSessionCameBackAs(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	store := swapTitleStore(t)
	mustSet(t, store, osSelf, "deploy-the-thing", "Deploy the thing")
	argvFile := withTmuxStub(t, "")

	// A restore renames when the name is taken by a different conversation:
	// the session returns as <name>-<HHMM>. The title has to follow it, and be
	// remembered under the name it actually came back as.
	restoreRememberedTitlesAs(osSelf, map[string]string{"deploy-the-thing": "deploy-the-thing-1430"})

	argv := recordedArgv(t, argvFile)
	if !strings.Contains(argv, "=deploy-the-thing-1430:\n") {
		t.Errorf("the title was not stamped onto the renamed session:\n%s", argv)
	}
	if got := store.get(osSelf, "deploy-the-thing-1430"); got != "Deploy the thing" {
		t.Errorf("title under the restored name = %q, want it carried over", got)
	}
}

// A restore whose sessions were never titled must not invoke tmux at all.
func TestRestoreWithNoRememberedTitlesTouchesNothing(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	swapTitleStore(t)
	argvFile := withTmuxStub(t, "")

	restoreRememberedTitles(osSelf, []string{"a", "b", "c"})

	if argv := recordedArgv(t, argvFile); argv != "" {
		t.Fatalf("tmux was invoked for sessions with no titles: %q", argv)
	}
}

// A kill drops the layout entry and the persist manifest row, and the title
// used to go with them. It does not any more: the picker restores a killed
// session from an OLDER snapshot — rememberKilledAssignment exists for exactly
// that — and a name is an opaque id since ADR-0019, so forgetting the title
// makes that row unreadable and unrecoverable at the same time.
func TestKillKeepsTheTitleForTheRestorePicker(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "authself="+osSelf+"\n")
	withTempLayoutStore(t)
	swapAssignmentStore(t)
	store := swapTitleStore(t)
	mustSet(t, store, osSelf, "work", "Work in progress")
	withTmuxStub(t, "exit 0")
	withSudoStub(t, "exit 0")

	if got := store.get(osSelf, "work"); got == "" {
		t.Fatal("fixture did not take")
	}
	rec := httptest.NewRecorder()
	handleSessionByName(rec, sessionReq(http.MethodDelete, "/sessions/work", "", "authself"))
	if rec.Code != http.StatusOK {
		t.Fatalf("DELETE /sessions/work: got %d, want 200", rec.Code)
	}

	if got := store.get(osSelf, "work"); got != "Work in progress" {
		t.Errorf("title after a kill = %q, want it kept so an older snapshot still reads", got)
	}
}
