package main

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// The T3 bearer: minted by the t3 CLI, held in memory, never written to disk.
//
// `t3 auth session issue --token-only --ttl <d> --base-dir <dir>` prints a
// token on stdout (verified fact 7). The syncer runs as the user who owns that
// base dir, so no privilege is crossed to mint it — and because the token is a
// full-authority credential for that user's T3, it stays in this process's
// memory: no file, no env var, no log line.

// mintTimeout bounds one `t3 auth session issue`. It touches the same sqlite
// the server holds open, so it is a local call that either answers quickly or
// is stuck; waiting longer than this only delays the next reconcile pass.
const mintTimeout = 30 * time.Second

// refreshMargin is how far before expiry a token is replaced, as a fraction of
// its lifetime, clamped by the two bounds below. Re-minting early is the whole
// point: a syncer that only learns of expiry from a rejected dispatch has
// already lost that dispatch.
const (
	refreshFraction = 10 // 1/10th of the TTL
	minRefreshLead  = time.Minute
	maxRefreshLead  = 30 * time.Minute
)

// Bearer holds a token and re-mints it before it expires.
//
// Safe for concurrent use: the reconcile loop and any one-shot command can both
// ask for the current token.
type Bearer struct {
	// T3Bin is the t3 CLI to mint with. A path rather than a fixed "t3" so a
	// test can point it at a stand-in without touching PATH.
	T3Bin string

	baseDir string
	ttl     time.Duration

	// now is the clock, injectable so expiry has a test that does not sleep.
	now func() time.Time

	mu      sync.Mutex
	token   string
	expires time.Time
}

// NewBearer prepares a bearer for one base dir. Nothing is minted until Token
// is first called.
func NewBearer(baseDir string, ttl time.Duration) *Bearer {
	return &Bearer{
		T3Bin:   "t3",
		baseDir: baseDir,
		ttl:     ttl,
		now:     time.Now,
	}
}

// Token returns a valid bearer, minting a new one when the held one is missing
// or inside its refresh margin.
//
// The lock is held across the mint. That serialises the several callers a tick
// can produce into one `t3 auth session issue` — which is the point: the token
// is cheap to hold and each mint writes a session row into T3's store.
func (b *Bearer) Token() (string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if b.token != "" && b.now().Before(b.expires.Add(-b.refreshLead())) {
		return b.token, nil
	}
	token, err := b.mint()
	if err != nil {
		return "", err
	}
	b.token = token
	b.expires = b.now().Add(b.ttl)
	return token, nil
}

// Invalidate discards the held token if it is still the one the caller used.
//
// The argument is what makes this safe under concurrency: when several requests
// fail together on an expired token, only the first one is news. Without the
// comparison, the second caller would throw away the replacement the first one
// had just minted, and the two would take turns invalidating each other.
func (b *Bearer) Invalidate(used string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if used == "" || used == b.token {
		b.token = ""
		b.expires = time.Time{}
	}
}

// Redacted is what a bearer may be logged as. It exists so there is an obvious
// right answer next to the obvious wrong one.
func (b *Bearer) Redacted() string { return "<bearer redacted>" }

// refreshLead is how long before expiry Token starts minting a replacement.
func (b *Bearer) refreshLead() time.Duration {
	lead := b.ttl / refreshFraction
	if lead < minRefreshLead {
		lead = minRefreshLead
	}
	if lead > maxRefreshLead {
		lead = maxRefreshLead
	}
	return lead
}

// mint shells out to the t3 CLI. Callers hold b.mu.
//
// stdout is the token and nothing else (--token-only); stderr is carried into
// the error because the CLI's own message ("no session store", a base dir that
// is not a T3 home) is the only useful thing to log — and the one thing that
// must never reach a log is on stdout.
func (b *Bearer) mint() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), mintTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, b.T3Bin, "auth", "session", "issue",
		"--token-only", "--ttl", formatTTL(b.ttl), "--base-dir", b.baseDir)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("mint bearer for %s: %w: %s", b.baseDir, err, strings.TrimSpace(stderr.String()))
	}
	token := strings.TrimSpace(stdout.String())
	if token == "" {
		return "", fmt.Errorf("mint bearer for %s: the CLI printed no token: %s", b.baseDir, strings.TrimSpace(stderr.String()))
	}
	return token, nil
}

// formatTTL renders a duration the way `t3 auth session issue --ttl` reads it
// ("5m", "1h", "30d"). Go's own "12h0m0s" is not one of the documented forms,
// so whole hours are emitted as hours and everything else as minutes.
//
// A non-positive TTL is a misconfiguration, not a request for an instantly
// dead token: it becomes the one-minute floor, which fails loudly on the next
// tick rather than silently minting something unusable.
func formatTTL(d time.Duration) string {
	if d < time.Minute {
		return "1m"
	}
	if d%time.Hour == 0 {
		return fmt.Sprintf("%dh", int64(d/time.Hour))
	}
	return fmt.Sprintf("%dm", int64(d/time.Minute))
}
