package main

import (
	"errors"
	"io"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// The kernel's own record of a pane cap kill. Read from /dev/kmsg rather than
// the journal because the watcher runs as root on the same box and needs the
// record within the tick the session vanishes in, and because journald
// rate-limits kernel messages: in the 2026-09-26 drill an OOM flood left no
// kill record in the journal at all.

// parseMemcgKill reads the pid out of a kernel "oom-kill:" record whose
// constraint is a cgroup memory limit, which on this box means a pane's 6G cap.
// A box-wide kernel OOM (CONSTRAINT_NONE) is not one: the machine is out of
// memory then, and resuming a claude into that invites the next kill. earlyoom
// kills from userspace and writes no such record at all.
//
// The task= field is deliberately ignored. A claude's comm has been seen
// carrying its version string, so the caller matches the pid against the
// claudes it found by exe.
func parseMemcgKill(line string) (int, bool) {
	if !strings.HasPrefix(line, "oom-kill:") || !strings.Contains(line, "constraint=CONSTRAINT_MEMCG,") {
		return 0, false
	}
	for _, field := range strings.Split(strings.TrimPrefix(line, "oom-kill:"), ",") {
		if v, ok := strings.CutPrefix(field, "pid="); ok {
			pid, err := strconv.Atoi(v)
			return pid, err == nil && pid > 0
		}
	}
	return 0, false
}

// kmsgText is the message of one /dev/kmsg record:
// "<prio>,<seq>,<usec>,<flags>;<text>\n" plus optional indented continuation
// lines, which carry structured metadata and are dropped.
func kmsgText(record string) string {
	_, rest, ok := strings.Cut(record, ";")
	if !ok {
		return ""
	}
	text, _, _ := strings.Cut(rest, "\n")
	return text
}

// memcgKill is one pane cap kill, stamped when the watcher read it.
type memcgKill struct {
	pid int
	at  time.Time
}

// watchKmsg reads /dev/kmsg continuously and sends every pane cap kill to the
// returned channel, which the tick drains.
//
// Continuously, not once per tick. The kernel ring buffer on the devvm is about
// 280 KB, and each OOM kill prints a full task dump into it. A burst of kills
// (2026-09-24: about 30 vitest workers and then the claude, all in one pane)
// can overwrite the claude's record inside one 30s tick, and the drill on
// 2026-09-26 lost a kill record exactly that way. A blocking read consumes each
// record as the kernel writes it.
//
// The buffer is large and a full channel drops the kill rather than blocking,
// so a flood can never stall the reader behind the tick.
func watchKmsg() (<-chan memcgKill, error) {
	fd, err := syscall.Open("/dev/kmsg", syscall.O_RDONLY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	// Start at the end: a kill from before the watcher started belongs to a
	// session the watcher never saw alive, so it cannot be matched anyway.
	if _, err := syscall.Seek(fd, 0, io.SeekEnd); err != nil {
		syscall.Close(fd)
		return nil, err
	}
	out := make(chan memcgKill, 1024)
	go func() {
		// One read returns one record. Raw syscalls rather than os.File, so the
		// read blocks this goroutine's thread and nothing else.
		buf := make([]byte, 8192)
		for {
			n, err := syscall.Read(fd, buf)
			if errors.Is(err, syscall.EPIPE) {
				// The ring overwrote records not yet read. The position has
				// moved to the oldest one left, so carry on from there.
				continue
			}
			if errors.Is(err, syscall.EINTR) {
				continue
			}
			if err != nil || n <= 0 {
				time.Sleep(time.Second)
				continue
			}
			if pid, ok := parseMemcgKill(kmsgText(string(buf[:n]))); ok {
				select {
				case out <- memcgKill{pid: pid, at: time.Now()}:
				default:
				}
			}
		}
	}()
	return out, nil
}
