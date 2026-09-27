package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"terminal-lobby/sessionio"
	"terminal-lobby/sessionio/siotest"
)

// POST /prompt refuses while the plan approval is up.
//
// The composer's own send is routed to the plan card's feedback while the card
// is docked, so what this guards is every other sender: a browser holding a
// bundle from before the card existed, a second tab, the new-session path.
// Injector.Prompt sends C-e C-u, a paste and Enter into whatever has focus,
// and on the plan approval Enter selects the highlighted row, which is the
// first one: clear the context and start executing in auto mode.

// An ExitPlanMode as Claude Code records it (input {plan, planFilePath},
// measured on 2.1.281), and the result that closes it.
const (
	planUseLine = `{"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","content":[` +
		`{"type":"tool_use","id":"toolu_plan","name":"ExitPlanMode","input":{"plan":"# Create hello.txt\n\n1. Write it.",` +
		`"planFilePath":"/home/wizard/.claude/plans/x.md"}}]},"uuid":"p1","timestamp":"2026-09-24T07:21:00Z"}`
	planResultLine = `{"type":"user","message":{"role":"user","content":[` +
		`{"type":"tool_result","tool_use_id":"toolu_plan","content":"User has approved your plan."}]},` +
		`"uuid":"p2","timestamp":"2026-09-24T07:21:09Z"}`
)

// guardPane is the pane and the hooks' options, as promptRefusal reads them.
type guardPane struct {
	*fakePane
	*siotest.FakeOptions
}

// planEnv registers "demo" for "wizard" over a transcript of `lines`, and
// returns the registry and a pane showing `capture`.
func planEnv(t *testing.T, capture string, lines ...string) (*registry, guardPane) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	home := t.TempDir()
	path := sessionio.TranscriptPath(sessionio.ProjectsRoot(home, "wizard"), "/home/wizard/x", "s1")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	opts := siotest.NewFakeOptions("wizard/demo")
	rg := newRegistry(ctx, time.Millisecond, home, opts, "wizard")
	register(t, rg, "wizard", "s1", "/home/wizard/x", "demo")
	return rg, guardPane{fakePane: &fakePane{text: capture}, FakeOptions: opts}
}

func capture(t *testing.T, name string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "sessionio", "testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestPlanOpenReadsThePane(t *testing.T) {
	for _, tc := range []struct {
		fixture string
		open    bool
	}{
		{"plan-first.txt", true},
		{"plan-feedback-typed.txt", true},
		{"plan-narrow.txt", true},
		// The dialog quoted in the conversation, over an input box that is
		// waiting for exactly this prompt.
		{"plan-quoted-in-conversation.txt", false},
		{"status-claude-idle.txt", false},
		// A question refuses a prompt too, but with a reason of its own
		// (TestQuestionOpenRefusesAPrompt).
		{"dialog-single.txt", false},
	} {
		t.Run(tc.fixture, func(t *testing.T) {
			rg, p := planEnv(t, capture(t, tc.fixture), answerUserLine)
			if got := promptRefusal(rg, p, "wizard", "demo") == planOpenReason; got != tc.open {
				t.Errorf("plan open = %v, want %v", got, tc.open)
			}
		})
	}
}

// THE SECOND NET. A plan approval the parser cannot read, restyled by a CLI
// update, is still refused while the hooks' marker names the ExitPlanMode the
// transcript holds open. The marker alone is not enough: it is set for a
// question too, and a question does not refuse a prompt.
func TestPlanOpenFallsBackToTheMarkerAndTheTranscript(t *testing.T) {
	restyled := strings.Replace(capture(t, "plan-first.txt"), "ctrl+g to edit in Vim", "ctrl+e to edit", 1)
	if sessionio.ParsePlanDialog(restyled) != nil {
		t.Fatal("the restyled capture still parses; the test would prove nothing")
	}
	for _, tc := range []struct {
		name  string
		ask   string
		lines []string
		open  bool
	}{
		{"the marker names the open ExitPlanMode", "toolu_plan", []string{answerUserLine, planUseLine}, true},
		{"the plan has its result", "toolu_plan", []string{answerUserLine, planUseLine, planResultLine}, false},
		{"the marker names a question", "tu_1", []string{answerUserLine, planUseLine, answerAskLine}, false},
		{"no marker", "", []string{answerUserLine, planUseLine}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rg, p := planEnv(t, restyled, tc.lines...)
			if tc.ask != "" {
				if err := p.SetOption("wizard", "demo", sessionio.OptionAsk, tc.ask); err != nil {
					t.Fatal(err)
				}
			}
			if got := promptRefusal(rg, p, "wizard", "demo") == planOpenReason; got != tc.open {
				t.Errorf("plan open = %v, want %v", got, tc.open)
			}
		})
	}
}

