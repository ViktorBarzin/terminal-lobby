package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"io"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The sanitizer ports T3's terminal-history sanitization rules
// (t3code apps/server/src/terminal/Manager.ts:869-897 + the chunk parser
// at :931-1039): replayed capture content must not contain terminal
// query/reply sequences, or the receiving terminal re-answers them and
// the answers land in the freshly spawned shell as junk input.

// --- strip rules (table) -----------------------------------------------------

func TestSanitizeStripsQueryReplies(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		// DSR: any CSI body with final byte 'n'.
		{"DSR cursor query", "before \x1b[6n after", "before  after"},
		{"DSR status query", "\x1b[5n", ""},
		{"DSR status reply", "\x1b[0n", ""},
		{"DSR private reply", "\x1b[?25;1n", ""},
		// CPR: final 'R' with body limited to [0-9;?].
		{"CPR reply", "row \x1b[24;80R col", "row  col"},
		{"DECXCPR reply", "\x1b[?24;80;1R", ""},
		{"CPR empty body", "\x1b[R", ""},
		// DA: final 'c' with body limited to [>0-9;?].
		{"DA1 query", "\x1b[c", ""},
		{"DA1 query with 0", "\x1b[0c", ""},
		{"DA1 reply", "\x1b[?64;1;2;6;9;15;18;21;22c", ""},
		{"DA2 query", "\x1b[>c", ""},
		{"DA2 reply", "\x1b[>84;0;0c", ""},
		// OSC 10/11/12 with '?' (query) or 'rgb:' (reply), any terminator.
		{"OSC10 query BEL", "\x1b]10;?\x07", ""},
		{"OSC11 query BEL", "x\x1b]11;?\x07y", "xy"},
		{"OSC11 reply ST", "\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\", ""},
		{"OSC12 reply BEL", "\x1b]12;rgb:f5e0/dcdc/aaaa\x07", ""},
		{"OSC10 reply C1 ST", "\x1b]10;rgb:aaaa/bbbb/cccc\u009c", ""},
		// C1 introducers (proper UTF-8 encodings of U+009B / U+009D).
		{"C1 CSI DSR", "a\u009b6nb", "ab"},
		{"C1 CSI CPR", "\u009b12;40R", ""},
		{"C1 OSC query", "\u009d11;?\u009c", ""},
		// Mixed with content that must survive.
		{
			"SGR kept around stripped query",
			"\x1b[31mred\x1b[0m\x1b[6n rest",
			"\x1b[31mred\x1b[0m rest",
		},
		{
			"multiple queries in one line",
			"$ \x1b[6nls\x1b[?1;2c -la\x1b]10;?\x07",
			"$ ls -la",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := sanitizeQueryReplies([]byte(tc.in))
			if !bytes.Equal(got, []byte(tc.want)) {
				t.Fatalf("sanitize(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// Everything that is not a query/reply must pass through byte-identical —
// including SGR colors, mode sets, titles, hyperlinks, DCS/PM/APC strings,
// raw controls, multibyte UTF-8 and invalid bytes.
func TestSanitizeLeavesEverythingElseUntouched(t *testing.T) {
	cases := []struct {
		name string
		in   string
	}{
		{"plain text", "hello world"},
		{"empty", ""},
		{"SGR truecolor", "\x1b[38;2;10;20;30mX\x1b[0m"},
		{"cursor move", "\x1b[10;20H\x1b[2J"},
		{"DECSET/DECRST", "\x1b[?1003h\x1b[?1006l\x1b[?2004h"},
		{"mode report final y", "\x1b[?2004;1$y"},
		// Final 'R'/'c' with a body outside the allowed charset stays.
		{"R with colon body", "\x1b[1:2R"},
		{"DA3-style '=' body", "\x1b[=0c"},
		// OSC that must not match the (10|11|12);(?|rgb:) rule.
		{"OSC0 title", "\x1b]0;my title\x07"},
		{"OSC2 title", "\x1b]2;✳ summary\x1b\\"},
		{"OSC52 clipboard", "\x1b]52;c;aGVsbG8=\x07"},
		{"OSC104 palette reset", "\x1b]104;10\x07"},
		{"OSC110 reset fg", "\x1b]110\x1b\\"},
		{"OSC10 set color", "\x1b]10;#ffffff\x07"},
		{"OSC8 hyperlink", "\x1b]8;;https://x.test\x07link\x1b]8;;\x07"},
		// String sequences other than OSC are never stripped, and their
		// payload is atomic — an embedded query-shaped run stays inside.
		{"DCS sixel", "\x1bPq#0;2;0;0;0-\x1b\\"},
		{"DCS with embedded CSI-like payload", "\x1bPx\x1b[6n-ish\x1b\\"},
		{"APC kitty", "\x1b_Gi=1\x1b\\"},
		{"PM string", "\x1b^hello\x1b\\"},
		// Non-CSI escapes.
		{"ESC 7 8 = charset", "\x1b7\x1b8\x1b=\x1b(B"},
		{"ESC with intermediates", "\x1b#8"},
		// Raw controls and text.
		{"BEL CR LF TAB", "a\x07b\r\nc\td"},
		{"box drawing + emoji", "│─ ✓ héllo 😀 done"},
		// 0x9F is a continuation byte of 😀 — must never be read as APC.
		{"emoji straddles C1 byte values", "😀😁😂"},
		// U+015C = C5 9C: continuation byte 0x9C must not terminate an OSC.
		{"OSC content with 0x9C continuation byte", "\x1b]0;SŜ title\x07"},
		{"invalid UTF-8 bytes", "a\xff\xfeb"},
		{"NUL byte", "a\x00b"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := sanitizeQueryReplies([]byte(tc.in))
			if !bytes.Equal(got, []byte(tc.in)) {
				t.Fatalf("sanitize(%q) = %q, want input unchanged", tc.in, got)
			}
		})
	}
}

// Applying the sanitizer twice must be a no-op the second time — the
// resurrect pre-restore hook runs on every restore.
func TestSanitizeIsIdempotent(t *testing.T) {
	inputs := []string{
		"before \x1b[6n after",
		"\x1b[31mred\x1b[0m\x1b[6n rest",
		"$ \x1b[6nls\x1b[?1;2c -la\x1b]10;?\x07",
		"\x1b[\x1b[5n6n", // pathological: CSI whose "final" is a second '['
		"a\xff\x1b[?24;80;1Rb",
	}
	for _, in := range inputs {
		once := sanitizeQueryReplies([]byte(in))
		twice := sanitizeQueryReplies(once)
		if !bytes.Equal(once, twice) {
			t.Fatalf("not idempotent for %q: once=%q twice=%q", in, once, twice)
		}
	}
}

// --- chunk-boundary straddle -------------------------------------------------

// feedChunks runs the streaming sanitizer over the given chunking and
// returns visible output + flushed tail.
func feedChunks(chunks [][]byte) []byte {
	var s querySanitizer
	var out []byte
	for _, c := range chunks {
		out = append(out, s.Sanitize(c)...)
	}
	return append(out, s.Flush()...)
}

// An escape sequence straddling two chunks must sanitize exactly like the
// unsplit input — for EVERY possible split point.
func TestSanitizeChunkStraddleEverySplit(t *testing.T) {
	cases := []string{
		"pre\x1b[?24;80;1Rpost",
		"pre\x1b[6npost",
		"pre\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\post",
		"pre\x1b]10;?\x07post",
		"pre\u009b6npost",
		"pre\u009d12;?\u009cpost",
		"keep\x1b[31mcolor\x1b[0mkeep",
		"a😀\x1b[6nb", // multibyte rune next to a stripped sequence
	}
	for _, in := range cases {
		want := sanitizeQueryReplies([]byte(in))
		for i := 1; i < len(in); i++ {
			got := feedChunks([][]byte{[]byte(in[:i]), []byte(in[i:])})
			if !bytes.Equal(got, want) {
				t.Fatalf("split %q at %d: got %q, want %q", in, i, got, want)
			}
		}
	}
}

// Byte-at-a-time is the most hostile chunking of all.
func TestSanitizeByteAtATime(t *testing.T) {
	in := "$ \x1b[6nls\x1b[?1;2c -la\x1b]10;?\x07 😀 \x1b[32mok\x1b[0m"
	want := sanitizeQueryReplies([]byte(in))
	chunks := make([][]byte, 0, len(in))
	for i := 0; i < len(in); i++ {
		chunks = append(chunks, []byte{in[i]})
	}
	if got := feedChunks(chunks); !bytes.Equal(got, want) {
		t.Fatalf("byte-at-a-time: got %q, want %q", got, want)
	}
}

// A truncated sequence at end-of-stream is NOT a query the terminal would
// answer — Flush must hand it back verbatim, never drop bytes.
func TestSanitizeFlushEmitsIncompleteTail(t *testing.T) {
	cases := []struct {
		in   string
		vis  string
		tail string
	}{
		{"abc\x1b[12", "abc", "\x1b[12"},
		{"abc\x1b", "abc", "\x1b"},
		{"abc\x1b]11;rgb:aa", "abc", "\x1b]11;rgb:aa"},
		{"abc\x1bPunterminated", "abc", "\x1bPunterminated"},
	}
	for _, tc := range cases {
		var s querySanitizer
		vis := s.Sanitize([]byte(tc.in))
		if !bytes.Equal(vis, []byte(tc.vis)) {
			t.Fatalf("Sanitize(%q) visible = %q, want %q", tc.in, vis, tc.vis)
		}
		tail := s.Flush()
		if !bytes.Equal(tail, []byte(tc.tail)) {
			t.Fatalf("Flush after %q = %q, want %q", tc.in, tail, tc.tail)
		}
		if again := s.Flush(); len(again) != 0 {
			t.Fatalf("second Flush = %q, want empty", again)
		}
	}
}

// --- property: sequence-free corpora pass through identical ------------------

// Random corpora containing no ESC bytes and no C1 control runes must come
// out byte-identical under arbitrary chunking.
func TestSanitizePropertySequenceFreeIdentity(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	alphabet := []rune{
		'a', 'z', 'A', 'Z', '0', '9', ' ', '\n', '\r', '\t', '\x07',
		'|', ';', '?', '[', ']', 'n', 'R', 'c', // rule-adjacent ASCII, no ESC
		'│', '─', 'é', 'ß', '✓', 'Ŝ', '😀', '⠋',
	}
	for iter := 0; iter < 300; iter++ {
		n := rng.Intn(400)
		var b bytes.Buffer
		for i := 0; i < n; i++ {
			if rng.Intn(40) == 0 {
				b.WriteByte(0xff) // invalid UTF-8 byte, still not a sequence
				continue
			}
			b.WriteRune(alphabet[rng.Intn(len(alphabet))])
		}
		in := b.Bytes()

		// Random chunking, including empty chunks.
		var chunks [][]byte
		rest := in
		for len(rest) > 0 {
			k := rng.Intn(len(rest) + 1)
			chunks = append(chunks, rest[:k])
			rest = rest[k:]
		}
		got := feedChunks(chunks)
		if !bytes.Equal(got, in) {
			t.Fatalf("iter %d: sequence-free input altered:\n in=%q\nout=%q", iter, in, got)
		}
	}
}

// --- resurrect archive rewriting (the capture→pty replay path) ---------------

// writeArchive builds a resurrect-shaped pane_contents.tar.gz.
func writeArchive(t *testing.T, path string, entries map[string][]byte) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{
		Name:     "./pane_contents/",
		Typeflag: tar.TypeDir,
		Mode:     0o755,
	}); err != nil {
		t.Fatal(err)
	}
	// Deterministic order for stable comparisons.
	names := make([]string, 0, len(entries))
	for name := range entries {
		names = append(names, name)
	}
	for i := 0; i < len(names); i++ {
		for j := i + 1; j < len(names); j++ {
			if names[j] < names[i] {
				names[i], names[j] = names[j], names[i]
			}
		}
	}
	for _, name := range names {
		data := entries[name]
		if err := tw.WriteHeader(&tar.Header{
			Name:     "./pane_contents/" + name,
			Typeflag: tar.TypeReg,
			Mode:     0o644,
			Size:     int64(len(data)),
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
}

// readArchive returns name→content for regular files plus the entry order.
func readArchive(t *testing.T, path string) (map[string][]byte, []string) {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	files := map[string][]byte{}
	var order []string
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		order = append(order, hdr.Name)
		if hdr.Typeflag == tar.TypeReg {
			data, err := io.ReadAll(tr)
			if err != nil {
				t.Fatal(err)
			}
			files[hdr.Name] = data
		}
	}
	return files, order
}

func TestSanitizeResurrectArchiveStripsPaneFiles(t *testing.T) {
	dir := t.TempDir()
	archive := filepath.Join(dir, "pane_contents.tar.gz")
	dirty := []byte("\x1b[31m$ ls\x1b[0m\n\x1b[6n\x1b[?64;1;2c\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\done\n")
	clean := []byte("plain \x1b[32mgreen\x1b[0m\nand binary \xff\x00 bytes\n")
	writeArchive(t, archive, map[string][]byte{
		"pane-main:0.0": dirty,
		"pane-work:1.0": clean,
	})

	changed, err := sanitizeResurrectArchive(archive)
	if err != nil {
		t.Fatalf("sanitizeResurrectArchive: %v", err)
	}
	if !changed {
		t.Fatal("changed = false, want true (archive contained query replies)")
	}

	files, order := readArchive(t, archive)
	wantDirty := []byte("\x1b[31m$ ls\x1b[0m\ndone\n")
	if got := files["./pane_contents/pane-main:0.0"]; !bytes.Equal(got, wantDirty) {
		t.Fatalf("dirty pane after sanitize = %q, want %q", got, wantDirty)
	}
	if got := files["./pane_contents/pane-work:1.0"]; !bytes.Equal(got, clean) {
		t.Fatalf("clean pane was altered: %q", got)
	}
	if len(order) != 3 || order[0] != "./pane_contents/" {
		t.Fatalf("entry order/layout not preserved: %v", order)
	}
}

// A fully clean archive must be left alone on disk (no rewrite, no mtime
// churn on the 5-minute continuum cadence).
func TestSanitizeResurrectArchiveCleanIsNoop(t *testing.T) {
	dir := t.TempDir()
	archive := filepath.Join(dir, "pane_contents.tar.gz")
	writeArchive(t, archive, map[string][]byte{
		"pane-main:0.0": []byte("nothing to strip \x1b[35mhere\x1b[0m\n"),
	})
	before, err := os.ReadFile(archive)
	if err != nil {
		t.Fatal(err)
	}

	changed, err := sanitizeResurrectArchive(archive)
	if err != nil {
		t.Fatalf("sanitizeResurrectArchive: %v", err)
	}
	if changed {
		t.Fatal("changed = true, want false for a clean archive")
	}
	after, err := os.ReadFile(archive)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("clean archive bytes were rewritten")
	}
}

func TestSanitizeResurrectArchivePreservesMode(t *testing.T) {
	dir := t.TempDir()
	archive := filepath.Join(dir, "pane_contents.tar.gz")
	writeArchive(t, archive, map[string][]byte{
		"pane-main:0.0": []byte("x\x1b[6ny"),
	})
	if err := os.Chmod(archive, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := sanitizeResurrectArchive(archive); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(archive)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o644 {
		t.Fatalf("archive mode after rewrite = %o, want 644", fi.Mode().Perm())
	}
}

// A corrupt archive must leave the original untouched and report the error.
func TestSanitizeResurrectArchiveCorruptLeavesOriginal(t *testing.T) {
	dir := t.TempDir()
	archive := filepath.Join(dir, "pane_contents.tar.gz")
	garbage := []byte("not a gzip stream at all")
	if err := os.WriteFile(archive, garbage, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := sanitizeResurrectArchive(archive); err == nil {
		t.Fatal("want error for corrupt archive, got nil")
	}
	after, err := os.ReadFile(archive)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(after, garbage) {
		t.Fatal("corrupt archive was modified")
	}
	if entries, err := os.ReadDir(dir); err == nil {
		for _, e := range entries {
			if e.Name() != "pane_contents.tar.gz" {
				t.Fatalf("temp file left behind: %s", e.Name())
			}
		}
	}
}

// --- CLI entry point (the resurrect pre-restore hook) -------------------------

// The hook contract: NEVER block a restore. Missing archives are silent,
// failures are stderr-only, exit code is always 0.
func TestRunSanitizeResurrectAlwaysExitsZero(t *testing.T) {
	var errb strings.Builder
	if code := runSanitizeResurrect([]string{filepath.Join(t.TempDir(), "nope.tar.gz")}, &errb); code != 0 {
		t.Fatalf("missing explicit archive: exit %d, want 0", code)
	}

	dir := t.TempDir()
	corrupt := filepath.Join(dir, "pane_contents.tar.gz")
	if err := os.WriteFile(corrupt, []byte("junk"), 0o644); err != nil {
		t.Fatal(err)
	}
	errb.Reset()
	if code := runSanitizeResurrect([]string{corrupt}, &errb); code != 0 {
		t.Fatalf("corrupt archive: exit %d, want 0", code)
	}
	if !strings.Contains(errb.String(), "sanitize-resurrect") {
		t.Fatalf("corrupt archive produced no stderr diagnostic: %q", errb.String())
	}
}

func TestRunSanitizeResurrectExplicitPath(t *testing.T) {
	dir := t.TempDir()
	archive := filepath.Join(dir, "pane_contents.tar.gz")
	writeArchive(t, archive, map[string][]byte{
		"pane-main:0.0": []byte("a\x1b[6nb"),
	})
	var errb strings.Builder
	if code := runSanitizeResurrect([]string{archive}, &errb); code != 0 {
		t.Fatalf("exit %d, want 0 (stderr: %s)", code, errb.String())
	}
	files, _ := readArchive(t, archive)
	if got := files["./pane_contents/pane-main:0.0"]; !bytes.Equal(got, []byte("ab")) {
		t.Fatalf("pane after CLI run = %q, want %q", got, "ab")
	}
}

// With no args the hook discovers the default resurrect locations under
// $HOME (~/.tmux/resurrect takes precedence, mirroring resurrect's own
// default; the XDG fallback is also visited).
func TestRunSanitizeResurrectDiscoversDefaultDirs(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, "xdg"))

	legacy := filepath.Join(home, ".tmux", "resurrect", "pane_contents.tar.gz")
	xdg := filepath.Join(home, "xdg", "tmux", "resurrect", "pane_contents.tar.gz")
	for _, p := range []string{legacy, xdg} {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		writeArchive(t, p, map[string][]byte{
			"pane-main:0.0": []byte("x\x1b[?24;80;1Ry"),
		})
	}

	var errb strings.Builder
	if code := runSanitizeResurrect(nil, &errb); code != 0 {
		t.Fatalf("exit %d, want 0 (stderr: %s)", code, errb.String())
	}
	for _, p := range []string{legacy, xdg} {
		files, _ := readArchive(t, p)
		if got := files["./pane_contents/pane-main:0.0"]; !bytes.Equal(got, []byte("xy")) {
			t.Fatalf("%s not sanitized: %q", p, got)
		}
	}
}
