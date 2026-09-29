package sessionio

import (
	"bufio"
	"bytes"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"testing"
)

// The long-message fix (pastechunks.go) depends on two numbers inside Claude
// Code: a bracketed paste longer than 800 UTF-16 units, or with more than 2
// line breaks, is collapsed into "[Pasted text #N]" and recorded wrapped in
// <pasted_content>, which tells the model the words are not the user's own.
// The CLI updates itself, independently of the lobby's releases, so this reads
// both numbers out of the installed binary and fails loudly if either drops
// below the chunk size the lobby pastes in (pasteChunkUnits, pasteChunkBreaks).
//
// Where it runs: with the rest of the sessionio tests, on the devvm, which is
// where the release checks run (docs/deployment.md, "Claude Code's paste
// limits"). It skips
// on a machine with no claude installed, such as GitHub Actions. CLAUDE_BIN
// points it at another binary.
//
// What it reads, from CLI 2.1.283 (2026-09-29). Two paste handlers compare a
// paste against the same unit limit, one of them against a break cap that
// shrinks on a pane under 12 rows:
//
//	if(h&&(b.length>t8||M>2)){let A=f.mintTextPaste(b) ...
//	let Xh=Math.max(0,Math.min(sr-10,2));if(vm.length>t8||nb>Xh){ ...
//	t8=800
//
// The minified names change between builds, so the patterns match any name.
func TestInstalledClaudeKeepsThesePastesInline(t *testing.T) {
	bin := installedClaude(t)
	lim, err := readPasteLimits(bin)
	if err != nil {
		t.Fatalf("could not read the paste limits out of %s: %v\n"+
			"Claude Code changed how it decides to collapse a paste. Re-measure it "+
			"(sessionio/pastechunks.go says how) and update this test and pasteChunkUnits/pasteChunkBreaks.", bin, err)
	}
	t.Logf("%s: a paste collapses past %d units or %d line breaks", bin, lim.units, lim.breaks)
	if lim.units < pasteChunkUnits {
		t.Errorf("Claude Code now collapses a paste over %d UTF-16 units, below the lobby's chunk of %d: "+
			"long messages would reach Claude as <pasted_content>. Lower pasteChunkUnits.", lim.units, pasteChunkUnits)
	}
	if lim.breaks < pasteChunkBreaks {
		t.Errorf("Claude Code now collapses a paste with more than %d line breaks, below the lobby's %d: "+
			"multi-line messages would reach Claude as <pasted_content>. Lower pasteChunkBreaks.", lim.breaks, pasteChunkBreaks)
	}
}

// installedClaude is the binary the box's `claude` resolves to, or CLAUDE_BIN.
func installedClaude(t *testing.T) string {
	t.Helper()
	bin := os.Getenv("CLAUDE_BIN")
	if bin == "" {
		p, err := exec.LookPath("claude")
		if err != nil {
			t.Skip("no claude installed here; the check runs on the devvm")
		}
		bin = p
	}
	real, err := filepath.EvalSymlinks(bin)
	if err != nil {
		t.Fatalf("resolving %s: %v", bin, err)
	}
	return real
}

type pasteLimits struct{ units, breaks int }

var (
	// The editor's handler: `(b.length>t8||M>2)){let A=f.mintTextPaste`.
	pasteGateMint = regexp.MustCompile(`\([\w$]+\.length>([\w$]+)\|\|[\w$]+>(\d+)\)\)\{let [\w$]+=[\w$]+\.mintTextPaste`)
	// The prompt input's handler, whose break cap is min(rows-10, N).
	pasteGateRows = regexp.MustCompile(`Math\.max\(0,Math\.min\([\w$]+-10,(\d+)\)\);if\([\w$]+\.length>([\w$]+)\|\|`)
)

