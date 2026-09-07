package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"regexp"
	"time"

	"terminal-lobby/sessionio"
	"terminal-lobby/spendstore"
)

// POST /hooks/usage — what a Claude Code session has spent, as its own CLI
// computes it (docs/plans/2026-09-06-agent-spend-panel-design.md).
//
// Why the statusLine and not a hook: no Claude Code hook payload carries cost.
// SessionEnd delivers {reason}, Stop delivers last_assistant_message, and the
// only money-shaped field anywhere in the hook surface is a forward-looking
// cache-rebuild estimate. The statusLine command is the one place the CLI hands
// out its own arithmetic, so devvm/tl-usage-record takes that slot, posts the
// payload here and then execs whatever statusLine the user already had.
//
// The cost is CUMULATIVE for the session, not a delta: total_cost_usd is the
// running total of that conversation. So a lost POST costs nothing as long as a
// later one arrives, and the last POST of a session carries its final figure.
// The TOKENS are not cumulative. context_window.total_input_tokens is the sum
// of current_usage's parts (2 + 31538 + 27254 = 58794 in the payload measured
// on 2026-09-06), so it describes the context the session is carrying right now
// and goes DOWN after a compaction. The store keeps it as a snapshot.
//
// Codex needs none of this. Its rollout files already carry token counts and
// rate limits on every turn, and tmux-api reads them directly.

