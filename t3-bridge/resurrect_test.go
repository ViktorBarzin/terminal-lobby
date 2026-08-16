package main

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"terminal-lobby/sessionio"
)

// resurrectRig is a Resurrector with every outside edge faked: the tmux server
// is attachFakeTmux (attach_test.go), the binding index a file in a temp dir,
// and "claude" a path that is never executed because nothing here runs tmux.
type resurrectRig struct {
	t        *testing.T
	tmux     *attachFakeTmux
	bindings *Bindings
	r        *Resurrector
}

func newResurrectRig(t *testing.T) *resurrectRig {
	t.Helper()
	tmux := newAttachFakeTmux()
	bindings := OpenBindingsAt(filepath.Join(t.TempDir(), "index.json"))
	return &resurrectRig{
		t:        t,
		tmux:     tmux,
		bindings: bindings,
		r: &Resurrector{
			OSUser:    "wizard",
			Tmux:      tmux,
			ClaudeBin: "/home/wizard/.local/bin/claude",
			Bindings:  bindings,
			// The fake stamps synchronously inside NewSession, so the wait only
			// ever costs one poll; a short budget keeps a broken expectation a
			// fast failure rather than a hung test.
			wait: 2 * time.Second,
			poll: time.Millisecond,
		},
	}
}

// stampsTranscript makes the fake tmux behave like the SessionStart hook: once
// the session exists, @claude_transcript names the transcript for claudeID.
func (rig *resurrectRig) stampsTranscript(root, cwd, claudeID string) {
	rig.tmux.onNew = func(f *attachFakeTmux, spec sessionio.NewSessionSpec) {
		_ = f.SetOption("wizard", spec.Name, sessionio.OptionTranscript,
			sessionio.TranscriptPath(root, cwd, claudeID))
	}
}

const resurrectID = "6c420342-1111-2222-3333-444444444444"

func TestSlug(t *testing.T) {
	cases := []struct {
		name  string
		title string
		want  string
	}{
		{"already a session name", "feat-header", "feat-header"},
		{"spaces become dashes", "Fix the header layout", "fix-the-header-layout"},
		{"punctuation collapses", "Why is __init__.py failing?!", "why-is-__init__-py-failing"},
		{"slashes are not path separators here", "code/terminal-lobby", "code-terminal-lobby"},
		{"leading and trailing junk is trimmed", "  --wat--  ", "wat"},
		{"underscores survive", "snake_case_name", "snake_case_name"},
		{"digits survive", "issue-4271", "issue-4271"},
		// Lowercasing and transliteration arrived with session titles: the name
		// is a normalized identifier now, and a thread's own phrasing reaches
		// the lobby as the session's title instead.
		{"case is normalized away", "Fix The Header", "fix-the-header"},
		{"non-ascii is transliterated, not dropped", "café ☕ time", "cafe-time"},
		{"cyrillic survives as latin", "тестова сесия", "testova-sesiya"},
		{"a too-long title is cut to the budget", strings.Repeat("ab", 40), strings.Repeat("ab", 16)},
		{"the cut never leaves a trailing dash", strings.Repeat("a", 31) + " tail", strings.Repeat("a", 31)},
		{"nothing usable falls back", "☕☕☕", resurrectFallbackName},
		{"empty falls back", "", resurrectFallbackName},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Slug(c.title)
			if got != c.want {
				t.Errorf("Slug(%q) = %q, want %q", c.title, got, c.want)
			}
			if len(got) > MaxTmuxNameLen {
				t.Errorf("Slug(%q) = %q, which is %d characters (budget %d)", c.title, got, len(got), MaxTmuxNameLen)
			}
			if got == "" {
				t.Errorf("Slug(%q) = %q: a session cannot be created under an empty name", c.title, got)
			}
		})
	}
}

