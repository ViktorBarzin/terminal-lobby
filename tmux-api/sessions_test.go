package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// row joins fields with the format separator, so fixtures stay readable even
// though the real separator is an invisible control character.
func row(fields ...string) string { return strings.Join(fields, listSep) }

// /sessions rows carry TWO arbitrary-text fields: pane_title, which
// applications set freely via OSC 2, and @title, the display title a person
// chose. Only one field can be last, which is why the separator is \x1f rather
// than '|' — neither a typed title nor a realistic pane title contains a unit
// separator, so both are safe where '|' protected only the trailing one.
func TestParseSessionsFields(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []Session
	}{
		{
			name: "full row",
			in:   row("$3", "work", "1", "1700000000", "1690000000", "", "running", "4242", "claude", "Deploy the thing", "~/code"),
			want: []Session{{
				ID: "$3", Name: "work", Attached: 1, LastActivity: 1700000000,
				Created: 1690000000, State: "running", PanePID: 4242,
				Command: "claude", Title: "Deploy the thing", PaneTitle: "~/code",
			}},
		},
		{
			name: "a pipe in either title survives verbatim",
			in:   row("$4", "logs", "0", "1700000001", "1690000001", "", "", "77", "zsh", "Deploy | stage 2", "make | tee build.log"),
			want: []Session{{
				ID: "$4", Name: "logs", LastActivity: 1700000001, Created: 1690000001,
				PanePID: 77, Command: "zsh",
				Title: "Deploy | stage 2", PaneTitle: "make | tee build.log",
			}},
		},
		{
			name: "a title in any script survives verbatim",
			in:   row("$5", "testova-sesiya", "0", "1", "2", "", "", "9", "claude", "тестова сесия 🚀", ""),
			want: []Session{{
				ID: "$5", Name: "testova-sesiya", LastActivity: 1, Created: 2,
				PanePID: 9, Command: "claude", Title: "тестова сесия 🚀",
			}},
		},
		{
			name: "no title is no title — every session that predates the feature",
			in:   row("$6", "bare", "0", "1", "2", "", "done", "9", "", "", ""),
			want: []Session{{
				ID: "$6", Name: "bare", LastActivity: 1, Created: 2,
				State: "done", PanePID: 9,
			}},
		},
		{
			// A pre-warmed pool slot. Its name is deliberately over the 32-char
			// limit so no endpoint can address it; listing it would put a card
			// in the lobby that every action refuses.
			name: "an over-long name is not listed",
			in: row("$7", "__terminal_lobby_prewarmed_pool_slot__home_wizard_code",
				"0", "1", "2", "", "", "9", "claude", "", ""),
			want: []Session{},
		},
		{
			// Reachable outside this API — tmux itself accepts these, and
			// setup scripts or a plain `tmux new -s` can create them.
			name: "a name with characters the API rejects is not listed",
			in:   row("$8", "has space", "0", "1", "2", "", "", "9", "zsh", "", ""),
			want: []Session{},
		},
		{
			name: "an addressable session alongside an unaddressable one still lists",
			in: row("$9", "work", "0", "1", "2", "", "", "9", "claude", "", "") + "\n" +
				row("$10", "__terminal_lobby_prewarmed_pool_slot__home_wizard_code",
					"0", "1", "2", "", "", "9", "claude", "", ""),
			want: []Session{{
				ID: "$9", Name: "work", LastActivity: 1, Created: 2,
				PanePID: 9, Command: "claude",
			}},
		},
		{
			name: "the pre-title 8-field row is skipped, not mis-parsed",
			in:   row("old", "1", "1700000000", "1690000000", "running", "4242", "claude", "t"),
			want: []Session{},
		},
		{
			name: "a row whose id is not a tmux session id is dropped",
			// A separator smuggled into a session name (possible outside the
			// API's NAME_RE) shifts every field left. The id anchor catches it
			// before the numeric columns have to.
			in:   row("we", "ird", "$7", "1", "1700000000", "", "1690000000", "running", "4242", "claude", "t"),
			want: []Session{},
		},
		{
			name: "a non-numeric count still drops the row",
			in:   row("$8", "odd", "many", "1700000000", "1690000000", "", "running", "4242", "claude", "", ""),
			want: []Session{},
		},
		{
			name: "mixed good and bad lines keep the good ones",
			in: row("$1", "ok", "0", "10", "20", "", "awaiting", "31", "vim", "Edit the thing", "edit") + "\n" +
				"broken" + listSep + "line\n" +
				row("$2", "also-ok", "2", "30", "40", "", "", "55", "bash", "", ""),
			want: []Session{
				{ID: "$1", Name: "ok", LastActivity: 10, Created: 20, State: "awaiting",
					PanePID: 31, Command: "vim", Title: "Edit the thing", PaneTitle: "edit"},
				{ID: "$2", Name: "also-ok", Attached: 2, LastActivity: 30, Created: 40,
					PanePID: 55, Command: "bash"},
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := parseSessions([]byte(tc.in + "\n"))
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("parseSessions(%q):\n got %+v\nwant %+v", tc.in, got, tc.want)
			}
		})
	}
}

