package main

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/user"
	"sort"
	"time"

	"terminal-lobby/sessionio"
	"terminal-lobby/spendstore"
)

// GET /agent-spend answers "what have my agents consumed", for the Settings
// page and the figure beside the gear.
//
// The two tools report different things and the response says so rather than
// forcing them into one shape. Claude Code computes dollars and this service
// reads them back from the store the statusLine recorder writes
// (/var/lib/tmux-api/spend/<user>.json). Codex reports no cost on a ChatGPT
// plan, so its half is rate-limit windows and tokens, read straight out of the
// rollout files the CLI already writes. A tool the user has never run has no
// section at all, which is what lets the page leave a heading out rather than
// draw one full of zeroes.
//
// The two halves are also independent in failure: a codex read that goes wrong
// is logged and its section omitted, because the Claude half is still worth
// rendering. Only a failure to read the store itself is a 500 — a month of
// spend showing as zero is worse than a panel that says it cannot load.
//
// Design: docs/plans/2026-09-06-agent-spend-panel-design.md.

// spendPeriodParam carries which span the caller wants, in the store's
// vocabulary (today, 7d, month, all). Absent means today, which is the figure
// the sidebar shows and the one most people open the page for.
const spendPeriodParam = "period"

// spendToolParam narrows the answer to one tool's section. Absent means both,
// which is what the Settings page wants. The sidebar figure follows the
// attached session's tool and reads a single number out of a single section, so
// it names the tool and the other half is neither read nor sent — the Codex
// half walks rollout files and shells out to tmux, and that figure is polled
// from every open tab.
const spendToolParam = "tool"

// TMUX_API_SPEND_DIR: scratch-build override for the dev harness, the same
// seam and the same reason as TMUX_API_PREFS_DIR. The systemd unit sets no
// environment, so production reads the real directory.
var spendStoreInstance = spendstore.New(func() string {
	if d := os.Getenv("TMUX_API_SPEND_DIR"); d != "" {
		return d
	}
	return spendstore.Dir
}())

// The seams below are vars purely so handler tests run hermetically: without
// them a test on a devvm would read whoever ran `go test`, their real rollouts
// and the live process table. Production never reassigns any of them.

// spendNow is the clock every period and every window expiry is judged against.
var spendNow = time.Now

// spendHomeDir is where the codex reader looks for ~/.codex. Empty when the
// user cannot be resolved, which the reader treats as "has never run Codex".
var spendHomeDir = func(osUser string) string {
	u, err := user.Lookup(osUser)
	if err != nil {
		return ""
	}
	return u.HomeDir
}

// spendProcDir is the process table the codex reader ties a rollout file to a
// tmux session through. Empty would turn live attribution off entirely.
var spendProcDir = "/proc"

// spendCodexPanes is the caller's live Codex panes. Only Codex ones: the walk
// costs a /proc readdir per pane and a claude session holds no rollout open.
var spendCodexPanes = func(osUser string) []codexPane {
	var out []codexPane
	for _, s := range userSessions(osUser) {
		if s.Tool != toolCodex || s.PanePID <= 0 {
			continue
		}
		out = append(out, codexPane{Session: s.Name, PID: s.PanePID})
	}
	return out
}

// agentSpendBody is the whole answer. A section is ABSENT rather than empty
// when the user has never run that tool.
type agentSpendBody struct {
	Period string              `json:"period"`
	Claude *claudeSpendSection `json:"claude,omitempty"`
	Codex  *codexSpendSection  `json:"codex,omitempty"`
}

// claudeSpendSection is spend, because that is the figure Claude Code computes
// for itself. Windows are present only for a seat whose statusLine payload
// carried rate_limits, which is Pro and Max and not enterprise.
type claudeSpendSection struct {
	CostUSD  float64              `json:"costUsd"`
	Tokens   spendstore.Tokens    `json:"tokens"`
	Models   []spendModelRow      `json:"models"`
	Windows  []spendstore.Window  `json:"windows,omitempty"`
	Sessions []claudeSpendSession `json:"sessions"`
}

