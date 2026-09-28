package sessionio

import (
	"context"
	"strings"
	"testing"
)

// Declining the tool permission prompt with words, through POST /answer's
// driver, against a real tmux and the stand-in's permission prompt
// (fakeDialogPy, FAKEDIALOG_CALL=permission), which answers keys the way CLI
// 2.1.283 does.

func permSession(t *testing.T, env string) (*Injector, string) {
	t.Helper()
	return standIn(t, "FAKEDIALOG_CALL=permission "+env+" ", "Esc to cancel")
}

func permDecline(t *testing.T, in *Injector, osUser, words string) AnswerResponse {
	t.Helper()
	res, err := in.Answer(context.Background(), osUser, "demo",
		AnswerRequest{Permission: &PermissionAnswer{Decline: words}})
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	return res
}

// The whole decline: ↓ to the No row, Tab, the words, Enter, and the prompt
// gone. The digit is never pressed, since it declines with no words.
func TestAnswerDeclinesThePermissionWithTheWords(t *testing.T) {
	in, osUser := permSession(t, "")

	res := permDecline(t, in, osUser, "print the date instead")

	if !res.Applied || !res.Done {
		t.Fatalf("applied=%v done=%v reason=%q, want the prompt gone", res.Applied, res.Done, res.Reason)
	}
	if res.Action != ActionPermissionDecline {
		t.Errorf("action = %q, want %q", res.Action, ActionPermissionDecline)
	}
	if pane := paneOf(t, in, osUser); !strings.Contains(pane, "PERMISSION DECLINED WITH print the date instead") {
		t.Fatalf("the words did not go with the decline:\n%s", pane)
	}
}

// Two tool calls sent together ask in turn: the next prompt is up the moment
// the first is answered. That prompt is not the one declined, so the decline
// has landed, and the reply carries the new prompt rather than reporting a
// failure (seen live 2026-09-27, an Edit declined with words and a Bash
// prompt drawn under it).
func TestAnswerDeclineLandsWhenTheNextCallAsksAtOnce(t *testing.T) {
	in, osUser := permSession(t, "FAKEDIALOG_PERM_NEXT='printf bye'")

	res := permDecline(t, in, osUser, "print the date instead")

	if !res.Applied || res.Reason != "" {
		t.Fatalf("applied=%v reason=%q, want the decline reported as landed", res.Applied, res.Reason)
	}
	if res.Dialog == nil || res.Dialog.Kind != DialogKindPermission {
		t.Fatalf("the reply must carry the next prompt: %+v", res.Dialog)
	}
	pane := paneOf(t, in, osUser)
	if !strings.Contains(pane, "PERMISSION DECLINED WITH print the date instead") || !strings.Contains(pane, "printf bye") {
		t.Fatalf("the first prompt was not declined with the words, or the second is not up:\n%s", pane)
	}
}

// Long words wrap under the row, and the reading joins them back before the
// Enter goes in.
func TestAnswerDeclinesWithWordsThatWrap(t *testing.T) {
	in, osUser := permSession(t, "")
	words := "Do not write anything to a.txt at all, instead print the current date with the date command and then list the directory with ls -la"

	res := permDecline(t, in, osUser, words)

	if !res.Applied || !res.Done {
		t.Fatalf("applied=%v done=%v reason=%q", res.Applied, res.Done, res.Reason)
	}
	if pane := paneOf(t, in, osUser); !strings.Contains(pane, "PERMISSION DECLINED WITH Do not write") {
		t.Fatalf("the decline did not land:\n%s", pane)
	}
}

// A narrow pane, a phone's 47 columns, cuts the open field's placeholder short
// ("No, and tell Claude what to do different…", CLI 2.1.283, 2026-09-28). It
// is still the empty field: the decline types the words into it rather than
// trying to clear words that are not there and waiting for a placeholder that
// never draws in full (deployed review round 2).
func TestAnswerDeclinesOnANarrowPane(t *testing.T) {
	in, osUser := permSession(t, "FAKEDIALOG_PERM_PLACEHOLDER='and tell Claude what to do different…'")

	res := permDecline(t, in, osUser, "write bye instead of hi")

	if !res.Applied || !res.Done {
		t.Fatalf("applied=%v done=%v reason=%q, want the prompt gone", res.Applied, res.Done, res.Reason)
	}
	if pane := paneOf(t, in, osUser); !strings.Contains(pane, "PERMISSION DECLINED WITH write bye instead of hi") {
		t.Fatalf("the words did not go with the decline:\n%s", pane)
	}
}

