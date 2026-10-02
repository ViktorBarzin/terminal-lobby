package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// The Delegation store on its own: transitions, expiry, caps and the file it
// keeps. The HTTP behaviour on top of it is in delegations_test.go.

// steppedClock is a clock a test moves by hand. Guarded, because a waiter
// reads it from another goroutine.
type steppedClock struct {
	mu sync.Mutex
	t  time.Time
}

func newSteppedClock() *steppedClock {
	return &steppedClock{t: time.Date(2026, 10, 2, 9, 0, 0, 0, time.UTC)}
}

func (c *steppedClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *steppedClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

func openTestStore(t *testing.T, clock *steppedClock) (*DelegationStore, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "state", delegationsFile)
	s, err := OpenDelegationStore(path, clock.now)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	return s, path
}

// newRecord is a delegation from homelab to muse, both acting as wizard.
func newRecord(id string, now time.Time, expiresIn time.Duration) delegationRecord {
	return delegationRecord{
		Delegation: Delegation{
			ID:          id,
			Caller:      "muse",
			CreatedBy:   "homelab",
			FromSession: "infra-7",
			Task:        "Ask Anca whether Saturday works.",
			ExpiresAt:   now.Add(expiresIn),
		},
		CreatorOSUser: "wizard",
		CallerOSUser:  "wizard",
	}
}

func mustCreate(t *testing.T, s *DelegationStore, rec delegationRecord) Delegation {
	t.Helper()
	d, err := s.Create(rec, defaultDelegationCaps)
	if err != nil {
		t.Fatalf("create %s: %v", rec.ID, err)
	}
	return d
}

// Every ordered pair of statuses, stated once, like the task table. The rows
// are the moves a request can make; expiry is the clock's and is tested on
// its own below.
func TestDelegationStatusTransitions(t *testing.T) {
	all := []DelegationStatus{
		DelegationPending, DelegationSent, DelegationDone,
		DelegationFailed, DelegationExpired, DelegationUndelivered,
	}
	allowed := map[DelegationStatus]map[DelegationStatus]bool{
		DelegationPending: {
			DelegationSent: true, DelegationUndelivered: true,
			DelegationDone: true, DelegationFailed: true, DelegationExpired: true,
		},
		DelegationSent: {
			DelegationDone: true, DelegationFailed: true, DelegationExpired: true,
		},
	}
	for _, from := range all {
		for _, to := range all {
			want := allowed[from][to]
			if got := from.canGo(to); got != want {
				t.Errorf("%s -> %s = %v, want %v", from, to, got, want)
			}
		}
	}
	for _, s := range all {
		want := s != DelegationPending && s != DelegationSent
		if got := s.finished(); got != want {
			t.Errorf("%s.finished() = %v, want %v", s, got, want)
		}
	}
}

// The message is the whole interface to the Caller: Muse reads it in a
// WhatsApp chat and nothing else. Byte for byte against the contract.
func TestDelegationMessageFormat(t *testing.T) {
	expires := time.Date(2026, 10, 3, 9, 0, 0, 0, time.UTC)
	got := renderDelegationMessage("d_01K6ABC", "infra-7", expires, "Ask Anca whether Saturday works.",
		"https://terminal-api.viktorbarzin.me")
	want := "[homelab delegation d_01K6ABC]\n" +
		"from: session infra-7\n" +
		"expires: 2026-10-03T09:00:00Z\n" +
		"\n" +
		"Ask Anca whether Saturday works.\n" +
		"\n" +
		"When done, POST the result to\n" +
		"https://terminal-api.viktorbarzin.me/v1/delegations/d_01K6ABC/result\n" +
		`with your agent-api bearer token and body {"status":"done","result":"..."} (or "failed").`
	if got != want {
		t.Fatalf("message:\n%s\n\nwant:\n%s", got, want)
	}

	// No session named, and a base URL with a trailing slash.
	got = renderDelegationMessage("d_1", "", expires, "x", "https://example.test/")
	if !strings.Contains(got, "\nfrom: session unknown\n") {
		t.Errorf("an absent session should read \"unknown\":\n%s", got)
	}
	if !strings.Contains(got, "\nhttps://example.test/v1/delegations/d_1/result\n") {
		t.Errorf("the callback URL doubled or lost its slash:\n%s", got)
	}
}

