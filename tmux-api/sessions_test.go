package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// row joins fields with the format separator, so fixtures stay readable even
// though the real separator is an invisible control character.
// row builds one list-sessions line from the fields in their historic order,
// inserting an EMPTY outstanding-work column where the format now carries it.
// Written this way so the twenty-odd existing rows keep saying what they were
// written to say; rowBG is the same line with that column filled in.
func row(fields ...string) string { return rowBG("", fields...) }

func rowBG(bg string, fields ...string) string { return rowBorn(bg, "", fields...) }

// rowBorn is the same line with the birth-name column filled in as well
// (sessionio.OptionBornAs — the name a renamed session was created with), and
// an EMPTY @tl_created stamp, which is what every session that predates the
// stamp reports.
func rowBorn(bg, born string, fields ...string) string {
	return rowCreated(bg, born, "", fields...)
}

// rowCreated is the same line with the @tl_created stamp filled in too — when
// the session became somebody's, stamped by tmux-user-attach at the moment a
// create claims a pre-warmed slot. It sits at createdColumn, immediately before
// pane_title, so it is spliced in the way the birth name is rather than
// appended.
func rowCreated(bg, born, created string, fields ...string) string {
	return rowOrigin(bg, born, created, "", fields...)
}

// rowOrigin is the same line with @tl_origin filled in too — who made the
// session. It sits at originColumn, the last column before pane_title, so it is
// spliced rather than appended for the reason rowCreated gives. Empty is what
// every session that predates the stamp reports, and what the parser has to
// keep listing.
func rowOrigin(bg, born, created, origin string, fields ...string) string {
	return rowGrid(bg, born, created, origin, "", "", fields...)
}

// rowGrid is the same line with the session's GRID filled in too — the tmux
// window's #{window_width} and #{window_height}, which a watching tile renders
// at. The two columns sit together at gridColsColumn, after @tl_origin and
// before pane_title, so they are spliced the way every column before them is
// rather than appended. EMPTY is what a tmux that answers neither reports, and
// what every fixture written before the columns existed keeps saying.
func rowGrid(bg, born, created, origin, cols, rows string, fields ...string) string {
	if len(fields) < bgColumn {
		return strings.Join(fields, listSep)
	}
	out := make([]string, 0, len(fields)+2)
	out = append(out, fields[:bgColumn]...)
	out = append(out, bg)
	out = append(out, fields[bgColumn:]...)
	if len(out) < bornColumn {
		return strings.Join(out, listSep)
	}
	withBorn := make([]string, 0, len(out)+2)
	withBorn = append(withBorn, out[:bornColumn]...)
	withBorn = append(withBorn, born)
	withBorn = append(withBorn, out[bornColumn:]...)
	if len(withBorn) < createdColumn {
		return strings.Join(withBorn, listSep)
	}
	withCreated := make([]string, 0, len(withBorn)+1)
	withCreated = append(withCreated, withBorn[:createdColumn]...)
	withCreated = append(withCreated, created)
	withCreated = append(withCreated, withBorn[createdColumn:]...)
	if len(withCreated) < originColumn {
		return strings.Join(withCreated, listSep)
	}
	withOrigin := make([]string, 0, len(withCreated)+1)
	withOrigin = append(withOrigin, withCreated[:originColumn]...)
	withOrigin = append(withOrigin, origin)
	withOrigin = append(withOrigin, withCreated[originColumn:]...)
	if len(withOrigin) < gridColsColumn {
		return strings.Join(withOrigin, listSep)
	}
	withGrid := make([]string, 0, len(withOrigin)+2)
	withGrid = append(withGrid, withOrigin[:gridColsColumn]...)
	withGrid = append(withGrid, cols, rows)
	withGrid = append(withGrid, withOrigin[gridColsColumn:]...)
	return strings.Join(withGrid, listSep)
}

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