// The refusal says why, in the shape the answer routes use, and is not a 2xx:
// a client from before the plan card counts a 2xx as sent and clears its
// field, and the contract is that the text comes back.
func TestThePlanRefusalSaysWhy(t *testing.T) {
	rec := httptest.NewRecorder()
	writePromptRefusal(rec, planOpenReason)
	if rec.Code != http.StatusConflict {
		t.Errorf("status %d, want 409", rec.Code)
	}
	if got := strings.TrimSpace(rec.Body.String()); got != `{"applied":false,"reason":"plan-open"}` {
		t.Errorf("body = %s", got)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q", ct)
	}
}

// A question is the third screen a prompt must not reach. Injector.Prompt ends
// with Enter, and on a question Enter picks the highlighted row: measured on
// 0.78.0 on 2026-09-27, a prompt sent the moment the dialog drew answered
// "Shape?" with Circle, which nobody chose, and the words were lost. The
// Text view routes Send to POST /answer once its card docks, about 1.4 s after
// the dialog draws, and a Send inside that window, or with the event stream
// stalled, went here.
func TestQuestionOpenRefusesAPrompt(t *testing.T) {
	for _, tc := range []struct {
		fixture string
		want    string
	}{
		{"dialog-single.txt", questionOpenReason},
		{"dialog-multi-second.txt", questionOpenReason},
		{"dialog-narrow-footer.txt", questionOpenReason},
		{"dialog-review-nofooter.txt", questionOpenReason},
		{"dialog-review-tall-clipped.txt", questionOpenReason},
		{"plan-first.txt", planOpenReason},
		{"permission-bash.txt", permissionOpenReason},
		{"status-claude-idle.txt", ""},
		// The model picker draws the same widget and is no question.
		{"picker-claude-model.txt", ""},
	} {
		t.Run(tc.fixture, func(t *testing.T) {
			rg, p := planEnv(t, capture(t, tc.fixture), answerUserLine)
			if got := promptRefusal(rg, p, "wizard", "demo"); got != tc.want {
				t.Errorf("refusal = %q, want %q", got, tc.want)
			}
		})
	}
}

// The net under the parse, as for the plan: a question whose top the pane has
// cut off does not parse, and the hooks' marker naming the AskUserQuestion the
// transcript holds open is the dialog on screen.
func TestQuestionOpenFallsBackToTheMarkerAndTheTranscript(t *testing.T) {
	unreadable := "❯ \n"
	for _, tc := range []struct {
		name  string
		ask   string
		lines []string
		want  string
	}{
		{"the marker names the open question", "tu_1", []string{answerUserLine, answerAskLine}, questionOpenReason},
		{"the question has its result", "tu_1", []string{answerUserLine, answerAskLine, answerResultLine}, ""},
		{"no marker", "", []string{answerUserLine, answerAskLine}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rg, p := planEnv(t, unreadable, tc.lines...)
			if tc.ask != "" {
				if err := p.SetOption("wizard", "demo", sessionio.OptionAsk, tc.ask); err != nil {
					t.Fatal(err)
				}
			}
			if got := promptRefusal(rg, p, "wizard", "demo"); got != tc.want {
				t.Errorf("refusal = %q, want %q", got, tc.want)
			}
		})
	}
}