func TestDelegationStoreCreateAndGet(t *testing.T) {
	clock := newSteppedClock()
	s, _ := openTestStore(t, clock)
	d := mustCreate(t, s, newRecord("d_1", clock.now(), time.Hour))
	if d.Status != DelegationPending {
		t.Fatalf("status %q, want pending", d.Status)
	}
	if !d.CreatedAt.Equal(clock.now()) || !d.UpdatedAt.Equal(clock.now()) {
		t.Errorf("created_at %v updated_at %v, want both %v", d.CreatedAt, d.UpdatedAt, clock.now())
	}
	rec, ok := s.Get("d_1")
	if !ok || rec.Task != "Ask Anca whether Saturday works." || rec.CallerOSUser != "wizard" {
		t.Fatalf("get: %+v %v", rec, ok)
	}
	if _, ok := s.Get("d_nope"); ok {
		t.Fatal("an id nobody issued was found")
	}
}

// A result may arrive before the creator has recorded the send: Muse can be
// faster than the CLI's second request.
func TestDelegationStoreFinishFromPendingOrSent(t *testing.T) {
	for _, sentFirst := range []bool{false, true} {
		clock := newSteppedClock()
		s, _ := openTestStore(t, clock)
		mustCreate(t, s, newRecord("d_1", clock.now(), time.Hour))
		if sentFirst {
			if _, err := s.MarkSent("d_1"); err != nil {
				t.Fatalf("sent: %v", err)
			}
		}
		clock.advance(time.Minute)
		d, err := s.Finish("d_1", DelegationDone, "Saturday works.")
		if err != nil {
			t.Fatalf("finish (sent first: %v): %v", sentFirst, err)
		}
		if d.Status != DelegationDone || d.Result != "Saturday works." || !d.UpdatedAt.Equal(clock.now()) {
			t.Fatalf("finished delegation %+v", d)
		}
		// A second result is a conflict, not an overwrite.
		if _, err := s.Finish("d_1", DelegationFailed, "changed my mind"); !errors.Is(err, errDelegationFinished) {
			t.Fatalf("second result: %v, want errDelegationFinished", err)
		}
	}
}

func TestDelegationStoreSentAndUndeliveredOnlyFromPending(t *testing.T) {
	clock := newSteppedClock()
	s, _ := openTestStore(t, clock)
	mustCreate(t, s, newRecord("d_1", clock.now(), time.Hour))
	d, err := s.MarkUndelivered("d_1", "WhatsApp Web is logged out")
	if err != nil {
		t.Fatalf("undelivered: %v", err)
	}
	if d.Status != DelegationUndelivered || d.Reason != "WhatsApp Web is logged out" {
		t.Fatalf("%+v", d)
	}
	if _, err := s.MarkSent("d_1"); !errors.Is(err, errDelegationNotPending) {
		t.Fatalf("sent after undelivered: %v, want errDelegationNotPending", err)
	}
	if _, err := s.Finish("d_1", DelegationDone, "x"); !errors.Is(err, errDelegationFinished) {
		t.Fatalf("result after undelivered: %v, want errDelegationFinished", err)
	}
	if _, err := s.MarkSent("d_nope"); !errors.Is(err, errDelegationNotFound) {
		t.Fatalf("unknown id: %v", err)
	}
}

// Expiry is read lazily: a delegation past its time reads as expired whether
// or not the sweep has run, and a late result is told so.
func TestDelegationStoreExpiresLazily(t *testing.T) {
	clock := newSteppedClock()
	s, path := openTestStore(t, clock)
	mustCreate(t, s, newRecord("d_1", clock.now(), time.Hour))
	clock.advance(time.Hour)

	rec, _ := s.Get("d_1")
	if rec.Status != DelegationExpired {
		t.Fatalf("status %q at expires_at, want expired", rec.Status)
	}
	if _, err := s.Finish("d_1", DelegationDone, "late"); !errors.Is(err, errDelegationExpired) {
		t.Fatalf("late result: %v, want errDelegationExpired", err)
	}
	// The lazy expiry was written down, so a restart reads it the same way.
	again, err := OpenDelegationStore(path, clock.now)
	if err != nil {
		t.Fatal(err)
	}
	if rec, _ := again.Get("d_1"); rec.Status != DelegationExpired {
		t.Fatalf("after reopen: %q", rec.Status)
	}
}

