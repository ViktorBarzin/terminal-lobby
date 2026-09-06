package spendstore

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"terminal-lobby/sessionio"
)

// A fixed local noon, so a test that adds hours never crosses a day boundary
// by accident and a test that means to cross one says so.
func noon(t *testing.T, date string) time.Time {
	t.Helper()
	at, err := time.ParseInLocation("2006-01-02 15:04:05", date+" 12:00:00", time.Local)
	if err != nil {
		t.Fatalf("parse %q: %v", date, err)
	}
	return at
}

// claudeReading is the shape the statusLine recorder produces: one session, one
// model, a running cost total and the context it is carrying.
func claudeReading(at time.Time, session, id string, cost float64, in, out int64) Reading {
	return Reading{
		User:        "alice",
		TmuxSession: session,
		Tool:        sessionio.HarnessClaude,
		SessionID:   id,
		Model:       "claude-opus-5",
		CostUSD:     cost,
		Tokens:      Tokens{Input: in, Output: out},
		At:          at,
	}
}

func mustRecord(t *testing.T, s *Store, readings ...Reading) {
	t.Helper()
	for i, r := range readings {
		if err := s.Record(r); err != nil {
			t.Fatalf("Record #%d: %v", i, err)
		}
	}
}

func mustLoad(t *testing.T, s *Store, user string) Doc {
	t.Helper()
	doc, err := s.Load(user)
	if err != nil {
		t.Fatalf("Load(%q): %v", user, err)
	}
	return doc
}

// dayCost sums every day rollup, which is the figure the page's All time shows.
func dayCost(d Doc) float64 {
	var c float64
	for _, day := range d.Days {
		c += day.CostUSD
	}
	return c
}

func TestLoadWithNothingStoredReturnsAnEmptyDocument(t *testing.T) {
	s := New(t.TempDir())
	doc := mustLoad(t, s, "alice")
	if doc.Version != Version {
		t.Fatalf("version: got %d, want %d", doc.Version, Version)
	}
	if len(doc.Sessions) != 0 || len(doc.Days) != 0 {
		t.Fatalf("empty document: got %d sessions and %d days, want none", len(doc.Sessions), len(doc.Days))
	}
}

func TestRecordKeepsASessionRowAndADayRollup(t *testing.T) {
	s := New(t.TempDir())
	at := noon(t, "2026-09-06")
	mustRecord(t, s, claudeReading(at, "work", "conv-1", 0.42, 58794, 12))

	doc := mustLoad(t, s, "alice")
	if len(doc.Sessions) != 1 {
		t.Fatalf("session rows: got %d, want 1", len(doc.Sessions))
	}
	row := doc.Sessions[0]
	if row.Key != "work" || row.SessionID != "conv-1" || row.Tool != sessionio.HarnessClaude {
		t.Fatalf("session row identity: %+v", row)
	}
	if row.CostUSD != 0.42 || row.Tokens.Input != 58794 || row.Tokens.Output != 12 {
		t.Fatalf("session row figures: %+v", row)
	}
	if row.FirstSeen != at.Unix() || row.LastSeen != at.Unix() {
		t.Fatalf("session row clock: got first %d last %d, want %d", row.FirstSeen, row.LastSeen, at.Unix())
	}
	if len(doc.Days) != 1 {
		t.Fatalf("day rollups: got %d, want 1", len(doc.Days))
	}
	day := doc.Days[0]
	if day.Date != "2026-09-06" || day.CostUSD != 0.42 || day.Model != "claude-opus-5" {
		t.Fatalf("day rollup: %+v", day)
	}
}