// @tl_origin rides the list format for the same reason @title and @last_drive
// do: the option is already on the session, so reading it costs no extra fork.
// The empty case is not an edge — on the deploy that introduces the option
// EVERY live session reports empty, and a parser that rejected the row for it
// would empty the sidebar.
func TestParseSessionsReadsOrigin(t *testing.T) {
	cases := []struct {
		name   string
		origin string
		want   string
	}{
		{
			name:   "stamped by the lobby's create path",
			origin: originUser, want: originUser,
		},
		{
			name:   "stamped by a harness",
			origin: originTest, want: originTest,
		},
		{
			// An unset tmux option renders as an empty string, exactly as
			// @last_drive does. The row still lists; isSystemSession is what
			// decides what an absent stamp means.
			name:   "an unset option still parses the row",
			origin: "", want: "",
		},
		{
			// Nothing in this repo writes anything else, but the parser is not
			// the place to police it: it carries the value through and lets
			// isSystemSession judge it.
			name:   "a value nothing writes is carried through, not dropped",
			origin: "somebody-elses-harness", want: "somebody-elses-harness",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := parseSessions([]byte(rowOrigin("", "", "", tc.origin,
				"$3", "work", "0", "1700000000", "1690000000", "", "running",
				"4242", "claude", "Deploy the thing", "~/code") + "\n"))
			want := []Session{{
				ID: "$3", Name: "work", LastActivity: 1700000000, Created: 1690000000,
				State: "running", PanePID: 4242, Command: "claude",
				Title: "Deploy the thing", PaneTitle: "~/code", Origin: tc.want,
			}}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("parseSessions with origin %q:\n got %+v\nwant %+v", tc.origin, got, want)
			}
		})
	}
}

// pane_title is the field that soaks up a stray separator, because SplitN hands
// the last field whatever separators are left over. That is the whole reason
// @tl_origin sits BEFORE it rather than at the end of the format: an origin
// parsed out of the tail would be whatever an application last wrote via OSC 2,
// and a session could talk itself out of System.
func TestOriginSurvivesATabInThePaneTitle(t *testing.T) {
	got := parseSessions([]byte(rowOrigin("", "", "", originUser,
		"$3", "work", "0", "1", "2", "", "", "9", "claude", "",
		"make\tinstall") + "\n"))
	want := []Session{{
		ID: "$3", Name: "work", LastActivity: 1, Created: 2, PanePID: 9,
		Command: "claude", Origin: originUser, PaneTitle: "make\tinstall",
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseSessions:\n got %+v\nwant %+v", got, want)
	}
}

// Created is when the session became SOMEBODY'S, which is what the sidebar
// sorts a newest-first list on. A create that claims a pre-warmed slot does it
// with `tmux rename-session`, and a rename leaves #{session_created} reading
// the slot's own age — 4h33m stale when the standing slot for /home/wizard/code
// was measured on 2026-09-04, days stale once it has stood a while. So the
// @tl_created stamp the claim writes wins over session_created whenever it
// parses, and session_created is what is left when it does not.
func TestParseSessionsPrefersTheClaimStampOverSessionCreated(t *testing.T) {
	cases := []struct {
		name    string
		stamp   string
		want    int64
		wantWhy string
	}{
		{
			name: "the stamp wins when it is set",
			// A slot created at 1690000000 and claimed 8 days later.
			stamp: "1690700000", want: 1690700000,
			wantWhy: "a claimed session must date from the claim, not from the slot",
		},
		{
			name:  "an empty stamp falls back — every session predating it",
			stamp: "", want: 1690000000,
			wantWhy: "an unstamped session must keep session_created, not lose its date",
		},
		{
			name:  "a non-numeric stamp falls back",
			stamp: "not-a-number", want: 1690000000,
			wantWhy: "garbage in the column must not be read as a date",
		},
		{
			name:  "zero falls back",
			stamp: "0", want: 1690000000,
			wantWhy: "the epoch is not a creation time any session has",
		},
		{
			name:  "a negative stamp falls back",
			stamp: "-5", want: 1690000000,
			wantWhy: "a negative date would sort a session to the very bottom",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := rowCreated("", "", tc.stamp,
				"$3", "work", "1", "1700000000", "1690000000", "", "running", "4242", "claude", "", "")
			got := parseSessions([]byte(in + "\n"))
			if len(got) != 1 {
				t.Fatalf("parseSessions dropped the row: %+v", got)
			}
			if got[0].Created != tc.want {
				t.Errorf("Created = %d, want %d — %s", got[0].Created, tc.want, tc.wantWhy)
			}
		})
	}
}