func TestDelegationStoreSweepExpiresAndPrunes(t *testing.T) {
	clock := newSteppedClock()
	s, path := openTestStore(t, clock)
	mustCreate(t, s, newRecord("d_short", clock.now(), time.Hour))
	mustCreate(t, s, newRecord("d_long", clock.now(), 48*time.Hour))
	mustCreate(t, s, newRecord("d_done", clock.now(), 48*time.Hour))
	if _, err := s.Finish("d_done", DelegationDone, "ok"); err != nil {
		t.Fatal(err)
	}

	clock.advance(2 * time.Hour)
	if n := s.Sweep(); n != 1 {
		t.Fatalf("sweep expired %d, want 1", n)
	}
	// Straight from the file, not through Get, so this is the sweep's write
	// and not a lazy one.
	reopened, err := OpenDelegationStore(path, clock.now)
	if err != nil {
		t.Fatal(err)
	}
	if st := reopened.byID["d_short"].rec.Status; st != DelegationExpired {
		t.Fatalf("on disk after the sweep: %q", st)
	}
	if st := reopened.byID["d_long"].rec.Status; st != DelegationPending {
		t.Fatalf("an unexpired delegation was touched: %q", st)
	}

	// Past the retention, finished delegations go; an open one never does.
	clock.advance(delegationRetention)
	s.Sweep()
	for _, id := range []string{"d_short", "d_done"} {
		if _, ok := s.Get(id); ok {
			t.Errorf("%s survived the retention", id)
		}
	}
	if rec, ok := s.Get("d_long"); !ok || rec.Status != DelegationExpired {
		t.Errorf("d_long: %+v %v (expired by now, and kept until the next retention)", rec.Status, ok)
	}
}

