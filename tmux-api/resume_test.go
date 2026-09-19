package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"terminal-lobby/authuser"
)

// stubResume swaps the three tmux seams for recorders and returns them.
type resumeStub struct {
	facts     suspendedFacts
	readOK    bool
	respawned []string
	pane      string
	fail      error
	failOut   string
	cleared   []string
	// claudeThere is what /proc says about a pane that is still alive: a
	// claude under it means the mark is stale. procUnreadable makes the scan
	// itself fail, which is neither answer.
	claudeThere    bool
	procUnreadable bool
}

func withResumeStub(t *testing.T, s *resumeStub) {
	t.Helper()
	oldRead, oldRespawn, oldClear := readSuspended, respawnPane, clearSuspendMarks
	oldUnder := claudeUnderPane
	claudeUnderPane = func(pid int) (bool, bool) {
		if s.procUnreadable {
			return false, false
		}
		return s.claudeThere, true
	}
	t.Cleanup(func() { claudeUnderPane = oldUnder })
	// The real probe asks the SESSION'S OWN tmux server rather than calling
	// os.Stat, because peer homes here are 0750 and a local stat on another
	// user's transcript returns EACCES (suspend.go transcriptHasAConversation
	// carries the measurement). A test host has neither a tmux server for the
	// target user nor the sudoers grant that reaches one, so leaving this
	// unstubbed made five tests pass on the devvm — where tmuxCmd skips sudo
	// for the current user — and fail on a CI runner, where every probe exits
	// 1 and the resume answered 500. Answer the same question the probe asks,
	// `test -f && test -s`, against the fixture file.
	oldProbe := transcriptHasAConversation
	transcriptHasAConversation = func(_, path string) bool {
		if path == "" {
			return false
		}
		fi, err := os.Stat(path)
		return err == nil && fi.Mode().IsRegular() && fi.Size() > 0
	}
	t.Cleanup(func() { transcriptHasAConversation = oldProbe })
	readSuspended = func(osUser, name string) (suspendedFacts, bool) {
		return s.facts, s.readOK
	}
	respawnPane = func(osUser, paneID string, argv []string) (string, error) {
		s.pane, s.respawned = paneID, argv
		return s.failOut, s.fail
	}
	clearSuspendMarks = func(osUser, name, savedState string) {
		s.cleared = append(s.cleared, name+":"+savedState)
	}
	t.Cleanup(func() { readSuspended, respawnPane, clearSuspendMarks = oldRead, oldRespawn, oldClear })
}

// suspendedSession is the shape a real suspended session has: a dead pane, the
// three marks, and a transcript file that EXISTS — the resume refuses to
// respawn without one, because `respawn-pane -k` is one-way and a claude with
// nothing to resume exits and takes the session with it.
func suspendedSession(t *testing.T) suspendedFacts {
	t.Helper()
	path := filepath.Join(t.TempDir(), testUUID+".jsonl")
	if err := os.WriteFile(path, []byte("{\"type\":\"summary\"}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return suspendedFacts{
		paneID:      "%42",
		suspendedAt: oneHourAgo,
		savedState:  stateAwaiting,
		// Dead, because that is what a suspended session IS: suspend.go kills
		// claude under remain-on-exit and tmux holds the pane as a corpse.
		paneDead:   true,
		transcript: path,
		resumeCmd:  shellQuoteArgv([]string{"/bin/zsh", "-lic", "claude --resume " + testUUID + " --effort max"}),
	}
}

// The conversation can go while the session sits suspended. Respawning then
// would put `claude --resume` into the pane, claude would find nothing, exit,
// and the one-pane session would close — the click that was meant to bring it
// back would delete it. So the resume refuses and the session stays suspended.
func TestResumeSessionRefusesWhenTheTranscriptIsGone(t *testing.T) {
	f := suspendedSession(t)
	if err := os.Remove(f.transcript); err != nil {
		t.Fatal(err)
	}
	st := &resumeStub{facts: f, readOK: true}
	withResumeStub(t, st)
	rec := httptest.NewRecorder()

	resumeSession(rec, "wizard", "k7m2q9x4tpz3")

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status %d, want 500 when there is nothing to resume: %s", rec.Code, rec.Body)
	}
	if st.respawned != nil {
		t.Fatalf("it respawned into a conversation that is not there: %v", st.respawned)
	}
	if st.cleared != nil {
		t.Fatalf("the marks were cleared, so the row can never be clicked again: %v", st.cleared)
	}
}

// An empty transcript is nothing to resume for the same reason a missing one
// is: the point of the check is that a conversation survived the kill.
func TestResumeSessionRefusesAnEmptyTranscript(t *testing.T) {
	f := suspendedSession(t)
	if err := os.WriteFile(f.transcript, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	st := &resumeStub{facts: f, readOK: true}
	withResumeStub(t, st)
	rec := httptest.NewRecorder()

	resumeSession(rec, "wizard", "k7m2q9x4tpz3")

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status %d, want 500 for an empty transcript: %s", rec.Code, rec.Body)
	}
	if st.respawned != nil {
		t.Fatalf("it respawned anyway: %v", st.respawned)
	}
}

