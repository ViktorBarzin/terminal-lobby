// Package spendstore keeps what a user's agent sessions have consumed:
// /var/lib/tmux-api/spend/<user>.json, one document per OS user, alongside the
// prefs, titles, layout and assignment stores that already live there.
//
// Two processes share it. session-events writes, from the statusLine recorder
// on POST /hooks/usage; tmux-api reads, to serve the Settings page and the
// sidebar figure. Both run as the same OS user, and every write lands through
// tmp+rename, so a reader sees the previous document or the next one and never
// a torn one. The mutex here serialises writers inside one process, which is
// all that is needed while session-events is the only writer.
//
// The shape of the numbers is what makes this store worth its own package. A
// statusLine reading is the session's RUNNING TOTAL and the prompt redraws many
// times a turn, so a write REPLACES the session row rather than adding to it,
// and moves the day rollup by the difference. Adding would multiply a figure by
// however often the prompt happened to render.
//
// That gives one invariant worth stating plainly: the day rollups are the
// complete record, and the session rows are the detail view of the last 30
// days. Every reading rolls its difference into the day it was taken, so
// dropping an old session row loses nothing, and All time is answerable from
// the days alone.
//
// Design: docs/plans/2026-09-06-agent-spend-panel-design.md.
package spendstore

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"terminal-lobby/sessionio"
)

const (
	// Version stamps the document so a later shape change can tell what it is
	// reading. Nothing migrates yet; there is one shape.
	Version = 1

	// Dir matches the other per-user stores under /var/lib/tmux-api.
	Dir = "/var/lib/tmux-api/spend"

	// SessionTTL is how long a session row survives after its last reading.
	// Past that it is dropped and only its day rollups remain, which is what
	// keeps the document from growing with every conversation ever opened.
	SessionTTL = 30 * 24 * time.Hour

	// MaxSessionRows bounds the rows even inside the retention window, the way
	// titlesKeep and assignmentsKeep bound their stores. The trim drops the
	// ones written to longest ago and costs no money: their spend is already in
	// the day it happened.
	MaxSessionRows = 2000

	dateLayout = "2006-01-02"
)

// The three windows Claude Code names inside rate_limits, kept under the CLI's
// own keys rather than translated, so a window it adds later can be stored
// without renaming what is already on disk.
const (
	WindowFiveHour   = "five_hour"
	WindowSevenDay   = "seven_day"
	WindowSpendLimit = "spend_limit"
)

// Reading is one moment's figures for one session, in the shape the store keeps
// rather than the shape a CLI emits. session-events builds it from a statusLine
// payload.
//
// At is when the reading was taken, which is what puts it in a day. The
// statusLine payload carries no timestamp of its own, so the recording service
// stamps it, and the same clock decides the fold.
type Reading struct {
	User        string
	TmuxSession string
	Tool        sessionio.Harness
	// SessionID is the conversation, and it is the row's identity. A tmux
	// session name outlives the process inside it, so two Claude runs that
	// shared a name are two rows.
	SessionID string
	Model     string
	// CostUSD is the running total for this conversation, as the CLI computed
	// it. Claude Code reports one; ChatGPT plans report none, and Codex rows
	// leave it zero.
	CostUSD float64
	Tokens  Tokens
	At      time.Time
	// Windows is empty for a seat that reports no rate limits, which is every
	// enterprise Claude seat (measured 2026-09-06). Empty means "this reading
	// named none", never "the windows are at zero".
	Windows []Window
}

// Tokens is what a reading was carrying, split the way the source reports it.
//
// Input is every input token including the cached ones; CacheRead and
// CacheCreation are the breakdown WITHIN it, not extra on top. Summing all four
// would count the cache twice.
type Tokens struct {
	Input         int64 `json:"input"`
	Output        int64 `json:"output"`
	CacheRead     int64 `json:"cacheRead"`
	CacheCreation int64 `json:"cacheCreation"`
}

func (t Tokens) add(o Tokens) Tokens {
	return Tokens{
		Input:         t.Input + o.Input,
		Output:        t.Output + o.Output,
		CacheRead:     t.CacheRead + o.CacheRead,
		CacheCreation: t.CacheCreation + o.CacheCreation,
	}
}

// sub clamps each field at zero. A figure that went backwards is a context that
// was compacted or a source that restarted its arithmetic, not a refund.
func (t Tokens) sub(o Tokens) Tokens {
	return Tokens{
		Input:         atLeastZero(t.Input - o.Input),
		Output:        atLeastZero(t.Output - o.Output),
		CacheRead:     atLeastZero(t.CacheRead - o.CacheRead),
		CacheCreation: atLeastZero(t.CacheCreation - o.CacheCreation),
	}
}