// spendModelRow is what one model cost over the period.
type spendModelRow struct {
	Model   string            `json:"model"`
	Tokens  spendstore.Tokens `json:"tokens"`
	CostUSD float64           `json:"costUsd"`
}

// claudeSpendSession is one conversation. CostUSD is the conversation's RUNNING
// TOTAL, not its share of the period: the store keeps day rollups and session
// rows separately, and only the rollups are split by day. A conversation that
// began yesterday and was worked on today therefore appears under Today
// carrying what it has cost since it started. The heading figure above it is
// the period's own arithmetic and is the number to trust for the period.
type claudeSpendSession struct {
	SessionID string `json:"sessionId"`
	// Session is the tmux session name. The page joins it to the session list
	// it already holds to show a title.
	Session     string            `json:"session"`
	Model       string            `json:"model,omitempty"`
	Tokens      spendstore.Tokens `json:"tokens"`
	CostUSD     float64           `json:"costUsd"`
	LastSeenSec int64             `json:"lastSeenSec"`
}

// codexSpendSection is windows and tokens. There is no cost anywhere in it,
// because ChatGPT plans report none.
type codexSpendSection struct {
	Plan     string              `json:"plan,omitempty"`
	Windows  []codexSpendWindow  `json:"windows,omitempty"`
	Credits  *codexSpendCredits  `json:"credits,omitempty"`
	Sessions []codexSpendSession `json:"sessions"`
}

// codexSpendWindow is one rate-limit window, labelled in Codex's own words.
// WindowMinutes rides along so a page can spell a window this build has never
// seen without a table of its own.
type codexSpendWindow struct {
	Label         string  `json:"label"`
	WindowMinutes int     `json:"windowMinutes"`
	UsedPercent   float64 `json:"usedPercent"`
	ResetsAtSec   int64   `json:"resetsAtSec,omitempty"`
}

// codexSpendCredits is present only when the account has credits. Balance stays
// the string the rollout carried: parsing it into a number would invent
// precision the source does not promise.
type codexSpendCredits struct {
	Unlimited bool   `json:"unlimited"`
	Balance   string `json:"balance"`
}

// codexSpendSession is one LIVE conversation, tied to its pane by the rollout
// file the process holds open. A conversation that has exited cannot be tied
// back to a session, so it has no row here and lives only in the account-wide
// windows above.
type codexSpendSession struct {
	SessionID     string           `json:"sessionId"`
	Session       string           `json:"session,omitempty"`
	Model         string           `json:"model,omitempty"`
	Tokens        codexSpendTokens `json:"tokens"`
	ContextWindow int64            `json:"contextWindow,omitempty"`
	AtSec         int64            `json:"atSec,omitempty"`
}

// codexSpendTokens is total_token_usage. CachedInput is the part of Input that
// came from cache rather than an addition to it, so summing the fields would
// count the cache twice.
type codexSpendTokens struct {
	Input           int64 `json:"input"`
	CachedInput     int64 `json:"cachedInput"`
	CacheWriteInput int64 `json:"cacheWriteInput"`
	Output          int64 `json:"output"`
	ReasoningOutput int64 `json:"reasoningOutput"`
	Total           int64 `json:"total"`
}

