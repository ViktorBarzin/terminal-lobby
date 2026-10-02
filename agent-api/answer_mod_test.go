package main

import (
	"net/http"
	"reflect"
	"strings"
	"testing"
)

// modPermissionPane is the terminal-lobby mod's own permission dialog, which
// replaces Claude Code's prompt in every session that loads the mod (captured
// live on 2026-10-02, CLI 2.1.287).
var modPermissionPane = strings.Join([]string{
	"● Creating directory and writing hostname to file",
	"  ⎿  $ mkdir -p /var/tmp/rv-fx-keys-dir && hostname > /var/tmp/rv-fx-keys-dir/h",
	"────────────────────────────────────────────────────────────────────────────────",
	" ☐ Permission",
	"",
	"Allow Bash: mkdir -p /var/tmp/rv-fx-keys-dir && hostname >",
	"/var/tmp/rv-fx-keys-dir/h?",
	"",
	"❯ 1. Allow",
	"  2. Deny",
	"  3. Type something.",
	"────────────────────────────────────────────────────────────────────────────────",
	"  4. Chat about this",
	"",
	"Enter to select · ↑/↓ to navigate · Esc to cancel",
}, "\n")

// modPlanPane is the mod's plan approval.
var modPlanPane = strings.Join([]string{
	"────────────────────────────────────────────────────────────────────────────────",
	" ☐ Plan",
	"",
	"1. Write hello.txt.",
	"",
	"Claude has finished planning. Approve the plan?",
	"",
	"❯ 1. Approve plan",
	"  2. Keep planning",
	"  3. Type something.",
	"────────────────────────────────────────────────────────────────────────────────",
	"  4. Chat about this",
	"",
	"Enter to select · ↑/↓ to navigate · Esc to cancel",
}, "\n")

// Measured live on 2026-10-02: with the mod's dialog on screen, a Bash
// permission prompt was reported as kind=choice with no answer_with, and
// POST /answer {"option":1} was refused with 422, so a conversation in the
// default permission mode always needed a person at the terminal. The
// dialog is the mod's, with fixed rows, and a digit answers it (checked on
// the live pane the same day).
func TestTheModsDialogsReadAsPermissionAndPlan(t *testing.T) {
	for _, c := range []struct {
		pane, kind, first string
	}{
		{modPermissionPane, KindPermission, "Allow"},
		{modPlanPane, KindPlan, "Approve plan"},
	} {
		q := parseQuestion(c.pane)
		if q.Kind != c.kind || !q.Mod {
			t.Fatalf("read as %q (mod %v), want %q from the mod", q.Kind, q.Mod, c.kind)
		}
		if len(q.Options) != 2 || q.Options[0] != (TaskOption{1, c.first}) {
			t.Fatalf("options %+v", q.Options)
		}
		if !reflect.DeepEqual(q.AnswerWith, []string{answerOption}) {
			t.Fatalf("answer_with %v, want [option]", q.AnswerWith)
		}
	}
	// An AskUserQuestion that only looks similar is still a choice.
	if q := parseQuestion(strings.Replace(modPermissionPane, "2. Deny", "2. Refuse", 1)); q.Kind != KindChoice || q.Mod {
		t.Fatalf("a look-alike menu read as %q (mod %v)", q.Kind, q.Mod)
	}
}

func TestAnswerPressesTheRowOfTheModsDialog(t *testing.T) {
	for _, c := range []struct {
		pane, body, key string
	}{
		{modPermissionPane, `{"option":1}`, "1"},
		{modPermissionPane, `{"option":2}`, "2"},
		{modPlanPane, `{"option":1}`, "1"},
	} {
		h := newHarness(t)
		task := h.needsInput(c.pane)
		h.sessions.onKeys = func(f *fakeSessions, k string) { f.panes[k] = "● Working…" }

		w := h.answer(task, c.body)
		var got struct {
			TaskView
			Warning string `json:"warning"`
		}
		h.decodeJSON(w, http.StatusOK, &got)
		if got.Status != StatusRunning || got.Warning != "" {
			t.Fatalf("got %+v, want the task back at running with no warning", got)
		}
		if keys := h.sessions.keyCalls(); !reflect.DeepEqual(keys, [][]string{{c.key}}) {
			t.Fatalf("keys %v, want [[%s]]", keys, c.key)
		}
		if n := len(h.sessions.answerCalls()); n != 0 {
			t.Fatalf("the mod's dialog went to the Claude Code driver %d times", n)
		}
		h.stop(task)
	}
}

func TestAnswerRefusesWordsAndUnknownRowsForTheModsDialog(t *testing.T) {
	for _, c := range []struct {
		body   string
		status int
	}{
		{`{"text":"no thanks"}`, http.StatusUnprocessableEntity},
		{`{"option":3}`, http.StatusBadRequest},
	} {
		h := newHarness(t)
		task := h.needsInput(modPermissionPane)
		h.decodeJSON(h.answer(task, c.body), c.status, nil)
		if keys := h.sessions.keyCalls(); len(keys) != 0 {
			t.Fatalf("%s pressed %v", c.body, keys)
		}
		h.stop(task)
	}
}

// A press that does not take the dialog off the screen says so.
func TestAnswerToTheModsDialogThatStaysUpWarns(t *testing.T) {
	h := newHarness(t)
	task := h.needsInput(modPermissionPane)
	defer h.stop(task)
	var got struct {
		TaskView
		Warning string `json:"warning"`
	}
	h.decodeJSON(h.answer(task, `{"option":1}`), http.StatusOK, &got)
	if got.Warning == "" {
		t.Fatal("no warning for a dialog that stayed on screen")
	}
}