func atLeastZero(n int64) int64 {
	if n < 0 {
		return 0
	}
	return n
}

// Window is one rate-limit window as its source reported it. ResetsAtSec is
// unix EPOCH SECONDS, zero when the source named no reset. A window whose reset
// has passed describes a window that no longer exists; dropping it is the
// reader's decision, not the store's, so it is kept as it arrived.
type Window struct {
	Name        string  `json:"name"`
	UsedPercent float64 `json:"usedPercent"`
	ResetsAtSec int64   `json:"resetsAtSec,omitempty"`
}

// Doc is one user's whole record.
type Doc struct {
	Version  int          `json:"version"`
	Sessions []SessionRow `json:"sessions"`
	Days     []DayRow     `json:"days"`
	// Windows is the newest set any reading named, and WindowsAt when it was
	// taken. A reading that names none leaves them alone: "this seat has no
	// windows" and "this render did not mention them" arrive looking the same,
	// and a set left behind by a plan change expires on its own once its resets
	// have passed.
	Windows   []Window `json:"windows,omitempty"`
	WindowsAt int64    `json:"windowsAtSec,omitempty"`
}

// SessionRow is one conversation's latest figures. Cost is its running total;
// Tokens is what it was carrying at the last reading, which goes down after a
// compaction and is a snapshot rather than a sum.
type SessionRow struct {
	SessionID string            `json:"sessionId"`
	Key       string            `json:"key"`
	Tool      sessionio.Harness `json:"tool"`
	Model     string            `json:"model"`
	Tokens    Tokens            `json:"tokens"`
	CostUSD   float64           `json:"costUsd"`
	FirstSeen int64             `json:"firstSeenSec"`
	LastSeen  int64             `json:"lastSeenSec"`
}

// DayRow is one day's total for one tool on one model, in the local day the
// readings were taken. Kept indefinitely: a row is about 150 bytes and a busy
// user produces a handful a day, so a decade of them is a few megabytes and All
// time stays answerable long after the session rows are gone.
type DayRow struct {
	Date    string            `json:"date"`
	Tool    sessionio.Harness `json:"tool"`
	Model   string            `json:"model"`
	Tokens  Tokens            `json:"tokens"`
	CostUSD float64           `json:"costUsd"`
}

// Store is the on-disk record, one document per OS user.
type Store struct {
	mu  sync.Mutex
	dir string
	// maxRows is MaxSessionRows in production. It is a field so the test that
	// exercises the trim can reach the cap in a handful of writes: each write
	// rewrites the whole document, so filling two thousand rows for real costs
	// two minutes under the race detector.
	maxRows int
}

// New opens the store rooted at dir. The directory is created on first write.
func New(dir string) *Store { return &Store{dir: dir, maxRows: MaxSessionRows} }

func (s *Store) path(osUser string) string {
	return filepath.Join(s.dir, osUser+".json")
}

// Load returns the user's document, or an empty one when nothing was ever
// recorded. A corrupt file is an error rather than an empty document: a month
// of spend reading as zero is worse than a panel that says it cannot load.
func (s *Store) Load(osUser string) (Doc, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked(osUser)
}

func (s *Store) loadLocked(osUser string) (Doc, error) {
	empty := Doc{Version: Version, Sessions: []SessionRow{}, Days: []DayRow{}}
	raw, err := os.ReadFile(s.path(osUser))
	if errors.Is(err, os.ErrNotExist) {
		return empty, nil
	}
	if err != nil {
		return empty, err
	}
	var doc Doc
	if err := json.Unmarshal(raw, &doc); err != nil {
		return empty, fmt.Errorf("corrupt spend record for %s: %w", osUser, err)
	}
	if doc.Sessions == nil {
		doc.Sessions = []SessionRow{}
	}
	if doc.Days == nil {
		doc.Days = []DayRow{}
	}
	doc.Version = Version
	return doc, nil
}

// Record folds one reading into the user's document.
//
// The session row is REPLACED with the reading's figures, and the day rollup
// moves by the difference against what the row held before. A first reading for
// a conversation has nothing to difference against, so it contributes its whole
// value once.
func (s *Store) Record(r Reading) error {
	if err := validate(r); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	doc, err := s.loadLocked(r.User)
	if err != nil {
		return err
	}
	apply(&doc, r, s.maxRows)
	return writeAtomicJSON(s.dir, r.User+".*.tmp", s.path(r.User), doc)
}

