package sessionio

import (
	"os"
	"reflect"
	"strings"
	"testing"
)

// Claude Code's tool permission prompt, read off the pane. The captures are
// real screens from CLI 2.1.283 in manual mode, 120 columns, taken 2026-09-27:
// a Bash command, a Read outside the working directory, and a Write.

func TestParsePermissionDialogReadsThePromptAsDrawn(t *testing.T) {
	for _, tc := range []struct {
		fixture string
		want    Dialog
	}{
		{"permission-bash.txt", Dialog{
			Kind:   DialogKindPermission,
			Title:  "Bash command",
			Detail: []string{`printf 'hi\n' > a.txt`, `Write "hi" to a.txt`},
			Prompt: "Do you want to proceed?",
			Options: []PlanOption{
				{Number: 1, Label: "Yes"},
				{Number: 2, Label: "Yes, and always allow access to /var/tmp/quiet-line-fix/proj from this project"},
				{Number: 3, Label: "Yes, and switch to auto mode · auto mode handles these prompts for you"},
				{Number: 4, Label: "No"},
			},
		}},
		{"permission-read.txt", Dialog{
			Kind:   DialogKindPermission,
			Title:  "Read file",
			Detail: []string{"Read(/etc/hostname)"},
			Prompt: "Do you want to proceed?",
			Options: []PlanOption{
				{Number: 1, Label: "Yes"},
				{Number: 2, Label: "Yes, allow reading from /etc during this session"},
				{Number: 3, Label: "No"},
			},
		}},
		{"permission-write.txt", Dialog{
			Kind:   DialogKindPermission,
			Title:  "Create file",
			Detail: []string{"b.txt", "1 bee"},
			Prompt: "Do you want to create b.txt?",
			Options: []PlanOption{
				{Number: 1, Label: "Yes"},
				{Number: 2, Label: "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)"},
				{Number: 3, Label: "No"},
			},
		}},
	} {
		t.Run(tc.fixture, func(t *testing.T) {
			d := ParsePermissionDialog(fixture(t, tc.fixture))
			if d == nil {
				t.Fatal("did not parse")
			}
			if !reflect.DeepEqual(*d, tc.want) {
				t.Errorf("got  %+v\nwant %+v", *d, tc.want)
			}
		})
	}
}

// A narrow pane wraps a long option at its label column, and the question
// too. The wrapped pieces belong to the row above them.
func TestParsePermissionDialogJoinsWrappedLines(t *testing.T) {
	pane := strings.Join([]string{
		"────────────────────────────────────────",
		" Bash command",
		"",
		"   rm -rf build",
		"",
		" Do you want to",
		" proceed?",
		" ❯ 1. Yes",
		"   2. Yes, and always allow access to",
		"      /home/me/proj from this project",
		"   3. No",
		"",
		" Esc to cancel · Tab to amend",
		"",
	}, "\n")
	d := ParsePermissionDialog(pane)
	if d == nil {
		t.Fatal("did not parse")
	}
	if d.Prompt != "Do you want to proceed?" {
		t.Errorf("prompt = %q", d.Prompt)
	}
	want := []PlanOption{
		{Number: 1, Label: "Yes"},
		{Number: 2, Label: "Yes, and always allow access to /home/me/proj from this project"},
		{Number: 3, Label: "No"},
	}
	if !reflect.DeepEqual(d.Options, want) {
		t.Errorf("options = %+v", d.Options)
	}
}

// Not a prompt: the footer is not the last line (a copy of the prompt in the
// conversation has the input box under it), the rows skip a number, no row
// carries the cursor, or nothing asks a question.
func TestParsePermissionDialogRefusesWhatIsNotOnScreen(t *testing.T) {
	good := []string{
		"──────────",
		" Bash command",
		"   ls",
		" Do you want to proceed?",
		" ❯ 1. Yes",
		"   2. No",
		"",
		" Esc to cancel · Tab to amend",
	}
	if ParsePermissionDialog(strings.Join(good, "\n")) == nil {
		t.Fatal("the control case did not parse")
	}
	for name, lines := range map[string][]string{
		"quoted above the input box": append(append([]string{}, good...), "──────────", "❯ ", "──────────", "  ⏸ manual mode on"),
		"rows skip a number":         {good[0], good[1], good[2], good[3], " ❯ 1. Yes", "   3. No", "", good[7]},
		"no cursor":                  {good[0], good[1], good[2], good[3], "   1. Yes", "   2. No", "", good[7]},
		"one row":                    {good[0], good[1], good[2], good[3], " ❯ 1. Yes", "", good[7]},
		"no question":                {good[0], good[1], good[2], " Proceed.", " ❯ 1. Yes", "   2. No", "", good[7]},
		"the select widget's footer": {good[0], good[1], good[2], good[3], " ❯ 1. Yes", "   2. No", "", " Enter to select · ↑/↓ to navigate · Esc to cancel"},
	} {
		if d := ParsePermissionDialog(strings.Join(lines, "\n")); d != nil {
			t.Errorf("%s: parsed as %+v", name, d)
		}
	}
}

// The permission prompt and the other dialogs leave each other's screens
// alone. The card that docks over a reading presses keys, so a question read
// as a permission prompt, or the reverse, is a key pressed on the wrong screen.
func TestPermissionParserAndTheOthersKeepApart(t *testing.T) {
	entries, err := os.ReadDir("testdata")
	if err != nil {
		t.Fatal(err)
	}
	var perms, others int
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".txt") {
			continue
		}
		pane := fixture(t, name)
		if strings.HasPrefix(name, "permission-") {
			perms++
			if d := ParseDialog(pane); d != nil {
				t.Errorf("%s read as a question: %+v", name, d)
			}
			if d := ParsePlanDialog(pane); d != nil {
				t.Errorf("%s read as the plan dialog: %+v", name, d)
			}
			continue
		}
		others++
		if d := ParsePermissionDialog(pane); d != nil {
			t.Errorf("%s read as a permission prompt: %+v", name, d)
		}
	}
	if perms < 3 || others < 30 {
		t.Fatalf("only %d permission and %d other captures found", perms, others)
	}
}
