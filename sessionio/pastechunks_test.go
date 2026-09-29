package sessionio

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

// chunkBreaks counts the line breaks Claude Code counts in a paste: any of
// \r\n, \r or \n, where this counts \r\n as two, which is the stricter reading.
func chunkBreaks(s string) int { return strings.Count(s, "\r") + strings.Count(s, "\n") }

// chunkUnits measures a paste the way Claude Code does: in UTF-16 units, after
// it has replaced every tab with four spaces (CLI 2.1.283, read from the
// binary on 2026-09-29).
func chunkUnits(s string) int {
	return len(utf16.Encode([]rune(strings.ReplaceAll(s, "\t", "    "))))
}

// Every chunk must stay under the size at which Claude Code 2.1.283 collapses
// a paste into "[Pasted text #N +M lines]" and records it wrapped in
// <pasted_content>, which tells the model the words are not the user's own.
func TestPasteChunksStayUnderTheCollapseLimits(t *testing.T) {
	long := "Reply with only the word PEAR. " + strings.Repeat("filler is here to pad the line ", 40)
	for _, tc := range []struct {
		name, text string
		want       int // chunk count; 0 = do not check
	}{
		{"empty", "", 1},
		{"one short line", "say banana", 1},
		{"two lines go as one paste", "New task.\nReply with BANANA", 1},
		{"three lines", "a\nb\nc", 2},
		{"six lines", "one\ntwo\nthree\nfour\nfive\nsix", 3},
		{"blank lines", "Reply FIG.\n\n\n\n\n\nsecond\n  indented", 0},
		{"a long single line", long, 2},
		{"a line with no spaces", strings.Repeat("0123456789abcdef", 200), 0},
		{"wide characters", strings.Repeat("日本語のテキスト ", 200), 0},
		{"astral characters", strings.Repeat("😀", 700), 0},
		{"crlf", "a\r\nb\r\nc\r\nd", 0},
		{"a path mid-sentence", "What is in /var/lib/clipboard-store/u/s/a.png ?\nand this\nand that", 0},
		{"tabs, which the CLI widens to four spaces", strings.Repeat("\tx", 400), 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			chunks := pasteChunks(tc.text)
			if got := strings.Join(chunks, ""); got != tc.text {
				t.Fatalf("chunks do not join back to the text:\n got %q\nwant %q", got, tc.text)
			}
			if tc.want != 0 && len(chunks) != tc.want {
				t.Fatalf("%d chunks, want %d: %q", len(chunks), tc.want, chunks)
			}
			for i, c := range chunks {
				if n := chunkBreaks(c); n > pasteChunkBreaks {
					t.Fatalf("chunk %d has %d line breaks, limit %d: %q", i, n, pasteChunkBreaks, c)
				}
				if n := chunkUnits(c); n > pasteChunkUnits {
					t.Fatalf("chunk %d is %d UTF-16 units, limit %d", i, n, pasteChunkUnits)
				}
				if !utf8.ValidString(c) {
					t.Fatalf("chunk %d splits a character: %q", i, c)
				}
				if c == "" && tc.text != "" {
					t.Fatalf("chunk %d is empty", i)
				}
			}
		})
	}
}

// A long line is cut after a space where there is one, so a word or a path is
// never split across two pastes. A picture's path ends a paste of its own
// (TestPasteChunksEndAPasteAfterEveryPicturesPath).
func TestPasteChunksCutALongLineAtASpace(t *testing.T) {
	path := "/var/lib/clipboard-store/wizard/demo/file-20260928-101010-0123abcd-shot.png"
	text := strings.Repeat("word ", 120) + path + " " + strings.Repeat("more ", 120)
	chunks := pasteChunks(text)
	for i, c := range chunks {
		if i > 0 && !strings.HasSuffix(chunks[i-1], " ") && !strings.HasSuffix(chunks[i-1], path) {
			t.Fatalf("chunk %d does not start after a space or a picture: %q", i, c)
		}
		if strings.Contains(c, "/var/lib") && !strings.Contains(c, path) {
			t.Fatalf("the path was split: %q", c)
		}
	}
}

