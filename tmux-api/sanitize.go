package main

// Query-reply sanitization for capture→pty replay paths (plan Task 3.6).
//
// When previously-captured pane content is played back through a pty (the
// tmux-resurrect pane-contents restore literally runs `cat <saved-file>`
// into each recreated pane), any terminal QUERY sequences embedded in that
// capture — DSR/DA requests, OSC 10/11/12 color queries — are re-answered
// by the attached terminal (xterm.js), and the answers arrive at the
// freshly spawned shell as junk input (e.g. `^[[65;1;9c` at the prompt;
// same failure class as memory #7336's viu DA1 leak). Stale REPLY
// sequences captured off a busy scrollback (`^[[24;80R`) are equally
// meaningless on replay. Both classes are stripped; every other byte
// passes through untouched.
//
// This is a byte-stream port of T3's terminal-history sanitizer
// (t3code apps/server/src/terminal/Manager.ts:869-897, parse loop
// :931-1039). Strip rules, verbatim from shouldStripCsiSequence /
// shouldStripOscSequence:
//
//	CSI … final 'n'                     any body        (DSR query/reply)
//	CSI … final 'R'  body ∈ [0-9;?]*                    (CPR / DECXCPR reply)
//	CSI … final 'c'  body ∈ [>0-9;?]*                   (DA query/reply)
//	OSC  content matching ^(10|11|12);(?|rgb:)          (color query/reply)
//
// DCS/PM/APC strings and every other escape sequence pass through whole
// (parsed only so their payloads stay atomic). Sequences may straddle
// chunk boundaries: the incomplete tail is carried into the next call,
// and Flush hands back an unterminated tail verbatim at end-of-stream.
//
// Byte-stream adaptation (T3 operates on decoded JS strings): C1 controls
// (0x9B CSI, 0x9D OSC, 0x90/0x9E/0x9F DCS/PM/APC introducers, 0x9C ST)
// are recognized only as properly UTF-8-decoded runes — a raw 0x9B..0x9F
// byte inside a multibyte character (every emoji contains one) or invalid
// binary is NEVER sequence-significant, so garbage cannot be corrupted.
//
// Where it is wired: the tmux-resurrect pane_contents.tar.gz rewriter
// below, invoked as `tmux-api sanitize-resurrect` from the
// @resurrect-hook-pre-restore-all hook that devvm/setup-user-persistence.sh
// provisions. The OTHER restore path — POST /restore → tmux-restore-user →
// tmux-persist — replays no captured content at all (its manifest is
// name/cwd/claude-uuid; sessions are recreated via `claude --resume`), so
// there is nothing to sanitize there (verified 2026-07-11).

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"unicode/utf8"
)

// querySanitizer strips terminal query/reply sequences from a byte
// stream, carrying sequences that straddle chunk boundaries. The zero
// value is ready to use.
type querySanitizer struct {
	// pending holds the prefix of a possibly-incomplete escape sequence
	// (or of an incomplete UTF-8 rune) seen at the end of the previous
	// chunk. Always an owned copy, never an alias of caller memory.
	pending []byte
}

// Sanitize processes one chunk and returns the bytes safe to emit so far.
// An incomplete trailing sequence is withheld until the next call (or
// Flush) decides its fate.
func (s *querySanitizer) Sanitize(chunk []byte) []byte {
	input := chunk
	if len(s.pending) > 0 {
		input = append(s.pending, chunk...)
		s.pending = nil
	}

	var out []byte
	i := 0
	for i < len(input) {
		b := input[i]

		if b == 0x1b { // ESC
			adv, emit, complete := scanEscape(input[i:])
			if !complete {
				s.carry(input[i:])
				return out
			}
			if emit {
				out = append(out, input[i:i+adv]...)
			}
			i += adv
			continue
		}

		if b < 0x80 { // plain ASCII (and C0 controls)
			out = append(out, b)
			i++
			continue
		}

		// Multibyte territory: decode so C1 controls are only honored as
		// real runes, never as stray bytes inside another character.
		r, size := utf8.DecodeRune(input[i:])
		if r == utf8.RuneError && size == 1 {
			if !utf8.FullRune(input[i:]) {
				// Truncated rune at the chunk end — carry it; the next
				// chunk completes (or invalidates) it.
				s.carry(input[i:])
				return out
			}
			out = append(out, b) // genuinely invalid byte: verbatim
			i++
			continue
		}

		switch r {
		case 0x9b: // C1 CSI
			adv, emit, complete := scanCSI(input[i:], size)
			if !complete {
				s.carry(input[i:])
				return out
			}
			if emit {
				out = append(out, input[i:i+adv]...)
			}
			i += adv
		case 0x9d, 0x90, 0x9e, 0x9f: // C1 OSC / DCS / PM / APC
			adv, emit, complete := scanString(input[i:], size, r == 0x9d)
			if !complete {
				s.carry(input[i:])
				return out
			}
			if emit {
				out = append(out, input[i:i+adv]...)
			}
			i += adv
		default:
			out = append(out, input[i:i+size]...)
			i += size
		}
	}
	return out
}

