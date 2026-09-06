package spendstore

import (
	"testing"
	"time"

	"terminal-lobby/sessionio"
)

// A document with one day rollup per date, so a period test reads as "which
// dates did this period pick up".
func daysDoc(rows ...DayRow) Doc {
	return Doc{Version: Version, Days: rows}
}

func day(date string, tool sessionio.Harness, cost float64) DayRow {
	return DayRow{
		Date:    date,
		Tool:    tool,
		Model:   "claude-opus-5",
		Tokens:  Tokens{Input: 1000, Output: 100},
		CostUSD: cost,
	}
}

func TestTotalsForEachPeriod(t *testing.T) {
	now, err := time.ParseInLocation("2006-01-02 15:04:05", "2026-09-15 12:00:00", time.Local)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	doc := daysDoc(
		day("2026-09-15", sessionio.HarnessClaude, 1),    // today
		day("2026-09-14", sessionio.HarnessClaude, 2),    // yesterday
		day("2026-09-09", sessionio.HarnessClaude, 4),    // the seventh day back
		day("2026-09-08", sessionio.HarnessClaude, 8),    // one day outside 7 days
		day("2026-09-01", sessionio.HarnessClaude, 16),   // this month, outside 7 days
		day("2026-08-31", sessionio.HarnessClaude, 32),   // last month
		day("2025-12-25", sessionio.HarnessClaude, 1024), // long ago
	)

	cases := []struct {
		period Period
		want   float64
	}{
		{PeriodToday, 1},
		{PeriodSevenDays, 1 + 2 + 4},
		{PeriodThisMonth, 1 + 2 + 4 + 8 + 16},
		{PeriodAllTime, 1 + 2 + 4 + 8 + 16 + 32 + 1024},
	}
	for _, tc := range cases {
		t.Run(string(tc.period), func(t *testing.T) {
			got := doc.TotalsFor(tc.period, now)
			if len(got) != 1 {
				t.Fatalf("totals: got %d entries, want 1 tool", len(got))
			}
			if got[0].CostUSD != tc.want {
				t.Fatalf("%s: got %v, want %v", tc.period, got[0].CostUSD, tc.want)
			}
		})
	}
}

func TestTotalsAreSplitPerToolAndOrderedByName(t *testing.T) {
	now, _ := time.ParseInLocation("2006-01-02", "2026-09-15", time.Local)
	doc := daysDoc(
		day("2026-09-15", sessionio.HarnessClaude, 3),
		day("2026-09-15", sessionio.HarnessCodex, 0),
		day("2026-09-14", sessionio.HarnessClaude, 4),
	)
	got := doc.TotalsFor(PeriodSevenDays, now)
	if len(got) != 2 {
		t.Fatalf("totals: got %d, want one per tool", len(got))
	}
	if got[0].Tool != sessionio.HarnessClaude || got[1].Tool != sessionio.HarnessCodex {
		t.Fatalf("order: got %s then %s, want claude then codex", got[0].Tool, got[1].Tool)
	}
	if got[0].CostUSD != 7 {
		t.Fatalf("claude: got %v, want 7", got[0].CostUSD)
	}
	if got[0].Tokens.Input != 2000 || got[0].Tokens.Output != 200 {
		t.Fatalf("claude tokens: %+v", got[0].Tokens)
	}
}

func TestTotalsForAnEmptyDocumentAreEmpty(t *testing.T) {
	if got := (Doc{}).TotalsFor(PeriodAllTime, time.Now()); len(got) != 0 {
		t.Fatalf("got %d totals, want none", len(got))
	}
}

// A period nobody recognises picks up nothing rather than quietly answering as
// All time, so a mistyped query param shows an empty panel instead of a wrong
// number. ParsePeriod is the gate that keeps one from getting this far.
func TestAnUnknownPeriodMatchesNothing(t *testing.T) {
	doc := daysDoc(day("2026-09-15", sessionio.HarnessClaude, 5))
	now, _ := time.ParseInLocation("2006-01-02", "2026-09-15", time.Local)
	if got := doc.TotalsFor(Period("last-tuesday"), now); len(got) != 0 {
		t.Fatalf("got %+v, want nothing", got)
	}
}

func TestParsePeriod(t *testing.T) {
	cases := []struct {
		in   string
		want Period
		ok   bool
	}{
		{"today", PeriodToday, true},
		{"7d", PeriodSevenDays, true},
		{"month", PeriodThisMonth, true},
		{"all", PeriodAllTime, true},
		{"", PeriodToday, false},
		{"7 days", PeriodToday, false},
		{"TODAY", PeriodToday, false},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			got, ok := ParsePeriod(tc.in)
			if ok != tc.ok {
				t.Fatalf("ParsePeriod(%q) ok: got %v, want %v", tc.in, ok, tc.ok)
			}
			if ok && got != tc.want {
				t.Fatalf("ParsePeriod(%q): got %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// Seven days means today and the six before it, the same span the Network page
// labels "7 days".
func TestSevenDaysCountsTodayAndTheSixBeforeIt(t *testing.T) {
	now, _ := time.ParseInLocation("2006-01-02", "2026-03-03", time.Local)
	doc := daysDoc(
		day("2026-03-03", sessionio.HarnessClaude, 1), // day 1
		day("2026-02-25", sessionio.HarnessClaude, 1), // day 7, the last one in
		day("2026-02-24", sessionio.HarnessClaude, 1), // day 8, outside
	)
	got := doc.TotalsFor(PeriodSevenDays, now)
	if len(got) != 1 || got[0].CostUSD != 2 {
		t.Fatalf("got %+v, want 2 across a month boundary", got)
	}
}

func TestTokensAddAndSubtract(t *testing.T) {
	a := Tokens{Input: 10, Output: 2, CacheRead: 5, CacheCreation: 3}
	b := Tokens{Input: 4, Output: 1, CacheRead: 9, CacheCreation: 0}
	if got, want := a.add(b), (Tokens{Input: 14, Output: 3, CacheRead: 14, CacheCreation: 3}); got != want {
		t.Fatalf("add: got %+v, want %+v", got, want)
	}
	// Subtraction clamps per field: a context that shrank did not un-spend.
	if got, want := a.sub(b), (Tokens{Input: 6, Output: 1, CacheRead: 0, CacheCreation: 3}); got != want {
		t.Fatalf("sub: got %+v, want %+v", got, want)
	}
}
