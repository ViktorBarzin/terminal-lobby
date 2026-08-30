package main

import (
	"sync"
	"time"
)

// procTreeTTL bounds how stale a shared /proc snapshot may be. It is
// deliberately far shorter than sessionsTTL: the point is to collapse the
// calls inside one request or one push tick, not to serve an old process
// table to a fresh caller.
const procTreeTTL = time.Second

// procCache hands one /proc snapshot to every caller inside a short window.
// A full scan is a readdir plus an os.ReadFile per PID — around 2,200
// syscalls on a box with 700 processes — and userSessions ran one per OS
// user it looked at. GET /sessions walks it once for the caller and again
// per foreign owner in the list, and the push sender walks it per subscribed
// user every 5 s, all producing the identical machine-global table.
//
// Same reasoning as sessionsCache: repetition at this cadence is what
// contributed to a host-level I/O wedge here before.
type procCache struct {
	mu   sync.Mutex
	ttl  time.Duration
	scan func() (procTree, error)
	now  func() time.Time

	tree      procTree
	expiresAt time.Time
	valid     bool
}

func newProcCache(ttl time.Duration) *procCache {
	return &procCache{
		ttl:  ttl,
		scan: func() (procTree, error) { return procTreeFrom("/proc") },
		now:  time.Now,
	}
}

// get returns the cached snapshot, scanning when it is missing or stale.
// A failed scan is not cached — the liveness backstop fails open, and
// holding a failure would keep it open for the whole window.
func (c *procCache) get() (procTree, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.valid && c.now().Before(c.expiresAt) {
		return c.tree, nil
	}
	tree, err := c.scan()
	if err != nil {
		c.valid = false
		return tree, err
	}
	c.tree, c.expiresAt, c.valid = tree, c.now().Add(c.ttl), true
	return tree, nil
}

var procCacheInstance = newProcCache(procTreeTTL)