// The whole point of the file: a restart loses nothing.
func TestDelegationStoreSurvivesARestart(t *testing.T) {
	clock := newSteppedClock()
	s, path := openTestStore(t, clock)
	mustCreate(t, s, newRecord("d_1", clock.now(), time.Hour))
	mustCreate(t, s, newRecord("d_2", clock.now(), time.Hour))
	if _, err := s.MarkSent("d_1"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Finish("d_2", DelegationFailed, "Anca did not answer"); err != nil {
		t.Fatal(err)
	}
	before1, _ := s.Get("d_1")
	before2, _ := s.Get("d_2")

	again, err := OpenDelegationStore(path, clock.now)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	after1, ok1 := again.Get("d_1")
	after2, ok2 := again.Get("d_2")
	if !ok1 || !ok2 {
		t.Fatal("a delegation did not survive the restart")
	}
	if after1.Status != DelegationSent || after2.Status != DelegationFailed || after2.Result != "Anca did not answer" {
		t.Fatalf("after restart: %+v / %+v", after1, after2)
	}
	if after1.CreatorOSUser != "wizard" || after1.CallerOSUser != "wizard" {
		t.Fatalf("the accounts were not kept, so visibility would change across a restart: %+v", after1)
	}
	if !after1.CreatedAt.Equal(before1.CreatedAt) || !after2.UpdatedAt.Equal(before2.UpdatedAt) {
		t.Fatal("timestamps moved across the restart")
	}
	// Order is creation order, so a list reads the same before and after.
	if got := again.order; len(got) != 2 || got[0] != "d_1" || got[1] != "d_2" {
		t.Fatalf("order after restart: %v", got)
	}
	// And the caps remember: a restart is not a way past them.
	if n := again.createdSince("muse", clock.now().Add(-time.Hour)); n != 2 {
		t.Fatalf("%d creations counted after the restart, want 2", n)
	}
}

// The file is written whole and renamed into place: no temp file is left
// behind, and nobody but the service account can read a task's text.
func TestDelegationStoreWritesAtomically(t *testing.T) {
	clock := newSteppedClock()
	s, path := openTestStore(t, clock)
	mustCreate(t, s, newRecord("d_1", clock.now(), time.Hour))

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("mode %04o, want 0600", perm)
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 || entries[0].Name() != delegationsFile {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("state dir holds %v, want only %s", names, delegationsFile)
	}
	if dir, _ := os.Stat(filepath.Dir(path)); dir.Mode().Perm() != 0o700 {
		t.Errorf("state dir mode %04o, want 0700", dir.Mode().Perm())
	}
}

// A write that fails leaves the store as it was: the caller is told, and
// nothing exists in memory that a restart would forget.
func TestDelegationStoreFailedWriteChangesNothing(t *testing.T) {
	clock := newSteppedClock()
	s, _ := openTestStore(t, clock)
	mustCreate(t, s, newRecord("d_1", clock.now(), time.Hour))

	s.writeFile = func(string, []byte) error { return errors.New("disk full") }
	if _, err := s.Create(newRecord("d_2", clock.now(), time.Hour), defaultDelegationCaps); err == nil {
		t.Fatal("create succeeded with a failing write")
	}
	if _, ok := s.Get("d_2"); ok {
		t.Fatal("a delegation that was never written exists in memory")
	}
	if _, err := s.MarkSent("d_1"); err == nil {
		t.Fatal("sent succeeded with a failing write")
	}
	if rec, _ := s.Get("d_1"); rec.Status != DelegationPending {
		t.Fatalf("status %q after a failed write, want pending", rec.Status)
	}
}

func TestDelegationStoreOpenEdgeCases(t *testing.T) {
	clock := newSteppedClock()

	t.Run("no file yet", func(t *testing.T) {
		s, err := OpenDelegationStore(filepath.Join(t.TempDir(), "x", delegationsFile), clock.now)
		if err != nil || len(s.byID) != 0 {
			t.Fatalf("open: %v, %d records", err, len(s.byID))
		}
	})

	// A file that does not parse is set aside rather than overwritten, so an
	// operator can still read what was in it, and the service starts empty
	// rather than not at all.
	t.Run("a file that does not parse", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, delegationsFile)
		if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
			t.Fatal(err)
		}
		s, err := OpenDelegationStore(path, clock.now)
		if err == nil {
			t.Fatal("a corrupt file opened without a word")
		}
		if s == nil || len(s.byID) != 0 {
			t.Fatal("the store is not usable after a corrupt file")
		}
		matches, _ := filepath.Glob(path + ".corrupt-*")
		if len(matches) != 1 {
			t.Fatalf("the corrupt file was not set aside: %v", matches)
		}
		if _, err := s.Create(newRecord("d_1", clock.now(), time.Hour), defaultDelegationCaps); err != nil {
			t.Fatalf("the store does not accept work after setting the file aside: %v", err)
		}
	})

	// A file that exists and cannot be read is not overwritten: the store
	// refuses every change and says why, so nothing on disk is lost.
	t.Run("a file that cannot be read", func(t *testing.T) {
		if os.Getuid() == 0 {
			t.Skip("root reads a 0000 file")
		}
		dir := t.TempDir()
		path := filepath.Join(dir, delegationsFile)
		if err := os.WriteFile(path, []byte(`{"version":1,"delegations":[]}`), 0o000); err != nil {
			t.Fatal(err)
		}
		s, err := OpenDelegationStore(path, clock.now)
		if err == nil {
			t.Fatal("an unreadable file opened without a word")
		}
		if _, err := s.Create(newRecord("d_1", clock.now(), time.Hour), defaultDelegationCaps); err == nil {
			t.Fatal("the store accepted work it would write over an unreadable file")
		}
	})
}

// Caps are per target Caller over a rolling window, and the refusal says
// when the oldest creation in the window falls out of it.
func TestDelegationStoreCaps(t *testing.T) {
	clock := newSteppedClock()
	s, _ := openTestStore(t, clock)
	caps := delegationCaps{PerHour: 3, PerDay: 5}

	create := func(id, caller string) error {
		rec := newRecord(id, clock.now(), time.Hour)
		rec.Caller = caller
		_, err := s.Create(rec, caps)
		return err
	}
	// Three in the first twenty minutes.
	for i := 0; i < 3; i++ {
		if err := create("d_h"+string(rune('a'+i)), "muse"); err != nil {
			t.Fatalf("create %d: %v", i, err)
		}
		clock.advance(10 * time.Minute)
	}
	// Now 30 minutes in; the first falls out of the hour at 60.
	var capErr *delegationCapError
	if err := create("d_over", "muse"); !errors.As(err, &capErr) {
		t.Fatalf("fourth in an hour: %v, want a cap error", err)
	}
	if capErr.RetryAfter != 30*time.Minute {
		t.Errorf("retry after %v, want 30m", capErr.RetryAfter)
	}
	// Another Caller has its own budget.
	if err := create("d_other", "scribe"); err != nil {
		t.Fatalf("another caller was capped by muse's traffic: %v", err)
	}
	// After the hour, two more fit before the day cap of five.
	clock.advance(time.Hour)
	for i := 0; i < 2; i++ {
		if err := create("d_d"+string(rune('a'+i)), "muse"); err != nil {
			t.Fatalf("day create %d: %v", i, err)
		}
	}
	if err := create("d_day_over", "muse"); !errors.As(err, &capErr) {
		t.Fatalf("sixth in a day: %v, want a cap error", err)
	}
	// The first creation was at 09:00; it leaves the day at 09:00 tomorrow.
	if want := clock.now().Sub(time.Date(2026, 10, 2, 9, 0, 0, 0, time.UTC)); capErr.RetryAfter != 24*time.Hour-want {
		t.Errorf("day retry after %v, want %v", capErr.RetryAfter, 24*time.Hour-want)
	}
	// A refused creation is not a creation.
	if _, ok := s.Get("d_day_over"); ok {
		t.Error("a capped delegation was recorded")
	}
}

