package sessionio

import (
	"errors"
	"strings"
	"time"
)

// Rebuilding a mod source from its transcript.
//
// A session-events restart leaves every mod source without a log. The mod's
// $.session.messages() was the only way back until 2026-10-05, and it holds
// the newest 4096 entries, starts at the last /compact, and carries no uuid,
// timestamp or stop_reason: a session with three compactions came back with 9
// of its 19 prompts, led by the compaction summary drawn as a prompt. The
// transcript holds the whole conversation, and the same Normalizer reads it.
//
// The file and the mod's snapshot are not taken at the same moment. Claude
// writes the transcript in batches every 100 ms (Claude Code 2.1.289), so the
// file can lag the snapshot, and it keeps growing after it. A mod from 0.4.0
// names the newest main-thread row its snapshot covers, and the replay stops
// at exactly that row: everything after it reaches the log live from the mod,
// once, in order. Row uuids are the same in the file and on the wire, which is
// how a live copy of a replayed row is dropped (feedRow).

// replayPoll is how often a replay looks again for a barrier row the file
// does not hold yet.
const replayPoll = 150 * time.Millisecond

var (
	errNoTranscript = errors.New("replay: no transcript path")
	errNoBarrier    = errors.New("replay: the transcript does not hold the barrier row")
)

// ReplayTranscript rebuilds the log from the transcript, up to and including
// the main-thread row whose uuid is `last`, waiting up to `wait` for that row
// to reach the file. running says whether the mod reports a main turn in
// flight; when it does not, the last turn is closed.
//
// On error the log is untouched, so the caller can fall back to the mod's own
// history without drawing anything twice.
func (f *FileSource) ReplayTranscript(last string, running bool, wait time.Duration) error {
	if f.mod == nil {
		return errors.New("replay: not a mod source")
	}
	path := f.Path()
	if path == "" {
		return errNoTranscript
	}
	recs, err := f.readToBarrier(path, last, wait)
	if err != nil {
		return err
	}

	f.normMu.Lock()
	defer f.normMu.Unlock()
	var evs []Event
	var at int64
	opened := ""
	for _, rec := range recs {
		got := f.norm.Record(rec)
		for _, e := range got {
			if e.Kind == KindUser {
				opened = strings.TrimSpace(rec.Text())
			}
		}
		evs = append(evs, got...)
		if t := parseAt(rec.Timestamp); t > 0 {
			at = t
		}
	}
	// The mod never sends queue-operation rows, so nothing would ever take a
	// prompt the file leaves enqueued off the queue. Whatever Claude still has
	// waiting reaches the log again as its row lands, and session-events adds
	// the prompts it holds itself (showHeld).
	if queueLeftOpen(evs) {
		e := f.norm.emit(KindMeta, at)
		e.Meta = MetaQueueCleared
		evs = append(evs, e)
	}
	if !running {
		if e, ok := f.norm.EndTurn(at, nil); ok {
			evs = append(evs, e)
		}
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	for _, rec := range recs {
		if rec.UUID != "" {
			f.mod.rows[rec.UUID] = true
		}
	}
	f.mod.opened = opened
	f.mod.answered = false
	f.diverged = true
	for _, e := range evs {
		f.seq++
		e.ID = f.seq
		e.Session = f.session
		f.logbuf = append(f.logbuf, e)
	}
	// A reader attached while the log was empty would otherwise be handed the
	// whole conversation as live frames, far past its buffer. Ending its stream
	// makes it reopen with the usual window.
	for id, ch := range f.subs {
		delete(f.subs, id)
		close(ch)
	}
	return nil
}

// readToBarrier reads the transcript's records up to and including the
// main-thread row `last`, reading on from where it stopped every replayPoll
// until `wait` has passed.
func (f *FileSource) readToBarrier(path, last string, wait time.Duration) ([]Record, error) {
	if last == "" {
		return nil, errNoBarrier
	}
	deadline := time.Now().Add(wait)
	var recs []Record
	var off int64
	for {
		lines, next, err := f.reader.ReadFrom(path, off)
		if err != nil {
			return nil, err
		}
		if next < off {
			// The file was rewritten shorter: start over.
			recs, off = nil, 0
			continue
		}
		off = next
		for _, ln := range lines {
			rec, ok := DecodeRecord([]byte(ln))
			if !ok {
				continue
			}
			recs = append(recs, rec)
			if rec.UUID == last && !rec.IsSidechain {
				return recs, nil
			}
		}
		if !time.Now().Before(deadline) {
			return nil, errNoBarrier
		}
		time.Sleep(replayPoll)
	}
}

// queueLeftOpen reports whether the queue the events describe still holds
// anything at their end.
func queueLeftOpen(evs []Event) bool {
	n := 0
	for _, e := range evs {
		if e.Kind != KindMeta {
			continue
		}
		switch e.Meta {
		case MetaQueued:
			n++
		case MetaUnqueued, MetaDequeued:
			if n > 0 {
				n--
			}
		case MetaQueueCleared:
			n = 0
		}
	}
	return n > 0
}
