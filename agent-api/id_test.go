package main

import (
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestIDShape(t *testing.T) {
	g := newIDGen(nil)
	id := g.New()
	if len(id) != 26 {
		t.Fatalf("id %q is %d characters, want 26", id, len(id))
	}
	for _, r := range id {
		if !strings.ContainsRune(crockford, r) {
			t.Fatalf("id %q carries %q, which is outside the alphabet", id, r)
		}
	}
}

// Sortable as text, which is what makes a trace file useful with `sort`.
func TestIDSortsByTime(t *testing.T) {
	now := time.Date(2026, 9, 16, 0, 0, 0, 0, time.UTC)
	g := newIDGen(func() time.Time { return now })

	var ids []string
	for i := 0; i < 200; i++ {
		ids = append(ids, g.New())
		now = now.Add(time.Millisecond)
	}
	if !sort.StringsAreSorted(ids) {
		t.Fatal("ids minted in order do not sort in order")
	}
}

// Two ids in the SAME millisecond still order by creation. Without the
// counter, a burst of messages reads as simultaneous.
func TestIDSortsWithinOneMillisecond(t *testing.T) {
	fixed := time.Date(2026, 9, 16, 0, 0, 0, 0, time.UTC)
	g := newIDGen(func() time.Time { return fixed })

	var ids []string
	for i := 0; i < 64; i++ {
		ids = append(ids, g.New())
	}
	if !sort.StringsAreSorted(ids) {
		t.Fatalf("ids within one millisecond do not sort in order: %v", ids[:8])
	}
}

func TestIDUniqueUnderConcurrency(t *testing.T) {
	g := newIDGen(nil)
	const n = 2000
	seen := make(map[string]bool, n)
	var mu sync.Mutex
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id := g.New()
			mu.Lock()
			defer mu.Unlock()
			if seen[id] {
				t.Errorf("duplicate id %q", id)
			}
			seen[id] = true
		}()
	}
	wg.Wait()
}
