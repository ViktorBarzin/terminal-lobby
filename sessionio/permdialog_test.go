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

// On an 80-column pane the tip wraps, and its second line is still the tip,
// not what the tool will do (seen live 2026-09-27: "below" read as the first
// line of the command).
func TestParsePermissionDialogLeavesAWrappedTipOut(t *testing.T) {
	pane := strings.Join([]string{
		"────────────────────────────────────────────────────────────────────────────────",
		" Bash command",
		` Tip: auto mode handles these prompts for you — choose "switch to auto mode"`,
		" below",
		"",
		`   printf 'x\n' > c.txt`,
		`   Write "x" to c.txt`,
		"",
		" Do you want to proceed?",
		" ❯ 1. Yes",
		"   2. No",
		"",
		" Esc to cancel · Tab to amend",
	}, "\n")
	d := ParsePermissionDialog(pane)
	if d == nil {
		t.Fatal("did not parse")
	}
	if d.Title != "Bash command" || !reflect.DeepEqual(d.Detail, []string{`printf 'x\n' > c.txt`, `Write "x" to c.txt`}) {
		t.Errorf("title %q, detail %q", d.Title, d.Detail)
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

// "Tab to amend" on the No row turns it into a field (measured on CLI 2.1.283,
// 2026-09-27, testdata/permission-amend-*.txt): the row reads "No, and tell
// Claude what to do differently" while the field is empty and "No, <words>"
// once something is typed, the footer drops "Tab to amend", and long words
// wrap under the row at the words' own column. The reading says which row is
// the No row, where the cursor is, and what the field holds.
func TestParsePermissionReadsTheNoRowAndItsField(t *testing.T) {
	for _, tc := range []struct {
		fixture string
		want    permScreen
	}{
		{"permission-bash.txt", permScreen{cursor: 1, no: 4}},
		{"permission-read.txt", permScreen{cursor: 1, no: 3}},
		{"permission-amend-empty.txt", permScreen{cursor: 4, no: 4, amended: true}},
		// A 47-column pane, a phone's, cuts the placeholder short with an
		// ellipsis rather than wrapping it (CLI 2.1.283, 2026-09-28). The
		// field is still empty.
		{"permission-amend-narrow.txt", permScreen{cursor: 4, no: 4, amended: true}},
		{"permission-amend-typed.txt", permScreen{cursor: 4, no: 4, amended: true, typed: "print the date instead"}},
		{"permission-amend-wrapped.txt", permScreen{cursor: 4, no: 4, amended: true,
			typed: "Do not write anything to a.txt at all, instead please print the current date with the date command and then list the directory contents with ls -la so I can see what is there before we go on"}},
	} {
		t.Run(tc.fixture, func(t *testing.T) {
			s, ok := parsePermission(strings.Split(fixture(t, tc.fixture), "\n"))
			if !ok || s.dialog == nil || s.dialog.Kind != DialogKindPermission {
				t.Fatalf("did not parse: %+v", s)
			}
			s.dialog = nil
			if s != tc.want {
				t.Errorf("got  %+v\nwant %+v", s, tc.want)
			}
		})
	}
}

// The field keeps its words when the cursor walks off the row (measured: ↑
// from the field left "4. No, print the date instead" with the cursor on 3),
// and a prompt with no No row has nothing to decline with.
func TestParsePermissionReadsAFieldTheCursorLeft(t *testing.T) {
	lines := []string{
		"──────────",
		" Bash command",
		"   ls",
		" Do you want to proceed?",
		"   1. Yes",
		" ❯ 2. Yes, and always allow access to /tmp/x from this project",
		"   3. No, print the date instead",
		"",
		" Esc to cancel",
	}
	s, ok := parsePermission(lines)
	if !ok {
		t.Fatal("did not parse")
	}
	if s.cursor != 2 || s.no != 3 || !s.amended || s.typed != "print the date instead" {
		t.Errorf("got %+v", s)
	}
	lines[6] = "   3. Maybe"
	if s, ok := parsePermission(lines); !ok || s.no != 0 {
		t.Errorf("a prompt without a No row read no=%d ok=%v", s.no, ok)
	}
}

// Lines under the bottom row belong to it only at its label column or deeper;
// anything else between the rows and the footer is not a prompt.
func TestParsePermissionRefusesStrayLinesUnderTheRows(t *testing.T) {
	pane := strings.Join([]string{
		"──────────",
		" Bash command",
		"   ls",
		" Do you want to proceed?",
		" ❯ 1. Yes",
		"   2. No, a long answer",
		"   wrapped too far left",
		"",
		" Esc to cancel",
	}, "\n")
	if d := ParsePermissionDialog(pane); d != nil {
		t.Errorf("parsed as %+v", d)
	}
}