// The statusLine hands out the session's RUNNING TOTAL and renders many times a
// turn. A second reading therefore REPLACES the row's total, and the day rollup
// moves by the difference. Adding instead would multiply the figure by however
// often the prompt happened to redraw.
func TestARerenderReplacesTheRunningTotalRatherThanAddingToIt(t *testing.T) {
	s := New(t.TempDir())
	at := noon(t, "2026-09-06")
	mustRecord(t, s,
		claudeReading(at, "work", "conv-1", 0.10, 1000, 10),
		claudeReading(at.Add(time.Second), "work", "conv-1", 0.10, 1000, 10),
		claudeReading(at.Add(2*time.Second), "work", "conv-1", 0.10, 1000, 10),
		claudeReading(at.Add(3*time.Second), "work", "conv-1", 0.25, 2500, 40),
	)

	doc := mustLoad(t, s, "alice")
	if len(doc.Sessions) != 1 {
		t.Fatalf("session rows: got %d, want 1 (one conversation)", len(doc.Sessions))
	}
	if got := doc.Sessions[0].CostUSD; got != 0.25 {
		t.Fatalf("session total after four renders: got %v, want 0.25", got)
	}
	if got := doc.Sessions[0].Tokens.Input; got != 2500 {
		t.Fatalf("session input tokens: got %d, want 2500", got)
	}
	if got := dayCost(doc); got != 0.25 {
		t.Fatalf("day rollup after four renders: got %v, want 0.25", got)
	}
	if got := doc.Sessions[0].FirstSeen; got != at.Unix() {
		t.Fatalf("first seen moved: got %d, want %d", got, at.Unix())
	}
	if got := doc.Sessions[0].LastSeen; got != at.Add(3*time.Second).Unix() {
		t.Fatalf("last seen: got %d, want %d", got, at.Add(3*time.Second).Unix())
	}
}

// Every reading rolls its DIFFERENCE into the day it was taken, so a session
// running past midnight leaves each day holding what was spent on it.
func TestASessionCrossingMidnightSplitsAcrossBothDays(t *testing.T) {
	s := New(t.TempDir())
	before := noon(t, "2026-09-06").Add(11*time.Hour + 59*time.Minute) // 23:59
	after := noon(t, "2026-09-07").Add(-11 * time.Hour)                // 01:00 the next day
	mustRecord(t, s,
		claudeReading(before, "work", "conv-1", 1.00, 1000, 10),
		claudeReading(after, "work", "conv-1", 3.50, 4000, 40),
	)

	doc := mustLoad(t, s, "alice")
	byDate := map[string]DayRow{}
	for _, d := range doc.Days {
		byDate[d.Date] = d
	}
	if len(byDate) != 2 {
		t.Fatalf("day rollups: got %d, want 2 (%+v)", len(byDate), doc.Days)
	}
	if got := byDate["2026-09-06"].CostUSD; got != 1.00 {
		t.Fatalf("first day: got %v, want 1.00", got)
	}
	if got := byDate["2026-09-07"].CostUSD; got != 2.50 {
		t.Fatalf("second day: got %v, want 2.50 (the difference, not the total)", got)
	}
	if got := byDate["2026-09-07"].Tokens.Input; got != 3000 {
		t.Fatalf("second day input tokens: got %d, want 3000", got)
	}
	if len(doc.Sessions) != 1 || doc.Sessions[0].CostUSD != 3.50 {
		t.Fatalf("the session row still holds the running total: %+v", doc.Sessions)
	}
}

// A tmux session name outlives the conversation inside it. Two Claude processes
// that shared a name are two rows, keyed by the conversation.
func TestTwoConversationsUnderOneSessionNameAreTwoRows(t *testing.T) {
	s := New(t.TempDir())
	at := noon(t, "2026-09-06")
	mustRecord(t, s,
		claudeReading(at, "work", "conv-1", 2.00, 1000, 10),
		claudeReading(at.Add(time.Hour), "work", "conv-2", 0.75, 500, 5),
	)

	doc := mustLoad(t, s, "alice")
	if len(doc.Sessions) != 2 {
		t.Fatalf("session rows: got %d, want 2", len(doc.Sessions))
	}
	if got := dayCost(doc); got != 2.75 {
		t.Fatalf("day rollup: got %v, want 2.75", got)
	}
}

