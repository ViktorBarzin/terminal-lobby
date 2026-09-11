package sessionio

import (
	"reflect"
	"strings"
	"testing"
)

// litMarkers names, in declaration order, the landmarks a reading turned on.
//
// The names come off the struct's own json tags rather than a list kept here,
// so the test speaks the vocabulary the wire carries, which is the vocabulary
// a Loki query will use on the day emitAnswer writes these. What makes a tenth
// marker impossible to declare without showing up in the tables below is
// everyMarker; this function on its own enumerates nothing.
func litMarkers(t *testing.T, m DialogMarkers) string {
	t.Helper()
	v := reflect.ValueOf(m)
	typ := v.Type()
	var on []string
	for i := 0; i < typ.NumField(); i++ {
		f := typ.Field(i)
		if v.Field(i).Kind() != reflect.Bool {
			t.Fatalf("DialogMarkers.%s is %s: a landmark is present or absent, nothing else", f.Name, v.Field(i).Kind())
		}
		name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
		if name == "" {
			t.Fatalf("DialogMarkers.%s has no json tag, so it has no name on the wire", f.Name)
		}
		if v.Field(i).Bool() {
			on = append(on, name)
		}
	}
	return strings.Join(on, " ")
}

type markerCase struct {
	name string
	// One of the two: a capture under testdata, or a pane written out here.
	fixture string
	pane    string
	// The markers this capture lights, in DialogMarkers field order. Every
	// marker not named here must be dark.
	lit string
}

