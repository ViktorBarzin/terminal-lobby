package sessionio

import (
	"errors"
	"strings"
	"time"
)

// Catching a mod source up on a compaction.
//
// The engine raises session.append for the bare "/compact" row and for
// nothing a compaction writes after it: the boundary, the summary, the caveat,
// the command record and the receipt all reach the transcript and none reaches
// the mod (Claude Code 2.1.296, measured 2026-10-11, although the mod
// reference says session.append covers them). The receipt is what settles the
// turn the command opened, so on the mod path that turn stayed open, and the
// Text view drew a Working row, until a session-events restart replayed the
// file.
//
// What the mod does see is session.compact, which it reports as a level whose
// compacting flag goes true and then false. On that edge session-events reads
// the rows written after the newest main-thread row the log holds and feeds
// them to the same Normalizer, so the log ends up as a tail of the file would
// have it. Should the rows not reach the file in time, a manual /compact's
// turn is settled anyway: a missing marker is better than a Working row that
// never stops.

// CatchUp is what a compaction catch-up drew.
type CatchUp struct {
	// Rows is how many transcript rows it fed.
	Rows int
	// Settled says it ended the /compact turn itself, because no receipt
	// arrived to do it.
	Settled bool
}

var errNoCompaction = errors.New("catch-up: the transcript does not hold the compaction's rows")

// CompactionEnded records a level event's compacting flag and reports whether
// this event ends a compaction the previous one reported running. Other
// events report false.
func (f *FileSource) CompactionEnded(ev ModEvent) bool {
	if f.mod == nil || ev.Type != ModLevelEvent {
		return false
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	was := f.mod.compacting
	f.mod.compacting = ev.Compacting
	return was && !ev.Compacting
}

// CatchUpCompaction draws the rows a compaction wrote to the transcript and
// the mod never sent, waiting up to `wait` for them to reach the file. running
// is the main-turn flag of the level that ended the compaction.
//
// A /compact the operator ran is over once its receipt is in, so the catch-up
// waits for that; a compaction Claude started inside a turn writes no
// receipt, and its summary is the last row to wait for. When the rows do not
// arrive, whatever did is still drawn, the /compact turn is settled, and the
// error says so.
func (f *FileSource) CatchUpCompaction(running bool, wait time.Duration) (CatchUp, error) {
	if f.mod == nil {
		return CatchUp{}, errors.New("catch-up: not a mod source")
	}
	f.mu.Lock()
	barrier := f.mod.lastMain
	command := compactCommand(f.mod.opened)
	f.mu.Unlock()
	manual := command && !running && f.TurnOpen()
	// The turn the command opened. A prompt sent during the wait opens
	// another, which the fallback must leave alone.
	turn := f.TurnID()

	var recs []Record
	err := errNoTranscript
	if path := f.Path(); path != "" {
		recs, err = f.readCompaction(path, barrier, manual, wait)
	}

	var got CatchUp
	f.normMu.Lock()
	var evs []Event
	for _, rec := range recs {
		f.mu.Lock()
		seen := f.mod.rows[rec.UUID]
		f.mod.rows[rec.UUID] = true
		f.mu.Unlock()
		if seen {
			continue
		}
		evs = append(evs, f.norm.Record(rec)...)
		got.Rows++
	}
	if manual && f.norm.turnID == turn && !f.norm.turnDone {
		if e, ok := f.norm.EndTurn(time.Now().UnixMilli(), nil); ok {
			evs = append(evs, e)
			got.Settled = true
		}
	}
	f.normMu.Unlock()
	for _, e := range evs {
		f.appendLive(e)
	}
	return got, err
}

// compactCommand reports whether a prompt's text is the /compact command.
func compactCommand(text string) bool {
	return text == "/compact" || strings.HasPrefix(text, "/compact ")
}

// readCompaction reads the transcript's rows after the main-thread row
// `barrier` that a compaction writes, up to and including the last one to
// wait for: the receipt for a /compact the operator ran, the summary
// otherwise. It reads on from where it stopped every replayPoll until `wait`
// has passed, then returns what it has with errNoCompaction.
//
// Only user and system rows are taken: everything else the compaction leaves
// (attachments) the mod sends itself, and an assistant row would race the
// mod's own copy of it.
func (f *FileSource) readCompaction(path, barrier string, manual bool, wait time.Duration) ([]Record, error) {
	if barrier == "" {
		return nil, errNoBarrier
	}
	deadline := time.Now().Add(wait)
	var recs []Record
	var off int64
	past := false
	for {
		lines, next, err := f.reader.ReadFrom(path, off)
		if err != nil {
			return recs, err
		}
		if next < off {
			// The file was rewritten shorter: start over.
			recs, off, past = nil, 0, false
			continue
		}
		off = next
		for _, ln := range lines {
			rec, ok := DecodeRecord([]byte(ln))
			if !ok || rec.IsSidechain {
				continue
			}
			if !past {
				past = rec.UUID == barrier
				continue
			}
			if rec.UUID == "" || (rec.Type != RecordUser && rec.Type != RecordSystem) {
				continue
			}
			recs = append(recs, rec)
			if lastCompactionRow(rec, manual) {
				return recs, nil
			}
		}
		if !time.Now().Before(deadline) {
			if !past {
				return nil, errNoBarrier
			}
			return recs, errNoCompaction
		}
		time.Sleep(replayPoll)
	}
}

// lastCompactionRow reports whether rec is the last row a compaction writes
// that the catch-up waits for.
func lastCompactionRow(rec Record, manual bool) bool {
	if !manual {
		return rec.IsCompactSummary
	}
	text := rec.Content
	if rec.Type == RecordUser {
		text = blockText(rec.Blocks())
	}
	_, settles, ok := harnessRow(text)
	return ok && settles
}