// Flush returns whatever incomplete tail is still withheld, verbatim: a
// truncated sequence at end-of-stream is not a query a terminal would
// answer, and dropping bytes would violate the leave-untouched contract.
func (s *querySanitizer) Flush() []byte {
	p := s.pending
	s.pending = nil
	return p
}

func (s *querySanitizer) carry(tail []byte) {
	s.pending = append([]byte(nil), tail...)
}

// sanitizeQueryReplies sanitizes a complete buffer in one go.
func sanitizeQueryReplies(data []byte) []byte {
	var s querySanitizer
	out := s.Sanitize(data)
	return append(out, s.Flush()...)
}

// scanEscape handles a sequence starting at p[0] == ESC. Returns the
// sequence length, whether to emit it, and whether it was complete within
// p (incomplete ⇒ carry everything from the ESC).
func scanEscape(p []byte) (adv int, emit, complete bool) {
	if len(p) < 2 {
		return 0, false, false
	}
	switch p[1] {
	case '[': // CSI
		return scanCSI(p, 2)
	case ']': // OSC — the only string sequence with a strip rule
		return scanString(p, 2, true)
	case 'P', '^', '_': // DCS / PM / APC — parsed for atomicity, kept
		return scanString(p, 2, false)
	default:
		// Generic escape: intermediates 0x20-0x2f then a final 0x30-0x7e;
		// anything else degrades to ESC + one byte (T3 parity). Never
		// stripped.
		j := 1
		for j < len(p) && p[j] >= 0x20 && p[j] <= 0x2f {
			j++
		}
		if j >= len(p) {
			return 0, false, false
		}
		if p[j] >= 0x30 && p[j] <= 0x7e {
			return j + 1, true, true
		}
		return 2, true, true
	}
}

// scanCSI scans a CSI sequence whose parameter body starts at bodyStart
// (2 for ESC-[, the rune width for C1 0x9B) and ends at the first final
// byte 0x40-0x7e.
func scanCSI(p []byte, bodyStart int) (adv int, emit, complete bool) {
	for j := bodyStart; j < len(p); j++ {
		if b := p[j]; b >= 0x40 && b <= 0x7e {
			return j + 1, !csiShouldStrip(p[bodyStart:j], b), true
		}
	}
	return 0, false, false
}

// csiShouldStrip is shouldStripCsiSequence (Manager.ts:871-882) verbatim.
func csiShouldStrip(body []byte, final byte) bool {
	switch final {
	case 'n': // DSR — stripped regardless of body
		return true
	case 'R': // CPR reply — digits/;/? only
		return csiBodyIn(body, false)
	case 'c': // DA — digits/;/? plus the DA2 '>' prefix
		return csiBodyIn(body, true)
	}
	return false
}

func csiBodyIn(body []byte, allowGT bool) bool {
	for _, b := range body {
		switch {
		case b >= '0' && b <= '9', b == ';', b == '?':
		case b == '>' && allowGT:
		default:
			return false
		}
	}
	return true
}

// scanString scans an OSC/DCS/PM/APC string sequence whose content starts
// at intro bytes in, terminated by BEL, C1 ST (U+009C) or ESC-\.
// Only OSC (osc=true) is strip-eligible.
func scanString(p []byte, intro int, osc bool) (adv int, emit, complete bool) {
	end, termLen, ok := findStringTerminator(p, intro)
	if !ok {
		return 0, false, false
	}
	emit = true
	if osc && oscShouldStrip(p[intro:end-termLen]) {
		emit = false
	}
	return end, emit, true
}

// findStringTerminator mirrors findStringTerminatorIndex
// (Manager.ts:899-910) rune-aware: returns the index just past the
// terminator and the terminator's byte length. A continuation byte 0x9C
// inside a multibyte character (e.g. 'Ŝ' = C5 9C) is NOT a terminator.
func findStringTerminator(p []byte, from int) (end, termLen int, ok bool) {
	j := from
	for j < len(p) {
		b := p[j]
		switch {
		case b == 0x07: // BEL
			return j + 1, 1, true
		case b == 0x1b:
			if j+1 >= len(p) {
				return 0, 0, false // can't decide ESC-\ vs content yet
			}
			if p[j+1] == '\\' {
				return j + 2, 2, true
			}
			j++
		case b < 0x80:
			j++
		default:
			r, size := utf8.DecodeRune(p[j:])
			if r == utf8.RuneError && size == 1 {
				if !utf8.FullRune(p[j:]) {
					return 0, 0, false // truncated rune at chunk end
				}
				j++
				continue
			}
			if r == 0x9c { // C1 ST
				return j + size, size, true
			}
			j += size
		}
	}
	return 0, 0, false
}