// The stamp is written by the shell and read here, so the name the format asks
// tmux for has to be the name tmux-user-attach set. TestCreatedStampMatchesShell
// guards the other half of that pair.
func TestListFormatCarriesTheClaimStamp(t *testing.T) {
	if !strings.Contains(tmuxListFmt, "#{"+createdStampOption+"}") {
		t.Errorf("tmuxListFmt does not ask for %s: %q", createdStampOption, tmuxListFmt)
	}
	// It has to stay AHEAD of pane_title, which is the only field allowed to
	// hold a tab and therefore has to be the one a stray tab is soaked into. A
	// stamp behind it would be the field that absorbed the overflow instead,
	// and an unparseable stamp sends a freshly claimed session to the bottom of
	// a newest-first list, which is what the stamp exists to prevent.
	if strings.Index(tmuxListFmt, createdStampOption) > strings.Index(tmuxListFmt, "pane_title") {
		t.Errorf("%s moved behind pane_title, where a tab in a pane title would eat it: %q",
			createdStampOption, tmuxListFmt)
	}
}

// @tl_origin has the same shape of contract as @tl_created: written by a shell
// script and by two harnesses, read only here, so the name the format asks tmux
// for has to be the name they set.
func TestListFormatCarriesTheOriginStamp(t *testing.T) {
	if !strings.Contains(tmuxListFmt, "#{"+originOption+"}") {
		t.Errorf("tmuxListFmt does not ask for %s: %q", originOption, tmuxListFmt)
	}
	// Behind pane_title it would be the field soaking up a stray tab, and an
	// origin read out of application-written text is worse than no origin at
	// all: a pane that prints a tab and the word `user` would walk its own
	// session out of the System group, back into the push path.
	if strings.Index(tmuxListFmt, originOption) > strings.Index(tmuxListFmt, "pane_title") {
		t.Errorf("%s moved behind pane_title, where a tab in a pane title would eat it: %q",
			originOption, tmuxListFmt)
	}
}

// THE SESSION'S GRID, which only a WATCHING tile has no other way to learn:
// it declines to claim the grid, so its own terminal's size says nothing about
// the window it is showing, and rendering at that size leaves tmux drawing the
// smaller window into a corner with its own dots around it. The design has the
// watcher render at the size the drivers gave it, centred, and these two
// columns are where that size arrives.
func TestParseSessionsReadsTheGrid(t *testing.T) {
	cases := []struct {
		name, cols, rows string
		wantCols         int
		wantRows         int
	}{
		{"a pinned window", "50", "14", 50, 14},
		{"a driven window", "231", "62", 231, 62},
		// Every fixture written before the columns existed, and any tmux that
		// stops answering them. No opinion beats a wrong opinion here: zero
		// leaves the watcher rendering the way it always did rather than
		// sizing a terminal to nothing.
		{"a tmux that answered neither", "", "", 0, 0},
		{"a size that does not parse", "wide", "tall", 0, 0},
		// Both halves have to be real, since the pair is what a size is.
		{"only the width", "80", "", 0, 0},
		{"a zero width", "0", "24", 0, 0},
		{"a negative height", "80", "-1", 0, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := parseSessions([]byte(rowGrid("", "", "", "", tc.cols, tc.rows,
				"$1", "watched", "1", "10", "20", "", "running", "42", "claude", "", "") + "\n"))
			if len(got) != 1 {
				t.Fatalf("parseSessions gave %d rows, want 1 — an unreadable grid must not drop the session", len(got))
			}
			if got[0].Cols != tc.wantCols || got[0].Rows != tc.wantRows {
				t.Errorf("grid = %dx%d, want %dx%d", got[0].Cols, got[0].Rows, tc.wantCols, tc.wantRows)
			}
		})
	}
}