// The format string has to keep @title and pane_title adjacent-but-separate and
// must not reintroduce '|' as the separator, since that is what made two
// arbitrary-text fields impossible.
func TestListFormatCarriesBothTitles(t *testing.T) {
	for _, want := range []string{"#{session_id}", "#{@title}", "#{pane_title}", "#{session_name}"} {
		if !strings.Contains(tmuxListFmt, want) {
			t.Errorf("tmuxListFmt is missing %s: %q", want, tmuxListFmt)
		}
	}
	if strings.Contains(tmuxListFmt, "|") {
		t.Errorf("tmuxListFmt still separates on '|', which a title may contain: %q", tmuxListFmt)
	}
	if n := len(strings.Split(tmuxListFmt, listSep)); n != listFields {
		t.Errorf("tmuxListFmt has %d fields, parser expects %d", n, listFields)
	}
}

// Wire shape: the display title travels as "title" and the session id as "id",
// and both vanish when empty so consumers that predate them see the historic
// object. pane_title keeps its own key — they are different things.
func TestSessionsJSONShape(t *testing.T) {
	full, err := json.Marshal(parseSessions([]byte(
		row("$3", "work", "1", "10", "20", "", "running", "42", "claude", "Deploy the thing", "~/code") + "\n")))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"pane_current_command":"claude"`,
		`"pane_title":"~/code"`,
		`"title":"Deploy the thing"`,
		`"id":"$3"`,
	} {
		if !strings.Contains(string(full), want) {
			t.Fatalf("marshaled sessions missing %s: %s", want, full)
		}
	}
	bare, err := json.Marshal(parseSessions([]byte(
		row("$4", "bare", "0", "1", "2", "", "", "9", "", "", "") + "\n")))
	if err != nil {
		t.Fatal(err)
	}
	for _, absent := range []string{"pane_current_command", "pane_title", `"title"`, "tool"} {
		if strings.Contains(string(bare), absent) {
			t.Fatalf("empty %s must be omitted from the wire: %s", absent, bare)
		}
	}
	tooled, err := json.Marshal([]Session{{Name: "w", Tool: toolCodex, Command: "bash"}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(tooled), `"tool":"codex"`) {
		t.Fatalf("marshaled session missing the tool key: %s", tooled)
	}
}

// set-option's -t takes a PANE, so a session option needs the trailing colon —
// `set-option -t "=name"` is rejected outright (measured on tmux 3.4). The '='
// matters more than usual now that retitling derives names: with `deploy` and
// `deploy-the-thing` both live, a bare target would resolve by prefix match and
// stamp the wrong session, exiting 0 while doing it.
func TestExactPaneTargetsOneSessionsWindow(t *testing.T) {
	if got := exactPane("work"); got != "=work:" {
		t.Errorf("exactPane(work) = %q, want %q", got, "=work:")
	}
	if got := exactSession("work"); got != "=work" {
		t.Errorf("exactSession(work) = %q, want %q", got, "=work")
	}
}
