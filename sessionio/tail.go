package sessionio

import (
	"bufio"
	"bytes"
	"io"
	"os"
)

// ReadFrom reads complete newline-terminated lines from path starting at byte
// offset off. It returns the lines (without the trailing newline) and the new
// offset positioned just past the last COMPLETE line — a partial trailing line
// (no newline yet, e.g. a transcript mid-write) is left unconsumed so a later
// ReadFrom picks it up once completed.
func ReadFrom(path string, off int64) (lines []string, next int64, err error) {
	blob, next, err := ReadRawFrom(path, off)
	if err != nil {
		return nil, next, err
	}
	return SplitLines(blob), next, nil
}

// ReadRawFrom is ReadFrom without the split: the raw bytes of the complete
// lines starting at off, newlines included, and the offset just past the last
// of them.
//
// It exists for the privop child. A transcript crossing the process boundary as
// a JSON array of per-line strings is escaped and allocated once per line in
// the child encoding it and again in the parent decoding it, before the
// normalizer parses each line a third time. As one value it is escaped once,
// and the parent does the split locally.
func ReadRawFrom(path string, off int64) (blob []byte, next int64, err error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, off, err
	}
	defer f.Close()
	if _, err = f.Seek(off, io.SeekStart); err != nil {
		return nil, off, err
	}
	data, err := io.ReadAll(bufio.NewReader(f))
	if err != nil {
		return nil, off, err
	}
	// A partial trailing line (no newline yet, e.g. a transcript mid-write) is
	// left unconsumed, so a later read picks it up once it is complete.
	end := bytes.LastIndexByte(data, '\n')
	if end < 0 {
		return nil, off, nil
	}
	return data[:end+1], off + int64(end+1), nil
}

// SplitLines turns a ReadRawFrom blob into the lines ReadFrom would have
// returned: newline-terminated, the newline dropped.
func SplitLines(blob []byte) []string {
	if len(blob) == 0 {
		return nil
	}
	var lines []string
	for start := 0; start < len(blob); {
		i := bytes.IndexByte(blob[start:], '\n')
		if i < 0 {
			break // ReadRawFrom never returns one, but a caller might
		}
		lines = append(lines, string(blob[start:start+i]))
		start += i + 1
	}
	return lines
}

// Tail streams decoded records out of one transcript, resuming by byte offset.
//
// It is the record-level read side, below the Event-level FileSource: the
// bridge forwards records to T3 more or less as they are, so folding them into
// the lobby's Event vocabulary first would only be something to undo. The
// cursor is a byte offset rather than a record count because that is the only
// thing a transcript guarantees — records have no index, and a file grows
// between reads.
//
// A Tail is NOT safe for concurrent use; give each reader its own.
type Tail struct {
	path string
	off  int64
}

// NewTail reads a transcript from the beginning — the replay case.
func NewTail(path string) *Tail { return &Tail{path: path} }

// NewTailAt resumes from a saved offset, so a re-attach does not re-deliver
// what the peer already has.
func NewTailAt(path string, off int64) *Tail { return &Tail{path: path, off: off} }

// Path is the transcript being read.
func (t *Tail) Path() string { return t.path }

// Offset is the cursor: the byte position just past the last complete line
// returned. Durable across processes — save it, pass it to NewTailAt.
func (t *Tail) Offset() int64 { return t.off }

// Next returns the records appended since the last call, advancing the cursor.
//
// A line that is not a JSON object is skipped rather than failing the batch: a
// transcript is append-only and written by another process, and one unreadable
// line must not stop the stream. An error means the FILE could not be read —
// most often because the session's Claude has not created it yet, which is an
// ordinary state at attach time and a reason to retry, not to give up.
func (t *Tail) Next() ([]Record, error) {
	lines, next, err := ReadFrom(t.path, t.off)
	if err != nil {
		return nil, err
	}
	t.off = next
	records := make([]Record, 0, len(lines))
	for _, ln := range lines {
		if rec, ok := DecodeRecord([]byte(ln)); ok {
			records = append(records, rec)
		}
	}
	return records, nil
}
