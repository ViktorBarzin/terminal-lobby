package main

// Delegations: work the homelab hands to a Caller, and the record of how it
// went.
//
// Everything else in this service runs in the other direction — a Caller asks,
// a session works. A Delegation is the mirror: a session on this box asks a
// Caller (Muse) to do something only it can, such as reaching a person over
// WhatsApp, and the Caller posts the result back here. The homelab CLI creates
// the record, sends the rendered message over WhatsApp itself, and tells this
// service whether the send went out; the waiting session long-polls the
// record. Design: infra/docs/plans/2026-10-02-muse-homelab-integration-design.md.
//
// Unlike tasks, Delegations are kept on disk. A task is a handle on a tmux
// conversation that survives without it; a Delegation has nothing behind it
// but this record, and it may run for two weeks, so a restart that forgot it
// would strand both the waiting session and a Caller holding finished work.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// DelegationStatus is the six-word lifecycle.
type DelegationStatus string

const (
	// DelegationPending — recorded, and the creator has not yet said whether
	// the message went out.
	DelegationPending DelegationStatus = "pending"
	// DelegationSent — the message reached the Caller's channel.
	DelegationSent DelegationStatus = "sent"
	// DelegationDone and DelegationFailed — the Caller posted a result.
	DelegationDone   DelegationStatus = "done"
	DelegationFailed DelegationStatus = "failed"
	// DelegationExpired — expires_at passed with no result.
	DelegationExpired DelegationStatus = "expired"
	// DelegationUndelivered — the send failed, so the Caller never saw it.
	DelegationUndelivered DelegationStatus = "undelivered"
)

// delegationStatuses is every status, for validating ?status= and for the
// OpenAPI test.
var delegationStatuses = []DelegationStatus{
	DelegationPending, DelegationSent, DelegationDone,
	DelegationFailed, DelegationExpired, DelegationUndelivered,
}

// finished reports whether a status is an end state.
func (s DelegationStatus) finished() bool {
	return s != DelegationPending && s != DelegationSent
}

// canGo reports whether a delegation may move from s to next.
//
// A result is accepted from pending as well as sent, because the Caller can
// answer before the creator's second request records the send. Undelivered is
// only reachable from pending: once a message is known to have gone out, a
// later delivery failure is not something the creator can observe.
func (s DelegationStatus) canGo(next DelegationStatus) bool {
	switch s {
	case DelegationPending:
		return next != DelegationPending
	case DelegationSent:
		return next == DelegationDone || next == DelegationFailed || next == DelegationExpired
	}
	return false
}

// Limits on what a delegation carries. The task travels in a WhatsApp message,
// where 8000 characters is already a long read; the result comes back from a
// Caller that may be summarising a whole conversation.
const (
	maxDelegationTask          = 8000
	maxDelegationResult        = 32000
	maxDelegationReason        = 2000
	maxFromSession             = 200
	defaultDelegationExpiry    = 24 * time.Hour
	maxDelegationExpirySeconds = 14 * 24 * 60 * 60
)

// delegationRetention is how long a finished delegation is kept before the
// sweep drops it. Long enough to read back what a fortnight-long delegation
// produced; short enough that the file, rewritten on every change, stays
// small.
const delegationRetention = 14 * 24 * time.Hour

// delegationSweepInterval is how often expired delegations are closed without
// anybody asking. Reads expire lazily anyway; the sweep is what makes the file
// and the list agree with the clock between reads.
const delegationSweepInterval = time.Minute