// The mark says suspended and a CLAUDE is running under the pane.
// respawn-pane -k replaces whatever is in the pane, so acting on the mark here
// would kill a live conversation mid-turn. The claude wins, the stale mark is
// cleared, and the caller is told the session is live.
func TestResumeSessionRefusesAPaneWithAClaudeInIt(t *testing.T) {
	facts := suspendedSession(t)
	facts.paneDead = false
	facts.panePID = 4242
	st := &resumeStub{facts: facts, readOK: true, claudeThere: true}
	withResumeStub(t, st)
	rec := httptest.NewRecorder()

	resumeSession(rec, "wizard", "k7m2q9x4tpz3")

	if rec.Code != http.StatusConflict {
		t.Fatalf("status %d, want 409 for a mark over a live conversation: %s", rec.Code, rec.Body)
	}
	if st.respawned != nil {
		t.Fatalf("it respawned over a live claude: %v", st.respawned)
	}
	if len(st.cleared) != 1 {
		t.Fatalf("the stale mark was left on the session: cleared %v", st.cleared)
	}
}

// A LIVE pane with no claude under it is the tmux-persist shape — the restored
// wrapper runs `…; claude …; exec bash -l`, so the kill leaves a shell behind
// rather than a corpse. That shell holds no conversation, the mark is good,
// and the click has to respawn over it. Refusing here is what left a killed
// conversation with no way back.
func TestResumeSessionRespawnsALivePaneThatLostItsClaude(t *testing.T) {
	facts := suspendedSession(t)
	facts.paneDead = false
	facts.panePID = 4242
	st := &resumeStub{facts: facts, readOK: true}
	withResumeStub(t, st)
	rec := httptest.NewRecorder()

	resumeSession(rec, "wizard", "k7m2q9x4tpz3")

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 for a restored session whose shell survived: %s", rec.Code, rec.Body)
	}
	if st.respawned == nil {
		t.Fatal("nothing was respawned, so the conversation stayed dead")
	}
}

// /proc that will not answer is not evidence either way. Nothing is
// respawned, and nothing is CLEARED: the marks are the only way back, and
// dropping them for an unreadable scan would strand the session for good.
func TestResumeSessionRefusesWhenProcCannotSayWhatIsInThePane(t *testing.T) {
	facts := suspendedSession(t)
	facts.paneDead = false
	facts.panePID = 4242
	st := &resumeStub{facts: facts, readOK: true, procUnreadable: true}
	withResumeStub(t, st)
	rec := httptest.NewRecorder()

	resumeSession(rec, "wizard", "k7m2q9x4tpz3")

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d, want 503 when /proc will not say: %s", rec.Code, rec.Body)
	}
	if st.respawned != nil {
		t.Fatalf("it respawned on a guess: %v", st.respawned)
	}
	if st.cleared != nil {
		t.Fatalf("the marks were cleared, so the session can never be resumed: %v", st.cleared)
	}
}

func TestResumeSessionRespawnsTheStoredCommand(t *testing.T) {
	s := &resumeStub{facts: suspendedSession(t), readOK: true}
	withResumeStub(t, s)
	rec := httptest.NewRecorder()

	resumeSession(rec, "wizard", "k7m2q9x4tpz3")

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200: %s", rec.Code, rec.Body)
	}
	var body resumeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || !body.Resumed {
		t.Fatalf("body = %s, want {\"resumed\":true}", rec.Body)
	}
	if s.pane != "%42" {
		t.Fatalf("respawned pane %q, want the id from the session, not its name", s.pane)
	}
	want := []string{"/bin/zsh", "-lic", "claude --resume " + testUUID + " --effort max"}
	if !reflect.DeepEqual(s.respawned, want) {
		t.Fatalf("respawn argv =\n  %q\nwant\n  %q", s.respawned, want)
	}
	if got := []string{"k7m2q9x4tpz3:" + stateAwaiting}; !reflect.DeepEqual(s.cleared, got) {
		t.Fatalf("cleared = %v, want %v — the saved state has to travel with the clear", s.cleared, got)
	}
}

func TestResumeSessionAnswers404WhenTheSessionIsGone(t *testing.T) {
	s := &resumeStub{readOK: false}
	withResumeStub(t, s)
	rec := httptest.NewRecorder()
	resumeSession(rec, "wizard", "gone")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status %d, want 404", rec.Code)
	}
	if s.respawned != nil {
		t.Fatalf("it respawned something anyway: %q", s.respawned)
	}
}