// A resurrection resumes the conversation: same uuid, same cwd, one claude.
func TestResurrectResumesIntoANewSession(t *testing.T) {
	rig := newResurrectRig(t)
	root := t.TempDir()
	rig.stampsTranscript(root, "/home/wizard/code/terminal-lobby", resurrectID)

	target, err := rig.r.Resurrect(ResurrectSpec{
		ClaudeID: resurrectID,
		Resume:   true,
		TmuxName: "feat-header",
		CWD:      "/home/wizard/code/terminal-lobby",
	})
	if err != nil {
		t.Fatalf("Resurrect: %v", err)
	}

	if len(rig.tmux.created) != 1 {
		t.Fatalf("created %d sessions, want exactly 1", len(rig.tmux.created))
	}
	spec := rig.tmux.created[0]
	if spec.Name != "feat-header" || spec.Dir != "/home/wizard/code/terminal-lobby" || spec.OSUser != "wizard" {
		t.Errorf("new-session spec = %+v, want the bound name, cwd and owner", spec)
	}
	if len(spec.Command) != 1 {
		t.Fatalf("Command = %q, want one already-quoted line (tmux re-splits several)", spec.Command)
	}
	cmd := spec.Command[0]
	for _, want := range []string{"/home/wizard/.local/bin/claude", "--resume", resurrectID} {
		if !strings.Contains(cmd, want) {
			t.Errorf("command %q does not carry %q", cmd, want)
		}
	}
	if strings.Contains(cmd, "--session-id") {
		t.Errorf("command %q passed --session-id for a resume", cmd)
	}

	wantTranscript := sessionio.TranscriptPath(root, "/home/wizard/code/terminal-lobby", resurrectID)
	want := Target{
		ClaudeID:   resurrectID,
		TmuxName:   "feat-header",
		CWD:        "/home/wizard/code/terminal-lobby",
		Transcript: wantTranscript,
	}
	if target != want {
		t.Errorf("Resurrect() = %+v, want %+v", target, want)
	}
}

// A thread born in T3 has no transcript yet: T3 assigned the uuid, so claude is
// started with --session-id and the two sides agree from the first message.
func TestResurrectStartsANewConversation(t *testing.T) {
	rig := newResurrectRig(t)
	root := t.TempDir()
	rig.stampsTranscript(root, "/home/wizard/code/infra", resurrectID)

	if _, err := rig.r.Resurrect(ResurrectSpec{
		ClaudeID: resurrectID,
		TmuxName: "infra",
		CWD:      "/home/wizard/code/infra",
	}); err != nil {
		t.Fatalf("Resurrect: %v", err)
	}
	cmd := rig.tmux.created[0].Command[0]
	if !strings.Contains(cmd, "--session-id "+resurrectID) {
		t.Errorf("command %q does not start the conversation under T3's own uuid", cmd)
	}
	if strings.Contains(cmd, "--resume") {
		t.Errorf("command %q tried to resume a conversation that has never run", cmd)
	}
}

// T3's own flags are carried over so a session the bridge launches keeps T3's
// tools — and the mcp config is JSON, which the shell must not re-split.
func TestResurrectCarriesT3sFlags(t *testing.T) {
	rig := newResurrectRig(t)
	root := t.TempDir()
	rig.stampsTranscript(root, "/tmp/ws", resurrectID)

	mcp := `{"mcpServers":{"t3":{"command":"t3 mcp","args":["--stdio"]}}}`
	if _, err := rig.r.Resurrect(ResurrectSpec{
		ClaudeID:  resurrectID,
		Resume:    true,
		TmuxName:  "ws",
		CWD:       "/tmp/ws",
		MCPConfig: mcp,
		ExtraArgs: []string{"--model", "claude-opus-5", "--dangerously-skip-permissions"},
	}); err != nil {
		t.Fatalf("Resurrect: %v", err)
	}

	cmd := rig.tmux.created[0].Command[0]
	if !strings.Contains(cmd, "--mcp-config") || !strings.Contains(cmd, "--model") {
		t.Errorf("command %q dropped T3's flags", cmd)
	}
	// The whole json must survive as ONE argument: tmux hands the line to a
	// shell, so an unquoted brace-and-quote payload would arrive as a dozen
	// arguments and claude would refuse to start.
	if !strings.Contains(cmd, resurrectQuote(mcp)) {
		t.Errorf("command %q does not carry the mcp config as a single quoted argument", cmd)
	}
}

