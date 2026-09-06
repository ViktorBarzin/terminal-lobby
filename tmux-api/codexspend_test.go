package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The fixtures under testdata/codex are real rollout shapes with the model
// instructions trimmed out. nowFixture sits between the 5-hour reset the
// current fixture names (1788730052) and the weekly one (1788757961), so a
// window is expired or not by arithmetic rather than by when the suite runs.
var nowFixture = time.Unix(1788730000, 0).UTC()

type fixtureRollout struct {
	fixture string // a file under testdata/codex
	day     string // the YYYY/MM/DD directory it is filed under
	stamp   string // the timestamp in the filename
	id      string // the conversation uuid in the filename
	age     time.Duration
}

// codexHome lays out a temp $HOME the way Codex lays out its own: one file per
// conversation under sessions/YYYY/MM/DD. age backdates the mtime, which is how
// the reader orders candidates.
func codexHome(t *testing.T, files ...fixtureRollout) string {
	t.Helper()
	home := t.TempDir()
	for _, f := range files {
		raw, err := os.ReadFile(filepath.Join("testdata", "codex", f.fixture))
		if err != nil {
			t.Fatalf("read fixture %s: %v", f.fixture, err)
		}
		dir := filepath.Join(home, ".codex", "sessions", filepath.FromSlash(f.day))
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(dir, fmt.Sprintf("rollout-%s-%s.jsonl", f.stamp, f.id))
		if err := os.WriteFile(path, raw, 0o600); err != nil {
			t.Fatal(err)
		}
		when := nowFixture.Add(-f.age)
		if err := os.Chtimes(path, when, when); err != nil {
			t.Fatal(err)
		}
	}
	return home
}

func currentFixture() fixtureRollout {
	return fixtureRollout{
		fixture: "current.jsonl", day: "2026/09/06",
		stamp: "2026-09-06T19-22-53", id: "01a0782c-7052-7920-a671-9b9e209750be",
	}
}

