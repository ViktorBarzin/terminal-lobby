package sessionio

import "strings"

// A slash command the operator ran is not written into the transcript as the
// line they typed. It is written as markup:
//
//	<command-message>wrap-up</command-message>
//	<command-name>/wrap-up</command-name>
//
// or, for others, name-first and indented with an <command-args> element. The
// text view renders a user bubble as PLAIN TEXT — deliberately, since a prompt
// is not markdown — so left alone this reaches the chat as a pair of visible
// angle-bracket tags where the command should be.
//
// Not every command is written at all: measured 2026-08-18, /help, /context and
// /status leave the transcript untouched, while /wrap-up, /model, /compact and
// /login are recorded. So this handles the ones that ARE recorded; the surface
// that sent a command is the only thing that can account for the rest.
//
// commandLine returns the line the operator typed, and whether the text was
// command markup at all.
func commandLine(text string) (string, bool) {
	if !strings.HasPrefix(strings.TrimSpace(text), "<command-") {
		return "", false
	}
	name := strings.TrimSpace(element(text, "command-name"))
	if name == "" {
		return "", false
	}
	if !strings.HasPrefix(name, "/") {
		name = "/" + name
	}
	if args := strings.TrimSpace(element(text, "command-args")); args != "" {
		return name + " " + args, true
	}
	return name, true
}

// element returns the contents of the first <tag>…</tag> in text, or "".
func element(text, tag string) string {
	open, closing := "<"+tag+">", "</"+tag+">"
	i := strings.Index(text, open)
	if i < 0 {
		return ""
	}
	rest := text[i+len(open):]
	j := strings.Index(rest, closing)
	if j < 0 {
		return ""
	}
	return rest[:j]
}