// oscShouldStrip is shouldStripOscSequence (Manager.ts:884-886):
// ^(10|11|12);(?|rgb:) — color queries and their replies. content
// arrives with the terminator already excluded.
func oscShouldStrip(content []byte) bool {
	if len(content) < 4 || content[0] != '1' || content[2] != ';' {
		return false
	}
	if content[1] != '0' && content[1] != '1' && content[1] != '2' {
		return false
	}
	rest := content[3:]
	return rest[0] == '?' || bytes.HasPrefix(rest, []byte("rgb:"))
}

// --- resurrect archive rewriting ---------------------------------------------

// sanitizeResurrectArchive rewrites a tmux-resurrect pane_contents.tar.gz
// in place with every regular file's content sanitized. Returns whether
// anything changed; a clean archive is left byte-untouched (no mtime
// churn). The rewrite is atomic (temp file + rename) and preserves the
// archive's permission bits; any error leaves the original as it was.
func sanitizeResurrectArchive(path string) (changed bool, err error) {
	in, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer in.Close()
	origInfo, err := in.Stat()
	if err != nil {
		return false, err
	}
	gzr, err := gzip.NewReader(in)
	if err != nil {
		return false, fmt.Errorf("gzip: %w", err)
	}
	defer gzr.Close()
	tr := tar.NewReader(gzr)

	tmp, err := os.CreateTemp(filepath.Dir(path), ".pane_contents.*.tmp")
	if err != nil {
		return false, err
	}
	tmpName := tmp.Name()
	defer func() {
		tmp.Close()
		if err != nil || !changed {
			os.Remove(tmpName)
		}
	}()

	gzw := gzip.NewWriter(tmp)
	tw := tar.NewWriter(gzw)
	for {
		hdr, nerr := tr.Next()
		if nerr == io.EOF {
			break
		}
		if nerr != nil {
			return false, fmt.Errorf("tar: %w", nerr)
		}
		if hdr.Typeflag != tar.TypeReg {
			if werr := tw.WriteHeader(hdr); werr != nil {
				return false, werr
			}
			if _, cerr := io.Copy(tw, tr); cerr != nil {
				return false, cerr
			}
			continue
		}
		data, rerr := io.ReadAll(tr)
		if rerr != nil {
			return false, fmt.Errorf("tar read %s: %w", hdr.Name, rerr)
		}
		clean := sanitizeQueryReplies(data)
		if !bytes.Equal(clean, data) {
			changed = true
		}
		hdr.Size = int64(len(clean))
		if werr := tw.WriteHeader(hdr); werr != nil {
			return false, werr
		}
		if _, werr := tw.Write(clean); werr != nil {
			return false, werr
		}
	}
	if err = tw.Close(); err != nil {
		return false, err
	}
	if err = gzw.Close(); err != nil {
		return false, err
	}
	if !changed {
		return false, nil // clean archive: keep the original untouched
	}
	if err = os.Chmod(tmpName, origInfo.Mode().Perm()); err != nil {
		return false, err
	}
	if err = tmp.Sync(); err != nil {
		return false, err
	}
	if err = tmp.Close(); err != nil {
		return false, err
	}
	if err = os.Rename(tmpName, path); err != nil {
		return false, err
	}
	return true, nil
}

// resurrectArchiveCandidates lists the default resurrect state locations
// (helpers.sh resurrect_dir(): ~/.tmux/resurrect when present, else the
// XDG data dir — we visit both; sanitizing is idempotent). A user-set
// @resurrect-dir override can be covered by passing the archive path
// explicitly.
func resurrectArchiveCandidates(home string) []string {
	xdg := os.Getenv("XDG_DATA_HOME")
	if xdg == "" {
		xdg = filepath.Join(home, ".local", "share")
	}
	return []string{
		filepath.Join(home, ".tmux", "resurrect", "pane_contents.tar.gz"),
		filepath.Join(xdg, "tmux", "resurrect", "pane_contents.tar.gz"),
	}
}

// runSanitizeResurrect backs `tmux-api sanitize-resurrect [archive...]`,
// invoked per-user by the @resurrect-hook-pre-restore-all hook right
// before resurrect extracts the archive and `cat`s pane contents into the
// recreated ptys. Hook contract: it must NEVER abort or wedge a restore —
// missing archives are silent, failures go to stderr, exit code is
// always 0.
func runSanitizeResurrect(args []string, stderr io.Writer) int {
	paths := args
	if len(paths) == 0 {
		home, err := os.UserHomeDir()
		if err != nil {
			fmt.Fprintf(stderr, "sanitize-resurrect: cannot resolve home: %v\n", err)
			return 0
		}
		paths = resurrectArchiveCandidates(home)
	}
	for _, p := range paths {
		changed, err := sanitizeResurrectArchive(p)
		if err != nil {
			if os.IsNotExist(err) {
				continue // nothing saved yet — normal
			}
			fmt.Fprintf(stderr, "sanitize-resurrect: %s: %v\n", p, err)
			continue
		}
		if changed {
			fmt.Fprintf(stderr, "sanitize-resurrect: stripped terminal query replies from %s\n", p)
		}
	}
	return 0
}