// Every capture this package keeps, and the landmarks each one carries.
//
// The table is the tripwire the design asks for. Claude Code ships roughly
// daily and these captures do not, so a restyle that moves one of the strings
// the parser depends on changes a row here and nothing else fails first.
var markerCorpus = []markerCase{
	{
		name:    "multi-question, nothing answered",
		fixture: "dialog-multi.txt",
		lit:     "tabBar openBox footer numberedList freeText chatOption",
	},
	{
		// The tab bar has flipped one box to ☒ while the second question is on
		// screen, so both glyphs are up at once. Measured 2026-09-10: a
		// multi-select question flips its own box on the FIRST Space, before
		// the Enter that leaves it, which is why answered is not a position.
		name:    "multi-question, one answered",
		fixture: "dialog-multi-second.txt",
		lit:     "tabBar answeredBox openBox footer numberedList freeText chatOption",
	},
	{
		// reviewTitle is dark here and that is the capture, not a bug in the
		// reading: this file was taken off CLI 2.1.250, which draws only the
		// ready prompt. Live 2.1.267 draws "Review your answers" above it as
		// well (measured 2026-09-10). Two of dialog.go's landmarks therefore
		// disagree about the same screen depending on the build, which is the
		// exact shape of drift this fingerprint exists to report.
		//
		// The review screen also has no free-text and no chat row — its two
		// options are Submit answers and Cancel — so it fingerprints like an
		// operator menu with a tab bar bolted on.
		name:    "review screen, CLI 2.1.250",
		fixture: "dialog-multi-review.txt",
		lit:     "tabBar answeredBox readyPrompt footer numberedList",
	},
	{
		// Transcribed from the live 2.1.267 reading recorded in
		// docs/plans/2026-09-10-text-mode-answers-dialogs-design.md, not a
		// capture: nothing under testdata carries "Review your answers" yet,
		// and a marker no case ever lights is a marker nobody would notice was
		// broken.
		name: "review screen, CLI 2.1.267 wording",
		pane: strings.Join([]string{
			"←  ☒ Fruit  ☒ Drink  ✔ Submit  →",
			"",
			"Review your answers",
			"",
			"Ready to submit your answers?",
			"",
			"❯ 1. Submit answers",
			"  2. Cancel",
			"",
			"Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
		}, "\n"),
		lit: "tabBar answeredBox reviewTitle readyPrompt footer numberedList",
	},
	{
		// A single question has no tab bar; its one ☐ is the header line.
		name:    "single question",
		fixture: "dialog-single.txt",
		lit:     "openBox footer numberedList freeText chatOption",
	},
	{
		name:    "single question wrapped over four lines",
		fixture: "dialog-wrapped.txt",
		lit:     "openBox footer numberedList freeText chatOption",
	},
	{
		// A live 58x16 pane: the 60-character footer wraps, so "Esc to cancel"
		// sits on the line below and reFooter matches nothing on its own. The
		// marker is read through footerAt, which rejoins up to three wrapped
		// lines, so it lights here. A phone is the common case for this, and a
		// footer marker that went dark on every phone would report drift that
		// was only ever a narrow terminal.
		name:    "narrow pane, footer wrapped",
		fixture: "dialog-narrow-footer.txt",
		lit:     "tabBar openBox footer numberedList freeText chatOption",
	},
	{
		name:    "an ordinary working pane",
		fixture: "dialog-none.txt",
		lit:     "",
	},
	{
		name: "an empty pane",
		pane: "",
		lit:  "",
	},

	// Three panes where the conversation above the dialog quotes a landmark
	// the dialog itself is not drawing. The reading is scoped to the dialog's
	// own region for exactly this: a marker lit by scrollback reads as
	// "nothing missing", and a marker going dark is the whole signal, so a
	// false present hides the drift this fingerprint exists to report.
	{
		// The drift this module is for, on a pane that still carries the old
		// wording: a build that renames the two rows the CLI adds to every
		// question, in a session that has already answered one and whose
		// transcript shows those rows as they used to be.
		name: "renamed CLI rows, old labels still in the conversation",
		pane: strings.Join([]string{
			"● User answered Claude's questions:",
			"  ⎿  · Which font should the badge use? → Sans",
			"",
			"❯ The rows it drew were:",
			"  3. Type something.",
			"  4. Chat about this",
			"",
			"───────────────────────────────────────────────────────────",
			" ☐ Font",
			"",
			"Which font should the badge use?",
			"",
			"❯ 1. Sans",
			"  2. Serif",
			"  3. Write your own",
			"  4. Ask me in chat",
			"",
			"Enter to select · ↑/↓ to navigate · Esc to cancel",
		}, "\n"),
		lit: "openBox footer numberedList",
	},
	{
		// One row is not a list, and ParseDialog refuses a screen with fewer
		// than two, so this is a screen that reaches the fingerprint. The two
		// numbered lines above the header belong to the conversation.
		name: "one-row dialog under a numbered conversation",
		pane: strings.Join([]string{
			"● The two fonts were:",
			"  1. Sans",
			"  2. Serif",
			"",
			" ☐ Font",
			"",
			"Which font should the badge use?",
			"",
			"❯ 1. Only one row fits",
			"",
			"Enter to select · ↑/↓ to navigate · Esc to cancel",
		}, "\n"),
		lit: "openBox footer",
	},
	{
		// No dialog at all: a session whose transcript quotes both review
		// wordings, which is what reading this feature's own design doc in a
		// terminal looks like. No tab bar, no ☐ header, no footer, so
		// answerRegion cannot place a dialog and there is no screen here to
		// fingerprint.
		name: "no dialog, both review wordings quoted in the conversation",
		pane: strings.Join([]string{
			"● The review screen draws two lines:",
			"",
			"Review your answers",
			"Ready to submit your answers?",
			"",
			"❯ ",
		}, "\n"),
		lit: "",
	},
	{
		// The reading doing its job: a build that restyles the footer and
		// leaves everything else alone. The ☐ header still anchors the region
		// (answerRegion falls back to it when footerAt finds nothing), so the
		// rows and the box are read and the footer is the one thing reported
		// missing. That is the signal, and the reason the footer is read off
		// the same lines as everything else rather than off the capture, where
		// a footer further up would have hidden it.
		//
		// The pane is written out rather than captured because no build has
		// shipped this; it is the shape of the last footer change, which went
		// the other way — the footer wrapping at 58 columns is what sent
		// ParseDialog home empty on 2026-09-04.
		name: "footer restyled, the rest of the dialog intact",
		pane: strings.Join([]string{
			" ☐ Font",
			"",
			"Which font should the badge use?",
			"",
			"❯ 1. Sans",
			"  2. Serif",
			"  3. Type something.",
			"  4. Chat about this",
			"",
			"↵ choose · ⎋ back out",
		}, "\n"),
		lit: "openBox numberedList freeText chatOption",
	},
	{
		// Both edges gone in one release, which is the case markerScope's own
		// fallback exists for: no footer the parser knows AND no ☐ header, so
		// answerRegion has nothing to anchor on and returns nothing. dialogTop
		// finds the option list instead and the reading comes back "the rows
		// are intact, the frame moved" rather than a blank that says only
		// "we recognised nothing".
		//
		// The operator menus below take the same branch, and to this reading
		// they look the same as this does. That is as far as a fingerprint can
		// go on its own; tl.reason is what separates them at the emit site.
		name: "footer and header both restyled, rows intact",
		pane: strings.Join([]string{
			"▸ Font",
			"",
			"Which font should the badge use?",
			"",
			"❯ 1. Sans",
			"  2. Serif",
			"  3. Type something.",
			"  4. Chat about this",
			"",
			"↵ choose · ⎋ back out",
		}, "\n"),
		lit: "numberedList freeText chatOption",
	},

	// The operator menus. /model, /effort and the resume picker draw with the
	// same select widget as a question, and not one of them carries a landmark
	// that identifies a dialog: no free-text row and no chat row — the absence
	// ParseDialog refuses them for (dialog.go: "a menu, not a question") — no
	// ☐ header, and a footer in their own words where they have one at all
	// ("Enter to set as default · s to use this session only · Esc to cancel"
	// on the model picker, nothing on the codex pickers or the confirmations).
	//
	// So none of them has a region, and the six that light numberedList do it
	// through markerScope's fallback, which reads the block of numbered rows at
	// the bottom of the capture. A menu and a dialog whose footer the CLI has
	// just renamed are the same shape to this reading. Telling those two apart
	// is tl.reason's job at the emit site, not this one's.
	{
		name:    "claude model picker",
		fixture: "picker-claude-model.txt",
		lit:     "numberedList",
	},
	{
		name:    "claude model picker, slugs",
		fixture: "picker-claude-model-slugs.txt",
		lit:     "numberedList",
	},
	{
		// One row fits on this narrow capture, and one row is not a list. The
		// floor of two is ParseDialog's own (len(opts) < 2 → nil).
		name:    "claude model picker, narrow",
		fixture: "picker-claude-model-narrow.txt",
		lit:     "",
	},
	{
		// No numbered rows at all: this picker draws its levels as prose.
		name:    "claude effort picker",
		fixture: "picker-claude-effort.txt",
		lit:     "",
	},
	{
		name:    "codex model picker",
		fixture: "picker-codex-model.txt",
		lit:     "numberedList",
	},
	{
		name:    "codex effort picker",
		fixture: "picker-codex-effort.txt",
		lit:     "numberedList",
	},
	{
		// One numbered row on this capture, so it is under the floor as well.
		name:    "codex advanced menu",
		fixture: "picker-codex-advanced.txt",
		lit:     "",
	},
	{
		name:    "claude effort confirmation",
		fixture: "confirm-claude-effort.txt",
		lit:     "numberedList",
	},
	{
		name:    "claude model switch confirmation",
		fixture: "confirm-claude-switch.txt",
		lit:     "numberedList",
	},
	{
		name:    "claude sitting idle",
		fixture: "status-claude-idle.txt",
		lit:     "",
	},
	{
		name:    "codex sitting idle",
		fixture: "status-codex-idle.txt",
		lit:     "",
	},
}

