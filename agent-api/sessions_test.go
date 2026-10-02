package main

import (
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"testing"

	"terminal-lobby/sessionio"
)

// A stamped transcript whose file is not there is an ordinary state, not a
// fault. Measured on the devvm 2026-09-16: 7 of 25 stamped sessions were in
// it, and before this classification every one of them answered 500.
func TestTranscriptReadError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want error // errNoTranscript, or nil meaning "a real error"
	}{
		{"the file is not there yet", fs.ErrNotExist, errNoTranscript},
		{"wrapped by os.Open", &fs.PathError{Op: "open", Path: "/x.jsonl", Err: fs.ErrNotExist}, errNoTranscript},
		{"permission denied is a real fault", &fs.PathError{Op: "open", Path: "/x.jsonl", Err: fs.ErrPermission}, nil},
		{"an I/O error is a real fault", errors.New("input/output error"), nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := transcriptReadError("/home/wizard/.claude/projects/-home-wizard/abc.jsonl", c.err)
			if c.want != nil {
				if !errors.Is(got, errNoTranscript) {
					t.Fatalf("got %v, want errNoTranscript", got)
				}
				return
			}
			if errors.Is(got, errNoTranscript) {
				t.Fatalf("a real fault was classified as a missing transcript: %v", got)
			}
			// A real fault keeps its cause and names the file, so an operator
			// can find it.
			if !errors.Is(got, c.err) || !strings.Contains(got.Error(), "abc.jsonl") {
				t.Fatalf("got %v, which loses the cause or the file name", got)
			}
		})
	}
}

// And the handler turns that classification into the right status: a
// conversation with nothing to read is a 404, a broken box is a 500.
func TestTranscriptStatusFollowsTheClassification(t *testing.T) {
	for _, c := range []struct {
		name string
		err  error
		want int
	}{
		{"no transcript yet", errNoTranscript, http.StatusNotFound},
		{"a real fault", errors.New("input/output error"), http.StatusInternalServerError},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t)
			h.sessions.start(testOSUser, LiveSession{Name: "c1", Owner: testActor})
			h.sessions.transcriptErr = c.err
			h.decodeJSON(h.call("GET", "/v1/conversations/c1/transcript", ""), c.want, nil)
		})
	}
}

