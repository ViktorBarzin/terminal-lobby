package sessionio

import (
	"encoding/json"
	"regexp"
	"strings"
)

// The harness writes its own bookkeeping into the transcript as user-role
// records: a background task finishing, the boilerplate caveat that precedes a
// slash command, and the command's own captured output. None of it is a prompt.
// Left as one, each renders as a bubble of angle-bracket tags and escape bytes
// in the chat where a person's words should be, and each opens a turn nobody
// started (Viktor, 2026-09-02).
//
// Measured across 354 transcripts on this box — 26,011 rendered text rows:
//
//	583  <task-notification>     a wall of XML, and a spurious turn each
//	 18  <local-command-caveat>  a fixed sentence addressed to the model
//	 15  <local-command-stdout>  the command's receipt, SGR codes included
//
// A sibling `<local-command-stderr>` is plausible and appears nowhere in the
// corpus, so it is deliberately not guessed at here.

// hookDone matches the CLI reporting that a hook finished. A hook that FAILS is
// already carried as MetaHookError off the system record, so a successful one is
// not news — and the PostCompact line embeds the hook's entire command, which is
// 2,206 of the 2,402 characters in the /compact receipt measured on 2026-09-02.
var hookDone = regexp.MustCompile(`^\S+ \[[\s\S]*\] completed successfully`)

// receiptCap bounds a command receipt. The hook filter is a pattern, so a shape
// it does not recognise would otherwise become a wall again the next time the
// CLI changes what it prints; every real receipt in the corpus is under 200
// bytes, so this costs nothing measured and bounds what it cannot foresee.
const receiptCap = 1 << 10

// harnessRow classifies a user-role record that is the harness talking to
// itself rather than the operator speaking.
//
// ok reports that the text is harness bookkeeping. line is the muted status
// line it renders as, or "" when there is nothing a reader would act on — in
// which case the record earns no row at all.
//
// settles reports that the record is a slash command's receipt, which is the
// transcript's own evidence that the command is finished: the CLI writes it
// once it has printed the command's output and gone back to the prompt. It
// matters because the command's own record opens a turn (it is a user-role
// record with text in it, which is the whole test for "the human spoke") and a
// command the CLI answers itself never reaches the model, so no assistant
// record with a terminal stop_reason ever arrives to close that turn. Measured
// across 357 transcripts on 2026-09-04: 16 command records were answered
// locally — /model 6, /compact 5, /effort 5 — and every one left its turn open
// until the operator's next prompt, which the text view drew as a working row
// on a session with nothing running. The longest was 31.6 hours.
func harnessRow(text string) (line string, settles, ok bool) {
	t := strings.TrimSpace(text)
	switch {
	case strings.HasPrefix(t, "<local-command-caveat>"):
		// Addressed to the model, identical every time, and says nothing to a
		// reader.
		return "", false, true
	case strings.HasPrefix(t, "<task-notification>"):
		// The markup carries the id, the tool-use id, the output file and the
		// status; the summary already says all of it in a sentence ("Background
		// command "…" completed (exit code 0)"). All 583 measured had one.
		return strings.TrimSpace(plainText(element(t, "summary"))), false, true
	case strings.HasPrefix(t, "<local-command-stdout>"):
		return commandReceipt(element(t, "local-command-stdout")), true, true
	}
	return "", false, false
}

// commandReceipt is what a slash command's captured output says, once the
// terminal formatting and the hook chatter are out of it.
func commandReceipt(out string) string {
	var keep []string
	for _, line := range strings.Split(plainText(out), "\n") {
		if hookDone.MatchString(strings.TrimSpace(line)) {
			continue
		}
		keep = append(keep, line)
	}
	cut, _ := capTextTo(strings.TrimSpace(strings.Join(keep, "\n")), receiptCap)
	return cut
}

