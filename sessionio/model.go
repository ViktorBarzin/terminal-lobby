package sessionio

import (
	"regexp"
	"strconv"
	"strings"
)

// Reading and setting which model a session runs on, and how hard it thinks.
//
// WHY A PANE DRIVER AND NOT A FLAG. Neither is a launch flag here. The attach
// contract carries a COMMAND KEY, not a command line (devvm/tmux-user-attach),
// and the pre-warm pool warms the bare `claude` key — a per-model key would
// miss the pool and give up the head start on every model but the default. So
// the choice is applied to a session that is already running, through the one
// channel a running TUI has: its own picker.
//
// WHY NOT A TYPED LINE. `/model opus` and `/effort high` do work as lines in
// Claude Code 2.1.261, and they are one round trip rather than six. They also
// save the choice as the ACCOUNT DEFAULT — the CLI answers "saved as your
// default for new sessions" — so a model picked for one thread would follow
// every session started afterwards. The picker has a key for the other
// meaning, `s` for this session only, and that is the one this drives. Codex
// settles the question by itself: `/model gpt-5.6-sol` is not a command there
// at all, it is a message, and codex-cli 0.144.3 sends it to the model.
//
// Everything below was measured against Claude Code 2.1.261 and codex-cli
// 0.144.3 on 2026-09-05, and the fixtures under testdata/picker-*.txt are
// `capture-pane -p` of the real dialogs.

// Harness is which CLI a session runs. Only the two that have a model to pick
// appear here; a plain shell has none, and callers are expected not to ask.
type Harness string

const (
	HarnessClaude Harness = "claude"
	HarnessCodex  Harness = "codex"
)

// ModelState is what a session is on: the model, and the effort level it
// reasons at. An empty field means the session did not say, which is a
// different answer from a level called "default".
type ModelState struct {
	Model  string `json:"model,omitempty"`
	Effort string `json:"effort,omitempty"`
}

// PickerOption is one numbered row of a select widget, as it appears on the
// pane. Index is the number the widget draws; Label is the option's own name
// with the widget's marks stripped.
type PickerOption struct {
	Index  int
	Label  string
	Cursor bool
}

var (
	// A numbered row: an optional cursor glyph, the number, then the label and
	// its description in two space-separated columns. Claude points with ❯ and
	// codex with ›; the ASCII > is carried because dialog.go already does.
	rePickerRow = regexp.MustCompile(`^\s*([❯›>]?)\s*(\d+)\.\s+(\S.*)$`)
	// The gap between an option's name and its description. Both CLIs pad the
	// name column, so the run of spaces is always there; a name never contains
	// one.
	reLabelGap = regexp.MustCompile(`\s{2,}`)
	// The suffixes a picker hangs off a label to say which row is which:
	// "(default)", "(current)", "(recommended)", and Claude's ✔ on the model
	// in force. None of them is part of the name a caller asks for.
	reLabelNote = regexp.MustCompile(`\s*\((?:default|current|recommended)\)`)
	// Claude draws the live effort level as a hint above its input line. This
	// is the ONE thing a stock Claude pane says about either setting — the
	// model comes off the transcript instead, since the line under the input
	// belongs to whatever statusLine command the account configured.
	reClaudeEffort = regexp.MustCompile(`◈\s*(\w+)\s*·\s*/effort`)
	// Codex's footer: the model, the reasoning level, then the directory.
	reCodexFooter = regexp.MustCompile(`(?m)^\s{0,4}([A-Za-z][\w.\-]*)\s+([a-z][a-z ]*[a-z]|[a-z])\s+·\s+\S`)
	// The footer every select widget draws. Used to decide whether a picker is
	// on screen at all, never to read anything out of it.
	rePickerFooter = regexp.MustCompile(`(?i)(Enter to set as default|Enter to confirm|Press enter to confirm|←/→ to adjust)`)
)

// ClaudeEfforts is the effort ladder Claude Code offers, in slider order.
// Written down rather than discovered because the slider is a row of words with
// no structure to read: knowing the set is what tells a line of words from a
// line of prose. A build that adds a step stops matching, and the driver says
// so rather than pressing → a guessed number of times.
var ClaudeEfforts = []string{"low", "medium", "high", "xhigh", "max", "ultracode"}

// CodexEfforts is codex's ladder, by the id a caller uses. The last two sit
// behind an extra screen (see CodexEffortIsAdvanced).
var CodexEfforts = []string{"low", "medium", "high", "xhigh", "max", "ultra"}

// codexEffortRows maps those ids to the row codex actually draws. "Extra high"
// is the only one that is not simply the id in title case, and "ultracode" is
// deliberately absent: it is Claude's top step, not one codex has.
var codexEffortRows = map[string]string{
	"low":    "Low",
	"medium": "Medium",
	"high":   "High",
	"xhigh":  "Extra high",
	"max":    "Max",
	"ultra":  "Ultra",
}

