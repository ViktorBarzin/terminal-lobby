package main

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