// What the reader gets back from each rollout shape we have measured. The
// window labels come from window_minutes rather than from the slot the CLI put
// the window in: August's build reported the weekly limit as "primary".
func TestReadCodexSpendAcrossRolloutShapes(t *testing.T) {
	for _, tc := range []struct {
		name  string
		files []fixtureRollout
		want  codexReading
	}{
		{
			name:  "the current shape names both windows",
			files: []fixtureRollout{currentFixture()},
			want: codexReading{
				Found: true,
				Plan:  "plus",
				Windows: []codexWindow{
					{Label: "5-hour limit", WindowMinutes: 300, UsedPercent: 2, ResetsAtSec: 1788730052},
					{Label: "weekly limit", WindowMinutes: 10080, UsedPercent: 4, ResetsAtSec: 1788757961},
				},
				Credits: codexCredits{Balance: "0"},
				Newest: codexRollout{
					SessionID: "01a0782c-7052-7920-a671-9b9e209750be",
					Model:     "gpt-6-astra",
					Tokens: codexTokens{
						Input: 20529, CachedInput: 12160, Output: 5, Total: 20534,
					},
					ContextWindow: 258400,
					At:            time.Date(2026, 9, 6, 19, 23, 3, 179000000, time.UTC),
				},
			},
		},
		{
			name: "the August shape has one window and a null secondary",
			files: []fixtureRollout{{
				fixture: "august.jsonl", day: "2026/08/16",
				stamp: "2026-08-16T11-42-09", id: "01a00a61-13a8-71d2-b285-c2e7cd4f29ba",
			}},
			want: codexReading{
				Found: true,
				Plan:  "plus",
				Windows: []codexWindow{
					{Label: "weekly limit", WindowMinutes: 10080, UsedPercent: 12, ResetsAtSec: 1788740000},
				},
				Credits: codexCredits{Balance: "0"},
				Newest: codexRollout{
					SessionID: "01a00a61-13a8-71d2-b285-c2e7cd4f29ba",
					Model:     "gpt-5-codex",
					Tokens: codexTokens{
						Input: 9001, CachedInput: 4096, Output: 77, ReasoningOutput: 12, Total: 9090,
					},
					ContextWindow: 272000,
					At:            time.Date(2026, 8, 16, 11, 43, 11, 466000000, time.UTC),
				},
			},
		},
		{
			name: "a half-written final line is skipped for the last whole one",
			files: []fixtureRollout{{
				fixture: "truncated.jsonl", day: "2026/09/06",
				stamp: "2026-09-06T19-22-53", id: "01a0782c-7052-7920-a671-9b9e209750bf",
			}},
			want: codexReading{
				Found: true,
				Plan:  "plus",
				Windows: []codexWindow{
					{Label: "5-hour limit", WindowMinutes: 300, UsedPercent: 2, ResetsAtSec: 1788730052},
					{Label: "weekly limit", WindowMinutes: 10080, UsedPercent: 4, ResetsAtSec: 1788757961},
				},
				Credits: codexCredits{Balance: "0"},
				Newest: codexRollout{
					SessionID: "01a0782c-7052-7920-a671-9b9e209750bf",
					Model:     "gpt-6-astra",
					Tokens: codexTokens{
						Input: 20529, CachedInput: 12160, Output: 5, Total: 20534,
					},
					ContextWindow: 258400,
					At:            time.Date(2026, 9, 6, 19, 23, 3, 179000000, time.UTC),
				},
			},
		},
		{
			name: "a rollout with no rate limits still reports its tokens",
			files: []fixtureRollout{{
				fixture: "norate.jsonl", day: "2026/09/06",
				stamp: "2026-09-06T19-22-53", id: "01a0782c-7052-7920-a671-9b9e209750c0",
			}},
			want: codexReading{
				Found: true,
				Newest: codexRollout{
					SessionID:     "01a0782c-7052-7920-a671-9b9e209750c0",
					Model:         "gpt-6-astra",
					Tokens:        codexTokens{Input: 1234, Output: 56, Total: 1290},
					ContextWindow: 258400,
					At:            time.Date(2026, 9, 6, 19, 23, 3, 179000000, time.UTC),
				},
			},
		},
		{
			name: "a window that has already reset is dropped",
			files: []fixtureRollout{{
				fixture: "expired.jsonl", day: "2026/09/06",
				stamp: "2026-09-06T19-22-53", id: "01a0782c-7052-7920-a671-9b9e209750c1",
			}},
			want: codexReading{
				Found: true,
				Plan:  "plus",
				Windows: []codexWindow{
					{Label: "weekly limit", WindowMinutes: 10080, UsedPercent: 4, ResetsAtSec: 1788757961},
				},
				Credits: codexCredits{Balance: "0"},
				Newest: codexRollout{
					SessionID: "01a0782c-7052-7920-a671-9b9e209750c1",
					Model:     "gpt-6-astra",
					Tokens: codexTokens{
						Input: 20529, CachedInput: 12160, Output: 5, Total: 20534,
					},
					ContextWindow: 258400,
					At:            time.Date(2026, 9, 6, 19, 23, 3, 179000000, time.UTC),
				},
			},
		},
		{
			name: "the newest turn named no limits, so the last turn that did is the reading",
			files: []fixtureRollout{{
				fixture: "latelimits.jsonl", day: "2026/09/06",
				stamp: "2026-09-06T19-22-53", id: "01a0782c-7052-7920-a671-9b9e209750c3",
			}},
			want: codexReading{
				Found: true,
				Plan:  "plus",
				Windows: []codexWindow{
					{Label: "5-hour limit", WindowMinutes: 300, UsedPercent: 2, ResetsAtSec: 1788730052},
					{Label: "weekly limit", WindowMinutes: 10080, UsedPercent: 4, ResetsAtSec: 1788757961},
				},
				Credits: codexCredits{Balance: "0"},
				Newest: codexRollout{
					SessionID: "01a0782c-7052-7920-a671-9b9e209750c3",
					Model:     "gpt-6-astra",
					Tokens: codexTokens{
						Input: 20529, CachedInput: 12160, Output: 5, Total: 20534,
					},
					ContextWindow: 258400,
					At:            time.Date(2026, 9, 6, 19, 23, 3, 179000000, time.UTC),
				},
			},
		},
		{
			name:  "a box that has never run Codex reads as nothing, not as an error",
			files: nil,
			want:  codexReading{},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			home := codexHome(t, tc.files...)
			got, err := codexSpendReader{home: home}.read(nil, nowFixture)
			if err != nil {
				t.Fatalf("read: %v", err)
			}
			assertCodexReading(t, got, tc.want)
		})
	}
}