// Delegation is the wire representation.
type Delegation struct {
	ID          string           `json:"delegation_id"`
	Caller      string           `json:"caller"`
	CreatedBy   string           `json:"created_by"`
	FromSession string           `json:"from_session,omitempty"`
	Task        string           `json:"task"`
	Status      DelegationStatus `json:"status"`
	Result      string           `json:"result,omitempty"`
	Reason      string           `json:"reason,omitempty"`
	// Message is the exact text the creator sends, rendered once at creation
	// so every reader of the record sees the words the Caller saw.
	Message   string    `json:"message"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	ExpiresAt time.Time `json:"expires_at"`
}

// delegationRecord is what the file keeps: the delegation plus the accounts
// the two Callers acted as when it was made. Visibility is checked against
// name AND account, the rule tasks follow, because two credential lines may
// share a name while naming different accounts.
type delegationRecord struct {
	Delegation
	CreatorOSUser string `json:"creator_os_user"`
	CallerOSUser  string `json:"caller_os_user"`
}

// renderDelegationMessage is the WhatsApp text, byte for byte as the contract
// gives it. The Caller has nothing but this message, so it carries the whole
// task and its own callback instructions.
func renderDelegationMessage(id, fromSession string, expiresAt time.Time, task, publicURL string) string {
	if fromSession == "" {
		fromSession = "unknown"
	}
	base := strings.TrimRight(publicURL, "/")
	return "[homelab delegation " + id + "]\n" +
		"from: session " + fromSession + "\n" +
		"expires: " + expiresAt.UTC().Format(time.RFC3339) + "\n" +
		"\n" +
		task + "\n" +
		"\n" +
		"When done, POST the result to\n" +
		base + "/v1/delegations/" + id + "/result\n" +
		`with your agent-api bearer token and body {"status":"done","result":"..."} (or "failed").`
}

// delegationCaps bounds creations per target Caller over rolling windows.
// WhatsApp traffic to a person's chat should stay at a human pace whatever a
// looping session does.
type delegationCaps struct {
	PerHour int
	PerDay  int
}

var defaultDelegationCaps = delegationCaps{PerHour: 20, PerDay: 100}

// delegationCapError is a creation refused by a cap. RetryAfter is when the
// oldest creation in the full window leaves it.
type delegationCapError struct {
	Caller     string
	Window     string
	Limit      int
	RetryAfter time.Duration
}

func (e *delegationCapError) Error() string {
	return fmt.Sprintf("%s has been handed %d delegations in the last %s, the most it takes; "+
		"try again in %s", e.Caller, e.Limit, e.Window, e.RetryAfter.Round(time.Second))
}

var (
	errDelegationNotFound   = errors.New("no such delegation")
	errDelegationNotPending = errors.New("delegation is not pending")
	errDelegationFinished   = errors.New("delegation is already finished")
	errDelegationExpired    = errors.New("delegation has expired")
)

// delegationsFile is the store's file name inside the state directory.
const delegationsFile = "delegations.json"

// delegationFileVersion is written into the file so a later format can tell
// an old one apart rather than guess.
const delegationFileVersion = 1

type delegationFile struct {
	Version     int                `json:"version"`
	Delegations []delegationRecord `json:"delegations"`
}

type delegationEntry struct {
	rec delegationRecord
	// changed is closed and replaced on every status change, the same
	// mechanism TaskStore.Wait uses: a waiter takes the channel with its
	// snapshot under the lock, so a change between the check and the block
	// closes the channel it is about to block on.
	changed chan struct{}
}

// DelegationStore holds every delegation, in memory and in one JSON file.
//
// Every change is written before it is made visible: the new state is
// serialised whole, written to a temp file, synced and renamed over the old
// one, and only then committed to memory. A failed write therefore leaves the
// service exactly where it was, and the caller gets a 500 rather than a 200
// for something a restart would forget.
//
// Expiry is the one change that is committed whatever the write does. It is a
// function of the clock, so a restart that read the older file would derive
// the same answer, and refusing a read because a write failed would be worse.
type DelegationStore struct {
	mu    sync.Mutex
	path  string
	byID  map[string]*delegationEntry
	order []string
	now   func() time.Time
	// broken is set when the file exists and could not be read. Every change
	// is then refused, because writing would replace a file whose contents
	// nobody has seen.
	broken error
	// writeFile is atomicWrite; a test swaps it to fail a write.
	writeFile func(path string, data []byte) error
}

// OpenDelegationStore loads the store at path, creating its directory.
//
// It always returns a usable store; the error is for the startup log. A file
// that does not parse is renamed aside to <path>.corrupt-<unix time> and the
// store starts empty, so an operator can still read what was in it. A file
// that cannot be read at all leaves the store refusing every change.
func OpenDelegationStore(path string, now func() time.Time) (*DelegationStore, error) {
	if now == nil {
		now = time.Now
	}
	s := &DelegationStore{
		path:      path,
		byID:      map[string]*delegationEntry{},
		now:       now,
		writeFile: atomicWrite,
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		s.broken = fmt.Errorf("cannot create %s: %w", filepath.Dir(path), err)
		return s, s.broken
	}
	raw, err := os.ReadFile(path)
	switch {
	case errors.Is(err, os.ErrNotExist):
		return s, nil
	case err != nil:
		s.broken = fmt.Errorf("cannot read %s: %w", path, err)
		return s, s.broken
	}
	var f delegationFile
	if err := json.Unmarshal(raw, &f); err != nil {
		aside := fmt.Sprintf("%s.corrupt-%d", path, now().Unix())
		if rerr := os.Rename(path, aside); rerr != nil {
			s.broken = fmt.Errorf("%s does not parse (%v) and could not be moved aside: %w", path, err, rerr)
			return s, s.broken
		}
		return s, fmt.Errorf("%s does not parse (%v); moved it to %s and started empty", path, err, aside)
	}
	for _, rec := range f.Delegations {
		if rec.ID == "" || s.byID[rec.ID] != nil {
			continue
		}
		s.byID[rec.ID] = &delegationEntry{rec: rec, changed: make(chan struct{})}
		s.order = append(s.order, rec.ID)
	}
	return s, nil
}

// clock is the store's time, truncated to the second in UTC, so a timestamp
// reads the same in the JSON field, in the message and in the file.
func (s *DelegationStore) clock() time.Time {
	return s.now().UTC().Truncate(time.Second)
}

// Create records a new pending delegation, unless the target Caller's cap is
// reached. The caller fills ID, Caller, CreatedBy, FromSession, Task,
// ExpiresAt, Message and both accounts; the store sets the rest.
func (s *DelegationStore) Create(rec delegationRecord, caps delegationCaps) (Delegation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.broken != nil {
		return Delegation{}, s.broken
	}
	now := s.now()
	if err := s.checkCapsLocked(rec.Caller, now, caps); err != nil {
		return Delegation{}, err
	}
	at := s.clock()
	rec.Status = DelegationPending
	rec.CreatedAt, rec.UpdatedAt = at, at
	rec.Result, rec.Reason = "", ""

	if err := s.persistLocked(func(out []delegationRecord) []delegationRecord {
		return append(out, rec)
	}); err != nil {
		return Delegation{}, err
	}
	s.byID[rec.ID] = &delegationEntry{rec: rec, changed: make(chan struct{})}
	s.order = append(s.order, rec.ID)
	return rec.Delegation, nil
}

// checkCapsLocked refuses a creation past either window's limit.
func (s *DelegationStore) checkCapsLocked(caller string, now time.Time, caps delegationCaps) error {
	for _, w := range []struct {
		name   string
		limit  int
		window time.Duration
	}{
		{"hour", caps.PerHour, time.Hour},
		{"day", caps.PerDay, 24 * time.Hour},
	} {
		if w.limit <= 0 {
			continue
		}
		var times []time.Time
		since := now.Add(-w.window)
		for _, id := range s.order {
			r := s.byID[id].rec
			if r.Caller == caller && r.CreatedAt.After(since) {
				times = append(times, r.CreatedAt)
			}
		}
		if len(times) < w.limit {
			continue
		}
		sort.Slice(times, func(i, j int) bool { return times[i].Before(times[j]) })
		// One creation has to leave the window for a new one to fit: the
		// (n-limit)th oldest, which with the cap enforced is the oldest.
		leaves := times[len(times)-w.limit].Add(w.window)
		return &delegationCapError{Caller: caller, Window: w.name, Limit: w.limit, RetryAfter: leaves.Sub(now)}
	}
	return nil
}

// createdSince counts a Caller's creations after t.
func (s *DelegationStore) createdSince(caller string, t time.Time) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, id := range s.order {
		if r := s.byID[id].rec; r.Caller == caller && r.CreatedAt.After(t) {
			n++
		}
	}
	return n
}

// Get returns one delegation, expiring it first if its time has passed.
func (s *DelegationStore) Get(id string) (delegationRecord, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.byID[id]
	if !ok {
		return delegationRecord{}, false
	}
	s.expireLocked([]*delegationEntry{e})
	return e.rec, true
}

// List returns every delegation keep accepts, newest first, after expiring
// whatever is due.
func (s *DelegationStore) List(keep func(delegationRecord) bool, limit int) []delegationRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked(s.entriesLocked())
	out := []delegationRecord{}
	for i := len(s.order) - 1; i >= 0 && (limit <= 0 || len(out) < limit); i-- {
		if r := s.byID[s.order[i]].rec; keep(r) {
			out = append(out, r)
		}
	}
	return out
}

func (s *DelegationStore) entriesLocked() []*delegationEntry {
	out := make([]*delegationEntry, 0, len(s.order))
	for _, id := range s.order {
		out = append(out, s.byID[id])
	}
	return out
}

// expireLocked moves every given entry that is past its time to expired, and
// writes the file once if anything moved. It reports how many moved.
func (s *DelegationStore) expireLocked(entries []*delegationEntry) int {
	now := s.now()
	var due []*delegationEntry
	for _, e := range entries {
		if !e.rec.Status.finished() && !now.Before(e.rec.ExpiresAt) {
			due = append(due, e)
		}
	}
	if len(due) == 0 {
		return 0
	}
	at := s.clock()
	for _, e := range due {
		e.rec.Status = DelegationExpired
		e.rec.UpdatedAt = at
		e.signal()
		logf("agent-api: delegation %s to %s expired unanswered", e.rec.ID, e.rec.Caller)
	}
	if s.broken == nil {
		if err := s.persistLocked(nil); err != nil {
			// Committed anyway: see the type's comment.
			logf("agent-api: recording %d expired delegation(s): %v", len(due), err)
		}
	}
	return len(due)
}

func (e *delegationEntry) signal() {
	close(e.changed)
	e.changed = make(chan struct{})
}

// MarkSent records that the message went out.
func (s *DelegationStore) MarkSent(id string) (Delegation, error) {
	return s.transition(id, func(r *delegationRecord) error {
		if r.Status != DelegationPending {
			return errDelegationNotPending
		}
		r.Status = DelegationSent
		return nil
	})
}

// MarkUndelivered records that the send failed, and why.
func (s *DelegationStore) MarkUndelivered(id, reason string) (Delegation, error) {
	return s.transition(id, func(r *delegationRecord) error {
		if r.Status != DelegationPending {
			return errDelegationNotPending
		}
		r.Status = DelegationUndelivered
		r.Reason = reason
		return nil
	})
}

// Finish records the Caller's result. Expired is told apart from every other
// finished state, because the Caller is owed a different answer: one says
// "already handled", the other says "stop, nobody is waiting".
func (s *DelegationStore) Finish(id string, status DelegationStatus, result string) (Delegation, error) {
	return s.transition(id, func(r *delegationRecord) error {
		switch {
		case r.Status == DelegationExpired:
			return errDelegationExpired
		case !r.Status.canGo(status):
			return errDelegationFinished
		}
		r.Status = status
		r.Result = result
		return nil
	})
}

// transition applies change to a copy of one delegation, writes the file with
// the copy in place, and commits it only once the write has succeeded.
func (s *DelegationStore) transition(id string, change func(*delegationRecord) error) (Delegation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.byID[id]
	if !ok {
		return Delegation{}, errDelegationNotFound
	}
	s.expireLocked([]*delegationEntry{e})
	next := e.rec
	if err := change(&next); err != nil {
		return e.rec.Delegation, err
	}
	if s.broken != nil {
		return Delegation{}, s.broken
	}
	next.UpdatedAt = s.clock()
	if err := s.persistLocked(func(out []delegationRecord) []delegationRecord {
		for i := range out {
			if out[i].ID == id {
				out[i] = next
			}
		}
		return out
	}); err != nil {
		return Delegation{}, err
	}
	e.rec = next
	e.signal()
	return next.Delegation, nil
}

// Wait blocks until the delegation's status differs from from, d runs out, or
// ctx is done, and returns it as it is then. A finished delegation returns at
// once. The timer is the shorter of d and the time to expires_at, so a waiter
// learns of an expiry when it happens rather than when its wait ends.
func (s *DelegationStore) Wait(ctx context.Context, id string, d time.Duration, from DelegationStatus) (delegationRecord, bool) {
	deadline := time.NewTimer(d)
	defer deadline.Stop()
	for {
		s.mu.Lock()
		e, ok := s.byID[id]
		if !ok {
			s.mu.Unlock()
			return delegationRecord{}, false
		}
		s.expireLocked([]*delegationEntry{e})
		rec, changed := e.rec, e.changed
		untilExpiry := rec.ExpiresAt.Sub(s.now())
		s.mu.Unlock()

		if rec.Status != from || rec.Status.finished() {
			return rec, true
		}
		expiry := time.NewTimer(untilExpiry)
		select {
		case <-changed:
		case <-expiry.C:
		case <-deadline.C:
			expiry.Stop()
			return s.current(id, rec), true
		case <-ctx.Done():
			expiry.Stop()
			return s.current(id, rec), true
		}
		expiry.Stop()
	}
}

// current is a fresh read, or the last one if the delegation was pruned in
// the moment since.
func (s *DelegationStore) current(id string, last delegationRecord) delegationRecord {
	if rec, ok := s.Get(id); ok {
		return rec
	}
	return last
}

// Sweep expires every delegation that is due and drops finished ones past the
// retention. It reports how many it expired.
func (s *DelegationStore) Sweep() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := s.expireLocked(s.entriesLocked())

	cutoff := s.now().Add(-delegationRetention)
	kept := s.order[:0]
	pruned := 0
	for _, id := range s.order {
		r := s.byID[id].rec
		if r.Status.finished() && !r.UpdatedAt.After(cutoff) {
			delete(s.byID, id)
			pruned++
			continue
		}
		kept = append(kept, id)
	}
	s.order = kept
	if pruned > 0 && s.broken == nil {
		if err := s.persistLocked(nil); err != nil {
			logf("agent-api: pruning %d old delegation(s): %v", pruned, err)
		}
	}
	return n
}

// SweepEvery runs Sweep on a ticker for the life of the process.
func (s *DelegationStore) SweepEvery(interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for range t.C {
		s.Sweep()
	}
}

// persistLocked writes the file: the current records in creation order,
// passed through edit when given. Called with the lock held.
func (s *DelegationStore) persistLocked(edit func([]delegationRecord) []delegationRecord) error {
	out := make([]delegationRecord, 0, len(s.order)+1)
	for _, id := range s.order {
		out = append(out, s.byID[id].rec)
	}
	if edit != nil {
		out = edit(out)
	}
	data, err := json.MarshalIndent(delegationFile{Version: delegationFileVersion, Delegations: out}, "", "  ")
	if err != nil {
		return fmt.Errorf("encoding the delegation store: %w", err)
	}
	if err := s.writeFile(s.path, append(data, '\n')); err != nil {
		return fmt.Errorf("writing the delegation store %s: %w", s.path, err)
	}
	return nil
}

// atomicWrite replaces path with data: a temp file in the same directory,
// synced, renamed over the target, and the directory synced, so a crash at
// any point leaves either the old file or the new one and never half of
// either. 0600, because a task's text is whatever the delegating session
// wrote and this box has other people's shells on it.
func atomicWrite(path string, data []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	cleanup := func() { os.Remove(name) }
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		cleanup()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return err
	}
	if err := os.Rename(name, path); err != nil {
		cleanup()
		return err
	}
	if d, err := os.Open(dir); err == nil {
		d.Sync()
		d.Close()
	}
	return nil
}
