package sessionio

import (
	"regexp"
	"strings"
)

// ProseMark goes in front of a prompt that starts with a slash but is not a
// command. Claude Code 2.1.290 refuses a prompt a mod submits when its first
// non-space character is a slash, since its queue would run it as a command,
// so a prompt opening with a pasted image's path went nowhere (2026-10-06).
// A zero-width space is not whitespace to JavaScript's trimStart, so the
// engine sees no slash and the model reads the same text. claude-mod's
// asProse marks the same way; this covers sessions still running an older mod.
const ProseMark = "​"

// pathFirst is a prompt whose first word holds a second slash, which no
// command name does (claude-mod/hooks/lib/command.ts), so it is a path.
var pathFirst = regexp.MustCompile(`^/[^\s/]*/`)

// MarkProse is the text to send for a prompt: marked when it starts with a
// path, as it was written otherwise. A slash command, or a name the session
// may have, is left for the mod to decide.
func MarkProse(text string) string {
	start := strings.TrimLeft(text, " \t\r\n")
	if !pathFirst.MatchString(start) {
		return text
	}
	return ProseMark + start
}

// Unmark is a prompt as it was written: the mark taken off a prompt read back
// from the transcript.
func Unmark(text string) string {
	if rest, ok := strings.CutPrefix(text, ProseMark); ok && strings.HasPrefix(rest, "/") {
		return rest
	}
	return text
}