// The name from the index may have been taken by an unrelated session in the
// meantime. Attaching to whatever holds it would paste this thread's prompts
// into somebody else's conversation, so a free name is chosen instead.
func TestResurrectNeverStealsALiveName(t *testing.T) {
	rig := newResurrectRig(t)
	root := t.TempDir()
	rig.tmux.start("feat-header", "/somewhere/else", nil)
	rig.tmux.start("feat-header-2", "/somewhere/else", nil)
	rig.stampsTranscript(root, "/home/wizard/code/terminal-lobby", resurrectID)

	target, err := rig.r.Resurrect(ResurrectSpec{
		ClaudeID: resurrectID,
		Resume:   true,
		TmuxName: "feat-header",
		CWD:      "/home/wizard/code/terminal-lobby",
	})
	if err != nil {
		t.Fatalf("Resurrect: %v", err)
	}
	if target.TmuxName != "feat-header-3" {
		t.Errorf("resurrected into %q, want the first free variant feat-header-3", target.TmuxName)
	}
	if got, _ := rig.tmux.Option("wizard", "feat-header", sessionio.OptionTranscript); got != "" {
		t.Error("the unrelated session that held the name was written to")
	}
}

// The binding is what the NEXT death is recovered from, so it is refreshed with
// whatever name the session actually ended up with.
func TestResurrectRecordsTheBinding(t *testing.T) {
	rig := newResurrectRig(t)
	root := t.TempDir()
	rig.tmux.start("feat-header", "/somewhere/else", nil)
	rig.stampsTranscript(root, "/home/wizard/code/terminal-lobby", resurrectID)

	target, err := rig.r.Resurrect(ResurrectSpec{
		ClaudeID: resurrectID,
		Resume:   true,
		TmuxName: "feat-header",
		CWD:      "/home/wizard/code/terminal-lobby",
	})
	if err != nil {
		t.Fatalf("Resurrect: %v", err)
	}
	b, ok, err := rig.bindings.Lookup(resurrectID)
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	if !ok {
		t.Fatal("no binding was recorded for a session that was just created")
	}
	if b.TmuxName != target.TmuxName || b.CWD != target.CWD {
		t.Errorf("binding = %+v, want the name and cwd the session ended up with (%+v)", b, target)
	}
}

// The stamp is the only source of the transcript path: the bridge waits for it
// rather than deriving one, so every reader agrees on which file is the
// conversation. A stamp that never comes is an error, not a guess.
func TestResurrectWaitsForTheStampAndGivesUp(t *testing.T) {
	rig := newResurrectRig(t)
	rig.r.wait = 30 * time.Millisecond

	_, err := rig.r.Resurrect(ResurrectSpec{
		ClaudeID: resurrectID,
		Resume:   true,
		TmuxName: "feat-header",
		CWD:      "/tmp/ws",
	})
	if err == nil {
		t.Fatal("Resurrect returned a target for a session that never stamped a transcript")
	}
	if !strings.Contains(err.Error(), sessionio.OptionTranscript) {
		t.Errorf("error %q does not name the stamp that is missing", err)
	}
	// A session that failed to come up is left exactly as it is. The bridge is
	// a detached client and never destroys a session (decision 3).
	if _, _, kills := rig.tmux.snapshot(); len(kills) != 0 {
		t.Errorf("a failed resurrection killed %v", kills)
	}
}

// A stamp naming a DIFFERENT conversation is a reused name, not our session:
// waiting it out is the safe answer, because mirroring it would put somebody
// else's transcript into this thread.
func TestResurrectIgnoresAStampForAnotherConversation(t *testing.T) {
	rig := newResurrectRig(t)
	rig.r.wait = 30 * time.Millisecond
	root := t.TempDir()
	rig.stampsTranscript(root, "/tmp/ws", "99999999-9999-4999-8999-999999999999")

	if _, err := rig.r.Resurrect(ResurrectSpec{
		ClaudeID: resurrectID,
		Resume:   true,
		TmuxName: "feat-header",
		CWD:      "/tmp/ws",
	}); err == nil {
		t.Fatal("Resurrect accepted a transcript belonging to another conversation")
	}
}