// The real adapter reads a real file through sessionio's containment rule.
// Driven without tmux: SessionMap takes an Options, and a fake one is all a
// stamp read needs.
func TestTmuxSessionsTranscriptLines(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, testOSUser, ".claude", "projects", "-home-wizard-code")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	transcript := filepath.Join(root, "abc.jsonl")
	body := assistantLine("hello", "2026-09-16T11:00:00Z") + "\n"
	if err := os.WriteFile(transcript, []byte(body), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	// A path OUTSIDE the projects root, which the stamp must not be able to
	// make this service read. The stamp is written by the session's own OS
	// user, so it is untrusted input.
	outside := filepath.Join(base, "secret.jsonl")
	if err := os.WriteFile(outside, []byte(assistantLine("private", "2026-09-16T11:00:00Z")), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	for _, c := range []struct {
		name  string
		stamp string
		want  int // lines, or -1 for a refusal
	}{
		{"a stamped transcript", transcript, 1},
		{"a stamp outside the projects root", outside, -1},
		{"a stamp pointing at a file that is not there", filepath.Join(root, "gone.jsonl"), -1},
		{"no stamp at all", "", -1},
	} {
		t.Run(c.name, func(t *testing.T) {
			opts := newStampStore(testOSUser, "c1", c.stamp)
			ts := &tmuxSessions{in: nil, homeBase: base, options: opts}
			lines, err := ts.TranscriptLines(testOSUser, "c1")
			if c.want < 0 {
				if !errors.Is(err, errNoTranscript) {
					t.Fatalf("got %d lines, err %v; want errNoTranscript", len(lines), err)
				}
				return
			}
			if err != nil {
				t.Fatalf("err %v", err)
			}
			if len(lines) != c.want {
				t.Fatalf("got %d lines, want %d", len(lines), c.want)
			}
		})
	}
}

// When the mod never says hello, @claude_transcript is never written, and
// the path agent-api stamped at create is the only way to the turn's answer.
// The hint is held to the same containment rule as the mod's stamp, and the
// mod's stamp wins when both are there: a /clear moves Claude to a new file,
// and only the mod knows which.
func TestTmuxSessionsTranscriptLinesFallsBackToTheCreateHint(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, testOSUser, ".claude", "projects", "-home-wizard-code")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	write := func(name string, lines int) string {
		p := filepath.Join(root, name)
		body := strings.Repeat(assistantLine("x", "2026-09-16T11:00:00Z")+"\n", lines)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
		return p
	}
	hinted := write("hinted.jsonl", 2)
	stamped := write("stamped.jsonl", 3)
	outside := filepath.Join(base, "secret.jsonl")
	if err := os.WriteFile(outside, []byte(assistantLine("private", "2026-09-16T11:00:00Z")), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	for _, c := range []struct {
		name        string
		stamp, hint string
		want        int // lines, or -1 for errNoTranscript
	}{
		{"only the create hint", "", hinted, 2},
		{"the mod's stamp wins over the hint", stamped, hinted, 3},
		{"a hint outside the projects root", "", outside, -1},
		{"a hint naming a file not written yet", "", filepath.Join(root, "later.jsonl"), -1},
		{"neither", "", "", -1},
	} {
		t.Run(c.name, func(t *testing.T) {
			opts := optionMap{
				"@claude_transcript": c.stamp,
				OptionTranscriptHint: c.hint,
			}
			ts := &tmuxSessions{in: nil, homeBase: base, options: opts}
			lines, err := ts.TranscriptLines(testOSUser, "c1")
			if c.want < 0 {
				if !errors.Is(err, errNoTranscript) {
					t.Fatalf("got %d lines, err %v; want errNoTranscript", len(lines), err)
				}
				return
			}
			if err != nil || len(lines) != c.want {
				t.Fatalf("got %d lines, err %v; want %d", len(lines), err, c.want)
			}
		})
	}
}

// optionMap is a sessionio.Options for one session, by option name.
type optionMap map[string]string

func (m optionMap) Option(osUser, session, name string) (string, bool) {
	if osUser != testOSUser || session != "c1" {
		return "", false
	}
	return m[name], true
}

func (m optionMap) SetOption(osUser, session, name, value string) error { return nil }

// stampStore is a sessionio.Options holding one session's @claude_transcript.
type stampStore struct{ osUser, session, stamp string }

func newStampStore(osUser, session, stamp string) *stampStore {
	return &stampStore{osUser, session, stamp}
}

func (s *stampStore) Option(osUser, session, name string) (string, bool) {
	if osUser != s.osUser || session != s.session {
		return "", false
	}
	return s.stamp, true
}

func (s *stampStore) SetOption(osUser, session, name, value string) error { return nil }

// The suspend mark is read from the column it is in, and its PRESENCE is what
// counts. Tested against the format rather than through the fake, because the
// fake hands back structs and cannot be wrong about a column index — which is
// exactly the way this breaks.
func TestParseLiveSessionsReadsTheSuspendMark(t *testing.T) {
	row := func(cols ...string) string { return strings.Join(cols, "\t") }
	out := row("napping", "/home/wizard/code", "done", "muse", "/t.jsonl", "a title", "napping", "1789845000") + "\n" +
		row("awake", "/home/wizard/code", "done", "muse", "/t.jsonl", "a title", "awake", "") + "\n" +
		// A tmux that stops printing the trailing empty column must not drop
		// the session out of the list.
		row("short", "/home/wizard/code", "running", "muse", "/t.jsonl", "", "short") + "\n"

	got := parseLiveSessions([]byte(out))
	if len(got) != 3 {
		t.Fatalf("parsed %d rows, want 3: %+v", len(got), got)
	}
	if !got[0].Suspended {
		t.Errorf("%q was not read as suspended", got[0].Name)
	}
	if got[1].Suspended || got[2].Suspended {
		t.Errorf("a live session was read as suspended: %+v", got[1:])
	}
	// The columns ahead of it still land where they did.
	if got[0].Owner != "muse" || got[0].BornAs != "napping" || got[0].State != "done" {
		t.Errorf("the mark shifted the row: %+v", got[0])
	}
}

// The production Kill against an ISOLATED tmux server (its own -L socket, so
// it cannot reach a real session): the session goes, and the tombstone is
// written for the name it has now and the name it was born with, because a
// snapshot taken before tmux-api renamed it recorded the first.
func TestTmuxSessionsKillTombstonesBothNames(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available")
	}
	u, err := user.Current()
	if err != nil {
		t.Skip("no current user")
	}
	sock := fmt.Sprintf("agent-api-test-%d", os.Getpid())
	tmux := func(args ...string) error {
		return exec.Command("tmux", append([]string{"-L", sock}, args...)...).Run()
	}
	t.Cleanup(func() {
		tmux("kill-server")
		// tmux leaves the socket file behind; one per run adds up.
		dir := os.Getenv("TMUX_TMPDIR")
		if dir == "" {
			dir = "/tmp"
		}
		os.Remove(filepath.Join(dir, fmt.Sprintf("tmux-%d", os.Getuid()), sock))
	})
	if err := tmux("new-session", "-d", "-s", "pong-response", "sh"); err != nil {
		t.Fatalf("new-session: %v", err)
	}
	if err := tmux("set-option", "-t", "=pong-response:", sessionio.OptionBornAs, "agent-01"); err != nil {
		t.Fatalf("set-option: %v", err)
	}

	var forgot []string
	ts := &tmuxSessions{
		in:     sessionio.NewInjectorOnSocket(u.Username, sock),
		forget: func(osUser, name string) error { forgot = append(forgot, osUser+"/"+name); return nil },
	}
	if err := ts.Kill(u.Username, "pong-response"); err != nil {
		t.Fatalf("Kill: %v", err)
	}
	if tmux("has-session", "-t", "=pong-response") == nil {
		t.Fatal("the session is still there")
	}
	want := []string{u.Username + "/pong-response", u.Username + "/agent-01"}
	if strings.Join(forgot, ",") != strings.Join(want, ",") {
		t.Fatalf("forgot %v, want %v", forgot, want)
	}
	if err := ts.Kill(u.Username, "pong-response"); !errors.Is(err, sessionio.ErrSessionGone) {
		t.Fatalf("a second kill answered %v, want ErrSessionGone", err)
	}
}