// Words already in the field, left by someone typing in the Terminal and
// walking off the row, are cleared first: walking back puts the text cursor
// in front of them, so a paste there would send both.
func TestAnswerClearsWordsTheFieldAlreadyHolds(t *testing.T) {
	in, osUser := permSession(t, "FAKEDIALOG_PERM_FIELD='old words' FAKEDIALOG_PERM_CURSOR=2")
	eventually(t, in, osUser, "No, old words")

	res := permDecline(t, in, osUser, "new words")

	if !res.Applied || !res.Done {
		t.Fatalf("applied=%v done=%v reason=%q", res.Applied, res.Done, res.Reason)
	}
	pane := paneOf(t, in, osUser)
	if !strings.Contains(pane, "PERMISSION DECLINED WITH new words") || strings.Contains(pane, "old") {
		t.Fatalf("the field was not cleared first:\n%s", pane)
	}
}

// Words that never reach the field stop the request before the Enter, which
// on an empty field would decline with nothing said.
func TestAnswerPressesNoEnterWhenTheWordsDidNotLand(t *testing.T) {
	in, osUser := permSession(t, "FAKEDIALOG_DROP_PASTE=1")

	res := permDecline(t, in, osUser, "print the date instead")

	if res.Applied || res.Reason != AnswerUnverified {
		t.Fatalf("applied=%v reason=%q, want unverified", res.Applied, res.Reason)
	}
	if res.Dialog == nil || res.Dialog.Kind != DialogKindPermission {
		t.Fatalf("the refusal must carry the prompt as it stands: %+v", res.Dialog)
	}
	if pane := paneOf(t, in, osUser); strings.Contains(pane, "PERMISSION") || !strings.Contains(pane, "No, and tell Claude") {
		t.Fatalf("the prompt should still be up with its field open:\n%s", pane)
	}
}

// Refused with nothing typed: blank words, words with a line break, a prompt
// with no No row, and a request that answers the plan as well.
func TestAnswerRefusesADeclineItCannotMake(t *testing.T) {
	for _, tc := range []struct {
		name   string
		env    string
		req    AnswerRequest
		reason string
	}{
		{"blank words", "", AnswerRequest{Permission: &PermissionAnswer{Decline: "  "}}, AnswerRefused},
		{"a line break", "", AnswerRequest{Permission: &PermissionAnswer{Decline: "a\nb"}}, AnswerRefused},
		{"no No row", "FAKEDIALOG_PERM_OPTS='Yes|Maybe'", AnswerRequest{Permission: &PermissionAnswer{Decline: "x"}}, AnswerUnknownOption},
		{"the plan too", "", AnswerRequest{
			Permission: &PermissionAnswer{Decline: "x"},
			Plan:       &PlanAnswer{Feedback: "x"},
		}, AnswerUnknownOption},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in, osUser := permSession(t, tc.env)
			res, err := in.Answer(context.Background(), osUser, "demo", tc.req)
			if err != nil {
				t.Fatalf("Answer: %v", err)
			}
			if res.Applied || res.Reason != tc.reason {
				t.Fatalf("applied=%v reason=%q, want %q", res.Applied, res.Reason, tc.reason)
			}
			if pane := paneOf(t, in, osUser); !strings.Contains(pane, "❯ 1.") || !strings.Contains(pane, "Tab to amend") {
				t.Fatalf("a refused request moved the prompt:\n%s", pane)
			}
		})
	}
}

