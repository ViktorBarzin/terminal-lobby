package spendstore

import (
	"sort"
	"time"

	"terminal-lobby/sessionio"
)

// Period is one of the spans the Settings page offers, the same four the
// Network page already labels.
type Period string

const (
	PeriodToday     Period = "today"
	PeriodSevenDays Period = "7d"
	PeriodThisMonth Period = "month"
	PeriodAllTime   Period = "all"
)

// ParsePeriod turns a query parameter into a Period. The bool is the gate: an
// unrecognised value is a caller's mistake, and answering it as All time would
// hand back a much larger number than the caller asked for.
func ParsePeriod(s string) (Period, bool) {
	switch Period(s) {
	case PeriodToday, PeriodSevenDays, PeriodThisMonth, PeriodAllTime:
		return Period(s), true
	}
	return "", false
}

// Total is one tool's figures over a period.
type Total struct {
	Tool    sessionio.Harness `json:"tool"`
	Tokens  Tokens            `json:"tokens"`
	CostUSD float64           `json:"costUsd"`
}

// TotalsFor sums the day rollups the period covers, one entry per tool, ordered
// by tool name so the page renders the same way twice.
//
// The days alone are the whole answer. Every reading rolled its difference into
// one, including the readings whose session rows have since been dropped, so
// there is nothing to add from the rows and no risk of counting a live session
// twice.
//
// A period nobody recognises matches nothing rather than falling back to All
// time. ParsePeriod is the gate that stops one reaching here.
func (d Doc) TotalsFor(p Period, now time.Time) []Total {
	byTool := map[sessionio.Harness]Total{}
	for _, day := range d.Days {
		if !periodCovers(p, day.Date, now) {
			continue
		}
		t := byTool[day.Tool]
		t.Tool = day.Tool
		t.CostUSD += day.CostUSD
		t.Tokens = t.Tokens.add(day.Tokens)
		byTool[day.Tool] = t
	}
	out := make([]Total, 0, len(byTool))
	for _, t := range byTool {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Tool < out[j].Tool })
	return out
}

// periodCovers compares ISO dates as strings, which orders them correctly and
// needs no parsing back into a time.
func periodCovers(p Period, date string, now time.Time) bool {
	switch p {
	case PeriodToday:
		return date == now.Format(dateLayout)
	case PeriodSevenDays:
		// Today and the six before it, the span the page labels "7 days".
		return date >= now.AddDate(0, 0, -6).Format(dateLayout) && date <= now.Format(dateLayout)
	case PeriodThisMonth:
		return len(date) >= 7 && date[:7] == now.Format("2006-01")
	case PeriodAllTime:
		return true
	}
	return false
}