// A grid nobody could read travels as an absent key rather than as 0x0, so a
// consumer that predates the fields sees the wire shape it always did and one
// that reads them cannot mistake "unknown" for a one-by-one terminal.
func TestGridJSONShape(t *testing.T) {
	sized, err := json.Marshal(parseSessions([]byte(rowGrid("", "", "", "", "50", "14",
		"$3", "watched", "1", "10", "20", "", "running", "42", "claude", "", "") + "\n")))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(sized), `"cols":50`) || !strings.Contains(string(sized), `"rows":14`) {
		t.Fatalf("marshaled session missing its grid: %s", sized)
	}
	unknown, err := json.Marshal(parseSessions([]byte(
		row("$4", "calm", "0", "1", "2", "", "done", "9", "claude", "", "") + "\n")))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(unknown), `"cols"`) || strings.Contains(string(unknown), `"rows"`) {
		t.Fatalf("a session with no readable grid must omit both: %s", unknown)
	}
}

// The grid rides the list poll rather than a second tmux call, and like every
// other column it has to stay ahead of pane_title — the one field allowed to
// contain a separator, and therefore the one that soaks up a stray tab. A width
// read out of application-written text would size a watcher's terminal from
// whatever the pane last printed.
func TestListFormatCarriesTheGrid(t *testing.T) {
	for _, want := range []string{"#{window_width}", "#{window_height}"} {
		if !strings.Contains(tmuxListFmt, want) {
			t.Errorf("tmuxListFmt does not ask for %s: %q", want, tmuxListFmt)
		}
		if strings.Index(tmuxListFmt, want) > strings.Index(tmuxListFmt, "pane_title") {
			t.Errorf("%s moved behind pane_title, where a tab in a pane title would eat it: %q",
				want, tmuxListFmt)
		}
	}
}

// Outstanding background work holds a session at "running" past the Stop that
// used to finish it, and the sidebar says WHICH kind so a reader can tell a
// 30-second command from a 30-minute workflow. The kinds come from the hook's
// `<kind>:<id>` tokens: a=agent, b=background command, w=workflow
// (docs/plans/2026-09-04-background-work-session-state-design.md).
func TestParseSessionsCountsOutstandingWorkByKind(t *testing.T) {
	cases := []struct {
		name, bg string
		want     *Background
	}{
		{"nothing outstanding", "", nil},
		{"one agent", "a:a1cbb47bebad51b9b", &Background{Agents: 1}},
		{"two agents and a command", "a:a1 a:a2 b:bmm8ohp9u", &Background{Agents: 2, Commands: 1}},
		{"a workflow", "w:wy71p4jz3", &Background{Workflows: 1}},
		{"a teammate counts as an agent", "t:probe2", &Background{Agents: 1}},
		{"a teammate and a subagent", "a:a1 t:probe2", &Background{Agents: 2}},
		{"one of each", "a:a1 b:b1 w:w1", &Background{Agents: 1, Commands: 1, Workflows: 1}},
		// The hook validates ids before it writes them, so a token in a shape
		// this parser does not know came from somewhere else. Counting it as
		// nothing keeps a corrupted option from holding a session at running
		// with no way back.
		{"an unrecognised token counts as nothing", "z:x nonsense", nil},
		{"a known kind survives an unknown neighbour", "a:a1 z:x", &Background{Agents: 1}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := parseSessions([]byte(rowBG(tc.bg,
				"$1", "work", "0", "10", "20", "", "running", "42", "claude", "", "") + "\n"))
			if len(got) != 1 {
				t.Fatalf("parseSessions gave %d rows, want 1", len(got))
			}
			if !reflect.DeepEqual(got[0].Background, tc.want) {
				t.Fatalf("Background for %q = %+v, want %+v", tc.bg, got[0].Background, tc.want)
			}
		})
	}
}

// The count rides the wire only when there is something to say, so a session
// that backgrounded nothing serves the object it always did.
func TestBackgroundCountJSONShape(t *testing.T) {
	busy, err := json.Marshal(parseSessions([]byte(rowBG("a:a1 w:w1",
		"$3", "work", "1", "10", "20", "", "running", "42", "claude", "", "") + "\n")))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(busy), `"bg":{"agents":1,"workflows":1}`) {
		t.Fatalf("marshaled session missing the background count: %s", busy)
	}
	idle, err := json.Marshal(parseSessions([]byte(
		row("$4", "calm", "0", "1", "2", "", "done", "9", "claude", "", "") + "\n")))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(idle), `"bg"`) {
		t.Fatalf("a session with nothing outstanding must omit bg: %s", idle)
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