// A decline for a pane showing the plan approval, and a plan answer for a pane
// showing a permission prompt, are each refused as not-drawn.
func TestAnswerRefusesADialogThePaneIsNotDrawing(t *testing.T) {
	in, osUser := planSession(t, "")
	if res := permDecline(t, in, osUser, "x"); res.Applied || res.Reason != AnswerNotDrawn {
		t.Errorf("decline over the plan: applied=%v reason=%q", res.Applied, res.Reason)
	}
	in, osUser = permSession(t, "")
	if res := planAnswer(t, in, osUser, PlanAnswer{Feedback: "x"}); res.Applied || res.Reason != AnswerNotDrawn {
		t.Errorf("plan feedback over a permission prompt: applied=%v reason=%q", res.Applied, res.Reason)
	}
	if pane := paneOf(t, in, osUser); !strings.Contains(pane, "❯ 1.") {
		t.Fatalf("a refused request moved the prompt:\n%s", pane)
	}
}

func permPick(t *testing.T, in *Injector, osUser string, option int, label string) AnswerResponse {
	t.Helper()
	res, err := in.Answer(context.Background(), osUser, "demo",
		AnswerRequest{Permission: &PermissionAnswer{Option: option, Label: label}})
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	return res
}

// A row picked on the card goes in as its digit, and the reply waits for the
// prompt to go.
func TestAnswerPicksAPermissionRow(t *testing.T) {
	in, osUser := permSession(t, "")

	res := permPick(t, in, osUser, 1, "Yes")

	if !res.Applied || !res.Done {
		t.Fatalf("applied=%v done=%v reason=%q, want the prompt gone", res.Applied, res.Done, res.Reason)
	}
	if res.Action != ActionPermissionPick {
		t.Errorf("action = %q, want %q", res.Action, ActionPermissionPick)
	}
	if pane := paneOf(t, in, osUser); !strings.Contains(pane, "PERMISSION 1") {
		t.Fatalf("row 1 was not picked:\n%s", pane)
	}
}

// With the cursor in the No row's open field, a digit is typed into the field
// ("No, 1") and picks nothing. That is where a failed typed decline left the
// pane, and the card's Yes then told Claude "1" instead of approving (deployed
// review round 2). The cursor walks off the field first, which closes an empty
// one, and only then does the digit go in.
func TestAnswerPicksARowWhileTheNoFieldIsOpen(t *testing.T) {
	for _, tc := range []struct{ name, field string }{
		{"empty", "''"},
		{"holding words", "'old words'"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in, osUser := permSession(t, "FAKEDIALOG_PERM_FIELD="+tc.field+" FAKEDIALOG_PERM_CURSOR=3")
			eventually(t, in, osUser, "❯ 3. No,")

			res := permPick(t, in, osUser, 1, "Yes")

			if !res.Applied || !res.Done {
				t.Fatalf("applied=%v done=%v reason=%q", res.Applied, res.Done, res.Reason)
			}
			pane := paneOf(t, in, osUser)
			if !strings.Contains(pane, "PERMISSION 1") || strings.Contains(pane, "No, 1") {
				t.Fatalf("the digit went into the field instead of picking row 1:\n%s", pane)
			}
		})
	}
}

// A row the prompt does not draw, a label that is not the one drawn now, or a
// row and words together, is refused with nothing typed.
func TestAnswerRefusesARowItCannotPick(t *testing.T) {
	for _, tc := range []struct {
		name string
		req  PermissionAnswer
	}{
		{"no such row", PermissionAnswer{Option: 7, Label: "Yes"}},
		{"another label", PermissionAnswer{Option: 1, Label: "Yes, and always allow"}},
		{"no label", PermissionAnswer{Option: 1}},
		{"words too", PermissionAnswer{Option: 1, Label: "Yes", Decline: "x"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in, osUser := permSession(t, "")
			req := tc.req
			res, err := in.Answer(context.Background(), osUser, "demo", AnswerRequest{Permission: &req})
			if err != nil {
				t.Fatalf("Answer: %v", err)
			}
			if res.Applied || res.Reason != AnswerUnknownOption {
				t.Fatalf("applied=%v reason=%q, want unknown-option", res.Applied, res.Reason)
			}
			if pane := paneOf(t, in, osUser); !strings.Contains(pane, "❯ 1.") || strings.Contains(pane, "PERMISSION") {
				t.Fatalf("a refused request moved the prompt:\n%s", pane)
			}
		})
	}
}