// tmuxSessionNameRe is the lobby's session-name alphabet, the same one tmux-api
// enforces. A name becomes a key in a per-user JSON document, so a name that
// could never belong to a real session is refused here rather than stored.
var tmuxSessionNameRe = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,32}$`)

// spendRecorder is the whole of this handler's dependency on storage: one
// method, no filesystem, so the endpoint is tested against an in-memory
// implementation. *spendstore.Store, writing
// /var/lib/tmux-api/spend/<user>.json, is what the service runs with.
type spendRecorder interface {
	Record(spendstore.Reading) error
}

// usageBody is what devvm/tl-usage-record puts on the wire: the statusLine
// payload untouched under "statusline", plus the two facts the script knows and
// the payload does not.
//
// User is checked against the calling account by peerOwnsClaim before this
// handler sees it, exactly as for /hooks/session-start.
type usageBody struct {
	User        string            `json:"user"`
	TmuxSession string            `json:"tmux_session"`
	StatusLine  *claudeStatusLine `json:"statusline"`
}

// claudeStatusLine is the subset of Claude Code's statusLine payload that says
// what a session has consumed. Measured against 2.1.263 on 2026-09-06.
//
// Every field is optional on purpose. The payload has grown keys between
// versions and rate_limits is present only for Claude.ai subscribers or behind
// a gateway with a spend limit, so a missing key is an ordinary reading rather
// than a broken one. session_id is the exception, checked by the handler: a
// reading with no session to attach to cannot be stored.
type claudeStatusLine struct {
	SessionID string `json:"session_id"`
	Cost      struct {
		TotalCostUSD float64 `json:"total_cost_usd"`
	} `json:"cost"`
	ContextWindow struct {
		TotalInputTokens  int64 `json:"total_input_tokens"`
		TotalOutputTokens int64 `json:"total_output_tokens"`
		// current_usage breaks the input total into fresh, cache-write and
		// cache-read tokens. They are parts OF TotalInputTokens rather than
		// extra on top of it, which is how spendstore.Tokens keeps them.
		CurrentUsage struct {
			CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
			CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
		} `json:"current_usage"`
	} `json:"context_window"`
	Model struct {
		ID string `json:"id"`
	} `json:"model"`
	RateLimits *claudeRateLimits `json:"rate_limits"`
}

// claudeRateLimits is present only where the seat has windows to report. Each
// window is a pointer so an absent one stays absent instead of arriving as a
// measured zero percent.
type claudeRateLimits struct {
	FiveHour   *claudeWindow `json:"five_hour"`
	SevenDay   *claudeWindow `json:"seven_day"`
	SpendLimit *claudeWindow `json:"spend_limit"`
}

// claudeWindow's ResetsAt is unix EPOCH SECONDS.
type claudeWindow struct {
	UsedPercentage float64 `json:"used_percentage"`
	ResetsAt       int64   `json:"resets_at"`
}

// windows flattens the payload's three optional keys into the store's list, in
// the order the page shows them: the tighter window first.
func (rl *claudeRateLimits) windows() []spendstore.Window {
	if rl == nil {
		return nil
	}
	var out []spendstore.Window
	for _, w := range []struct {
		name string
		src  *claudeWindow
	}{
		{spendstore.WindowFiveHour, rl.FiveHour},
		{spendstore.WindowSevenDay, rl.SevenDay},
		{spendstore.WindowSpendLimit, rl.SpendLimit},
	} {
		if w.src == nil {
			continue
		}
		out = append(out, spendstore.Window{
			Name:        w.name,
			UsedPercent: w.src.UsedPercentage,
			ResetsAtSec: w.src.ResetsAt,
		})
	}
	return out
}

// handleUsage records one statusLine reading. Loopback only and wrapped in
// peerOwnsClaim in main, for the same reason /hooks/session-start is: loopback
// authenticates a host, every lobby user has a shell on this host, and the
// "user" in the body would otherwise be anyone's to choose.
//
// No telemetry event. The statusLine renders many times a turn, and the
// recorder's own throttle is what keeps that off the wire; emitting a row per
// accepted reading would put the same volume into a shared 30-day log store.
func handleUsage(rec spendRecorder) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		b, err := decodeUsageBody(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		cw := b.StatusLine.ContextWindow
		reading := spendstore.Reading{
			User:        b.User,
			TmuxSession: b.TmuxSession,
			Tool:        sessionio.HarnessClaude,
			SessionID:   b.StatusLine.SessionID,
			Model:       b.StatusLine.Model.ID,
			CostUSD:     b.StatusLine.Cost.TotalCostUSD,
			Tokens: spendstore.Tokens{
				Input:         cw.TotalInputTokens,
				Output:        cw.TotalOutputTokens,
				CacheRead:     cw.CurrentUsage.CacheReadInputTokens,
				CacheCreation: cw.CurrentUsage.CacheCreationInputTokens,
			},
			At:      time.Now(),
			Windows: b.StatusLine.RateLimits.windows(),
		}
		if err := rec.Record(reading); err != nil {
			log.Printf("usage %s/%s: %v", reading.User, reading.TmuxSession, err)
			http.Error(w, "cannot record the reading", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// decodeUsageBody reads and validates the envelope. Bounded by hookBodyLimit,
// the same bound peerOwnsClaim applies, so a payload that grew a large new key
// is refused rather than read into memory twice.
func decodeUsageBody(body io.Reader) (usageBody, error) {
	raw, err := io.ReadAll(io.LimitReader(body, hookBodyLimit))
	if err != nil {
		return usageBody{}, errors.New("cannot read body")
	}
	var b usageBody
	dec := json.NewDecoder(bytes.NewReader(raw))
	if err := dec.Decode(&b); err != nil {
		return usageBody{}, errors.New("bad body (need user, tmux_session, statusline)")
	}
	if _, err := dec.Token(); err != io.EOF {
		return usageBody{}, errors.New("trailing data after the JSON document")
	}
	if b.User == "" || b.StatusLine == nil {
		return usageBody{}, errors.New("bad body (need user, tmux_session, statusline)")
	}
	if !tmuxSessionNameRe.MatchString(b.TmuxSession) {
		return usageBody{}, errors.New("tmux_session is not a session name")
	}
	// The conversation this reading belongs to. Without it two Claude processes
	// that shared a tmux session name over a day are one indistinguishable row.
	if b.StatusLine.SessionID == "" {
		return usageBody{}, errors.New("bad body (statusline needs session_id)")
	}
	return b, nil
}
