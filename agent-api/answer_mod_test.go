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

// modPlanPaneLive is the mod's plan approval as a live pane drew it on
// 2026-10-02 (CLI 2.1.287): the question, plan included, under a border.
var modPlanPaneLive = strings.Join([]string{
	"● Updated plan",
	"  ⎿  /plan to preview",
	"────────────────────────────────────────────────────────────────────────────────",
	"Planning: /home/wizard/.claude/plans/this-is-an-api-dreamy-marble.md",
	"────────────────────────────────────────────────────────────────────────────────",
	" ☐ Plan",
	"",
	"│ # Plan",
	"│",
	"│ Run `uname -m` and print its output.",
	"│",
	"│ Claude has finished planning. Approve the plan?",
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

// Measured live on 2026-10-02: a plan-mode conversation reached the mod's
// plan approval and the task said only "Claude has finished planning.
// Approve the plan?", with answer_with [option]. A caller had to approve a
// plan it could not read, and could not send feedback. The plan is on the
// pane, above the rows, and words go into the dialog's free-text row.
func TestTheModsPlanDialogCarriesThePlanAndTakesWords(t *testing.T) {
	for _, c := range []struct {
		pane string
		want []string
	}{
		{modPlanPane, []string{"1. Write hello.txt.", "Approve the plan?"}},
		{modPlanPaneLive, []string{"# Plan\n\nRun `uname -m` and print its output.", "Approve the plan?"}},
	} {
		q := parseQuestion(c.pane)
		if q.Kind != KindPlan || !q.Mod {
			t.Fatalf("read as %q (mod %v)", q.Kind, q.Mod)
		}
		for _, w := range c.want {
			if !strings.Contains(q.Text, w) {
				t.Errorf("question %q lacks %q", q.Text, w)
			}
		}
		for _, no := range []string{"│", "Approve plan", "Enter to select", "Planning:"} {
			if strings.Contains(q.Text, no) {
				t.Errorf("question %q carries %q, which is not the plan", q.Text, no)
			}
		}
		if !reflect.DeepEqual(q.AnswerWith, []string{answerOption, answerText}) {
			t.Fatalf("answer_with %v, want [option text]", q.AnswerWith)
		}
	}
}

// modFeedbackFake makes the fake pane behave like the live dialog did on
// 2026-10-02: the free-text row's digit puts the cursor on it, a paste lands
// in it, and Enter submits it.
func modFeedbackFake(h *harness, landsAs func(text string) string) {
	h.sessions.onKeys = func(f *fakeSessions, k string) {
		switch last := f.keys[len(f.keys)-1]; last[0] {
		case "3":
			p := strings.Replace(f.panes[k], "❯ 1. Approve plan", "  1. Approve plan", 1)
			f.panes[k] = strings.Replace(p, "  3. Type something.", "❯ 3. Type something.", 1)
		case "Enter":
			f.panes[k] = "● Working…"
		case "Up":
			p := strings.Replace(f.panes[k], "  2. Keep planning", "❯ 2. Keep planning", 1)
			f.panes[k] = strings.Replace(p, "❯ 3. ", "  3. ", 1)
		}
	}
	h.sessions.onText = func(f *fakeSessions, k, text string) {
		f.panes[k] = strings.Replace(f.panes[k], "❯ 3. Type something.", "❯ 3. "+landsAs(text), 1)
	}
}

func TestAnswerSendsWordsToTheModsPlanDialog(t *testing.T) {
	h := newHarness(t)
	task := h.needsInput(modPlanPaneLive)
	defer h.stop(task)
	modFeedbackFake(h, func(text string) string { return text })

	var got struct {
		TaskView
		Warning string `json:"warning"`
	}
	h.decodeJSON(h.answer(task, `{"text":"Also print the hostname."}`), http.StatusOK, &got)
	if got.Status != StatusRunning || got.Warning != "" {
		t.Fatalf("got %+v, want the task back at running with no warning", got)
	}
	if keys := h.sessions.keyCalls(); !reflect.DeepEqual(keys, [][]string{{"3"}, {"Enter"}}) {
		t.Fatalf("keys %v, want [[3] [Enter]]", keys)
	}
	if texts := h.sessions.textCalls(); !reflect.DeepEqual(texts, []string{"Also print the hostname."}) {
		t.Fatalf("typed %v", texts)
	}
}

// Words that cannot be read back off the row are not submitted: Enter on
// whatever the row holds would send Claude something nobody wrote. The cursor
// is walked off the field, where a later digit would be typed into it.
func TestAnswerToTheModsPlanDialogStopsWhenTheWordsDoNotShow(t *testing.T) {
	h := newHarness(t)
	task := h.needsInput(modPlanPaneLive)
	defer h.stop(task)
	modFeedbackFake(h, func(string) string { return "something else" })

	h.decodeJSON(h.answer(task, `{"text":"Also print the hostname."}`), http.StatusInternalServerError, nil)
	if keys := h.sessions.keyCalls(); !reflect.DeepEqual(keys, [][]string{{"3"}, {"Up"}}) {
		t.Fatalf("keys %v, want [[3] [Up]]", keys)
	}
}

// A free-text row that already holds words is refused before any key: its
// digit would submit those words at once (seen live on 2026-10-02).
func TestAnswerToTheModsPlanDialogRefusesAFilledRow(t *testing.T) {
	filled := strings.Replace(modPlanPaneLive, "3. Type something.", "3. left by someone", 1)
	for _, body := range []string{`{"text":"Also print the hostname."}`, `{"option":1}`} {
		h := newHarness(t)
		task := h.needsInput(strings.Replace(filled, "❯ 1. Approve plan", "  1. Approve plan", 1))
		h.sessions.setPane(testOSUser, "c1", strings.Replace(
			strings.Replace(filled, "❯ 1. Approve plan", "  1. Approve plan", 1),
			"  3. left by someone", "❯ 3. left by someone", 1))
		w := h.answer(task, body)
		if w.Code != http.StatusConflict {
			t.Fatalf("%s: status %d (%s), want 409", body, w.Code, w.Body.String())
		}
		if keys := h.sessions.keyCalls(); len(keys) != 0 {
			t.Fatalf("%s pressed %v", body, keys)
		}
		h.stop(task)
	}
	// Words into a filled row whose cursor is elsewhere are refused too.
	h := newHarness(t)
	task := h.needsInput(filled)
	defer h.stop(task)
	if w := h.answer(task, `{"text":"Also print the hostname."}`); w.Code != http.StatusConflict {
		t.Fatalf("status %d (%s), want 409", w.Code, w.Body.String())
	}
	if keys := h.sessions.keyCalls(); len(keys) != 0 {
		t.Fatalf("pressed %v", keys)
	}
}