func (tc markerCase) capture(t *testing.T) string {
	t.Helper()
	if tc.fixture != "" {
		return fixture(t, tc.fixture)
	}
	return tc.pane
}

func TestDialogMarkersFingerprintEveryCapture(t *testing.T) {
	for _, tc := range markerCorpus {
		t.Run(tc.name, func(t *testing.T) {
			got := litMarkers(t, ParseDialogMarkers(tc.capture(t)))
			if got != tc.lit {
				t.Errorf("lit  = %q\nwant = %q", got, tc.lit)
			}
		})
	}
}

// everyMarker is a reading with every declared landmark on, built by walking
// the struct rather than by naming the fields.
//
// The hand-written literal this replaces listed the nine markers somebody
// remembered to type, so a tenth field wired to nothing stayed dark in every
// capture, never appeared in the list below, and the guard passed — the exact
// failure the guard says it prevents. Measured 2026-09-11 in a scratch copy of
// the package: adding a `Spinner bool` to DialogMarkers and setting it nowhere
// left `go test -run TestEveryDeclaredMarker` green with the literal and fails
// it with this.
func everyMarker(t *testing.T) DialogMarkers {
	t.Helper()
	var m DialogMarkers
	v := reflect.ValueOf(&m).Elem()
	for i := 0; i < v.NumField(); i++ {
		if v.Field(i).Kind() != reflect.Bool {
			t.Fatalf("DialogMarkers.%s is %s: a landmark is present or absent, nothing else",
				v.Type().Field(i).Name, v.Field(i).Kind())
		}
		v.Field(i).SetBool(true)
	}
	return m
}