// The newest conversation is the one whose numbers describe the account right
// now, and mtime is what says which that is: a resumed rollout keeps the
// filename it was created with.
func TestReadCodexSpendPrefersTheMostRecentlyWrittenRollout(t *testing.T) {
	home := codexHome(t,
		fixtureRollout{
			fixture: "august.jsonl", day: "2026/08/16",
			stamp: "2026-08-16T11-42-09", id: "01a00a61-13a8-71d2-b285-c2e7cd4f29ba",
			age: time.Hour,
		},
		fixtureRollout{
			fixture: "current.jsonl", day: "2026/09/06",
			stamp: "2026-09-06T19-22-53", id: "01a0782c-7052-7920-a671-9b9e209750be",
		},
	)
	got, err := codexSpendReader{home: home}.read(nil, nowFixture)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(got.Windows) != 2 {
		t.Fatalf("windows from the newest rollout: got %+v", got.Windows)
	}
	if got.Newest.SessionID != "01a0782c-7052-7920-a671-9b9e209750be" {
		t.Errorf("read the wrong rollout: %s", got.Newest.SessionID)
	}
}

// A conversation that has not finished a turn has written no token_count, and
// answering "no Codex here" because the newest file happens to be that one
// would blank the panel every time somebody opens a fresh session.
func TestReadCodexSpendFallsBackWhenTheNewestRolloutHasNoTurnYet(t *testing.T) {
	home := codexHome(t,
		fixtureRollout{
			fixture: "current.jsonl", day: "2026/09/06",
			stamp: "2026-09-06T19-22-53", id: "01a0782c-7052-7920-a671-9b9e209750be",
			age: time.Hour,
		},
		fixtureRollout{
			fixture: "noturn.jsonl", day: "2026/09/06",
			stamp: "2026-09-06T19-30-00", id: "01a0782c-7052-7920-a671-9b9e209750c2",
		},
	)
	got, err := codexSpendReader{home: home}.read(nil, nowFixture)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !got.Found || got.Plan != "plus" {
		t.Fatalf("fell through to nothing: %+v", got)
	}
	if got.Newest.SessionID != "01a0782c-7052-7920-a671-9b9e209750be" {
		t.Errorf("read back %s, want the rollout that has a turn in it", got.Newest.SessionID)
	}
}

// The reader tails a bounded number of bytes because these files reach 26 MB on
// this box. A token_count that far from the end is deliberately out of reach,
// and the cost of that choice is worth having a test say out loud.
func TestReadCodexSpendStopsShortOfAHugeFile(t *testing.T) {
	home := codexHome(t, currentFixture())
	path := filepath.Join(home, ".codex", "sessions", "2026", "09", "06",
		"rollout-2026-09-06T19-22-53-01a0782c-7052-7920-a671-9b9e209750be.jsonl")
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	filler := `{"timestamp":"2026-09-06T19:24:00.000Z","type":"response_item","payload":{"type":"message","text":"` +
		strings.Repeat("x", 4000) + `"}}` + "\n"
	for written := 0; written < codexTailBudget+len(filler); written += len(filler) {
		if _, err := f.WriteString(filler); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}

	got, err := codexSpendReader{home: home}.read(nil, nowFixture)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if got.Found {
		t.Fatalf("read past the tail budget: %+v", got)
	}
}