// validate refuses what cannot be stored. The user becomes a filename, so it is
// checked here as well as by the caller that resolved it.
func validate(r Reading) error {
	switch {
	case r.User == "":
		return errors.New("spend reading has no user")
	case strings.ContainsAny(r.User, `/\`) || r.User == "." || r.User == "..":
		return fmt.Errorf("spend reading user %q is not a name", r.User)
	case r.SessionID == "":
		return errors.New("spend reading has no conversation to attach to")
	case r.At.IsZero():
		return errors.New("spend reading has no timestamp")
	}
	return nil
}

// apply is the arithmetic, separated from the file so the rule that matters can
// be read in one place.
func apply(doc *Doc, r Reading, maxRows int) {
	prevCost, prevTokens := 0.0, Tokens{}
	found := false
	for i := range doc.Sessions {
		if doc.Sessions[i].SessionID != r.SessionID {
			continue
		}
		found = true
		prevCost, prevTokens = doc.Sessions[i].CostUSD, doc.Sessions[i].Tokens
		row := &doc.Sessions[i]
		// A renamed session keeps its row and takes the new name.
		row.Key, row.Model, row.Tool = r.TmuxSession, r.Model, r.Tool
		row.CostUSD, row.Tokens = r.CostUSD, r.Tokens
		row.LastSeen = r.At.Unix()
		break
	}
	if !found {
		doc.Sessions = append(doc.Sessions, SessionRow{
			SessionID: r.SessionID,
			Key:       r.TmuxSession,
			Tool:      r.Tool,
			Model:     r.Model,
			Tokens:    r.Tokens,
			CostUSD:   r.CostUSD,
			FirstSeen: r.At.Unix(),
			LastSeen:  r.At.Unix(),
		})
	}

	addToDay(doc, r, max(r.CostUSD-prevCost, 0), r.Tokens.sub(prevTokens))
	if len(r.Windows) > 0 {
		doc.Windows, doc.WindowsAt = r.Windows, r.At.Unix()
	}
	fold(doc, r.At, maxRows)
}

// addToDay puts the difference on the local day the reading was taken, under
// the model it was taken on. A conversation whose model changed mid-way leaves
// each model holding what was spent while it was selected.
func addToDay(doc *Doc, r Reading, cost float64, tokens Tokens) {
	if cost == 0 && tokens == (Tokens{}) {
		return
	}
	date := r.At.Format(dateLayout)
	for i := range doc.Days {
		d := &doc.Days[i]
		if d.Date == date && d.Tool == r.Tool && d.Model == r.Model {
			d.CostUSD += cost
			d.Tokens = d.Tokens.add(tokens)
			return
		}
	}
	doc.Days = append(doc.Days, DayRow{
		Date:    date,
		Tool:    r.Tool,
		Model:   r.Model,
		Tokens:  tokens,
		CostUSD: cost,
	})
}

// fold drops the session rows the retention window has passed, and trims the
// rest to the cap. Both are pure drops: the spend is already in the days. It
// runs on every write rather than on a timer, so there is nothing to schedule
// and a store nobody writes to never needs sweeping.
func fold(doc *Doc, now time.Time, maxRows int) {
	cutoff := now.Add(-SessionTTL).Unix()
	kept := doc.Sessions[:0]
	for _, row := range doc.Sessions {
		if row.LastSeen >= cutoff {
			kept = append(kept, row)
		}
	}
	doc.Sessions = kept
	if maxRows > 0 && len(doc.Sessions) > maxRows {
		sort.SliceStable(doc.Sessions, func(i, j int) bool {
			return doc.Sessions[i].LastSeen < doc.Sessions[j].LastSeen
		})
		doc.Sessions = doc.Sessions[len(doc.Sessions)-maxRows:]
	}
}

// writeAtomicJSON writes the document through a temp file in the same directory
// so a crash mid-write cannot leave a truncated one behind. The directory lands
// 0700 and the file 0600: this is one OS user's own record. A trailing newline
// keeps it readable with cat.
//
// The same shape as tmux-api/atomicwrite.go, repeated rather than shared
// because that one lives in package main and this module is imported by both
// services.
func writeAtomicJSON(dir, tmpPrefix, path string, v any) error {
	doc, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, tmpPrefix)
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(doc, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
