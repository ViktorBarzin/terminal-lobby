package main

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"terminal-lobby/telemetry"
)

// The auto-title rule: a Claude session nobody has titled takes Claude Code's
// own conversation summary out of the pane title, once, seconds after the first
// prompt (docs/plans/2026-09-04-prompt-first-sessions-design.md).
//
// Same posture as the title-handler suite: the tmux binary swapped for a stub
// that records its argv, every store pointed at a temp directory, and the
// emitter captured so the telemetry contract is asserted rather than assumed.

// withAutoTitleTracker gives the test its own memory of which sessions the rule
// is still waiting on. The tracker is package state deliberately — it is what
// stops `gave_up` firing twice — so a test that did not swap it would inherit
// whatever the previous test settled.
func withAutoTitleTracker(t *testing.T) {
	t.Helper()
	old := autoTitles
	autoTitles = newAutoTitleTracker()
	t.Cleanup(func() { autoTitles = old })
}

// autoTitleFixture is the common setup: a fresh tracker, a temp title store, a
// tmux stub running `script`, and a capturing emitter.
func autoTitleFixture(t *testing.T, script string) (argvFile string, rec *recorder) {
	t.Helper()
	actAs(t, "wizard") // these tests act as the owner of the sessions they build
	withAutoTitleTracker(t)
	swapTitleStore(t)
	return withTmuxStub(t, script), withTelemetry(t)
}

// claudeSession is a Claude session with a summary in its pane title, created
// `age` ago and titled by nobody.
func claudeSession(name, paneTitle string, age time.Duration, now time.Time) Session {
	return Session{
		ID:        "$1",
		Name:      name,
		State:     stateRunning,
		Created:   now.Add(-age).Unix(),
		PaneTitle: paneTitle,
	}
}

// autonamed returns the decoded session.autonamed events the recorder holds.
func autonamed(t *testing.T, rec *recorder) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, line := range rec.lines {
		ev := decodeEvent(t, line)
		if ev["event.name"] == "session.autonamed" {
			out = append(out, ev)
		}
	}
	return out
}

func attrsOf(t *testing.T, ev map[string]any) map[string]any {
	t.Helper()
	attrs, ok := ev["attrs"].(map[string]any)
	if !ok {
		t.Fatalf("event has no attrs: %v", ev)
	}
	return attrs
}

// The glyph is stripped as a SET, not as the literal "✳ ". Claude Code carries
// six glyphs for that position and rotates them while a turn animates, so a
// title can arrive wearing any of them.
func TestStripTitleGlyph(t *testing.T) {
	cases := []struct {
		name  string
		in    string
		want  string
		glyph bool
	}{
		{"middle dot", "· Tashkent trip planning", "Tashkent trip planning", true},
		{"four teardrop-spoked asterisk", "✢ Tashkent trip planning", "Tashkent trip planning", true},
		{"eight-spoked asterisk", "✳ Tashkent trip planning", "Tashkent trip planning", true},
		{"six-pointed black star", "✶ Tashkent trip planning", "Tashkent trip planning", true},
		{"open-centre asterisk", "✻ Tashkent trip planning", "Tashkent trip planning", true},
		{"heavy teardrop-spoked asterisk", "✽ Tashkent trip planning", "Tashkent trip planning", true},

		{"no prefix at all", "Session naming optional", "Session naming optional", false},
		{"the no-summary sentinel", "✳ Claude Code", "Claude Code", true},
		{"the sentinel under another glyph", "✻ Claude Code", "Claude Code", true},

		// The glyph is a PREFIX. A summary that happens to contain one keeps
		// every character of it.
		{"a glyph later in the string", "Fix the ✳ rendering", "Fix the ✳ rendering", false},
		{"a glyph at the end", "Rendering of ✽", "Rendering of ✽", false},
		{"a glyph both leading and later", "✳ Fix the ✳ rendering", "Fix the ✳ rendering", true},

		{"no space after the glyph", "✳Tashkent", "Tashkent", true},
		{"several spaces after the glyph", "✳   Tashkent", "Tashkent", true},
		{"the glyph alone", "✳", "", true},
		{"the glyph and a space", "✳ ", "", true},
		{"empty", "", "", false},
		{"a shell's own pane title", "devvm", "devvm", false},
		{"an asterisk is not one of the glyphs", "* not a spinner", "* not a spinner", false},
		{"surrounding whitespace", "  Tashkent  ", "Tashkent", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, glyph := stripTitleGlyph(c.in)
			if got != c.want || glyph != c.glyph {
				t.Errorf("stripTitleGlyph(%q) = (%q, %v), want (%q, %v)", c.in, got, glyph, c.want, c.glyph)
			}
		})
	}
}

