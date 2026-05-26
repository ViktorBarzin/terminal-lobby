package main

import (
	"testing"
	"time"
)

func TestSessionsCache_HitWithinTTL(t *testing.T) {
	now := time.Date(2026, 5, 26, 2, 0, 0, 0, time.UTC)
	c := newTestCache(2*time.Second, &now)
	c.put("emo", []byte(`[{"name":"main"}]`))

	body, ok := c.get("emo")
	if !ok {
		t.Fatal("expected hit immediately after put")
	}
	if string(body) != `[{"name":"main"}]` {
		t.Fatalf("body mismatch: %q", body)
	}
}

func TestSessionsCache_ExpiresAfterTTL(t *testing.T) {
	now := time.Date(2026, 5, 26, 2, 0, 0, 0, time.UTC)
	c := newTestCache(2*time.Second, &now)
	c.put("emo", []byte("[]"))

	if _, ok := c.get("emo"); !ok {
		t.Fatal("expected hit at t=0")
	}
	now = now.Add(1900 * time.Millisecond)
	if _, ok := c.get("emo"); !ok {
		t.Fatal("expected hit at t=1.9s (still inside 2s TTL)")
	}
	now = now.Add(200 * time.Millisecond) // total 2.1s since put
	if _, ok := c.get("emo"); ok {
		t.Fatal("expected miss at t=2.1s (past 2s TTL)")
	}
}

func TestSessionsCache_InvalidateRemovesEntry(t *testing.T) {
	now := time.Date(2026, 5, 26, 2, 0, 0, 0, time.UTC)
	c := newTestCache(2*time.Second, &now)
	c.put("emo", []byte("[]"))
	c.invalidate("emo")
	if _, ok := c.get("emo"); ok {
		t.Fatal("expected miss after invalidate")
	}
}

func TestSessionsCache_KeyedByUser(t *testing.T) {
	now := time.Date(2026, 5, 26, 2, 0, 0, 0, time.UTC)
	c := newTestCache(2*time.Second, &now)
	c.put("emo", []byte(`["emo"]`))
	c.put("wizard", []byte(`["wizard"]`))

	if body, ok := c.get("emo"); !ok || string(body) != `["emo"]` {
		t.Fatalf("emo entry corrupted: ok=%v body=%q", ok, body)
	}
	if body, ok := c.get("wizard"); !ok || string(body) != `["wizard"]` {
		t.Fatalf("wizard entry corrupted: ok=%v body=%q", ok, body)
	}
}

func TestSessionsCache_PutOverwrites(t *testing.T) {
	now := time.Date(2026, 5, 26, 2, 0, 0, 0, time.UTC)
	c := newTestCache(2*time.Second, &now)
	c.put("emo", []byte(`["v1"]`))
	c.put("emo", []byte(`["v2"]`))
	if body, _ := c.get("emo"); string(body) != `["v2"]` {
		t.Fatalf("expected v2 after overwrite, got %q", body)
	}
}

// newTestCache builds a cache whose clock follows a caller-controlled
// time.Time pointer. Tests advance time by reassigning the pointer's value.
func newTestCache(ttl time.Duration, now *time.Time) *sessionsCache {
	c := newSessionsCache(ttl)
	c.now = func() time.Time { return *now }
	return c
}