// Reading backwards means stitching a line that straddles a chunk boundary.
// This lays the file out so a boundary falls INSIDE the token_count line: the
// first chunk holds its tail, the next holds its head, and only joining the two
// reads back. Dropping the join loses the whole reading, which is the quiet
// failure this guards.
func TestReadCodexSpendStitchesLinesAcrossChunks(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "codex", "current.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")
	tokenLine := lines[len(lines)-1]
	head := strings.Join(lines[:len(lines)-1], "\n") + "\n"

	// Put the boundary at len(head) + len(tokenLine)/2, counted back from EOF.
	filler := codexTailChunk - len(tokenLine)/2
	if filler < 2 {
		t.Fatalf("fixture line of %d bytes is too long for this layout", len(tokenLine))
	}
	body := head + tokenLine + "\n" + strings.Repeat("x", filler-2) + "\n"

	home := t.TempDir()
	dir := filepath.Join(home, ".codex", "sessions", "2026", "09", "06")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "rollout-2026-09-06T19-22-53-01a0782c-7052-7920-a671-9b9e209750be.jsonl")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := len(body) - codexTailChunk; got <= len(head) || got >= len(head)+len(tokenLine) {
		t.Fatalf("the boundary landed at %d, outside the token_count line at %d..%d",
			got, len(head), len(head)+len(tokenLine))
	}

	got, err := codexSpendReader{home: home}.read(nil, nowFixture)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !got.Found || got.Newest.Tokens.Total != 20534 {
		t.Fatalf("lost the reading across the chunk boundary: %+v", got)
	}
	if len(got.Windows) != 2 {
		t.Errorf("windows: got %+v, want both", got.Windows)
	}
}

// Attribution: a rollout belongs to a tmux session when a live codex process
// under that session's pane holds the file open. Nothing in the rollout itself
// names a tmux session, so this is the only link there is.
func TestReadCodexSpendAttributesLiveRolloutsToTheirPanes(t *testing.T) {
	home := codexHome(t, currentFixture())
	rollout := filepath.Join(home, ".codex", "sessions", "2026", "09", "06",
		"rollout-2026-09-06T19-22-53-01a0782c-7052-7920-a671-9b9e209750be.jsonl")
	procDir := fakeProc(t, []fakeProcEntry{
		{pid: 900, ppid: 1, comm: "bash"},
		{pid: 901, ppid: 900, comm: "node"},
		{pid: 902, ppid: 901, comm: "codex", open: []string{rollout}},
	})

	got, err := codexSpendReader{home: home, procDir: procDir}.read(
		[]codexPane{{Session: "work", PID: 900}}, nowFixture)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(got.Sessions) != 1 {
		t.Fatalf("attributed rows: got %+v, want one", got.Sessions)
	}
	row := got.Sessions[0]
	if row.TmuxSession != "work" {
		t.Errorf("tmux session: got %q, want work", row.TmuxSession)
	}
	if row.Tokens.Total != 20534 || row.Model != "gpt-6-astra" {
		t.Errorf("attributed row carries the wrong reading: %+v", row)
	}
	if got.Newest.TmuxSession != "work" {
		t.Errorf("the newest rollout is that same live one, so it takes the name too: %+v", got.Newest)
	}
}

// A pane running a shell, or a codex whose rollout we cannot see, leaves the
// account-wide reading alone rather than inventing a row.
func TestReadCodexSpendReturnsAccountWideWhenNothingCanBeAttributed(t *testing.T) {
	home := codexHome(t, currentFixture())
	procDir := fakeProc(t, []fakeProcEntry{
		{pid: 900, ppid: 1, comm: "bash"},
		{pid: 901, ppid: 900, comm: "vim"},
	})

	got, err := codexSpendReader{home: home, procDir: procDir}.read(
		[]codexPane{{Session: "work", PID: 900}}, nowFixture)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(got.Sessions) != 0 {
		t.Fatalf("attributed rows: got %+v, want none", got.Sessions)
	}
	if !got.Found || len(got.Windows) != 2 {
		t.Errorf("the account-wide reading should survive: %+v", got)
	}
	if got.Newest.TmuxSession != "" {
		t.Errorf("an unattributed rollout must not carry a session name: %q", got.Newest.TmuxSession)
	}
}