// plainText strips the terminal control bytes out of text bound for a chat row.
//
// Transcript text is not always terminal-free: a slash command's output is
// captured with the SGR codes the CLI drew it with, and a prompt can carry the
// key bytes that were in the line editor when it was submitted. In a browser
// those are not formatting — an escape byte is a replacement glyph and its
// parameters are literal text, so "\x1b[2mCompacted" reads on screen as a tofu
// box followed by "[2mCompacted".
//
// Tab, newline and carriage return are kept: those are layout. Only ASCII
// control bytes and escape sequences are removed, so multi-byte UTF-8 — every
// byte of which is >= 0x80 — passes through untouched.
func plainText(s string) string {
	if !hasControl(s) {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); {
		c := s[i]
		switch {
		case c == 0x1b:
			i += escapeLen(s[i:])
		case c == 0x7f, c < 0x20 && c != '\t' && c != '\n' && c != '\r':
			i++
		default:
			b.WriteByte(c)
			i++
		}
	}
	return b.String()
}

// encodesControl reports whether ENCODED JSON could hold a control byte inside
// one of its strings — the cheap test that keeps the 98% with nothing to strip
// out of a round trip through the decoder.
//
// A control byte cannot appear raw inside a JSON string, so it reads as \u00XX
// — except backspace and form feed, which the short escapes \b and \f cover,
// and DEL, which needs no escape at all. Testing for \u00 alone let 6 results
// with a stray form feed through (measured 2026-09-02). Tab, newline and
// carriage return are kept by plainText, so their escapes are not tested for.
//
// A false positive costs one decode and returns the input unchanged.
func encodesControl(s string) bool {
	return strings.Contains(s, `\u00`) || strings.Contains(s, `\b`) ||
		strings.Contains(s, `\f`) || strings.ContainsRune(s, 0x7f)
}

// hasControl reports whether s holds anything plainText would remove. The point
// is to return the original string untouched for the ~98% that hold nothing.
func hasControl(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == 0x7f || (c < 0x20 && c != '\t' && c != '\n' && c != '\r') {
			return true
		}
	}
	return false
}

// escapeLen is the length of the escape sequence at the front of s, which
// begins with ESC.
//
// Malformed input costs its introducer and no more. A terminal reading an
// unterminated OSC swallows everything after it, which here would mean losing
// the rest of somebody's message to one stray byte — so the string-terminated
// forms give up at the end of the line, and a CSI gives up on the first byte
// that cannot be part of one.
func escapeLen(s string) int {
	if len(s) < 2 {
		return len(s) // a trailing ESC with nothing behind it
	}
	switch s[1] {
	case '[': // CSI: parameter and intermediate bytes, then a final in @…~
		for i := 2; i < len(s); i++ {
			c := s[i]
			switch {
			case c >= 0x40 && c <= 0x7e:
				return i + 1
			case c == '\n':
				return 2 // a CSI never spans a line — keep the rest of it
			case c >= 0x20 && c <= 0x3f: // parameters and intermediates
			default:
				return 2 // not a CSI after all
			}
		}
		return len(s)
	case ']', 'P', 'X', '^', '_': // OSC / DCS / SOS / PM / APC: run to ST or BEL
		for i := 2; i < len(s); i++ {
			switch {
			case s[i] == 0x07:
				return i + 1
			case s[i] == 0x1b && i+1 < len(s) && s[i+1] == '\\':
				return i + 2
			case s[i] == '\n':
				return 2 // unterminated — keep the line
			}
		}
		return 2
	default: // ESC + one byte: charset selection, RIS, NEL, …
		return 2
	}
}

// plainResult strips the terminal control bytes out of a structured result's
// captured output.
//
// A Bash row renders `stdout` from here in preference to the flattened body, so
// cleaning only the body left the colour codes on screen. Measured across 354
// transcripts: 911 of 49,896 tool results (1.8%) carry control bytes, nearly all
// of them SGR codes from a command that decided it was talking to a terminal.
//
// Only stdout and stderr are touched, and only when there is something to
// strip: a result with nothing in it comes back byte-for-byte, which keeps the
// other 98% out of a needless round trip through the JSON encoder.
func plainResult(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 || !encodesControl(string(raw)) {
		return raw
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return raw // not an object — nothing safe to reach into
	}
	changed := false
	for _, k := range []string{"stdout", "stderr"} {
		var s string
		if v, ok := fields[k]; ok && json.Unmarshal(v, &s) == nil {
			clean := plainText(s)
			if clean == s {
				continue
			}
			b, err := json.Marshal(clean)
			if err != nil {
				return raw
			}
			fields[k], changed = b, true
		}
	}
	if !changed {
		return raw
	}
	out, err := json.Marshal(fields)
	if err != nil {
		return raw
	}
	return out
}