// A rename changes what the row is called without changing which conversation
// it is, so the figures stay on the one row.
func TestARenamedSessionKeepsItsRowAndTakesTheNewName(t *testing.T) {
	s := New(t.TempDir())
	at := noon(t, "2026-09-06")
	mustRecord(t, s,
		claudeReading(at, "old-name", "conv-1", 1.00, 1000, 10),
		claudeReading(at.Add(time.Minute), "new-name", "conv-1", 1.50, 1500, 15),
	)

	doc := mustLoad(t, s, "alice")
	if len(doc.Sessions) != 1 {
		t.Fatalf("session rows: got %d, want 1", len(doc.Sessions))
	}
	if doc.Sessions[0].Key != "new-name" {
		t.Fatalf("session key: got %q, want new-name", doc.Sessions[0].Key)
	}
	if got := dayCost(doc); got != 1.50 {
		t.Fatalf("day rollup: got %v, want 1.50", got)
	}
}

// Switching model mid-conversation puts the spend from that point on under the
// new model, which is where it was actually incurred.
func TestSwitchingModelPutsLaterSpendUnderTheNewModel(t *testing.T) {
	s := New(t.TempDir())
	at := noon(t, "2026-09-06")
	first := claudeReading(at, "work", "conv-1", 1.00, 1000, 10)
	second := claudeReading(at.Add(time.Minute), "work", "conv-1", 1.75, 2000, 20)
	second.Model = "claude-haiku-4-5"
	mustRecord(t, s, first, second)

	doc := mustLoad(t, s, "alice")
	byModel := map[string]float64{}
	for _, d := range doc.Days {
		byModel[d.Model] += d.CostUSD
	}
	if byModel["claude-opus-5"] != 1.00 {
		t.Fatalf("opus day rollup: got %v, want 1.00", byModel["claude-opus-5"])
	}
	if byModel["claude-haiku-4-5"] != 0.75 {
		t.Fatalf("haiku day rollup: got %v, want 0.75", byModel["claude-haiku-4-5"])
	}
	if doc.Sessions[0].Model != "claude-haiku-4-5" {
		t.Fatalf("session row model: got %q, want the model it is on now", doc.Sessions[0].Model)
	}
}

// A figure that goes backwards is a source that restarted its arithmetic, not a
// refund. It contributes nothing rather than subtracting from the day.
func TestAFigureGoingBackwardsDoesNotSubtractFromTheDay(t *testing.T) {
	s := New(t.TempDir())
	at := noon(t, "2026-09-06")
	mustRecord(t, s,
		claudeReading(at, "work", "conv-1", 5.00, 90000, 900),
		claudeReading(at.Add(time.Minute), "work", "conv-1", 4.00, 1000, 10),
	)

	doc := mustLoad(t, s, "alice")
	if got := dayCost(doc); got != 5.00 {
		t.Fatalf("day rollup: got %v, want 5.00", got)
	}
	if got := doc.Sessions[0].CostUSD; got != 4.00 {
		t.Fatalf("session row: got %v, want the latest reading 4.00", got)
	}
}

// Retention: a row nobody has written to in 30 days stops being listed. Its
// money stays in the days, and the row itself stays as a baseline.
func TestSessionRowsOlderThanThirtyDaysStopBeingListedAndTheDaysKeepTheMoney(t *testing.T) {
	s := New(t.TempDir())
	old := noon(t, "2026-07-01")
	recent := old.Add(SessionTTL + time.Hour)

	mustRecord(t, s, claudeReading(old, "old", "conv-old", 9.00, 1000, 10))
	if got := len(mustLoad(t, s, "alice").Sessions); got != 1 {
		t.Fatalf("before the fold: got %d session rows, want 1", got)
	}

	mustRecord(t, s, claudeReading(recent, "new", "conv-new", 1.00, 100, 1))
	doc := mustLoad(t, s, "alice")
	live := LiveRows(doc.Sessions)
	if len(live) != 1 || live[0].SessionID != "conv-new" {
		t.Fatalf("after the fold: %+v, want only conv-new listed", live)
	}
	if got := dayCost(doc); got != 10.00 {
		t.Fatalf("day rollups after the fold: got %v, want 10.00", got)
	}
	if len(doc.Days) != 2 {
		t.Fatalf("day rollups: got %d, want 2 (both days survive)", len(doc.Days))
	}
}