// window_minutes is self-describing, so the label comes from the number. Codex
// calls 300 minutes the "5-hour limit" and 10080 the "weekly limit"; the rest
// are formatted rather than guessed at.
func TestCodexWindowLabel(t *testing.T) {
	for _, tc := range []struct {
		minutes int
		want    string
	}{
		{300, "5-hour limit"},
		{10080, "weekly limit"},
		{60, "1-hour limit"},
		{1440, "1-day limit"},
		{4320, "3-day limit"},
		{45, "45-minute limit"},
		{0, "limit"},
		{-5, "limit"},
	} {
		if got := codexWindowLabel(tc.minutes); got != tc.want {
			t.Errorf("codexWindowLabel(%d): got %q, want %q", tc.minutes, got, tc.want)
		}
	}
}

// --- fake /proc --------------------------------------------------------------

type fakeProcEntry struct {
	pid, ppid int
	comm      string
	open      []string
}

// fakeProc builds the shape procTreeFrom reads (a stat file per pid) plus the
// fd symlinks the rollout attribution walks.
func fakeProc(t *testing.T, entries []fakeProcEntry) string {
	t.Helper()
	root := t.TempDir()
	for _, e := range entries {
		dir := filepath.Join(root, fmt.Sprint(e.pid))
		if err := os.MkdirAll(filepath.Join(dir, "fd"), 0o700); err != nil {
			t.Fatal(err)
		}
		stat := fmt.Sprintf("%d (%s) S %d 0 0 0 -1 0\n", e.pid, e.comm, e.ppid)
		if err := os.WriteFile(filepath.Join(dir, "stat"), []byte(stat), 0o600); err != nil {
			t.Fatal(err)
		}
		for i, target := range e.open {
			link := filepath.Join(dir, "fd", fmt.Sprint(i+3))
			if err := os.Symlink(target, link); err != nil {
				t.Fatal(err)
			}
		}
	}
	return root
}

// --- assertions --------------------------------------------------------------

func assertCodexReading(t *testing.T, got, want codexReading) {
	t.Helper()
	if got.Found != want.Found {
		t.Errorf("found: got %v, want %v", got.Found, want.Found)
	}
	if got.Plan != want.Plan {
		t.Errorf("plan: got %q, want %q", got.Plan, want.Plan)
	}
	if got.Credits != want.Credits {
		t.Errorf("credits: got %+v, want %+v", got.Credits, want.Credits)
	}
	if len(got.Windows) != len(want.Windows) {
		t.Fatalf("windows: got %+v, want %+v", got.Windows, want.Windows)
	}
	for i := range want.Windows {
		if got.Windows[i] != want.Windows[i] {
			t.Errorf("window %d: got %+v, want %+v", i, got.Windows[i], want.Windows[i])
		}
	}
	assertCodexRollout(t, got.Newest, want.Newest)
}

func assertCodexRollout(t *testing.T, got, want codexRollout) {
	t.Helper()
	if got.SessionID != want.SessionID {
		t.Errorf("session id: got %q, want %q", got.SessionID, want.SessionID)
	}
	if got.Model != want.Model {
		t.Errorf("model: got %q, want %q", got.Model, want.Model)
	}
	if got.Tokens != want.Tokens {
		t.Errorf("tokens: got %+v, want %+v", got.Tokens, want.Tokens)
	}
	if got.ContextWindow != want.ContextWindow {
		t.Errorf("context window: got %d, want %d", got.ContextWindow, want.ContextWindow)
	}
	if !got.At.Equal(want.At) {
		t.Errorf("taken at: got %s, want %s", got.At, want.At)
	}
}