func handleAgentSpend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	osUser := resolveOSUser(w, r)
	if osUser == "" {
		return
	}
	period := spendstore.PeriodToday
	if raw := r.URL.Query().Get(spendPeriodParam); raw != "" {
		p, ok := spendstore.ParsePeriod(raw)
		if !ok {
			http.Error(w, "unknown period", http.StatusBadRequest)
			return
		}
		period = p
	}
	tool, ok := parseSpendTool(r.URL.Query().Get(spendToolParam))
	if !ok {
		http.Error(w, "unknown tool", http.StatusBadRequest)
		return
	}

	doc, err := spendStoreInstance.Load(osUser)
	if err != nil {
		logAndFail(w, "spend load for %s failed: %v", osUser, err)
		return
	}
	now := spendNow()

	body := agentSpendBody{Period: string(period)}
	if tool == "" || tool == sessionio.HarnessClaude {
		body.Claude = claudeSpendFor(doc, period, now)
	}
	if tool == "" || tool == sessionio.HarnessCodex {
		body.Codex = codexSpendFor(osUser, now)
	}

	// Same no-store rationale as /prefs and /sessions: a figure the user just
	// watched move must not be served from the browser's cache.
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(body); err != nil {
		log.Printf("agent-spend encode for %s failed: %v", osUser, err)
	}
}

// parseSpendTool reads the tool filter. "" is both sections. Anything the
// panel cannot draw is a caller's mistake rather than a reason to answer with
// everything, the same gate ParsePeriod is: a shell spends nothing, and
// answering "shell" with both sections would be answering a different question.
func parseSpendTool(raw string) (sessionio.Harness, bool) {
	switch sessionio.Harness(raw) {
	case "", sessionio.HarnessClaude, sessionio.HarnessCodex:
		return sessionio.Harness(raw), true
	}
	return "", false
}

// claudeSpendFor builds the Claude half, or nil when the user has never run
// Claude Code.
//
// Presence is decided by whether the document holds ANY Claude row, at any
// date, and the figures inside are the requested period's. A user who spent
// last week and nothing today therefore sees the section with a zero in it
// rather than watching the page disappear when they pick Today, which would
// read as a bug rather than as an answer.
func claudeSpendFor(doc spendstore.Doc, period spendstore.Period, now time.Time) *claudeSpendSection {
	if !docHasTool(doc, sessionio.HarnessClaude) {
		return nil
	}
	out := &claudeSpendSection{
		Models:   []spendModelRow{},
		Sessions: []claudeSpendSession{},
	}
	for _, t := range doc.TotalsFor(period, now) {
		if t.Tool != sessionio.HarnessClaude {
			continue
		}
		out.CostUSD, out.Tokens = t.CostUSD, t.Tokens
	}
	for _, m := range doc.ModelsFor(period, now) {
		if m.Tool != sessionio.HarnessClaude {
			continue
		}
		out.Models = append(out.Models, spendModelRow{Model: m.Model, Tokens: m.Tokens, CostUSD: m.CostUSD})
	}
	// LiveRows, not every row: retention retires a row to a bare baseline so a
	// resumed conversation is differenced rather than counted twice, and those
	// carry no name or model to show.
	for _, s := range spendstore.LiveRows(doc.Sessions) {
		if s.Tool != sessionio.HarnessClaude {
			continue
		}
		if !period.CoversTime(time.Unix(s.LastSeen, 0), now) {
			continue
		}
		out.Sessions = append(out.Sessions, claudeSpendSession{
			SessionID:   s.SessionID,
			Session:     s.Key,
			Model:       s.Model,
			Tokens:      s.Tokens,
			CostUSD:     s.CostUSD,
			LastSeenSec: s.LastSeen,
		})
	}
	// Dearest conversation first, then newest, so the row a person is looking
	// for is at the top and the order does not move between renders.
	sort.Slice(out.Sessions, func(i, j int) bool {
		if out.Sessions[i].CostUSD != out.Sessions[j].CostUSD {
			return out.Sessions[i].CostUSD > out.Sessions[j].CostUSD
		}
		if out.Sessions[i].LastSeenSec != out.Sessions[j].LastSeenSec {
			return out.Sessions[i].LastSeenSec > out.Sessions[j].LastSeenSec
		}
		return out.Sessions[i].SessionID < out.Sessions[j].SessionID
	})
	out.Windows = liveWindows(doc.Windows, now)
	return out
}

