package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log"
	"math"
	"net/http"
	"regexp"
	"time"

	"terminal-lobby/sessionio"
	"terminal-lobby/spendstore"
)

// POST /hooks/pi-usage — what a pi conversation has spent, posted by the
// lobby's pi extension each time a turn settles (devvm/pi-extension.js,
// docs/plans/2026-09-25-pi-harness-design.md).
//
// It is the extension that posts rather than tmux-api that reads, because
// tmux-api runs as one OS user and cannot read another user's ~/.pi. Reading
// pi's session files directly would only ever have worked for that one user;
// posting from inside each user's pi works for everyone.
//
// The figures are RUNNING TOTALS for the conversation, added up the way pi's
// own session statistics add them (assistant messages, usage entries, and
// compaction and branch summaries), so a reading replaces the session row and
// moves the day by the difference, exactly as a Claude reading does. A lost
// POST costs nothing once a later one lands.

// piUsageBody is what the extension puts on the wire. User is checked against
// the calling account by peerOwnsClaim before this handler sees it.
type piUsageBody struct {
	User        string   `json:"user"`
	TmuxSession string   `json:"tmux_session"`
	SessionID   string   `json:"sessionId"`
	Model       string   `json:"model"`
	CostUSD     float64  `json:"costUsd"`
	Tokens      piTokens `json:"tokens"`
}

// piTokens is pi's Usage split: Input is fresh input only, and CacheRead and
// CacheWrite sit beside it rather than inside it (pi-ai counts totalTokens as
// the sum of all four).
type piTokens struct {
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	CacheRead  int64 `json:"cacheRead"`
	CacheWrite int64 `json:"cacheWrite"`
}

// piSessionIDRe is the conversation id's alphabet. Pi's own are UUIDs; the id
// becomes a key in the user's spend document, so anything that does not look
// like an id is refused rather than stored.
var piSessionIDRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$`)

// handlePiUsage records one pi reading. Loopback only and wrapped in
// peerOwnsClaim in main, for the reason /hooks/usage is.
func handlePiUsage(rec spendRecorder) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		b, err := decodePiUsageBody(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		model := b.Model
		if model != "" && !sessionio.ValidPiModelRef(model) {
			// Shown on the Agent spend page, so held to the shape of a pi
			// reference. The spend still counts without it.
			model = ""
		}
		reading := spendstore.Reading{
			User:        b.User,
			TmuxSession: b.TmuxSession,
			Tool:        sessionio.HarnessPi,
			SessionID:   b.SessionID,
			Model:       model,
			CostUSD:     b.CostUSD,
			// The store keeps Input as every input token with the cache figures
			// as parts of it (spendstore.Tokens), so pi's separate figures are
			// added in rather than copied across.
			Tokens: spendstore.Tokens{
				Input:         b.Tokens.Input + b.Tokens.CacheRead + b.Tokens.CacheWrite,
				Output:        b.Tokens.Output,
				CacheRead:     b.Tokens.CacheRead,
				CacheCreation: b.Tokens.CacheWrite,
			},
			At: time.Now(),
		}
		if err := rec.Record(reading); err != nil {
			log.Printf("pi usage %s/%s: %v", reading.User, reading.TmuxSession, err)
			http.Error(w, "cannot record the reading", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// decodePiUsageBody reads and validates the envelope, bounded by
// hookBodyLimit like every hook body.
func decodePiUsageBody(body io.Reader) (piUsageBody, error) {
	raw, err := io.ReadAll(io.LimitReader(body, hookBodyLimit))
	if err != nil {
		return piUsageBody{}, errors.New("cannot read body")
	}
	var b piUsageBody
	dec := json.NewDecoder(bytes.NewReader(raw))
	if err := dec.Decode(&b); err != nil {
		return piUsageBody{}, errors.New("bad body (need user, tmux_session, sessionId, costUsd, tokens)")
	}
	if _, err := dec.Token(); err != io.EOF {
		return piUsageBody{}, errors.New("trailing data after the JSON document")
	}
	switch {
	case b.User == "":
		return piUsageBody{}, errors.New("bad body (need user)")
	case !tmuxSessionNameRe.MatchString(b.TmuxSession):
		return piUsageBody{}, errors.New("tmux_session is not a session name")
	case !piSessionIDRe.MatchString(b.SessionID):
		return piUsageBody{}, errors.New("sessionId is not a conversation id")
	case b.CostUSD < 0 || math.IsNaN(b.CostUSD) || math.IsInf(b.CostUSD, 0):
		return piUsageBody{}, errors.New("costUsd must be a sum of money, not negative")
	case b.Tokens.Input < 0 || b.Tokens.Output < 0 || b.Tokens.CacheRead < 0 || b.Tokens.CacheWrite < 0:
		return piUsageBody{}, errors.New("token counts cannot be negative")
	}
	return b, nil
}