func TestAutoTitleStampsTheFirstSummary(t *testing.T) {
	now := time.Now()
	argv, rec := autoTitleFixture(t, "exit 0")

	sessions := []Session{claudeSession("k7m2q9x4tpz3", "✳ Tashkent trip planning", 12*time.Second, now)}
	autoTitleSessions("wizard", sessions, now)

	got := recordedArgv(t, argv)
	for _, want := range []string{"set-option", "-t", "=k7m2q9x4tpz3:", sessionTitleOption, "Tashkent trip planning"} {
		if !strings.Contains(got, want) {
			t.Errorf("argv missing %q:\n%s", want, got)
		}
	}
	// Served on the SAME poll that stamped it, so the card reads the summary
	// now rather than one cache cycle later.
	if sessions[0].Title != "Tashkent trip planning" {
		t.Errorf("Title on the returned session = %q, want the summary", sessions[0].Title)
	}
	// Remembered, or a restore hands the session back untitled.
	if got := titleStoreInstance.all("wizard")["k7m2q9x4tpz3"]; got != "Tashkent trip planning" {
		t.Errorf("title memory = %q, want the summary", got)
	}

	evs := autonamed(t, rec)
	if len(evs) != 1 {
		t.Fatalf("emitted %d session.autonamed events, want 1: %v", len(evs), rec.lines)
	}
	attrs := attrsOf(t, evs[0])
	if attrs["tl.session"] != "k7m2q9x4tpz3" {
		t.Errorf("tl.session = %v, want the session name", attrs["tl.session"])
	}
	if attrs["tl.outcome"] != autoTitleTitled {
		t.Errorf("tl.outcome = %v, want %q", attrs["tl.outcome"], autoTitleTitled)
	}
	if ms, ok := attrs["tl.delay_ms"].(float64); !ok || ms < 1000 || ms > 60000 {
		t.Errorf("tl.delay_ms = %v, want roughly the 12s since creation", attrs["tl.delay_ms"])
	}
}

func TestAutoTitleLeavesEverythingItShould(t *testing.T) {
	now := time.Now()
	cases := []struct {
		name    string
		session Session
		why     string
	}{
		{
			name:    "a plain shell",
			session: Session{ID: "$1", Name: "k7m2q9x4tpz3", Created: now.Add(-10 * time.Second).Unix(), PaneTitle: "devvm"},
			why:     "no @claude_state, so nothing here is a conversation summary",
		},
		{
			name: "a session somebody titled",
			session: Session{ID: "$1", Name: "k7m2q9x4tpz3", State: stateRunning, Title: "Trip planning",
				Created: now.Add(-10 * time.Second).Unix(), PaneTitle: "✳ Tashkent trip planning"},
			why: "a title someone chose is never overwritten",
		},
		{
			name:    "no summary yet",
			session: claudeSession("k7m2q9x4tpz3", "✳ Claude Code", 10*time.Second, now),
			why:     "the sentinel means the summariser has not run",
		},
		{
			name:    "no pane title at all",
			session: claudeSession("k7m2q9x4tpz3", "", 10*time.Second, now),
			why:     "nothing to title with",
		},
		{
			name:    "a pane title of only whitespace",
			session: claudeSession("k7m2q9x4tpz3", "✳    ", 10*time.Second, now),
			why:     "nothing survives the clean, and stamping an empty title would unset the option",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			argv, rec := autoTitleFixture(t, "exit 0")
			sessions := []Session{c.session}
			autoTitleSessions("wizard", sessions, now)

			if got := recordedArgv(t, argv); got != "" {
				t.Errorf("touched tmux (%s):\n%s", c.why, got)
			}
			if evs := autonamed(t, rec); len(evs) != 0 {
				t.Errorf("emitted %d events (%s): %v", len(evs), c.why, rec.lines)
			}
		})
	}
}