// PickerOptions reads the numbered rows of the select widget on the pane, or
// nothing when the pane is not showing one.
//
// The numbers must run consecutively, because they are what a caller would act
// on: prose that happens to contain "1." and "4." is not a picker, and treating
// it as one would send a keystroke into somebody's conversation. A list taller
// than the pane shows a WINDOW of itself, so the run is not required to start
// at 1 — which is also why the driver walks with arrows rather than reading an
// index and pressing it.
func PickerOptions(pane string) []PickerOption {
	if !rePickerFooter.MatchString(pane) {
		return nil
	}
	var out []PickerOption
	for _, line := range strings.Split(pane, "\n") {
		m := rePickerRow.FindStringSubmatch(stripDialogBorder(line))
		if m == nil {
			continue
		}
		n, err := strconv.Atoi(m[2])
		if err != nil {
			continue
		}
		label := optionLabel(m[3])
		if label == "" {
			continue
		}
		if len(out) > 0 && n != out[len(out)-1].Index+1 {
			// A break in the run means the rows are not one list. Keep the
			// longer of the two rather than splicing them together.
			if len(out) > 1 {
				break
			}
			out = out[:0]
		}
		out = append(out, PickerOption{Index: n, Label: label, Cursor: m[1] != ""})
	}
	if len(out) < 2 {
		return nil
	}
	return out
}

// optionLabel takes an option's own name off a row: the first column, without
// the picker's marks.
func optionLabel(rest string) string {
	label := rest
	if cut := reLabelGap.FindStringIndex(label); cut != nil {
		label = label[:cut[0]]
	}
	label = reLabelNote.ReplaceAllString(label, "")
	label = strings.TrimRight(label, " ✔✓•")
	return strings.TrimSpace(label)
}

// FindOption picks the row a caller asked for, matching on the label alone and
// ignoring case. Not found is an answer, not an error: it means this account is
// not offered that model, and the caller must say so rather than pick another.
func FindOption(opts []PickerOption, label string) (PickerOption, bool) {
	for _, o := range opts {
		if strings.EqualFold(o.Label, label) {
			return o, true
		}
	}
	return PickerOption{}, false
}

// CursorOption is the row the picker's cursor is on.
func CursorOption(opts []PickerOption) (PickerOption, bool) {
	for _, o := range opts {
		if o.Cursor {
			return o, true
		}
	}
	return PickerOption{}, false
}

// EffortLadder reads Claude's effort slider off the pane: the levels in the
// order → walks them. False when the pane is not showing the slider, which
// includes a build whose ladder is not the one written down above.
func EffortLadder(pane string) ([]string, bool) {
	if !strings.Contains(pane, "←/→ to adjust") {
		return nil, false
	}
	known := make(map[string]bool, len(ClaudeEfforts))
	for _, e := range ClaudeEfforts {
		known[e] = true
	}
	for _, line := range strings.Split(pane, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		all := true
		for _, f := range fields {
			if !known[f] {
				all = false
				break
			}
		}
		if all {
			return fields, true
		}
	}
	return nil, false
}

// ClaudeEffortHint reads the effort level off a Claude pane, "" when it says
// nothing about one.
func ClaudeEffortHint(pane string) string {
	m := reClaudeEffort.FindStringSubmatch(pane)
	if m == nil {
		return ""
	}
	return strings.ToLower(m[1])
}

// CodexState reads the model and reasoning level off a codex pane.
//
// Codex fetches its model list AFTER the TUI is up — the box reads "loading"
// and the footer says "default" where the level goes — so a level that is not
// on the ladder is reported as no level at all rather than as a level called
// "default".
func CodexState(pane string) ModelState {
	known := make(map[string]bool, len(CodexEfforts))
	for _, e := range CodexEfforts {
		known[e] = true
	}
	var st ModelState
	// Last match wins: the pane holds scrollback, and the footer is the most
	// recent line in it.
	for _, m := range reCodexFooter.FindAllStringSubmatch(pane, -1) {
		model, level := m[1], strings.ToLower(m[2])
		if model == "loading" {
			continue
		}
		st = ModelState{Model: model}
		if known[level] {
			st.Effort = level
		}
	}
	return st
}

// CodexEffortLabel names the row to pick for one of codex's levels.
func CodexEffortLabel(id string) (string, bool) {
	row, ok := codexEffortRows[strings.ToLower(id)]
	return row, ok
}

// CodexEffortIsAdvanced says whether a level sits behind codex's "More
// reasoning…" screen rather than on its first one.
func CodexEffortIsAdvanced(id string) bool {
	switch strings.ToLower(id) {
	case "max", "ultra":
		return true
	}
	return false
}

// effortSteps says how many → presses reach the wanted level once the slider
// has been pinned at its first step. Not found means this build's ladder does
// not have that level, which is the caller's problem to report.
func effortSteps(ladder []string, want string) (int, bool) {
	for i, step := range ladder {
		if strings.EqualFold(step, want) {
			return i, true
		}
	}
	return 0, false
}
