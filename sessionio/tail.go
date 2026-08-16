package sessionio

import (
	"bufio"
	"io"
	"os"
)

// ReadFrom reads complete newline-terminated lines from path starting at byte
// offset off. It returns the lines (without the trailing newline) and the new
// offset positioned just past the last COMPLETE line — a partial trailing line
// (no newline yet, e.g. a transcript mid-write) is left unconsumed so a later
// ReadFrom picks it up once completed.
func ReadFrom(path string, off int64) (lines []string, next int64, err error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, off, err
	}
	defer f.Close()
	if _, err = f.Seek(off, io.SeekStart); err != nil {
		return nil, off, err
	}
	r := bufio.NewReader(f)
	next = off
	for {
		b, readErr := r.ReadBytes('\n')
		if len(b) > 0 && b[len(b)-1] == '\n' {
			lines = append(lines, string(b[:len(b)-1]))
			next += int64(len(b))
		}
		if readErr == io.EOF {
			return lines, next, nil
		}
		if readErr != nil {
			return lines, next, readErr
		}
	}
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