// A row still being written to is not old, however long ago it started.
func TestALongRunningSessionIsNotFoldedWhileItIsStillBeingWrittenTo(t *testing.T) {
	s := New(t.TempDir())
	start := noon(t, "2026-07-01")
	for day := 0; day <= 40; day++ {
		mustRecord(t, s, claudeReading(start.AddDate(0, 0, day), "work", "conv-1", float64(day+1), 0, 0))
	}
	doc := mustLoad(t, s, "alice")
	if len(doc.Sessions) != 1 {
		t.Fatalf("session rows: got %d, want 1 (last written to today)", len(doc.Sessions))
	}
	if got := doc.Sessions[0].CostUSD; got != 41 {
		t.Fatalf("session total: got %v, want 41", got)
	}
}

// The day rollups are the complete record and the session rows are the detail
// view of the last 30 days. That invariant is what makes the fold a plain drop
// and All time answerable from the days alone.
func TestTheDayRollupsHoldEverySessionRowsSpend(t *testing.T) {
	s := New(t.TempDir())
	at := noon(t, "2026-09-06")
	for i := 0; i < 12; i++ {
		id := fmt.Sprintf("conv-%d", i%4)
		mustRecord(t, s, claudeReading(at.Add(time.Duration(i)*time.Minute), "work", id, float64(i)*0.5, int64(i)*100, int64(i)))
	}
	doc := mustLoad(t, s, "alice")
	var rows float64
	for _, r := range doc.Sessions {
		rows += r.CostUSD
	}
	if got := dayCost(doc); got != rows {
		t.Fatalf("day rollups %v, session rows %v: the two must agree inside the retention window", got, rows)
	}
}

// Windows are account-wide and only some seats report them. The newest set that
// said anything wins; a reading that reports none leaves the last one alone,
// because "this seat has no windows" and "this render did not mention them"
// arrive looking the same. A stale set expires on its own: the reader drops a
// window whose reset has passed.
func TestWindowsKeepTheNewestReadingThatNamedAny(t *testing.T) {
	s := New(t.TempDir())
	at := noon(t, "2026-09-06")

	withWindows := claudeReading(at, "work", "conv-1", 1.00, 0, 0)
	withWindows.Windows = []Window{{Name: WindowFiveHour, UsedPercent: 37, ResetsAtSec: 1788730052}}
	mustRecord(t, s, withWindows)

	mustRecord(t, s, claudeReading(at.Add(time.Minute), "work", "conv-1", 1.50, 0, 0))
	doc := mustLoad(t, s, "alice")
	if len(doc.Windows) != 1 || doc.Windows[0].UsedPercent != 37 {
		t.Fatalf("a reading with no windows erased the last set: %+v", doc.Windows)
	}
	if doc.WindowsAt != at.Unix() {
		t.Fatalf("windows timestamp: got %d, want %d", doc.WindowsAt, at.Unix())
	}

	newer := claudeReading(at.Add(2*time.Minute), "work", "conv-1", 2.00, 0, 0)
	newer.Windows = []Window{{Name: WindowFiveHour, UsedPercent: 44, ResetsAtSec: 1788730052}}
	mustRecord(t, s, newer)
	doc = mustLoad(t, s, "alice")
	if len(doc.Windows) != 1 || doc.Windows[0].UsedPercent != 44 {
		t.Fatalf("newer windows did not win: %+v", doc.Windows)
	}
}

func TestRecordRejectsWhatCannotBeStored(t *testing.T) {
	at := noon(t, "2026-09-06")
	cases := []struct {
		name  string
		mutit func(*Reading)
	}{
		{"no user", func(r *Reading) { r.User = "" }},
		{"a user that is a path", func(r *Reading) { r.User = "../etc/passwd" }},
		{"a user with a separator", func(r *Reading) { r.User = "a/b" }},
		{"no conversation", func(r *Reading) { r.SessionID = "" }},
		{"no clock", func(r *Reading) { r.At = time.Time{} }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := New(t.TempDir())
			r := claudeReading(at, "work", "conv-1", 1.0, 10, 1)
			tc.mutit(&r)
			if err := s.Record(r); err == nil {
				t.Fatalf("Record accepted %s", tc.name)
			}
			if ents, _ := os.ReadDir(s.dir); len(ents) != 0 {
				t.Fatalf("a rejected reading wrote %d files", len(ents))
			}
		})
	}
}