// pastes splits what a raw-mode pane received into the bodies of its
// bracketed pastes, failing on anything outside one.
func pastes(t *testing.T, raw string) []string {
	t.Helper()
	const open, closer = "\x1b[200~", "\x1b[201~"
	var out []string
	for rest := raw; rest != ""; {
		body, ok := strings.CutPrefix(rest, open)
		if !ok {
			// The Enter after the last paste, and nothing else.
			if strings.Trim(rest, "\r") != "" {
				t.Fatalf("bytes outside a paste: %q", rest)
			}
			break
		}
		end := strings.Index(body, closer)
		if end < 0 {
			t.Fatalf("an unterminated paste: %q", body)
		}
		out = append(out, body[:end])
		rest = body[end+len(closer):]
	}
	return out
}

// The defect, measured 2026-09-28 on Claude Code 2.1.283: every Text view send
// was ONE bracketed paste, and a paste over 800 characters or 2 line breaks
// reached Claude as <pasted_content>, which it declined to act on ("You pasted
// it without a message of your own"). The same words sent as pastes under
// those limits were recorded as typed and followed. The pane here is a
// raw-mode cat that enables bracketed paste, so it receives exactly what a
// Claude pane would.
func TestPromptSendsALongMessageAsPastesClaudeKeepsInline(t *testing.T) {
	in, osUser, sock := scratchSession(t)
	out := filepath.Join(t.TempDir(), "received")
	if err := exec.Command("tmux", "-L", sock, "new-session", "-d", "-s", "raw",
		"sh", "-c", `stty raw -echo; printf '\033[?2004h'; exec cat > `+out).Run(); err != nil {
		t.Fatalf("new-session: %v", err)
	}
	time.Sleep(200 * time.Millisecond)

	text := "New task.\nStep one: think of a fruit.\nStep two: make it yellow.\n" +
		"Step three: " + strings.Repeat("keep going with more words ", 40) + "\nStep four.\nReply with the fruit."
	if err := in.Prompt(osUser, "raw", text); err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	// tmux paste-buffer turns each LF into CR.
	want := strings.ReplaceAll(text, "\n", "\r")
	deadline := time.Now().Add(3 * time.Second)
	var got []byte
	for {
		got, _ = os.ReadFile(out)
		if strings.Contains(string(got), "fruit.\x1b[201~\r") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the prompt never fully arrived; got %q", got)
		}
		time.Sleep(50 * time.Millisecond)
	}
	// C-e C-u (a shell pane with no box) arrive first.
	raw := strings.TrimPrefix(string(got), "\x05\x15")
	bodies := pastes(t, raw)
	if len(bodies) < 3 {
		t.Fatalf("%d pastes, want the message split into several: %q", len(bodies), bodies)
	}
	if strings.Join(bodies, "") != want {
		t.Fatalf("the pastes do not add up to the message:\n got %q\nwant %q", strings.Join(bodies, ""), want)
	}
	for i, b := range bodies {
		if chunkBreaks(b) > pasteChunkBreaks || chunkUnits(b) > pasteChunkUnits {
			t.Fatalf("paste %d would be collapsed: %d breaks, %d units", i, chunkBreaks(b), chunkUnits(b))
		}
	}
}

// Claude Code attaches a picture from a path only when the path ends a paste:
// "Name this colour. <path>" is attached as [Image #1], "<path> Name this
// colour." is sent as text, and Claude then reads the file with its Read tool,
// which asks permission in Manual, Edits and Plan mode for a folder outside
// the project (measured on CLI 2.1.283, 2026-09-29; deployed review round 5:
// every photo sent from a phone asked to read the lobby's upload folder). So
// every picture's path ends a paste of its own.
func TestPasteChunksEndAPasteAfterEveryPicturesPath(t *testing.T) {
	for _, tc := range []struct {
		name, text string
		want       []string
	}{
		{"picture first", "/var/lib/clipboard-store/u/s/pasted-1.png second picture message",
			[]string{"/var/lib/clipboard-store/u/s/pasted-1.png", " second picture message"}},
		{"picture last", "Name this colour. /var/tmp/x/red.PNG",
			[]string{"Name this colour. /var/tmp/x/red.PNG"}},
		{"two pictures", "/a/one.jpg /a/two.webp compare them",
			[]string{"/a/one.jpg", " /a/two.webp", " compare them"}},
		{"not a picture", "/var/tmp/notes.txt read this", []string{"/var/tmp/notes.txt read this"}},
		{"a relative name", "red.png is the file", []string{"red.png is the file"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := pasteChunks(tc.text); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("pasteChunks = %q, want %q", got, tc.want)
			}
		})
	}
}