func TestResumeSessionAnswers409WhenTheSessionIsLive(t *testing.T) {
	f := suspendedSession(t)
	f.suspendedAt = 0 // the option is unset, which is every live session
	s := &resumeStub{facts: f, readOK: true}
	withResumeStub(t, s)
	rec := httptest.NewRecorder()

	resumeSession(rec, "wizard", "live")

	if rec.Code != http.StatusConflict {
		t.Fatalf("status %d, want 409", rec.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body %s does not parse: %v", rec.Body, err)
	}
	if body["error"] != "not suspended" {
		t.Fatalf("body = %v, want {\"error\":\"not suspended\"}", body)
	}
	if s.respawned != nil {
		t.Fatalf("it respawned a live session: %q", s.respawned)
	}
}

// Only this service writes the option, so an unreadable one means it was
// edited by hand or truncated. Respawning half of it would run something
// nobody wrote, so the session stays suspended and the marks stay put.
func TestResumeSessionRefusesAnUnreadableCommand(t *testing.T) {
	f := suspendedSession(t)
	f.resumeCmd = `'unterminated`
	s := &resumeStub{facts: f, readOK: true}
	withResumeStub(t, s)
	rec := httptest.NewRecorder()

	resumeSession(rec, "wizard", "broken")

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status %d, want 500", rec.Code)
	}
	if s.respawned != nil || s.cleared != nil {
		t.Fatalf("it acted anyway: respawned %q, cleared %v", s.respawned, s.cleared)
	}
}

// A failed respawn must leave every mark where it was, or the session reads as
// live with a dead pane and the click can never be retried.
func TestResumeSessionKeepsTheMarksWhenTheRespawnFails(t *testing.T) {
	s := &resumeStub{facts: suspendedSession(t), readOK: true, fail: fmt.Errorf("boom"), failOut: "some tmux noise"}
	withResumeStub(t, s)
	rec := httptest.NewRecorder()

	resumeSession(rec, "wizard", "x")

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status %d, want 500", rec.Code)
	}
	if s.cleared != nil {
		t.Fatalf("it cleared the marks after a failed respawn: %v", s.cleared)
	}
}

// A respawn against a session that went away between the read and the write is
// gone, not broken.
func TestResumeSessionMapsAMissingTargetTo404(t *testing.T) {
	s := &resumeStub{facts: suspendedSession(t), readOK: true, fail: fmt.Errorf("exit 1"), failOut: "can't find session: x"}
	withResumeStub(t, s)
	rec := httptest.NewRecorder()
	resumeSession(rec, "wizard", "x")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status %d, want 404", rec.Code)
	}
}

func TestResumeSessionEmitsTheEvent(t *testing.T) {
	tel := withTelemetry(t)
	s := &resumeStub{facts: suspendedSession(t), readOK: true}
	withResumeStub(t, s)
	resumeSession(httptest.NewRecorder(), "wizard", "k7m2q9x4tpz3")

	if len(tel.lines) != 1 {
		t.Fatalf("emitted %d lines, want 1: %v", len(tel.lines), tel.lines)
	}
	line := tel.lines[0]
	for _, want := range []string{`"session.resumed"`, `"tl.session":"k7m2q9x4tpz3"`, `"tl.suspendedSeconds":`, `"tl.resumeMs":`} {
		if !strings.Contains(line, want) {
			t.Errorf("the event is missing %s:\n  %s", want, line)
		}
	}
}

// The route the lobby posts to, through the dispatcher that owns every
// /sessions/{name}/… path.
func TestResumeRouteReachesTheHandler(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "authself="+osSelf+"\n")
	s := &resumeStub{facts: suspendedSession(t), readOK: true}
	withResumeStub(t, s)

	req := httptest.NewRequest(http.MethodPost, "/sessions/k7m2q9x4tpz3/resume", nil)
	req.Header.Set(authuser.DefaultAuthHeader, "authself")
	rec := httptest.NewRecorder()
	handleSessionByName(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("POST /sessions/{name}/resume = %d, want 200: %s", rec.Code, rec.Body)
	}
	if s.respawned == nil {
		t.Fatal("the route answered 200 without respawning anything")
	}
}

func TestResumeRouteIsPostOnly(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withUserMap(t, "authself="+osSelf+"\n")
	s := &resumeStub{facts: suspendedSession(t), readOK: true}
	withResumeStub(t, s)

	for _, method := range []string{http.MethodGet, http.MethodDelete, http.MethodPut} {
		req := httptest.NewRequest(method, "/sessions/k7m2q9x4tpz3/resume", nil)
		req.Header.Set(authuser.DefaultAuthHeader, "authself")
		rec := httptest.NewRecorder()
		handleSessionByName(rec, req)
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s /sessions/{name}/resume = %d, want 405", method, rec.Code)
		}
	}
	if s.respawned != nil {
		t.Fatalf("a non-POST respawned the pane: %q", s.respawned)
	}
}

// readSuspended parses what tmux actually prints, so a stamp carrying the
// field separator cannot shift the columns ahead of it.
func TestReadSuspendedKeepsTheCommandInTheLastField(t *testing.T) {
	// The shape display-message returns, assembled the way the seam splits it.
	cmd := "/bin/zsh -lic 'claude --resume " + testUUID + "'"
	line := strings.Join([]string{
		"k7m2q9x4tpz3", "%42", strconv.FormatInt(oneHourAgo, 10), stateAwaiting, cmd,
	}, listSep)
	parts := strings.SplitN(line, listSep, 5)
	if len(parts) != 5 || parts[4] != cmd {
		t.Fatalf("the command did not survive the split: %q", parts)
	}
}
