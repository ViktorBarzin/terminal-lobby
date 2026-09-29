package sessionio

import (
	"regexp"
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
// acted on. The unit limit keeps a margin under the CLI's 800. The CLI
// measures after widening every tab to four spaces, so a tab counts as four.
//
// TestInstalledClaudeKeepsThesePastesInline (pastelimits_test.go) reads both
// limits out of the installed claude binary and fails if either drops below
// these sizes.
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
//
// Every picture's path is also a paste of its own (picturePathCuts). Claude
// Code attaches a picture from a path only when the path is the end of what
// was pasted (measured on CLI 2.1.283, 2026-09-29). A path at the front was
// sent as text, and Claude read the file with its Read tool, which asks
// permission outside the project in Manual, Edits and Plan mode (deployed
// review round 5: every photo sent from a phone asked to read the lobby's
// upload folder). And Claude draws the picture's "[Image #N]" at the FRONT of
// the paste that attached it, so "words /red.png" as one paste became
// "[Image #1]words", every picture one slot early in the message (deployed
// review round 2 of the T3 pass, CLI 2.1.284, 2026-09-29).
func pasteChunks(text string) []string {
	if text == "" {
		return []string{text}
	}
	var out []string
	start := 0
	for _, end := range append(picturePathCuts(text), len(text)) {
		for part := text[start:end]; part != ""; {
			n := chunkEnd(part)
			out = append(out, part[:n])
			part = part[n:]
		}
		start = end
	}
	return out
}

// picturePath is an absolute path to a picture, as a whole word: what Claude
// Code attaches when it ends a paste.
var picturePath = regexp.MustCompile(`(?i)(?:^|\s)(/\S+\.(?:png|jpe?g|gif|webp))(?:\s|$)`)

// picturePathCuts is the byte offset of the start of each picture's path in
// text and the offset just past it, in order, leaving out the text's own
// start and end.
func picturePathCuts(text string) []int {
	var cuts []int
	for rest, base := text, 0; ; {
		m := picturePath.FindStringSubmatchIndex(rest)
		if m == nil {
			return cuts
		}
		if begin := base + m[2]; begin > 0 {
			cuts = append(cuts, begin)
		}
		if end := base + m[3]; end < len(text) {
			cuts = append(cuts, end)
		}
		// Resume at the path's end, so a whitespace that ended one path can
		// begin the next.
		base += m[3]
		rest = text[base:]
	}
}

// chunkEnd is the byte length of the first piece of text.
func chunkEnd(text string) int {
	units, breaks, lastSpace := 0, 0, -1
	for i, r := range text {
		n := 1
		switch {
		case r >= 0x10000:
			n = 2 // a surrogate pair in UTF-16
		case r == '\t':
			n = 4 // the CLI widens a tab to four spaces before it measures
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
		if err := in.pasteOne(osUser, session, chunk); err != nil {
			return err
		}
	}
	return nil
}

// pasteOne puts one piece into the pane as a single bracketed paste.
func (in *Injector) pasteOne(osUser, session, chunk string) error {
	if err := in.loadBuffer(osUser, chunk); err != nil {
		return err
	}
	// -p = bracketed paste, -d = delete the buffer afterwards.
	return in.Command(osUser, "paste-buffer", "-p", "-d", "-t", exactPane(session)).Run()
}

// endingPicture is the picture's path a piece ends with, if it ends with one.
func endingPicture(chunk string) (string, bool) {
	m := endingPicturePath.FindStringSubmatch(chunk)
	if m == nil {
		return "", false
	}
	return m[1], true
}

// endingPicturePath is picturePath at the very end of a piece.
var endingPicturePath = regexp.MustCompile(`(?i)(?:^|\s)(/\S+\.(?:png|jpe?g|gif|webp))$`)