func TestTheFileIsPrivateToItsUser(t *testing.T) {
	s := New(t.TempDir())
	mustRecord(t, s, claudeReading(noon(t, "2026-09-06"), "work", "conv-1", 1.0, 10, 1))
	fi, err := os.Stat(filepath.Join(s.dir, "alice.json"))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode: got %o, want 600", fi.Mode().Perm())
	}
}

func TestEachUserGetsTheirOwnFile(t *testing.T) {
	s := New(t.TempDir())
	at := noon(t, "2026-09-06")
	alice := claudeReading(at, "work", "conv-1", 1.0, 10, 1)
	bob := claudeReading(at, "work", "conv-2", 7.0, 70, 7)
	bob.User = "bob"
	mustRecord(t, s, alice, bob)

	if got := dayCost(mustLoad(t, s, "alice")); got != 1.0 {
		t.Fatalf("alice: got %v, want 1.0", got)
	}
	if got := dayCost(mustLoad(t, s, "bob")); got != 7.0 {
		t.Fatalf("bob: got %v, want 7.0", got)
	}
}

func TestACorruptFileIsAnErrorRatherThanAnEmptyDocument(t *testing.T) {
	s := New(t.TempDir())
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(s.dir, "alice.json"), []byte("{not json"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := s.Load("alice"); err == nil {
		t.Fatal("Load accepted a corrupt document; a month of spend must not read as zero")
	}
}

// Concurrency: the statusLine of every open session posts independently, so
// Record is called from several goroutines at once. Run under -race.
func TestConcurrentRecordsAllLand(t *testing.T) {
	s := New(t.TempDir())
	at := noon(t, "2026-09-06")
	const sessions, renders = 8, 25

	var wg sync.WaitGroup
	for i := 0; i < sessions; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for n := 1; n <= renders; n++ {
				r := claudeReading(at.Add(time.Duration(n)*time.Second), "work", fmt.Sprintf("conv-%d", i), float64(n), int64(n)*10, int64(n))
				if err := s.Record(r); err != nil {
					t.Errorf("Record: %v", err)
					return
				}
			}
		}(i)
	}
	wg.Wait()

	doc := mustLoad(t, s, "alice")
	if len(doc.Sessions) != sessions {
		t.Fatalf("session rows: got %d, want %d", len(doc.Sessions), sessions)
	}
	for _, r := range doc.Sessions {
		if r.CostUSD != renders {
			t.Fatalf("%s ended at %v, want the last running total %d", r.SessionID, r.CostUSD, renders)
		}
	}
	if got, want := dayCost(doc), float64(sessions*renders); got != want {
		t.Fatalf("day rollup: got %v, want %v", got, want)
	}
}

// The rows are bounded even inside the retention window, the way the titles and
// assignment stores are. Trimming one costs no money, because its spend is
// already in the day it happened.
func TestSessionRowsAreBoundedAndTrimmingOneKeepsItsSpend(t *testing.T) {
	s := New(t.TempDir())
	s.maxRows = 5 // the production cap, reached in ten writes instead of two thousand
	at := noon(t, "2026-09-06")
	const rows = 12
	for i := 0; i < rows; i++ {
		mustRecord(t, s, claudeReading(at.Add(time.Duration(i)*time.Second), "work", fmt.Sprintf("conv-%d", i), 0.01, 0, 0))
	}
	doc := mustLoad(t, s, "alice")
	if len(doc.Sessions) != s.maxRows {
		t.Fatalf("session rows: got %d, want the cap %d", len(doc.Sessions), s.maxRows)
	}
	if got, want := dayCost(doc), 0.01*rows; !closeEnough(got, want) {
		t.Fatalf("day rollup after trimming: got %v, want %v", got, want)
	}
	// The trim drops the ones written to longest ago.
	for _, r := range doc.Sessions {
		if r.SessionID == "conv-0" {
			t.Fatal("the trim kept the oldest row and dropped a newer one")
		}
	}
}

