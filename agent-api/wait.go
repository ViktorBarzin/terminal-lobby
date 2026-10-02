package main

// Waiting inside a request, and the query integers the read routes take.
//
// Every poll costs the caller a full model turn, so a caller that can say
// "hold this until something happens" pays for one turn where it would pay
// for dozens. Two routes take ?wait=N: sending a message, which holds until
// the turn settles, and reading a task, which holds until it moves. Both wait
// on TaskStore.Wait, which the store wakes on every status change, so a held
// request costs a parked goroutine and one timer, not a poll loop.

import (
	"net/url"
	"strconv"
)

// maxWaitSeconds caps ?wait=. Five minutes is long enough that a caller's
// turn budget goes on work rather than on asking, and short enough to sit
// well inside every timeout between the caller and this process: the
// server's own WriteTimeout is set from it (main.go).
const maxWaitSeconds = 300

// waitSeconds reads ?wait=. Absent is 0, which is the behaviour every route
// had before the parameter existed. Anything else must be a plain decimal
// integer in 0..maxWaitSeconds: no sign, no fraction, no empty value. A typo
// is refused rather than read as zero, because a caller that asked to wait
// and silently did not would spend the very turns the parameter exists to
// save.
func waitSeconds(q url.Values) (int, error) {
	n, present, err := queryInt(q, "wait")
	if err != nil {
		return 0, err
	}
	if present && n > maxWaitSeconds {
		return 0, badRequest("wait must be a whole number of seconds from 0 to %d, not %q", maxWaitSeconds, q.Get("wait"))
	}
	return n, nil
}

// queryInt reads one non-negative integer query parameter. present=false
// means the parameter was not sent at all.
func queryInt(q url.Values, name string) (n int, present bool, err error) {
	if _, ok := q[name]; !ok {
		return 0, false, nil
	}
	raw := q.Get(name)
	if raw == "" || !allDigits(raw) {
		return 0, true, badRequest("%s must be a non-negative whole number, not %q", name, raw)
	}
	n, convErr := strconv.Atoi(raw)
	if convErr != nil {
		return 0, true, badRequest("%s %q is out of range", name, raw)
	}
	return n, true, nil
}

// allDigits is the check strconv.Atoi does not make: it takes a leading sign.
func allDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// settledOrBlocked is where send-and-wait stops: an end state, or a question
// nobody but a person can move past. Either way a caller holding on gains
// nothing by holding longer.
func settledOrBlocked(s TaskStatus) bool {
	return s.terminal() || s == StatusNeedsInput
}
