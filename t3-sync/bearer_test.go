package main

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeT3 writes a stand-in for the t3 CLI that prints a fresh token per call
// and appends its argv to a log, so a test can assert both how often the
// syncer minted and what it asked for.
func fakeT3(t *testing.T) (bin, argvLog string) {
	t.Helper()
	dir := t.TempDir()
	bin = filepath.Join(dir, "t3")
	argvLog = filepath.Join(dir, "argv.log")
	script := "#!/bin/sh\n" +
		"echo \"$@\" >> " + argvLog + "\n" +
		"n=$(wc -l < " + argvLog + " | tr -d ' ')\n" +
		"echo \"token-$n\"\n"
	if err := os.WriteFile(bin, []byte(script), 0o700); err != nil {
		t.Fatalf("write fake t3: %v", err)
	}
	return bin, argvLog
}

func mintCount(t *testing.T, argvLog string) int {
	t.Helper()
	raw, err := os.ReadFile(argvLog)
	if os.IsNotExist(err) {
		return 0
	}
	if err != nil {
		t.Fatalf("read %s: %v", argvLog, err)
	}
	return len(strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n"))
}

func TestBearerMintsOnceAndCaches(t *testing.T) {
	bin, argvLog := fakeT3(t)
	b := NewBearer("/base/dir", time.Hour)
	b.T3Bin = bin

	first, err := b.Token()
	if err != nil {
		t.Fatalf("Token: %v", err)
	}
	if first != "token-1" {
		t.Fatalf("Token = %q, want token-1", first)
	}
	for i := 0; i < 3; i++ {
		again, err := b.Token()
		if err != nil {
			t.Fatalf("Token %d: %v", i, err)
		}
		if again != first {
			t.Fatalf("Token %d = %q, want the cached %q", i, again, first)
		}
	}
	if got := mintCount(t, argvLog); got != 1 {
		t.Errorf("minted %d times, want 1", got)
	}
}

// The argv is the contract with the t3 CLI: --token-only so stdout is only the
// token, --base-dir so it is this user's own T3 and no other.
func TestBearerMintArgv(t *testing.T) {
	bin, argvLog := fakeT3(t)
	b := NewBearer("/home/wizard/.t3", 12*time.Hour)
	b.T3Bin = bin

	if _, err := b.Token(); err != nil {
		t.Fatalf("Token: %v", err)
	}
	raw, err := os.ReadFile(argvLog)
	if err != nil {
		t.Fatalf("read argv log: %v", err)
	}
	argv := strings.TrimSpace(string(raw))
	for _, want := range []string{"auth session issue", "--token-only", "--ttl 12h", "--base-dir /home/wizard/.t3"} {
		if !strings.Contains(argv, want) {
			t.Errorf("argv %q is missing %q", argv, want)
		}
	}
}

func TestFormatTTL(t *testing.T) {
	cases := []struct {
		in   time.Duration
		want string
	}{
		{12 * time.Hour, "12h"},
		{24 * time.Hour, "24h"},
		{90 * time.Minute, "90m"},
		{30 * time.Second, "1m"}, // never ask for less than a minute
		{0, "1m"},
		{-time.Hour, "1m"},
	}
	for _, c := range cases {
		if got := formatTTL(c.in); got != c.want {
			t.Errorf("formatTTL(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}

// Re-mint EARLY rather than on the first 401: a syncer that only discovers
// expiry from a failed dispatch loses whatever that dispatch was.
func TestBearerRemintsBeforeExpiry(t *testing.T) {
	bin, argvLog := fakeT3(t)
	b := NewBearer("/base/dir", time.Hour)
	b.T3Bin = bin
	base := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)
	clock := base
	b.now = func() time.Time { return clock }

	if _, err := b.Token(); err != nil {
		t.Fatalf("Token: %v", err)
	}

	// Half way through the lifetime: still the cached token.
	clock = base.Add(30 * time.Minute)
	tok, err := b.Token()
	if err != nil {
		t.Fatalf("Token mid-life: %v", err)
	}
	if tok != "token-1" {
		t.Errorf("mid-life Token = %q, want the cached token-1", tok)
	}

	// Inside the refresh margin but still valid: mint now, while a failure is
	// still recoverable.
	clock = base.Add(time.Hour - 30*time.Second)
	tok, err = b.Token()
	if err != nil {
		t.Fatalf("Token near expiry: %v", err)
	}
	if tok != "token-2" {
		t.Errorf("near-expiry Token = %q, want a fresh token-2", tok)
	}
	if got := mintCount(t, argvLog); got != 2 {
		t.Errorf("minted %d times, want 2", got)
	}
}

// Invalidate is the 401 path: the server rejected the token we believed in, so
// the cached answer is wrong regardless of what the clock says.
func TestBearerInvalidateForcesRemint(t *testing.T) {
	bin, _ := fakeT3(t)
	b := NewBearer("/base/dir", time.Hour)
	b.T3Bin = bin

	first, err := b.Token()
	if err != nil {
		t.Fatalf("Token: %v", err)
	}
	b.Invalidate(first)
	second, err := b.Token()
	if err != nil {
		t.Fatalf("Token after Invalidate: %v", err)
	}
	if second == first {
		t.Fatal("Invalidate did not force a re-mint")
	}

	// Invalidating a token we no longer hold must not throw away the good one:
	// two requests can fail concurrently and only the first is news.
	b.Invalidate(first)
	third, err := b.Token()
	if err != nil {
		t.Fatalf("Token after stale Invalidate: %v", err)
	}
	if third != second {
		t.Errorf("a stale Invalidate discarded the current token: %q → %q", second, third)
	}
}

func TestBearerReportsMintFailure(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "t3")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho 'no session store' >&2\nexit 1\n"), 0o700); err != nil {
		t.Fatalf("write fake t3: %v", err)
	}
	b := NewBearer("/base/dir", time.Hour)
	b.T3Bin = bin

	if _, err := b.Token(); err == nil {
		t.Fatal("Token returned nil error for a failing t3")
	} else if !strings.Contains(err.Error(), "no session store") {
		t.Errorf("error %q does not carry the CLI's stderr", err)
	}
}

// A t3 that prints nothing is a failure, not an empty bearer: an empty
// Authorization header would 401 on every request for the rest of the run.
func TestBearerRejectsEmptyToken(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "t3")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatalf("write fake t3: %v", err)
	}
	b := NewBearer("/base/dir", time.Hour)
	b.T3Bin = bin

	if _, err := b.Token(); err == nil {
		t.Fatal("Token accepted an empty mint")
	}
}