func TestNewStoreCarriesTheProductionCap(t *testing.T) {
	if got := New(t.TempDir()).maxRows; got != MaxSessionRows {
		t.Fatalf("maxRows: got %d, want %d", got, MaxSessionRows)
	}
}

func closeEnough(a, b float64) bool {
	d := a - b
	if d < 0 {
		d = -d
	}
	return d < 1e-9
}

// The document on disk is plain JSON another process can read, which is how
// tmux-api serves it while session-events writes it.
func TestTheDocumentOnDiskIsReadableJSON(t *testing.T) {
	s := New(t.TempDir())
	mustRecord(t, s, claudeReading(noon(t, "2026-09-06"), "work", "conv-1", 1.25, 100, 10))
	raw, err := os.ReadFile(filepath.Join(s.dir, "alice.json"))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var doc Doc
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("unmarshal %s: %v", raw, err)
	}
	if doc.Version != Version || len(doc.Sessions) != 1 || doc.Sessions[0].CostUSD != 1.25 {
		t.Fatalf("round trip: %+v", doc)
	}
}

// Retention must not become an accounting error. A row the fold retired has
// already put its money in the days, so when that conversation reports again
// the store differences against what it last held rather than treating the
// whole running total as new spend.
//
// The trim takes the least recently seen, which is never a conversation that is
// rendering: two live ones alternating keep their baselines however tight the
// cap is, and each is counted once.
func TestConversationsRenderingAlternatelyKeepTheirBaselineThroughTheTrim(t *testing.T) {
	s := New(t.TempDir())
	s.maxRows = 3
	at := noon(t, "2026-09-06")

	// One conversation that reports once and then goes quiet, plus two that
	// keep rendering at $10 and $1.
	mustRecord(t, s, claudeReading(at, "done", "conv-done", 0.50, 0, 0))
	for i := 0; i < 4; i++ {
		step := time.Duration(i*2+1) * time.Second
		mustRecord(t, s,
			claudeReading(at.Add(step), "big", "conv-big", 10.00, 0, 0),
			claudeReading(at.Add(step+time.Second), "small", "conv-small", 1.00, 0, 0),
		)
	}

	doc := mustLoad(t, s, "alice")
	if got := dayCost(doc); !closeEnough(got, 11.50) {
		t.Fatalf("all time: got %v, want 11.50 (each conversation counted once)", got)
	}
	if len(doc.Sessions) > s.maxRows {
		t.Fatalf("rows: got %d, want at most the cap %d", len(doc.Sessions), s.maxRows)
	}
}

// The residual, stated as a test rather than left to be discovered: the cap is
// the one place a baseline is genuinely dropped, and a conversation that speaks
// again after that contributes its running total afresh. It takes more
// conversations than the cap, passing through the document, before the old one
// reports again.
func TestAConversationThatOutlivedItsBaselineIsCountedAgain(t *testing.T) {
	s := New(t.TempDir())
	s.maxRows = 2
	at := noon(t, "2026-09-06")

	mustRecord(t, s, claudeReading(at, "work", "conv-1", 5.00, 0, 0))
	// Two other conversations push conv-1 out of the document entirely.
	mustRecord(t, s,
		claudeReading(at.Add(time.Second), "a", "conv-a", 0, 0, 0),
		claudeReading(at.Add(2*time.Second), "b", "conv-b", 0, 0, 0),
	)
	if _, ok := rowFor(mustLoad(t, s, "alice"), "conv-1"); ok {
		t.Fatal("conv-1 still has a baseline, so this test no longer describes the cap")
	}

	mustRecord(t, s, claudeReading(at.Add(3*time.Second), "work", "conv-1", 5.00, 0, 0))
	if got := dayCost(mustLoad(t, s, "alice")); !closeEnough(got, 10.00) {
		t.Fatalf("all time: got %v, want 10.00 — the documented cost of an evicted baseline", got)
	}
}

