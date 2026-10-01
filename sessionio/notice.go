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
// message. Control characters become spaces and runs of space collapse, since
// a notification shows one line.
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
	text = strings.Join(strings.Fields(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, text)), " ")
	if text == "" {
		return Notice{}, false
	}
	return Notice{At: at, Text: text}, true
}