// A marker no capture ever lights is a marker that could be wired to nothing
// and stay green forever — which is precisely the failure the fingerprint is
// meant to catch, so it must not be possible in the fingerprint itself.
func TestEveryDeclaredMarkerIsLitBySomething(t *testing.T) {
	seen := map[string]bool{}
	for _, tc := range markerCorpus {
		for _, name := range strings.Fields(litMarkers(t, ParseDialogMarkers(tc.capture(t)))) {
			seen[name] = true
		}
	}
	all := strings.Fields(litMarkers(t, everyMarker(t)))
	// The count is the guard on the guard: litMarkers skips a field it cannot
	// name, and a list shorter than the struct would quietly stop checking the
	// markers it dropped.
	if n := reflect.TypeOf(DialogMarkers{}).NumField(); len(all) != n {
		t.Fatalf("the all-on reading names %d markers and DialogMarkers declares %d: %v", len(all), n, all)
	}
	for _, name := range all {
		if !seen[name] {
			t.Errorf("no capture in the corpus lights %q, so nothing would notice it breaking", name)
		}
	}
}

// A review screen the CLI has retitled must fail the parser and darken the
// marker on the same capture.
//
// That pairing is what the comment above reviewTitle promises, and a substring
// test broke it: "Review your answers before you submit" contains the constant,
// so the one capture that proves the wording moved reported it intact. One of
// the two wordings on its own is a shape the CLI has really shipped — 2.1.250
// drew the ready prompt with no title above it (dialog-multi-review.txt) — so a
// retitle that keeps only the other line is not a hypothetical.
//
// The other half of the pair is the "review screen, CLI 2.1.267 wording" row in
// the corpus: the exact strings still light both markers.
func TestARetitledReviewScreenDarkensItsMarker(t *testing.T) {
	pane := strings.Join([]string{
		"←  ☒ Fruit  ☒ Drink  ✔ Submit  →",
		"",
		"Review your answers before you submit",
		"",
		"❯ 1. Submit answers",
		"  2. Cancel",
		"",
		"Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
	}, "\n")
	if d := ParseDialog(pane); d != nil {
		t.Fatalf("the parser read the retitled screen as %+v, so this capture no longer tests the pair", d)
	}
	if got, want := litMarkers(t, ParseDialogMarkers(pane)), "tabBar answeredBox footer numberedList"; got != want {
		t.Errorf("lit  = %q\nwant = %q", got, want)
	}
}

// The wire accepts "Other" as well as "Type something", because a client on an
// older build still sends it (answer-api.ts: LEGACY_FREE_TEXT_LABEL). The
// marker must not, or the day the CLI renames the row back the fingerprint
// would keep reporting it present and the drift would go unseen — which is how
// "Other" survived in the frontend until 2026-09-10 in the first place.
func TestFreeTextMarkerFollowsTheCLINotTheLegacyLabel(t *testing.T) {
	menu := func(third string) string {
		return strings.Join([]string{
			" ☐ Font",
			"",
			"Which font should the badge use?",
			"",
			"❯ 1. Sans",
			"  2. Serif",
			"  3. " + third,
			"  4. Chat about this",
			"",
			"Enter to select · ↑/↓ to navigate · Esc to cancel",
		}, "\n")
	}
	if m := ParseDialogMarkers(menu("Type something.")); !m.FreeText {
		t.Error("the CLI's own label did not light freeText")
	}
	if m := ParseDialogMarkers(menu("Other")); m.FreeText {
		t.Error("the retired label lit freeText, so a rename back would look like no change at all")
	}
}