// readPasteLimits scans the binary for both handlers, then for the unit limit
// they share, and returns the strictest reading. Every handler and the
// constant must be found, so a changed shape is an error rather than a pass.
func readPasteLimits(path string) (pasteLimits, error) {
	var mintVar, rowsVar string
	breaks := -1
	take := func(b int) {
		if breaks < 0 || b < breaks {
			breaks = b
		}
	}
	err := scanWindows(path, func(buf []byte) {
		// A plain search first: the regexes are slow over 240 MB.
		if mintVar == "" && bytes.Contains(buf, []byte("mintTextPaste")) {
			m := pasteGateMint.FindSubmatch(buf)
			if m == nil {
				return
			}
			mintVar = string(m[1])
			b, _ := strconv.Atoi(string(m[2]))
			take(b)
		}
		if rowsVar == "" && bytes.Contains(buf, []byte("Math.min(")) {
			m := pasteGateRows.FindSubmatch(buf)
			if m == nil {
				return
			}
			rowsVar = string(m[2])
			b, _ := strconv.Atoi(string(m[1]))
			take(b)
		}
	})
	switch {
	case err != nil:
		return pasteLimits{}, err
	case mintVar == "":
		return pasteLimits{}, errShape("the editor's paste handler (…length>X||N>2)){…mintTextPaste)")
	case rowsVar == "":
		return pasteLimits{}, errShape("the prompt's paste handler (Math.max(0,Math.min(rows-10,N));if(…length>X||)")
	}
	units := -1
	for _, v := range []string{mintVar, rowsVar} {
		re := regexp.MustCompile(`[,;\s]` + regexp.QuoteMeta(v) + `=(\d+)[,;]`)
		found := -1
		if err := scanWindows(path, func(buf []byte) {
			if found >= 0 || !bytes.Contains(buf, []byte(v+"=")) {
				return
			}
			if m := re.FindSubmatch(buf); m != nil {
				found, _ = strconv.Atoi(string(m[1]))
			}
		}); err != nil {
			return pasteLimits{}, err
		}
		if found < 0 {
			return pasteLimits{}, errShape("the unit limit " + v + "=<number>")
		}
		if units < 0 || found < units {
			units = found
		}
	}
	return pasteLimits{units: units, breaks: breaks}, nil
}

// scanWindows hands `see` the file in overlapping 8 MiB windows, so a match
// across a window's edge is still seen whole in one of them.
func scanWindows(path string, see func([]byte)) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	const window, overlap = 8 << 20, 4 << 10
	r := bufio.NewReaderSize(f, window)
	buf := make([]byte, 0, window+overlap)
	chunk := make([]byte, window)
	for {
		n, rerr := io.ReadFull(r, chunk)
		buf = append(buf, chunk[:n]...)
		see(buf)
		if rerr != nil {
			return nil
		}
		keep := append([]byte(nil), buf[len(buf)-overlap:]...)
		buf = append(buf[:0], keep...)
	}
}

type errShape string

func (e errShape) Error() string { return "not found: " + string(e) }

// The reader itself, on stand-in binaries: the shape 2.1.283 has, a CLI that
// lowered its limits, and one whose handler changed shape.
func TestReadPasteLimits(t *testing.T) {
	const pad = "\x00\x01junk;"
	for _, tc := range []struct {
		name, body string
		want       pasteLimits
		bad        bool
	}{
		{"2.1.283", pad + `if(h&&(b.length>t8||M>2)){let A=f.mintTextPaste(b)` + pad +
			`let Xh=Math.max(0,Math.min(sr-10,2));if(vm.length>t8||nb>Xh){` + pad + `var q=1, t8=800,EDe=1e4;`,
			pasteLimits{units: 800, breaks: 2}, false},
		{"lowered", pad + `if(h&&(b.length>Q$||M>1)){let A=f.mintTextPaste(b)` + pad +
			`let Xh=Math.max(0,Math.min(sr-10,1));if(vm.length>Q$||nb>Xh){` + pad + `;Q$=500;`,
			pasteLimits{units: 500, breaks: 1}, false},
		{"reshaped", pad + `if(isLargePaste(b)){mint(b)}` + pad + `t8=800;`, pasteLimits{}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "claude")
			if err := os.WriteFile(path, []byte(tc.body), 0o600); err != nil {
				t.Fatal(err)
			}
			got, err := readPasteLimits(path)
			if tc.bad {
				if err == nil {
					t.Fatalf("read %+v from a binary with no recognisable handler, want an error", got)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("readPasteLimits = %+v, %v; want %+v", got, err, tc.want)
			}
		})
	}
}
