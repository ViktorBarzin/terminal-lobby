package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// /sessions rows gain the active pane's current command + title (Task 2.5,
// live-command chip). parseSessions decodes the two new trailing fields from
// the extended tmuxListFmt; pane_title is LAST because applications set it
// freely (OSC 2) and it may contain the field separator — the tail must soak
// embedded pipes rather than shift fields (or worse, hide the session).
func TestParseSessionsPaneCommandAndTitle(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []Session
	}{
		{
			name: "full row",
			in:   "work|1|1700000000|1690000000|running|4242|claude|~/code",
			want: []Session{{
				Name: "work", Attached: 1, LastActivity: 1700000000,
				Created: 1690000000, State: "running", PanePID: 4242,
				Command: "claude", Title: "~/code",
			}},
		},
		{
			name: "pipe in pane title survives verbatim",
			in:   "logs|0|1700000001|1690000001||77|zsh|make | tee build.log",
			want: []Session{{
				Name: "logs", LastActivity: 1700000001, Created: 1690000001,
				PanePID: 77, Command: "zsh", Title: "make | tee build.log",
			}},
		},
		{
			name: "empty command and title stay empty",
			in:   "bare|0|1|2|done|9||",
			want: []Session{{
				Name: "bare", LastActivity: 1, Created: 2,
				State: "done", PanePID: 9,
			}},
		},
		{
			name: "legacy 6-field row is skipped, not mis-parsed",
			in:   "old|1|1700000000|1690000000|running|4242",
			want: []Session{},
		},
		{
			name: "pipe in a session name (created outside the API) drops the row",
			// The name's pipe shifts a non-numeric segment into the attached
			// column — the strict integer guard skips the row instead of
			// serving a garbage session the UI can't act on.
			in:   "we|ird|1|1700000000|1690000000|running|4242|claude|t",
			want: []Session{},
		},
		{
			name: "mixed good and bad lines keep the good ones",
			in: "ok|0|10|20|awaiting|31|vim|edit\n" +
				"broken|line\n" +
				"also-ok|2|30|40||55|bash|",
			want: []Session{
				{Name: "ok", LastActivity: 10, Created: 20, State: "awaiting",
					PanePID: 31, Command: "vim", Title: "edit"},
				{Name: "also-ok", Attached: 2, LastActivity: 30, Created: 40,
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

// Wire shape: the new fields serialize as pane_current_command / pane_title
// (the keys the frontend chip + title logic read) and vanish when empty —
// stateless external pollers keep seeing the historic object shape.
func TestSessionsJSONShape(t *testing.T) {
	full, err := json.Marshal(parseSessions([]byte("work|1|10|20|running|42|claude|~/code\n")))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"pane_current_command":"claude"`, `"pane_title":"~/code"`} {
		if !strings.Contains(string(full), want) {
			t.Fatalf("marshaled sessions missing %s: %s", want, full)
		}
	}
	bare, err := json.Marshal(parseSessions([]byte("bare|0|1|2||9||\n")))
	if err != nil {
		t.Fatal(err)
	}
	for _, absent := range []string{"pane_current_command", "pane_title", "tool"} {
		if strings.Contains(string(bare), absent) {
			t.Fatalf("empty %s must be omitted from the wire: %s", absent, bare)
		}
	}
	// The tool mark travels under its own key — the frontends must never have
	// to guess it from pane_current_command (which reads "bash" for both
	// wrapper-launched agents).
	tooled, err := json.Marshal([]Session{{Name: "w", Tool: toolCodex, Command: "bash"}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(tooled), `"tool":"codex"`) {
		t.Fatalf("marshaled session missing the tool key: %s", tooled)
	}
}