// The token is a full-authority credential for that user's T3. Redacted is
// what may be logged, and it must not contain any of it.
func TestBearerRedacted(t *testing.T) {
	bin, _ := fakeT3(t)
	b := NewBearer("/base/dir", time.Hour)
	b.T3Bin = bin
	tok, err := b.Token()
	if err != nil {
		t.Fatalf("Token: %v", err)
	}
	if strings.Contains(b.Redacted(), tok) {
		t.Errorf("Redacted() = %q leaks the token", b.Redacted())
	}
}

func TestBearerConcurrentTokenMintsOnce(t *testing.T) {
	bin, argvLog := fakeT3(t)
	b := NewBearer("/base/dir", time.Hour)
	b.T3Bin = bin

	var wg sync.WaitGroup
	tokens := make([]string, 8)
	for i := range tokens {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			tok, err := b.Token()
			if err != nil {
				t.Errorf("Token: %v", err)
				return
			}
			tokens[i] = tok
		}(i)
	}
	wg.Wait()

	if got := mintCount(t, argvLog); got != 1 {
		t.Errorf("minted %d times under concurrency, want 1", got)
	}
	for i, tok := range tokens {
		if tok != tokens[0] {
			t.Errorf("goroutine %d saw %q, want %q", i, tok, tokens[0])
		}
	}
}