func TestResurrectRejectsAnIncompleteSpec(t *testing.T) {
	cases := []struct {
		name string
		spec ResurrectSpec
	}{
		{"no conversation", ResurrectSpec{TmuxName: "x", CWD: "/tmp"}},
		{"no name", ResurrectSpec{ClaudeID: resurrectID, CWD: "/tmp"}},
		{"no working directory", ResurrectSpec{ClaudeID: resurrectID, TmuxName: "x"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rig := newResurrectRig(t)
			if _, err := rig.r.Resurrect(c.spec); err == nil {
				t.Fatalf("Resurrect(%+v) returned no error", c.spec)
			}
			if len(rig.tmux.created) != 0 {
				t.Errorf("an incomplete spec still created %+v", rig.tmux.created)
			}
		})
	}
}

func TestResurrectNeedsAClaudeBinary(t *testing.T) {
	rig := newResurrectRig(t)
	rig.r.ClaudeBin = ""
	if _, err := rig.r.Resurrect(ResurrectSpec{
		ClaudeID: resurrectID, Resume: true, TmuxName: "x", CWD: "/tmp",
	}); err == nil {
		t.Fatal("Resurrect created a session with no claude to run in it")
	}
}

func TestResurrectQuote(t *testing.T) {
	cases := []struct{ in, want string }{
		{"plain", "plain"},
		{"/home/wizard/.local/bin/claude", "/home/wizard/.local/bin/claude"},
		{"--session-id", "--session-id"},
		{"has space", `'has space'`},
		{`{"a":1}`, `'{"a":1}'`},
		{"it's", `'it'\''s'`},
		{"", "''"},
	}
	for _, c := range cases {
		if got := resurrectQuote(c.in); got != c.want {
			t.Errorf("resurrectQuote(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestResurrectFreeName(t *testing.T) {
	taken := map[string]bool{"feat": true, "feat-2": true, strings.Repeat("z", 32): true}
	cases := []struct{ base, want string }{
		{"free", "free"},
		{"feat", "feat-3"},
		// The suffix has to fit inside the budget, so the base is cut for it.
		{strings.Repeat("z", 32), strings.Repeat("z", 30) + "-2"},
	}
	for _, c := range cases {
		got := resurrectFreeName(c.base, taken)
		if got != c.want {
			t.Errorf("resurrectFreeName(%q) = %q, want %q", c.base, got, c.want)
		}
		if len(got) > MaxTmuxNameLen {
			t.Errorf("resurrectFreeName(%q) = %q, over the %d character budget", c.base, got, MaxTmuxNameLen)
		}
	}
}

// The prompt that goes missing does so because the resumed TUI was not reading
// keys yet, so the resurrect path must wait for the pane before it hands the
// target back to whoever is about to type into it. Pinning the ORDER matters as
// much as the call: waiting after the paste would be no wait at all.
func TestResurrectWaitsForThePaneBeforeReturning(t *testing.T) {
	rig := newResurrectRig(t)
	root := t.TempDir()
	rig.stampsTranscript(root, "/tmp/ws", resurrectID)

	target, err := rig.r.Resurrect(ResurrectSpec{
		ClaudeID: resurrectID, Resume: true, TmuxName: "revived", CWD: "/tmp/ws",
	})
	if err != nil {
		t.Fatalf("Resurrect: %v", err)
	}
	if got := rig.tmux.readyWaits(); len(got) != 1 || got[0] != target.TmuxName {
		t.Fatalf("expected exactly one readiness wait on %q, got %v", target.TmuxName, got)
	}
}

// A pane that never settles must not sink the resurrection. Losing the
// operator's prompt is the failure being fixed here; typing into a pane that is
// probably ready is the lesser risk, and the give-up is logged rather than
// silent.
func TestResurrectStillReturnsWhenThePaneNeverSettles(t *testing.T) {
	rig := newResurrectRig(t)
	root := t.TempDir()
	rig.stampsTranscript(root, "/tmp/ws", resurrectID)
	rig.tmux.readyErr = errors.New("drew no settled prompt")

	if _, err := rig.r.Resurrect(ResurrectSpec{
		ClaudeID: resurrectID, Resume: true, TmuxName: "revived", CWD: "/tmp/ws",
	}); err != nil {
		t.Fatalf("a pane that never settled must not fail the resurrection: %v", err)
	}
}