// Stamping @title is what stops the rule firing again — no separate marker.
func TestAutoTitleStampsOnceAndThenLeavesItAlone(t *testing.T) {
	now := time.Now()
	argv, rec := autoTitleFixture(t, "exit 0")

	sessions := []Session{claudeSession("k7m2q9x4tpz3", "✳ Tashkent trip planning", 12*time.Second, now)}
	autoTitleSessions("wizard", sessions, now)
	first := recordedArgv(t, argv)

	// The next poll reads @title back off the session, which is the state the
	// stamp above left behind.
	next := []Session{claudeSession("k7m2q9x4tpz3", "✳ Tashkent trip planning, day two", 20*time.Second, now)}
	next[0].Title = "Tashkent trip planning"
	autoTitleSessions("wizard", next, now.Add(8*time.Second))

	if got := recordedArgv(t, argv); got != first {
		t.Errorf("stamped a second time; the title should freeze at the first summary:\n%s", got)
	}
	if evs := autonamed(t, rec); len(evs) != 1 {
		t.Errorf("emitted %d events, want 1", len(evs))
	}
}

// Clearing a title unsets @title, which puts the session back in front of the
// rule. "Clear" meaning "go back to auto" is deliberate.
func TestAutoTitleRunsAgainAfterATitleIsCleared(t *testing.T) {
	now := time.Now()
	argv, rec := autoTitleFixture(t, "exit 0")

	sessions := []Session{claudeSession("k7m2q9x4tpz3", "✳ Tashkent trip planning", 12*time.Second, now)}
	autoTitleSessions("wizard", sessions, now)

	cleared := []Session{claudeSession("k7m2q9x4tpz3", "✳ Tashkent trip planning", 20*time.Second, now)}
	autoTitleSessions("wizard", cleared, now.Add(8*time.Second))

	if got := strings.Count(recordedArgv(t, argv), "set-option"); got != 2 {
		t.Errorf("stamped %d times; a cleared title did not go back to auto:\n%s", got, recordedArgv(t, argv))
	}
	if cleared[0].Title != "Tashkent trip planning" {
		t.Errorf("Title after the re-stamp = %q, want the summary", cleared[0].Title)
	}
	// One outcome per session for its whole life. A re-stamp after a clear is
	// not a second autoname.
	if evs := autonamed(t, rec); len(evs) != 1 {
		t.Errorf("emitted %d events, want 1 for the life of the session", len(evs))
	}
}

// The ~2 minute window is what stops the rule watching forever.
func TestAutoTitleGivesUpAfterTheWindow(t *testing.T) {
	now := time.Now()
	argv, rec := autoTitleFixture(t, "exit 0")

	// Seen first INSIDE the window with no summary: this is the session the
	// rule is waiting on.
	waiting := []Session{claudeSession("k7m2q9x4tpz3", "✳ Claude Code", 10*time.Second, now)}
	autoTitleSessions("wizard", waiting, now)
	if evs := autonamed(t, rec); len(evs) != 0 {
		t.Fatalf("gave up while still inside the window: %v", rec.lines)
	}

	later := now.Add(autoTitleWindow + time.Minute)
	expired := []Session{claudeSession("k7m2q9x4tpz3", "✳ Claude Code", 10*time.Second, now)}
	autoTitleSessions("wizard", expired, later)

	evs := autonamed(t, rec)
	if len(evs) != 1 {
		t.Fatalf("emitted %d events after the window, want 1: %v", len(evs), rec.lines)
	}
	attrs := attrsOf(t, evs[0])
	if attrs["tl.outcome"] != autoTitleGaveUp {
		t.Errorf("tl.outcome = %v, want %q", attrs["tl.outcome"], autoTitleGaveUp)
	}
	if attrs["tl.session"] != "k7m2q9x4tpz3" {
		t.Errorf("tl.session = %v, want the session name", attrs["tl.session"])
	}
	if got := recordedArgv(t, argv); got != "" {
		t.Errorf("stamped a title after giving up:\n%s", got)
	}

	// Every later poll sees the same expired session. One event, not one per
	// five seconds for as long as it lives.
	autoTitleSessions("wizard", expired, later.Add(time.Minute))
	if evs := autonamed(t, rec); len(evs) != 1 {
		t.Errorf("emitted %d events, want 1 for the life of the session", len(evs))
	}
}

