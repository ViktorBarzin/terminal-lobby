package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"terminal-lobby/sessionio"
)

// The whole suspend-and-resume loop against a REAL tmux server.
//
// suspend_test.go stubs every side effect, which proves the order and the
// decisions and proves nothing about tmux. The four things that can only be
// wrong against a real server are exactly the ones this feature rests on:
//
//   - whether `remain-on-exit` set on ONE session keeps that session alive when
//     its only pane's process dies, and leaves the global and every other
//     window alone;
//   - whether `#{pane_dead}` then reads 1 while the session still lists;
//   - whether an argv read out of /proc and handed back to `respawn-pane` as
//     separate arguments reproduces the process exactly;
//   - whether the three marks survive the round trip through tmux options and
//     come back as a session the list reports as suspended.
//
// Skipped when tmux is missing, so this stays runnable anywhere.

// fakeClaudeScript is a program whose /proc comm is "claude", which ignores
// its arguments and exits cleanly on SIGTERM — the two behaviours the suspend
// act depends on. A shell script rather than a copy of `sleep`, because the
// resume command adds `--resume <uuid>` to the invocation and `sleep` would
// refuse it; measured here, Linux takes a `#!` script's comm from the SCRIPT's
// name, not the interpreter's.
func fakeClaudeScript(t *testing.T) string {
	t.Helper()
	// Not t.TempDir(): the path goes into a tmux pane's argv and the session
	// outlives the directory's cleanup ordering.
	dir, err := os.MkdirTemp("", "tlc")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	path := filepath.Join(dir, "claude")
	body := "#!/bin/sh\ntrap 'kill $! 2>/dev/null; exit 0' TERM\nsleep 600 &\nwait\n"
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

// withFakeTranscript stands a transcript up under a projects root of its own,
// so resolving the stamp is exercised for real without writing into anybody's
// home.
func withFakeTranscript(t *testing.T, uuid string) string {
	t.Helper()
	root := t.TempDir()
	dir := filepath.Join(root, "-home-wizard-code-terminal-lobby")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, uuid+".jsonl")
	if err := os.WriteFile(path, []byte("{\"type\":\"summary\"}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	old := claudeProjectsRoot
	claudeProjectsRoot = func(string) string { return root }
	t.Cleanup(func() { claudeProjectsRoot = old })
	return path
}

func TestSuspendAndResumeAgainstRealTmux(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	tmux := withRealTmux(t)
	withTelemetry(t)
	transcript := withFakeTranscript(t, testUUID)
	claude := fakeClaudeScript(t)

	// The production shape: a shell running claude as a command STRING. The
	// trailing `:` is what stops the shell exec'ing over itself, so the pane
	// process is the shell and claude is its child — which is how every lobby
	// session looks (`/bin/zsh -lic "claude …"`).
	const name = "k7m2q9x4tpz3"
	// Idle relative to the REAL clock, not the fixture's: the unit tests pin a
	// far-future `now`, and a stamp taken from there would read as a session
	// driven in the future, which the rule correctly declines to suspend.
	idleSince := time.Now().Add(-100 * time.Hour).Unix()
	paneCmd := claude + " --effort max; :"
	if out, err := tmux("new-session", "-d", "-s", name, "/bin/sh", "-c", paneCmd); err != nil {
		t.Fatalf("new-session: %v: %s", err, out)
	}
	if out, err := tmux("set-option", "-t", exactPane(name), sessionio.OptionTranscript, transcript); err != nil {
		t.Fatalf("stamping the transcript: %v: %s", err, out)
	}
	if out, err := tmux("set-option", "-t", exactPane(name), sessionio.OptionState, stateAwaiting); err != nil {
		t.Fatalf("stamping the state: %v: %s", err, out)
	}
	if out, err := tmux("set-option", "-t", exactPane(name), originOption, originUser); err != nil {
		t.Fatalf("stamping the origin: %v: %s", err, out)
	}
	if out, err := tmux("set-option", "-t", exactPane(name), lastDriveOption, strconv.FormatInt(idleSince, 10)); err != nil {
		t.Fatalf("stamping the drive time: %v: %s", err, out)
	}
	// The fake claude has to be up before the tool mark can see it.
	waitUntil(t, 3*time.Second, func() bool {
		s := liveSessionNamed(t, osSelf, name)
		return s.Tool == toolClaude
	}, "the fake claude never appeared under the pane")

	before := liveSessionNamed(t, osSelf, name)
	if before.State != stateAwaiting {
		t.Fatalf("State = %q before the suspend, want %q", before.State, stateAwaiting)
	}
	if before.SuspendedAt != 0 {
		t.Fatalf("SuspendedAt = %d on a live session, want 0", before.SuspendedAt)
	}

	// An AWAITING session is exempt forever, whatever its age. Proving that
	// against the real list is worth more than proving it against a struct
	// literal, because the state has to survive tmux to be read at all.
	if got := sessionsToSuspend([]Session{before}, time.Now().Unix()); len(got) != 0 {
		t.Fatalf("the rule picked an awaiting session: %v", got)
	}

	// Move it to done and it qualifies.
	if out, err := tmux("set-option", "-t", exactPane(name), sessionio.OptionState, stateDone); err != nil {
		t.Fatalf("restamping the state: %v: %s", err, out)
	}
	ready := liveSessionNamed(t, osSelf, name)
	if got := sessionsToSuspend([]Session{ready}, time.Now().Unix()); len(got) != 1 || got[0] != name {
		t.Fatalf("the rule did not pick a 100h-idle done session: %v", got)
	}

	// --- the suspend ------------------------------------------------------
	if !suspendSession(liveSuspendOps, osSelf, ready, time.Now()) {
		t.Fatal("suspendSession refused a session it should have taken")
	}

	// The session is STILL THERE. This is fact 1: without remain-on-exit the
	// pane would have exited with its command and taken the one-pane session
	// with it.
	if out, err := tmux("has-session", "-t", exactSession(name)); err != nil {
		t.Fatalf("the session died with its claude: %v: %s", err, out)
	}
	dead, err := tmux("display-message", "-p", "-t", exactPane(name), "#{pane_dead}")
	if err != nil || dead != "1" {
		t.Fatalf("pane_dead = %q (%v), want 1 — the pane should be a frozen corpse", dead, err)
	}
	// remain-on-exit is ON THIS WINDOW and nowhere else. Set globally it would
	// stop an ordinary `exit` closing anybody's session.
	if g, _ := tmux("show-options", "-g", "remain-on-exit"); !strings.Contains(g, "off") {
		t.Fatalf("the global remain-on-exit moved: %q", g)
	}
	if w, _ := tmux("show-options", "-w", "-g", "remain-on-exit"); !strings.Contains(w, "off") {
		t.Fatalf("the global window remain-on-exit moved: %q", w)
	}
	if w, err := tmux("show-options", "-w", "-t", exactPane(name), "remain-on-exit"); err != nil || !strings.Contains(w, "on") {
		t.Fatalf("remain-on-exit on the suspended window = %q (%v), want on", w, err)
	}

	// The list says suspended, and clearDeadStates left it that way even
	// though there is no claude under the pane any more.
	got := liveSessionNamed(t, osSelf, name)
	if got.SuspendedAt <= 0 {
		t.Fatalf("SuspendedAt = %d after the suspend, want a stamp", got.SuspendedAt)
	}
	if got.State != stateSuspended {
		t.Fatalf("State = %q after the suspend, want %q", got.State, stateSuspended)
	}
	// The saved state is the one the session had, ready to be put back.
	saved, err := tmux("display-message", "-p", "-t", exactPane(name), "#{"+suspendStateOption+"}")
	if err != nil || saved != stateDone {
		t.Fatalf("%s = %q (%v), want %q", suspendStateOption, saved, err, stateDone)
	}
	// …and the resume command carries the original flags plus the uuid.
	stored, err := tmux("display-message", "-p", "-t", exactPane(name), "#{"+resumeCmdOption+"}")
	if err != nil {
		t.Fatalf("reading %s: %v", resumeCmdOption, err)
	}
	argv, ok := shellSplitArgv(stored)
	if !ok {
		t.Fatalf("%s does not read back: %q", resumeCmdOption, stored)
	}
	wantArgv := []string{"/bin/sh", "-c", claude + " --resume " + testUUID + " --effort max; :"}
	if len(argv) != len(wantArgv) {
		t.Fatalf("stored argv = %q, want %q", argv, wantArgv)
	}
	for i := range argv {
		if argv[i] != wantArgv[i] {
			t.Fatalf("stored argv =\n  %q\nwant\n  %q", argv, wantArgv)
		}
	}

	// --- the resume -------------------------------------------------------
	rec := httptest.NewRecorder()
	resumeSession(rec, osSelf, name)
	if rec.Code != http.StatusOK {
		t.Fatalf("resume = %d, want 200: %s", rec.Code, rec.Body)
	}
	if dead, err := tmux("display-message", "-p", "-t", exactPane(name), "#{pane_dead}"); err != nil || dead != "0" {
		t.Fatalf("pane_dead = %q (%v) after the resume, want 0", dead, err)
	}
	// The process is back, running the argv that was stored — exactly, because
	// respawn-pane was handed separate arguments and execvp'd them.
	pane, ok := liveSuspendOps.pane(osSelf, name)
	if !ok {
		t.Fatal("the resumed session has no readable pane")
	}
	backArgv, ok := procArgv(procRoot, pane.pid)
	if !ok {
		t.Fatalf("the resumed pane process %d has no cmdline", pane.pid)
	}
	for i := range wantArgv {
		if i >= len(backArgv) || backArgv[i] != wantArgv[i] {
			t.Fatalf("the resumed process argv =\n  %q\nwant\n  %q", backArgv, wantArgv)
		}
	}
	// Every mark is gone and the state is back where it was. Waited for rather
	// than read immediately: the restored state only stands once claude is
	// under the pane again, because clearDeadStates blanks the state of a
	// session with no claude and a resumed one spends its boot in exactly that
	// condition (see clearSuspendMarks).
	waitUntil(t, 5*time.Second, func() bool {
		return liveSessionNamed(t, osSelf, name).Tool == toolClaude
	}, "the resumed pane never got its claude back")
	after := liveSessionNamed(t, osSelf, name)
	if after.SuspendedAt != 0 {
		t.Fatalf("SuspendedAt = %d after the resume, want 0", after.SuspendedAt)
	}
	if after.State != stateDone {
		t.Fatalf("State = %q after the resume, want the saved %q", after.State, stateDone)
	}
	if w, _ := tmux("show-options", "-w", "-t", exactPane(name), "remain-on-exit"); strings.Contains(w, "on") {
		t.Fatalf("remain-on-exit is still on after the resume: %q — the session would never close again", w)
	}
	if v, _ := tmux("display-message", "-p", "-t", exactPane(name), "#{"+resumeCmdOption+"}"); v != "" {
		t.Fatalf("%s survived the resume: %q", resumeCmdOption, v)
	}

	// A second resume has nothing to do, and says so rather than respawning a
	// live pane out from under whoever is now using it.
	rec2 := httptest.NewRecorder()
	resumeSession(rec2, osSelf, name)
	if rec2.Code != http.StatusConflict {
		t.Fatalf("a second resume = %d, want 409: %s", rec2.Code, rec2.Body)
	}
}

// liveSessionNamed reads one session through the real list format and parser.
func liveSessionNamed(t *testing.T, osUser, name string) Session {
	t.Helper()
	for _, s := range userSessions(osUser) {
		if s.Name == name {
			return s
		}
	}
	t.Fatalf("%s is not in %s's session list", name, osUser)
	return Session{}
}

// A mark over a pane with a CLAUDE STILL IN IT is the shape a failed suspend
// leaves behind — the kill was refused or the process would not go, and
// something wrote the mark anyway. Acting on it would run `respawn-pane -k`
// over a running conversation, so the resume refuses, clears the stale mark
// and answers 409.
//
// The claude is what makes it stale, not the pane. A LIVE pane with no claude
// under it is the ordinary tmux-persist shape and is perfectly resumable —
// TestResumeRespawnsARestoredSessionAgainstRealTmux is that case.
//
// Against a real server because the whole question is what tmux and /proc say
// about a pane that is still running, and a fake cannot be wrong about that.
func TestResumeRefusesALivePaneAgainstRealTmux(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	tmux := withRealTmux(t)
	withTelemetry(t)
	claude := fakeClaudeScript(t)

	const name = "k7m2q9x4tpz4"
	if out, err := tmux("new-session", "-d", "-s", name, "/bin/sh", "-c", claude+" --effort max; :"); err != nil {
		t.Fatalf("new-session: %v: %s", err, out)
	}
	// The mark is only stale because a claude is under the pane, so the test
	// has to wait for one to actually be there.
	waitUntil(t, 3*time.Second, func() bool {
		return liveSessionNamed(t, osSelf, name).Tool == toolClaude
	}, "the fake claude never appeared under the pane")
	// Exactly what a suspend that could not finish would leave: the marks, and
	// a pane still running.
	for _, kv := range [][2]string{
		{resumeCmdOption, shellQuoteArgv([]string{"/bin/sh", "-c", "echo resumed"})},
		{suspendStateOption, stateDone},
		{suspendedOption, strconv.FormatInt(time.Now().Unix(), 10)},
	} {
		if out, err := tmux("set-option", "-t", exactPane(name), kv[0], kv[1]); err != nil {
			t.Fatalf("stamping %s: %v: %s", kv[0], err, out)
		}
	}
	before, err := tmux("display-message", "-p", "-t", exactPane(name), "#{pane_pid}")
	if err != nil {
		t.Fatalf("reading the pane pid: %v", err)
	}

	rec := httptest.NewRecorder()
	resumeSession(rec, osSelf, name)

	if rec.Code != http.StatusConflict {
		t.Fatalf("resume of a live pane = %d, want 409: %s", rec.Code, rec.Body)
	}
	after, err := tmux("display-message", "-p", "-t", exactPane(name), "#{pane_pid}")
	if err != nil {
		t.Fatalf("reading the pane pid after: %v", err)
	}
	if after != before {
		t.Fatalf("the pane was respawned anyway: pid %s -> %s", before, after)
	}
	if dead, _ := tmux("display-message", "-p", "-t", exactPane(name), "#{pane_dead}"); dead != "0" {
		t.Fatalf("pane_dead = %q, want 0 — the live process should still be running", dead)
	}
	// The stale mark is cleared on the way out, so the row stops claiming to
	// be something a click can revive.
	if v, _ := tmux("display-message", "-p", "-t", exactPane(name), "#{"+suspendedOption+"}"); v != "" {
		t.Fatalf("%s = %q after the refusal, want it cleared", suspendedOption, v)
	}
	if got := liveSessionNamed(t, osSelf, name); got.State == stateSuspended {
		t.Fatalf("the list still calls a running session suspended: %+v", got)
	}
}

// The tmux-persist shape, end to end against a real server: a pane whose shell
// OUTLIVES its claude.
//
// `tmux-persist.sh` restores every session as `zsh -c '…; claude --resume …;
// echo …; exec bash -l'`, so after a reboot this is what the whole box looks
// like, and the launcher in docs/multi-user.md drops to a shell on a non-zero
// exit the same way. Killing the claude under that shape leaves #{pane_dead}
// at 0 with an ordinary shell in the pane (measured on tmux 3.4, 2026-09-19).
//
// Both halves have to hold for the feature to work after a reboot: the suspend
// must still MARK the session, because a mark is the only thing that makes the
// row clickable, and the resume must still RESPAWN it, because the surviving
// shell holds no conversation. An earlier build stamped the mark and then
// refused the resume, which killed the claude and left no way back.
func TestResumeRespawnsARestoredSessionAgainstRealTmux(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	tmux := withRealTmux(t)
	withTelemetry(t)
	transcript := withFakeTranscript(t, testUUID)
	claude := fakeClaudeScript(t)

	const name = "k7m2q9x4tpz5"
	idleSince := time.Now().Add(-100 * time.Hour).Unix()
	// `exec sleep` stands in for `exec bash -l`: a command that keeps the pane
	// alive after claude has gone, without needing a tty to sit at.
	paneCmd := claude + " --effort max; exec sleep 600"
	if out, err := tmux("new-session", "-d", "-s", name, "/bin/sh", "-c", paneCmd); err != nil {
		t.Fatalf("new-session: %v: %s", err, out)
	}
	for _, kv := range [][2]string{
		{sessionio.OptionTranscript, transcript},
		{sessionio.OptionState, stateDone},
		{originOption, originUser},
		{lastDriveOption, strconv.FormatInt(idleSince, 10)},
	} {
		if out, err := tmux("set-option", "-t", exactPane(name), kv[0], kv[1]); err != nil {
			t.Fatalf("stamping %s: %v: %s", kv[0], err, out)
		}
	}
	waitUntil(t, 3*time.Second, func() bool {
		return liveSessionNamed(t, osSelf, name).Tool == toolClaude
	}, "the fake claude never appeared under the pane")

	ready := liveSessionNamed(t, osSelf, name)
	if got := sessionsToSuspend([]Session{ready}, time.Now().Unix()); len(got) != 1 {
		t.Fatalf("the rule did not pick a 100h-idle restored session: %v", got)
	}
	if !suspendSession(liveSuspendOps, osSelf, ready, time.Now()) {
		t.Fatal("suspendSession refused a restored session whose shell outlives its claude")
	}

	// The pane is ALIVE — this is the shape the whole test is about — and the
	// session is marked suspended anyway.
	if dead, err := tmux("display-message", "-p", "-t", exactPane(name), "#{pane_dead}"); err != nil || dead != "0" {
		t.Fatalf("pane_dead = %q (%v), want 0: the wrapper shell was supposed to outlive its claude", dead, err)
	}
	if got := liveSessionNamed(t, osSelf, name); got.State != stateSuspended || got.SuspendedAt <= 0 {
		t.Fatalf("the list says %+v, want a suspended session with a stamp", got)
	}

	// …and the click brings it back, over the surviving shell.
	rec := httptest.NewRecorder()
	resumeSession(rec, osSelf, name)
	if rec.Code != http.StatusOK {
		t.Fatalf("resume of a restored session = %d, want 200: %s", rec.Code, rec.Body)
	}
	waitUntil(t, 5*time.Second, func() bool {
		return liveSessionNamed(t, osSelf, name).Tool == toolClaude
	}, "the respawned pane never got its claude back")
	if v, _ := tmux("display-message", "-p", "-t", exactPane(name), "#{"+suspendedOption+"}"); v != "" {
		t.Fatalf("%s = %q after the resume, want it cleared", suspendedOption, v)
	}
	// An explicit resume counts as a drive, or the next sweep suspends it
	// again five minutes later.
	drive, _ := tmux("display-message", "-p", "-t", exactPane(name), "#{"+lastDriveOption+"}")
	at, _ := strconv.ParseInt(drive, 10, 64)
	if at <= idleSince {
		t.Fatalf("%s = %q after the resume, still the stamp that made it a candidate", lastDriveOption, drive)
	}
}

// The repair pass, against a real server.
//
// The shape it fixes: a dead pane, a resume command, and no timestamp —
// what is left when the stamp fails or the service is restarted between the
// kill and the mark, which a package upgrade does. Nothing else would ever
// look at that session again: its tool reads as a shell, so no sweep picks it
// up, and POST /resume answers 409 because there is no mark to act on.
//
// Against a real server because the read is a `list-sessions -F` of its own,
// and a typo in that format string would be invisible to a test that supplied
// the rows itself.
func TestRepairHalfSuspendedAgainstRealTmux(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	tmux := withRealTmux(t)

	const name = "k7m2q9x4tpz6"
	if out, err := tmux("new-session", "-d", "-s", name, "/bin/sh", "-c", "sleep 600"); err != nil {
		t.Fatalf("new-session: %v: %s", err, out)
	}
	// Exactly what the gap leaves: remain-on-exit on, the pane killed, the
	// resume command written, and no @tl_suspended.
	if out, err := tmux("set-option", "-t", exactPane(name), "remain-on-exit", "on"); err != nil {
		t.Fatalf("remain-on-exit: %v: %s", err, out)
	}
	if out, err := tmux("set-option", "-t", exactPane(name), resumeCmdOption,
		shellQuoteArgv([]string{"/bin/sh", "-c", "echo resumed"})); err != nil {
		t.Fatalf("stamping %s: %v: %s", resumeCmdOption, err, out)
	}
	pane, ok := liveSuspendOps.pane(osSelf, name)
	if !ok {
		t.Fatal("no readable pane")
	}
	if err := liveSuspendOps.signal(osSelf, pane.pid); err != nil {
		t.Fatalf("killing the pane process: %v", err)
	}
	waitUntil(t, 5*time.Second, func() bool {
		dead, _ := tmux("display-message", "-p", "-t", exactPane(name), "#{pane_dead}")
		return dead == "1"
	}, "the pane never went dead")

	// Before: nothing in the list says this session is anything but broken.
	if got := liveSessionNamed(t, osSelf, name); got.State == stateSuspended || got.SuspendedAt > 0 {
		t.Fatalf("the session is already marked: %+v", got)
	}

	if !repairHalfSuspended(osSelf, time.Now()) {
		t.Fatal("the repair pass did not pick up a dead pane carrying a resume command")
	}
	got := liveSessionNamed(t, osSelf, name)
	if got.SuspendedAt <= 0 || got.State != stateSuspended {
		t.Fatalf("after the repair the list says %+v, want a suspended session with a stamp", got)
	}
	// And a second pass leaves it alone rather than restamping every 5 minutes.
	if repairHalfSuspended(osSelf, time.Now()) {
		t.Fatal("the repair pass stamped an already-marked session again")
	}
}

// A LIVE pane carrying a resume command is not a half-finished suspend — it is
// a suspend that failed before the kill, or a resume whose mark-clearing did
// not finish. Marking it would report a running conversation as suspended.
// A live pane whose claude is GONE is repaired, because that is what a suspend
// leaves behind on a `tmux-persist`-restored session: killing the claude inside
// `sh -c '…; claude …; exec bash -l'` runs the shell on to its last command, so
// the pane stays alive with the conversation just as dead. This test used to
// assert the opposite and pass, because it read the pane's liveness as the
// session's. Measured on the box 2026-09-19: the first sweep killed `beads-2`
// and `health` into exactly this shape and the repair skipped both, leaving two
// conversations no click could bring back.
func TestRepairHalfSuspendedMarksALivePaneWhoseClaudeIsGoneAgainstRealTmux(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	tmux := withRealTmux(t)

	const name = "k7m2q9x4tpz7"
	if out, err := tmux("new-session", "-d", "-s", name, "/bin/sh", "-c", "sleep 600"); err != nil {
		t.Fatalf("new-session: %v: %s", err, out)
	}
	if out, err := tmux("set-option", "-t", exactPane(name), resumeCmdOption,
		shellQuoteArgv([]string{"/bin/sh", "-c", "echo resumed"})); err != nil {
		t.Fatalf("stamping %s: %v: %s", resumeCmdOption, err, out)
	}
	if !repairHalfSuspended(osSelf, time.Now()) {
		t.Fatal("a pane that lost its claude was not repaired")
	}
	if got := liveSessionNamed(t, osSelf, name); got.SuspendedAt == 0 {
		t.Fatal("SuspendedAt = 0 on a pane whose claude is gone")
	}
}

// And a pane that still HAS its claude is left alone, which is the guard the
// test above used to stand in for. The fixture is a copy of /bin/sleep named
// `claude`, because claudeUnderPane reads comm out of /proc/<pid>/stat and comm
// is the executable's basename — so this is a real positive for the same code
// path a real conversation takes, without needing a real Claude.
func TestRepairHalfSuspendedLeavesAPaneThatStillHasAClaudeAgainstRealTmux(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	tmux := withRealTmux(t)

	bin := filepath.Join(t.TempDir(), "claude")
	src, err := os.ReadFile("/bin/sleep")
	if err != nil {
		t.Skipf("no /bin/sleep to borrow: %v", err)
	}
	if err := os.WriteFile(bin, src, 0o755); err != nil {
		t.Fatal(err)
	}

	const name = "k7m2q9x4tpz8"
	if out, err := tmux("new-session", "-d", "-s", name, "/bin/sh", "-c", bin+" 600"); err != nil {
		t.Fatalf("new-session: %v: %s", err, out)
	}
	if out, err := tmux("set-option", "-t", exactPane(name), resumeCmdOption,
		shellQuoteArgv([]string{"/bin/sh", "-c", "echo resumed"})); err != nil {
		t.Fatalf("stamping %s: %v: %s", resumeCmdOption, err, out)
	}
	// The pane forks sh then the binary; give the child a moment to appear in
	// /proc, or the walk answers "no claude" about a claude that is starting.
	deadline := time.Now().Add(5 * time.Second)
	pid := panePIDOf(t, tmux, name)
	for time.Now().Before(deadline) {
		if there, ok := claudeUnderPane(pid); ok && there {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if there, ok := claudeUnderPane(pid); !ok || !there {
		t.Skipf("the fixture claude never showed under pane %d (there=%v ok=%v)", pid, there, ok)
	}

	if repairHalfSuspended(osSelf, time.Now()) {
		t.Fatal("a session still running its claude was marked suspended")
	}
	if got := liveSessionNamed(t, osSelf, name); got.SuspendedAt > 0 {
		t.Fatalf("SuspendedAt = %d on a session whose claude is alive", got.SuspendedAt)
	}
}

// panePIDOf reads #{pane_pid} for a session in the test's own tmux server.
func panePIDOf(t *testing.T, tmux func(...string) (string, error), name string) int {
	t.Helper()
	out, err := tmux("display", "-p", "-t", exactPane(name), "#{pane_pid}")
	if err != nil {
		t.Fatalf("pane_pid: %v: %s", err, out)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(out))
	if err != nil {
		t.Fatalf("pane_pid %q: %v", out, err)
	}
	return pid
}

// waitUntil polls a CONDITION rather than sleeping a guessed interval, and says
// how long it waited when it gives up.
func waitUntil(t *testing.T, limit time.Duration, ok func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("%s (waited %s)", msg, limit)
}