// ?wait= on a delegation wakes on a status change, without polling.
func TestDelegationStoreWaitWakesOnChange(t *testing.T) {
	clock := newSteppedClock()
	s, _ := openTestStore(t, clock)
	mustCreate(t, s, newRecord("d_1", clock.now(), time.Hour))

	done := make(chan Delegation, 1)
	go func() {
		rec, _ := s.Wait(context.Background(), "d_1", 10*time.Second, DelegationPending)
		done <- rec.Delegation
	}()
	time.Sleep(5 * time.Millisecond)
	if _, err := s.MarkSent("d_1"); err != nil {
		t.Fatal(err)
	}
	select {
	case d := <-done:
		if d.Status != DelegationSent {
			t.Fatalf("woke with %q, want sent", d.Status)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the waiter did not wake on a status change")
	}
}

// A waiter is woken by the sweep's expiry, too.
func TestDelegationStoreWaitWakesOnSweptExpiry(t *testing.T) {
	clock := newSteppedClock()
	s, _ := openTestStore(t, clock)
	mustCreate(t, s, newRecord("d_1", clock.now(), time.Hour))

	done := make(chan Delegation, 1)
	go func() {
		rec, _ := s.Wait(context.Background(), "d_1", 10*time.Second, DelegationPending)
		done <- rec.Delegation
	}()
	time.Sleep(5 * time.Millisecond)
	// Two hours on the store's clock, which the waiter's real-time timer
	// knows nothing about: only the sweep's signal can end this wait early.
	clock.advance(2 * time.Hour)
	s.Sweep()
	select {
	case d := <-done:
		if d.Status != DelegationExpired {
			t.Fatalf("woke with %q, want expired", d.Status)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the waiter did not wake on expiry")
	}
}

// On a real clock, a waiter wakes at expires_at without waiting for a sweep.
func TestDelegationStoreWaitWakesAtExpiresAt(t *testing.T) {
	path := filepath.Join(t.TempDir(), delegationsFile)
	s, err := OpenDelegationStore(path, nil)
	if err != nil {
		t.Fatal(err)
	}
	now := s.now()
	mustCreate(t, s, newRecord("d_1", now, time.Second))
	start := time.Now()
	rec, _ := s.Wait(context.Background(), "d_1", 30*time.Second, DelegationPending)
	if rec.Status != DelegationExpired {
		t.Fatalf("status %q, want expired", rec.Status)
	}
	if took := time.Since(start); took > 5*time.Second {
		t.Fatalf("took %v to notice an expiry a second away", took)
	}
}

// A finished delegation will not move, so a wait on it answers at once.
func TestDelegationStoreWaitOnAFinishedDelegationReturnsAtOnce(t *testing.T) {
	clock := newSteppedClock()
	s, _ := openTestStore(t, clock)
	mustCreate(t, s, newRecord("d_1", clock.now(), time.Hour))
	if _, err := s.Finish("d_1", DelegationDone, "ok"); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	rec, ok := s.Wait(context.Background(), "d_1", 10*time.Second, DelegationDone)
	if !ok || rec.Status != DelegationDone || time.Since(start) > time.Second {
		t.Fatalf("wait on a finished delegation: %v %v after %v", rec.Status, ok, time.Since(start))
	}
}
