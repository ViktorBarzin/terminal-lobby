package sessionio

import (
	"encoding/json"
	"strconv"
	"strings"
	"unicode"
)

// OptionNotice holds the newest message Claude sent with its PushNotification
// tool, as "<unix second> <message>". Written by the claude-tmux-state hook
// script from the Notification hook, whose `message` field carries the text
// when `notification_type` is "push_notification". The message is stored still
// JSON-escaped, the way it sits in the hook payload, because the script has no
// JSON parser; ParseNotice decodes it.
//
// terminal-lobby's push sender reads it on every tick and sends a new stamp as
// a notification whose body is the message.
const OptionNotice = "@claude_notice"

// OptionReply holds the reply that ended the session's last turn, in the same
// "<unix second> <message>" shape as OptionNotice and read with the same
// ParseNotice. The hook script writes it from Stop's last_assistant_message
// and unsets it on a Stop that carries none. terminal-lobby's push sender uses
// it as the body of the "finished" push.
const OptionReply = "@claude_reply"

// Notice is a decoded OptionNotice.
type Notice struct {
	// At is the unix second the hook recorded the message. It is what tells one
	// message from the next, including a repeat of the same words.
	At int64
	// Text is the message as Claude wrote it, on one line.
	Text string
}

// ParseNotice decodes an OptionNotice value. ok is false for an unset option,
// and for anything that does not carry both a stamp and some text.
//
// The text is JSON-decoded, and a value that does not decode, which is what a
// cut through an escape at the script's byte cap leaves, keeps its raw text
// rather than being dropped: an odd backslash on the phone is better than no
// message. A reply is markdown, so the marks that only make sense rendered go
// (see flatten), and the lines join into one, since a notification shows one
// line.
func ParseNotice(v string) (Notice, bool) {
	stamp, raw, found := strings.Cut(v, " ")
	if !found {
		return Notice{}, false
	}
	at, err := strconv.ParseInt(stamp, 10, 64)
	if err != nil || at <= 0 {
		return Notice{}, false
	}
	raw = strings.ToValidUTF8(raw, "")
	text := raw
	var decoded string
	if json.Unmarshal([]byte(`"`+raw+`"`), &decoded) == nil {
		text = decoded
	}
	text = flatten(text)
	if text == "" {
		return Notice{}, false
	}
	return Notice{At: at, Text: text}, true
}

// markdownMarks are removed wherever they appear: emphasis and inline code.
// A single asterisk or underscore stays, since `2 * 3` and snake_case are
// text.
var markdownMarks = strings.NewReplacer("**", "", "__", "", "`", "")

// flatten turns markdown into one plain line. Per line: a fence or a table
// rule goes, a heading, quote or list marker at the start goes, table pipes
// become spaces. Then control characters become spaces and runs of space
// collapse.
func flatten(text string) string {
	lines := strings.Split(text, "\n")
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "```") || isTableRule(line) {
			continue
		}
		line = strings.TrimLeft(line, "#>")
		line = strings.TrimSpace(line)
		line = trimListMarker(line)
		line = strings.ReplaceAll(markdownMarks.Replace(line), "|", " ")
		out = append(out, line)
	}
	return strings.Join(strings.Fields(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, strings.Join(out, " "))), " ")
}

// isTableRule is a markdown table's separator row, or a horizontal rule.
func isTableRule(line string) bool {
	if !strings.Contains(line, "-") {
		return false
	}
	return strings.Trim(line, "|-: ") == ""
}

// trimListMarker drops a leading "- ", "* ", "+ " or "12. ".
func trimListMarker(line string) string {
	for _, m := range []string{"- ", "* ", "+ "} {
		if strings.HasPrefix(line, m) {
			return line[len(m):]
		}
	}
	i := 0
	for i < len(line) && line[i] >= '0' && line[i] <= '9' {
		i++
	}
	if i > 0 && strings.HasPrefix(line[i:], ". ") {
		return line[i+2:]
	}
	return line
}