// A restart must not re-report every old untitled Claude session on the box.
func TestAutoTitleSaysNothingAboutASessionItNeverWatched(t *testing.T) {
	now := time.Now()
	argv, rec := autoTitleFixture(t, "exit 0")

	// First sight is already past the window — this process never had a chance
	// to watch it, so it has nothing to report about it.
	old := []Session{claudeSession("k7m2q9x4tpz3", "✳ Claude Code", autoTitleWindow+time.Hour, now)}
	autoTitleSessions("wizard", old, now)

	if evs := autonamed(t, rec); len(evs) != 0 {
		t.Errorf("reported a session it never watched: %v", rec.lines)
	}
	if got := recordedArgv(t, argv); got != "" {
		t.Errorf("touched tmux for a session past its window:\n%s", got)
	}
}

// A summary reaches @title, which is field 9 of the list format with pane_title
// LAST. A tab in it would shift every field of the next parse, so the same
// clean every stored title gets has to run here too.
func TestAutoTitleCleansTheSummaryBeforeStamping(t *testing.T) {
	now := time.Now()
	long := strings.Repeat("a", 200)
	cases := []struct {
		name      string
		paneTitle string
		want      string
	}{
		{"a tab in the summary", "✳ Tashkent\ttrip planning", "Tashkent trip planning"},
		{"a newline in the summary", "✳ Tashkent\ntrip", "Tashkent trip"},
		{"longer than the title cap", "✳ " + long, long[:64]},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			argv, _ := autoTitleFixture(t, "exit 0")
			sessions := []Session{claudeSession("k7m2q9x4tpz3", c.paneTitle, 12*time.Second, now)}
			autoTitleSessions("wizard", sessions, now)

			if sessions[0].Title != c.want {
				t.Errorf("Title = %q, want %q", sessions[0].Title, c.want)
			}
			if got := recordedArgv(t, argv); !strings.Contains(got, c.want) {
				t.Errorf("argv missing the cleaned title %q:\n%s", c.want, got)
			}
		})
	}
}

// A stamp that tmux refused must be retried, not swallowed — the session is
// still untitled and still inside its window.
func TestAutoTitleRetriesAfterARefusedStamp(t *testing.T) {
	now := time.Now()
	marker := filepath.Join(t.TempDir(), "stamped-once")
	script := "if [ -f '" + marker + "' ]; then exit 0; fi\ntouch '" + marker + "'\necho 'no such session' >&2\nexit 1"
	argv, rec := autoTitleFixture(t, script)

	sessions := []Session{claudeSession("k7m2q9x4tpz3", "✳ Tashkent trip planning", 12*time.Second, now)}
	autoTitleSessions("wizard", sessions, now)
	if sessions[0].Title != "" {
		t.Errorf("served a title tmux refused to stamp: %q", sessions[0].Title)
	}
	if evs := autonamed(t, rec); len(evs) != 0 {
		t.Errorf("reported a title it did not stamp: %v", rec.lines)
	}

	retry := []Session{claudeSession("k7m2q9x4tpz3", "✳ Tashkent trip planning", 20*time.Second, now)}
	autoTitleSessions("wizard", retry, now.Add(8*time.Second))
	if retry[0].Title != "Tashkent trip planning" {
		t.Errorf("did not retry a refused stamp; Title = %q", retry[0].Title)
	}
	if evs := autonamed(t, rec); len(evs) != 1 {
		t.Errorf("emitted %d events after the retry landed, want 1", len(evs))
	}
	if got := strings.Count(recordedArgv(t, argv), "set-option"); got != 2 {
		t.Errorf("ran set-option %d times, want the refusal and then the retry", got)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("the stub never ran: %v", err)
	}
}

// The tracker holds one entry per session it is waiting on. Sessions die.
func TestAutoTitleForgetsSessionsThatAreGone(t *testing.T) {
	now := time.Now()
	autoTitleFixture(t, "exit 0")

	autoTitleSessions("wizard", []Session{
		claudeSession("k7m2q9x4tpz3", "✳ Claude Code", 10*time.Second, now),
		claudeSession("q4m8vwx2rt5n", "✳ Claude Code", 10*time.Second, now),
	}, now)
	if got := autoTitles.size("wizard"); got != 2 {
		t.Fatalf("tracking %d sessions, want 2", got)
	}

	autoTitleSessions("wizard", []Session{
		claudeSession("q4m8vwx2rt5n", "✳ Claude Code", 20*time.Second, now),
	}, now.Add(10*time.Second))
	if got := autoTitles.size("wizard"); got != 1 {
		t.Errorf("tracking %d sessions after one died, want 1", got)
	}

	// One user's sessions disappearing must not drop another user's.
	autoTitleSessions("emo", []Session{
		claudeSession("z9k3npq7v2wx", "✳ Claude Code", 10*time.Second, now),
	}, now.Add(10*time.Second))
	autoTitleSessions("wizard", nil, now.Add(20*time.Second))
	if got := autoTitles.size("emo"); got != 1 {
		t.Errorf("wizard's pass dropped emo's tracking (%d entries)", got)
	}
}

