package main

import (
	"sync"
	"time"
)

// sessionsCache memoises the JSON body returned by GET /sessions, keyed by
// OS user. Without it, each poll forks `sudo tmux list-sessions` — at a
// 5 s client cadence with 3+ pollers this saturated the journal and
// contributed to a wider host-level I/O wedge.
type sessionsCache struct {
	mu   sync.Mutex
	ttl  time.Duration
	now  func() time.Time
	data map[string]cacheEntry
}

type cacheEntry struct {
	body      []byte
	expiresAt time.Time
}

func newSessionsCache(ttl time.Duration) *sessionsCache {
	return &sessionsCache{
		ttl:  ttl,
		now:  time.Now,
		data: map[string]cacheEntry{},
	}
}

func (c *sessionsCache) get(key string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.data[key]
	if !ok || c.now().After(e.expiresAt) {
		return nil, false
	}
	return e.body, true
}

func (c *sessionsCache) put(key string, body []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.data[key] = cacheEntry{body: body, expiresAt: c.now().Add(c.ttl)}
}

func (c *sessionsCache) invalidate(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.data, key)
}