// The same arithmetic across the retention window: a conversation resumed after
// its row aged out adds only what it has spent since.
func TestAConversationResumedAfterItsRowExpiredIsNotCountedTwice(t *testing.T) {
	s := New(t.TempDir())
	start := noon(t, "2026-07-01")
	later := start.Add(SessionTTL + time.Hour)

	mustRecord(t, s, claudeReading(start, "work", "conv-1", 10.00, 1000, 10))
	// Another conversation's write is what runs the fold that retires conv-1.
	mustRecord(t, s, claudeReading(later, "other", "conv-2", 0, 0, 0))
	mustRecord(t, s, claudeReading(later.Add(time.Minute), "work", "conv-1", 10.50, 1200, 12))

	doc := mustLoad(t, s, "alice")
	if got := dayCost(doc); !closeEnough(got, 10.50) {
		t.Fatalf("all time: got %v, want 10.50 (the running total, not twice it)", got)
	}
	if got := dayTokens(doc); got.Input != 1200 {
		t.Fatalf("all time input tokens: got %d, want 1200", got.Input)
	}
}

// A retired row is a baseline and nothing else: no name, no model, and the
// reader leaves it out of the session list.
func TestARetiredRowKeepsTheTotalsAndDropsTheDetail(t *testing.T) {
	s := New(t.TempDir())
	start := noon(t, "2026-07-01")
	later := start.Add(SessionTTL + time.Hour)

	mustRecord(t, s, claudeReading(start, "work", "conv-1", 10.00, 1000, 10))
	mustRecord(t, s, claudeReading(later, "other", "conv-2", 1.00, 0, 0))

	doc := mustLoad(t, s, "alice")
	if got := len(LiveRows(doc.Sessions)); got != 1 {
		t.Fatalf("live session rows: got %d, want 1", got)
	}
	row, ok := rowFor(doc, "conv-1")
	if !ok {
		t.Fatal("conv-1 kept no baseline, so a later reading from it would count twice")
	}
	if !row.Folded {
		t.Fatal("conv-1 is still a live row after the retention window")
	}
	if row.Key != "" || row.Model != "" {
		t.Fatalf("retired row kept detail: %+v", row)
	}
	if row.CostUSD != 10.00 {
		t.Fatalf("retired row total: got %v, want 10.00", row.CostUSD)
	}
}

// Reporting again un-retires the row, so the conversation is back in the
// session list under whatever name it now runs in.
func TestAResumedConversationBecomesALiveRowAgain(t *testing.T) {
	s := New(t.TempDir())
	start := noon(t, "2026-07-01")
	later := start.Add(SessionTTL + time.Hour)

	mustRecord(t, s,
		claudeReading(start, "work", "conv-1", 10.00, 0, 0),
		claudeReading(later, "other", "conv-2", 1.00, 0, 0),
		claudeReading(later.Add(time.Minute), "renamed", "conv-1", 10.50, 0, 0),
	)
	doc := mustLoad(t, s, "alice")
	row, ok := rowFor(doc, "conv-1")
	if !ok || row.Folded {
		t.Fatalf("conv-1 after reporting again: %+v, want a live row", row)
	}
	if row.Key != "renamed" {
		t.Fatalf("row name: got %q, want renamed", row.Key)
	}
}

// The cap counts retired rows too, so the document stays bounded however many
// conversations pass through it.
func TestTheCapBoundsRetiredRowsAsWell(t *testing.T) {
	s := New(t.TempDir())
	s.maxRows = 4
	start := noon(t, "2026-07-01")
	for i := 0; i < 20; i++ {
		at := start.AddDate(0, 0, i*3) // three days apart: most of them age out
		mustRecord(t, s, claudeReading(at, "work", fmt.Sprintf("conv-%d", i), 0.10, 0, 0))
	}
	doc := mustLoad(t, s, "alice")
	if len(doc.Sessions) > s.maxRows {
		t.Fatalf("rows: got %d, want at most the cap %d", len(doc.Sessions), s.maxRows)
	}
	if got := dayCost(doc); !closeEnough(got, 2.00) {
		t.Fatalf("all time: got %v, want 2.00", got)
	}
}

func rowFor(d Doc, id string) (SessionRow, bool) {
	for _, r := range d.Sessions {
		if r.SessionID == id {
			return r, true
		}
	}
	return SessionRow{}, false
}

func dayTokens(d Doc) Tokens {
	var out Tokens
	for _, day := range d.Days {
		out = out.add(day.Tokens)
	}
	return out
}