// The rule runs on the session poll, and two of those can land together: a
// lobby tab missing the 5-second cache while the push sender is on its tick.
// Both would be holding a row parsed before the other stamped. The stamp itself
// is idempotent — the second writes the same value — but the record of it must
// not be, or the metric counts one session twice.
func TestAutoTitleReportsOnceUnderConcurrentPolls(t *testing.T) {
	now := time.Now()
	_, rec := autoTitleFixture(t, "exit 0")
	var mu sync.Mutex
	old := events
	events = telemetry.New("tmux-api", "test", &lockedWriter{mu: &mu, to: rec})
	t.Cleanup(func() { events = old })

	const polls = 8
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < polls; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			autoTitleSessions("wizard", []Session{
				claudeSession("k7m2q9x4tpz3", "✳ Tashkent trip planning", 12*time.Second, now),
			}, now)
		}()
	}
	close(start)
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()
	if evs := autonamed(t, rec); len(evs) != 1 {
		t.Errorf("%d polls emitted %d events, want 1", polls, len(evs))
	}
}

// lockedWriter serialises the recorder, which is a plain slice, so the
// concurrency test measures the tracker rather than tripping over its own
// instrument under -race.
type lockedWriter struct {
	mu *sync.Mutex
	to *recorder
}

func (w *lockedWriter) Write(line string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.to.Write(line)
}

// Both outcomes have to be in the closed catalog, or Emit drops the line and
// the rule is unmeasurable. session.retitled rides along: the design reads a
// user retitle arriving soon after an autoname as "the summary was rejected",
// and that signal has been dropped since the event was first emitted.
func TestAutoTitleEventsAreInTheCatalog(t *testing.T) {
	for _, name := range []string{"session.autonamed", "session.retitled"} {
		if !telemetry.IsKnown(name) {
			t.Errorf("%s is not in telemetry/events.go, so Emit drops it", name)
		}
	}
}

// A pre-warm claim is a rename, and a rename does not touch session_created.
// The standing pool slot for a directory is refilled rather than recreated, so
// it has no TTL at all — measured on 2026-09-04, the slot for
// /home/wizard/code read session_created 4h33m in the past. Dating the window
// from that would have every pooled create born expired.
func TestAutoTitleDatesAClaimedPreWarmSlotFromWhenItAppeared(t *testing.T) {
	now := time.Now()
	argv, rec := autoTitleFixture(t, "exit 0")

	// A poll with the slot still standing under its own name, which is what
	// makes the next poll able to tell a new name from an old one.
	slot := claudeSession("__terminal_lobby_prewarmed_pool_slot__home_wizard_code",
		"✳ Claude Code", 4*time.Hour+33*time.Minute, now)
	slot.State = stateDone
	autoTitleSessions("wizard", []Session{slot}, now)

	// The claim: the slot is renamed to the minted id, carrying the slot's
	// creation time with it.
	claimed := claudeSession("k7m2q9x4tpz3", "✳ Claude Code", 4*time.Hour+33*time.Minute, now)
	autoTitleSessions("wizard", []Session{claimed}, now.Add(2*time.Second))
	if evs := autonamed(t, rec); len(evs) != 0 {
		t.Fatalf("gave up on a session that had just been claimed: %v", rec.lines)
	}

	// Claude's summary lands a few seconds later, well inside the window the
	// claim started.
	summarised := []Session{claudeSession("k7m2q9x4tpz3", "✳ Tashkent trip planning",
		4*time.Hour+33*time.Minute+12*time.Second, now)}
	autoTitleSessions("wizard", summarised, now.Add(14*time.Second))

	if got := recordedArgv(t, argv); !strings.Contains(got, "Tashkent trip planning") {
		t.Errorf("never stamped the claimed slot's summary:\n%s", got)
	}
	if summarised[0].Title != "Tashkent trip planning" {
		t.Errorf("Title = %q, want the summary", summarised[0].Title)
	}
	evs := autonamed(t, rec)
	if len(evs) != 1 || attrsOf(t, evs[0])["tl.outcome"] != autoTitleTitled {
		t.Fatalf("events = %v, want one titled outcome", rec.lines)
	}
	// Measured from the claim, not from the slot's creation four hours ago.
	if ms, ok := attrsOf(t, evs[0])["tl.delay_ms"].(float64); !ok || ms > 60000 {
		t.Errorf("tl.delay_ms = %v, want the seconds since the claim", attrsOf(t, evs[0])["tl.delay_ms"])
	}
}

