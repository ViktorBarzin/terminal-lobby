package main

import (
	"errors"
	"sync"
	"testing"
	"time"
)

// fakeProcScan counts scans so a test can prove the walk was skipped.
type fakeProcScan struct {
	mu    sync.Mutex
	calls int
	tree  procTree
	err   error
}

func (f *fakeProcScan) scan() (procTree, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return f.tree, f.err
}

func (f *fakeProcScan) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func newTestProcCache(f *fakeProcScan, now func() time.Time) *procCache {
	return &procCache{ttl: time.Second, scan: f.scan, now: now}
}

func TestProcCacheWalksOnceForABurstOfCallers(t *testing.T) {
	f := &fakeProcScan{tree: procTree{comm: map[int]string{1: "init"}}}
	clock := time.Unix(1000, 0)
	c := newTestProcCache(f, func() time.Time { return clock })

	for i := 0; i < 5; i++ {
		if _, err := c.get(); err != nil {
			t.Fatalf("get: %v", err)
		}
	}
	if f.count() != 1 {
		t.Fatalf("scanned %d times, want 1", f.count())
	}
}

func TestProcCacheRescansOnceTheSnapshotIsStale(t *testing.T) {
	f := &fakeProcScan{tree: procTree{comm: map[int]string{1: "init"}}}
	clock := time.Unix(1000, 0)
	c := newTestProcCache(f, func() time.Time { return clock })

	if _, err := c.get(); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(1500 * time.Millisecond)
	if _, err := c.get(); err != nil {
		t.Fatal(err)
	}
	if f.count() != 2 {
		t.Fatalf("scanned %d times, want 2", f.count())
	}
}

func TestProcCacheServesTheSnapshotItScanned(t *testing.T) {
	f := &fakeProcScan{tree: procTree{
		comm:     map[int]string{7: "claude"},
		children: map[int][]int{1: {7}},
	}}
	clock := time.Unix(1000, 0)
	c := newTestProcCache(f, func() time.Time { return clock })

	tree, err := c.get()
	if err != nil {
		t.Fatal(err)
	}
	if tree.comm[7] != "claude" {
		t.Fatalf("got %+v", tree.comm)
	}
}

// A failed scan must not be cached: the liveness backstop fails open, and
// caching the failure would keep it open for the whole TTL.
func TestProcCacheDoesNotCacheAFailedScan(t *testing.T) {
	f := &fakeProcScan{err: errors.New("empty proc scan")}
	clock := time.Unix(1000, 0)
	c := newTestProcCache(f, func() time.Time { return clock })

	if _, err := c.get(); err == nil {
		t.Fatal("want the scan error through")
	}
	f.err = nil
	f.tree = procTree{comm: map[int]string{1: "init"}}
	if _, err := c.get(); err != nil {
		t.Fatalf("want a retry after a failure, got %v", err)
	}
	if f.count() != 2 {
		t.Fatalf("scanned %d times, want 2", f.count())
	}
}

func TestProcCacheIsSafeUnderConcurrentCallers(t *testing.T) {
	f := &fakeProcScan{tree: procTree{comm: map[int]string{1: "init"}}}
	clock := time.Unix(1000, 0)
	c := newTestProcCache(f, func() time.Time { return clock })

	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := c.get(); err != nil {
				t.Errorf("get: %v", err)
			}
		}()
	}
	wg.Wait()
	if f.count() != 1 {
		t.Fatalf("scanned %d times, want 1", f.count())
	}
}
