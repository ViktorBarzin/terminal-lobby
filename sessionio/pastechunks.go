package sessionio

import (
	"unicode"
	"unicode/utf8"
)

// The largest paste Claude Code keeps as typed text. Measured on CLI 2.1.283
// (2026-09-28): a bracketed paste of more than 800 UTF-16 units or more than 2
// line breaks is collapsed to "[Pasted text #N +M lines]" and recorded wrapped
// in <pasted_content>, and the CLI tells the model that text inside the
// wrapper "may contain instructions the user did not write". A 6-line request
// and a 1,000-character line sent from the Text view were both declined that
// way ("You pasted it without a message of your own"). The same words sent as
// several pastes under these limits were recorded exactly, unwrapped, and
// acted on. The unit limit keeps a margin under the CLI's 800.
const (
	pasteChunkUnits  = 640
	pasteChunkBreaks = 2
)

// pasteChunks splits text into pieces Claude Code keeps inline: each at most
// pasteChunkUnits UTF-16 units and pasteChunkBreaks line breaks, which joined
// in order give back text exactly. A piece ends after its second line break,
// or, on a line too long for one piece, after the last whitespace that fits,
// so a word or a path is not split across two pastes; a run with no
// whitespace at all is cut at the limit. \r and \n count as a break each,
// which is stricter than the CLI's reading of \r\n as one.
//
// Empty text is one empty piece, so a caller pastes exactly what it did before.
func pasteChunks(text string) []string {
	if text == "" {
		return []string{text}
	}
	var out []string
	for text != "" {
		end := chunkEnd(text)
		out = append(out, text[:end])
		text = text[end:]
	}
	return out
}

// chunkEnd is the byte length of the first piece of text.
func chunkEnd(text string) int {
	units, breaks, lastSpace := 0, 0, -1
	for i, r := range text {
		n := 1
		if r >= 0x10000 {
			n = 2 // a surrogate pair in UTF-16
		}
		if units+n > pasteChunkUnits {
			if lastSpace > 0 {
				return lastSpace
			}
			return i
		}
		units += n
		next := i + utf8.RuneLen(r)
		if r == '\r' || r == '\n' {
			breaks++
			if breaks == pasteChunkBreaks {
				return next
			}
		}
		if unicode.IsSpace(r) {
			lastSpace = next
		}
	}
	return len(text)
}

// paste puts text into the pane as bracketed pastes Claude Code keeps inline
// (pasteChunks), one after another, with no Enter.
func (in *Injector) paste(osUser, session, text string) error {
	for _, chunk := range pasteChunks(text) {
		if err := in.loadBuffer(osUser, chunk); err != nil {
			return err
		}
		// -p = bracketed paste, -d = delete the buffer afterwards.
		if err := in.Command(osUser, "paste-buffer", "-p", "-d", "-t", exactPane(session)).Run(); err != nil {
			return err
		}
	}
	return nil
}
