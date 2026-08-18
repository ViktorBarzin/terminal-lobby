package sessionio

import "strings"

// composerMarker is what the CLI draws at the start of its input line. Measured
// on 2.1.234: an idle composer is the marker and nothing else, between two
// horizontal rules; a draft follows the marker on the same line. There is no
// placeholder text to tell apart from a draft, which is what makes the check
// below a reliable one.
const composerMarker = "❯"

// PaneComposerEmpty reports whether the pane's input line is empty — nobody has
// a half-typed message waiting in it.
//
// It is the guard on refreshing the context reading. A refresh runs `/context`
// through Prompt, which clears the input line first (C-e C-u), so running one
// while a draft sits there would delete something the operator typed and never
// sent. That is a worse outcome than a stale meter, and it is not a trade a
// reader watching in the browser would know they were making.
//
// It fails CLOSED. Only a screen positively recognised as an idle composer
// returns true: no marker at all — a blocking dialog is up, the CLI restyled its
// input, the capture failed — answers false and the pane goes untouched. A
// future release that changes the marker turns the refresh off rather than
// turning it destructive.
func PaneComposerEmpty(pane string) bool {
	lines := strings.Split(pane, "\n")
	// The composer is the LAST input line on screen; earlier markers are prompts
	// already sent, sitting in the scrollback.
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if !strings.HasPrefix(line, composerMarker) {
			continue
		}
		return strings.TrimSpace(strings.TrimPrefix(line, composerMarker)) == ""
	}
	return false
}