// docHasTool reports whether this tool has ever been recorded for the user. The
// day rollups are the complete record, so a session row that survives its
// rollups is impossible; both are checked anyway, because the check is cheap
// and the section's presence is what decides whether the page has a heading.
func docHasTool(doc spendstore.Doc, tool sessionio.Harness) bool {
	for _, d := range doc.Days {
		if d.Tool == tool {
			return true
		}
	}
	for _, s := range doc.Sessions {
		if s.Tool == tool {
			return true
		}
	}
	return false
}

// liveWindows drops the readings whose reset has already passed. Such a window
// has since started over, so showing its percentage would report a limit the
// account is no longer anywhere near. A window with no reset at all is kept:
// there is nothing to say it is stale.
func liveWindows(windows []spendstore.Window, now time.Time) []spendstore.Window {
	var out []spendstore.Window
	for _, wnd := range windows {
		if wnd.ResetsAtSec > 0 && wnd.ResetsAtSec <= now.Unix() {
			continue
		}
		out = append(out, wnd)
	}
	return out
}

// codexSpendFor builds the Codex half from the user's own rollouts, or nil when
// there are none to read.
//
// Period does not reach it. Codex writes running totals and account-wide
// windows and keeps no per-day record, so there is nothing to slice by date;
// what comes back describes right now whichever period the caller asked for.
//
// A read that fails is logged and dropped rather than failing the request: the
// Claude half of the page is still worth drawing.
func codexSpendFor(osUser string, now time.Time) *codexSpendSection {
	home := spendHomeDir(osUser)
	if home == "" {
		return nil
	}
	reader := codexSpendReader{home: home, procDir: spendProcDir}
	// Ask the cheap question first. Building the pane list shells out to tmux
	// twice, and this endpoint is polled by every open tab; a box that has never
	// run Codex should pay a stat and nothing more.
	switch err := reader.rolloutsReadable(); {
	case errors.Is(err, fs.ErrNotExist):
		return nil
	case err != nil:
		// Not the same answer as "never ran Codex", and worth saying out loud:
		// this service runs as one OS user, and another user's home is theirs to
		// read. The section is omitted either way, but silently omitting a
		// section for a user who does run Codex is what makes it look broken.
		log.Printf("codex spend for %s: %v (omitting the section)", osUser, err)
		return nil
	}
	reading, err := reader.read(spendCodexPanes(osUser), now)
	if err != nil {
		log.Printf("codex spend read for %s failed (omitting the section): %v", osUser, err)
		return nil
	}
	if !reading.Found {
		return nil
	}
	out := &codexSpendSection{Plan: reading.Plan, Sessions: []codexSpendSession{}}
	for _, wnd := range reading.Windows {
		out.Windows = append(out.Windows, codexSpendWindow{
			Label:         wnd.Label,
			WindowMinutes: wnd.WindowMinutes,
			UsedPercent:   wnd.UsedPercent,
			ResetsAtSec:   wnd.ResetsAtSec,
		})
	}
	if reading.Credits.HasCredits {
		out.Credits = &codexSpendCredits{
			Unlimited: reading.Credits.Unlimited,
			Balance:   reading.Credits.Balance,
		}
	}
	for _, s := range reading.Sessions {
		out.Sessions = append(out.Sessions, codexSpendSession{
			SessionID:     s.SessionID,
			Session:       s.TmuxSession,
			Model:         s.Model,
			Tokens:        codexSpendTokensOf(s.Tokens),
			ContextWindow: s.ContextWindow,
			AtSec:         unixOrZero(s.At),
		})
	}
	return out
}

func codexSpendTokensOf(t codexTokens) codexSpendTokens {
	return codexSpendTokens{
		Input:           t.Input,
		CachedInput:     t.CachedInput,
		CacheWriteInput: t.CacheWriteInput,
		Output:          t.Output,
		ReasoningOutput: t.ReasoningOutput,
		Total:           t.Total,
	}
}

// unixOrZero keeps a rollout whose line carried no parseable timestamp from
// serializing as the epoch, which a page would render as 1970.
func unixOrZero(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.Unix()
}