// The window still runs out for a claimed slot: it is a window, not an
// exemption.
func TestAutoTitleGivesUpOnAClaimedSlotThatNeverSummarises(t *testing.T) {
	now := time.Now()
	_, rec := autoTitleFixture(t, "exit 0")

	slot := claudeSession("__terminal_lobby_prewarmed_pool_slot__home_wizard_code",
		"✳ Claude Code", 4*time.Hour, now)
	autoTitleSessions("wizard", []Session{slot}, now)

	claimed := []Session{claudeSession("k7m2q9x4tpz3", "✳ Claude Code", 4*time.Hour, now)}
	autoTitleSessions("wizard", claimed, now.Add(time.Second))
	autoTitleSessions("wizard", claimed, now.Add(autoTitleWindow+time.Minute))

	evs := autonamed(t, rec)
	if len(evs) != 1 || attrsOf(t, evs[0])["tl.outcome"] != autoTitleGaveUp {
		t.Fatalf("events = %v, want one gave_up outcome", rec.lines)
	}
}

// @claude_state is stamped ~300ms before Claude writes its first title, so a
// poll can land on a live Claude whose pane title is still the shell's. On this
// box that is the hostname. Stamping it would freeze the session's title as
// `devvm` for the rest of its life, because stamping is what stops the rule.
func TestAutoTitleWaitsForTheGlyphNotJustForTheSentinel(t *testing.T) {
	now := time.Now()
	argv, rec := autoTitleFixture(t, "exit 0")

	booting := []Session{claudeSession("k7m2q9x4tpz3", "devvm", 1200*time.Millisecond, now)}
	autoTitleSessions("wizard", booting, now)

	if got := recordedArgv(t, argv); got != "" {
		t.Fatalf("stamped the shell's own pane title:\n%s", got)
	}
	if booting[0].Title != "" {
		t.Fatalf("Title = %q, want none until Claude writes one", booting[0].Title)
	}
	if evs := autonamed(t, rec); len(evs) != 0 {
		t.Fatalf("reported an outcome mid-boot: %v", rec.lines)
	}

	// And the real summary still lands.
	settled := []Session{claudeSession("k7m2q9x4tpz3", "✳ Tashkent trip planning", 12*time.Second, now)}
	autoTitleSessions("wizard", settled, now.Add(11*time.Second))
	if settled[0].Title != "Tashkent trip planning" {
		t.Errorf("Title = %q, want the summary", settled[0].Title)
	}
	if got := recordedArgv(t, argv); !strings.Contains(got, "Tashkent trip planning") {
		t.Errorf("never stamped the summary:\n%s", got)
	}
}

// paneTitleSummary is the whole "is there a summary here" test. Only a leading
// glyph makes a pane title one.
func TestPaneTitleSummary(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
		ok   bool
	}{
		{"a summary", "✳ Tashkent trip planning", "Tashkent trip planning", true},
		{"under another glyph", "✽ Tashkent trip planning", "Tashkent trip planning", true},
		{"no space after the glyph", "✳Tashkent", "Tashkent", true},

		{"the no-summary sentinel", "✳ Claude Code", "", false},
		{"the sentinel under another glyph", "✻ Claude Code", "", false},
		{"the shell's own pane title", "devvm", "", false},
		{"a bare hostname that looks like prose", "wizard@devvm: ~/code", "", false},
		{"empty", "", "", false},
		{"the glyph alone", "✳", "", false},
		{"the glyph and whitespace", "✳    ", "", false},
		{"a glyph that is not leading", "Fix the ✳ rendering", "", false},

		// The title someone would have to type to be mistaken for Claude.
		{"a person's title starting with a glyph", "✳ my own title", "my own title", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := paneTitleSummary(c.in)
			if got != c.want || ok != c.ok {
				t.Errorf("paneTitleSummary(%q) = (%q, %v), want (%q, %v)", c.in, got, ok, c.want, c.ok)
			}
		})
	}
}
