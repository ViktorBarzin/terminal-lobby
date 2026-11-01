package t3client

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newClock() *fakeClock { return &fakeClock{t: time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)} }

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func TestParsePairing(t *testing.T) {
	out := []byte(`{
  "id": "b1e856fb",
  "credential": "DW278PMWNX59",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-11-01T00:08:45.755Z"
}`)
	got, err := ParsePairing(out)
	if err != nil || got != "DW278PMWNX59" {
		t.Fatalf("ParsePairing = %q, %v", got, err)
	}
	for _, bad := range []string{``, `{}`, `{"credential":""}`, `not json`} {
		if _, err := ParsePairing([]byte(bad)); err == nil {
			t.Errorf("ParsePairing(%q) accepted", bad)
		}
	}
}

func TestSudoMinterArgv(t *testing.T) {
	got := SudoMinter().Argv("emo")
	want := []string{"sudo", "-n", "/usr/local/bin/t3-mint", "emo"}
	if len(got) != len(want) {
		t.Fatalf("argv = %q", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("argv = %q, want %q", got, want)
		}
	}
	if _, err := SudoMinter().Mint(context.Background(), "../root"); err == nil {
		t.Fatal("an invalid user reached the minter")
	}
}

func TestExecMinterRunsCommand(t *testing.T) {
	m := ExecMinter{Argv: func(user string) []string {
		return []string{"sh", "-c", `printf '{"credential":"CODE-%s"}' "$0"`, user}
	}}
	got, err := m.Mint(context.Background(), "wizard")
	if err != nil || got != "CODE-wizard" {
		t.Fatalf("Mint = %q, %v", got, err)
	}
	fail := ExecMinter{Argv: func(string) []string { return []string{"sh", "-c", "echo user not mapped >&2; exit 3"} }}
	if _, err := fail.Mint(context.Background(), "wizard"); err == nil {
		t.Fatal("a failing minter returned no error")
	}
}

func TestTokenStoreRoundTripAndMode(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	s := TokenStore{Dir: dir}
	if _, err := s.Load("wizard"); !errors.Is(err, ErrNoToken) {
		t.Fatalf("Load on empty store: %v", err)
	}
	tok := Token{AccessToken: "abc", Label: "tmux-api", ClientID: "cid", IssuedAt: time.Unix(100, 0).UTC(), ExpiresAt: time.Unix(200, 0).UTC()}
	if err := s.Save("wizard", tok); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(filepath.Join(dir, "t3-token-wizard.json"))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("token file mode %v, want 0600", fi.Mode().Perm())
	}
	got, err := s.Load("wizard")
	if err != nil || got != tok {
		t.Fatalf("Load = %+v, %v; want %+v", got, err, tok)
	}
	// Overwrite leaves no temp files behind.
	if err := s.Save("wizard", tok); err != nil {
		t.Fatal(err)
	}
	ents, _ := os.ReadDir(dir)
	if len(ents) != 1 {
		t.Fatalf("store holds %d files, want 1", len(ents))
	}
	if err := s.Save("../evil", tok); err == nil {
		t.Fatal("a path-like user was saved")
	}
}

// A token file someone else can read is not trusted: a fresh token is made.
func TestTokenStoreRejectsLooseMode(t *testing.T) {
	dir := t.TempDir()
	s := TokenStore{Dir: dir}
	if err := s.Save("wizard", Token{AccessToken: "abc"}); err != nil {
		t.Fatal(err)
	}
	os.Chmod(filepath.Join(dir, "t3-token-wizard.json"), 0o644)
	if _, err := s.Load("wizard"); err == nil {
		t.Fatal("a world-readable token file was loaded")
	}
}

func newCreds(t *testing.T, f *fakeT3, clock *fakeClock) *Credentials {
	return &Credentials{
		Label:  "tmux-api",
		Minter: f.minter(),
		Store:  TokenStore{Dir: t.TempDir()},
		Now:    clock.Now,
	}
}

func TestCredentialsMintOnceAndReuse(t *testing.T) {
	f := newFakeT3(t)
	clock := newClock()
	c := newCreds(t, f, clock)
	ctx := context.Background()
	a, err := c.Token(ctx, "wizard", f.srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	b, err := c.Token(ctx, "wizard", f.srv.URL)
	if err != nil || a != b {
		t.Fatalf("second Token = %q, %v; want %q", b, err, a)
	}
	// A new process with the same state dir reads the stored token.
	c2 := &Credentials{Label: "tmux-api", Minter: f.minter(), Store: c.Store, Now: clock.Now}
	if got, _ := c2.Token(ctx, "wizard", f.srv.URL); got != a {
		t.Fatalf("restart minted a new token: %q vs %q", got, a)
	}
	if _, issued, _ := f.counts(); issued != 1 {
		t.Fatalf("issued %d tokens, want 1", issued)
	}
	tok, _ := c.Store.Load("wizard")
	if tok.Label != "tmux-api" || tok.ExpiresAt.Sub(tok.IssuedAt) != 30*24*time.Hour {
		t.Fatalf("stored token %+v", tok)
	}
}

func TestCredentialsRenewalTiming(t *testing.T) {
	cases := []struct {
		age   time.Duration
		renew bool
	}{
		{0, false},
		{19*24*time.Hour + 23*time.Hour, false},
		{20 * 24 * time.Hour, true},
		{29 * 24 * time.Hour, true},
		{31 * 24 * time.Hour, true},
	}
	for _, tc := range cases {
		f := newFakeT3(t)
		clock := newClock()
		c := newCreds(t, f, clock)
		ctx := context.Background()
		first, err := c.Token(ctx, "wizard", f.srv.URL)
		if err != nil {
			t.Fatal(err)
		}
		clock.Advance(tc.age)
		got, err := c.Token(ctx, "wizard", f.srv.URL)
		if err != nil {
			t.Fatal(err)
		}
		if renewed := got != first; renewed != tc.renew {
			t.Errorf("age %v: renewed=%v, want %v", tc.age, renewed, tc.renew)
		}
	}
}

// A failed renewal of a token that has not yet expired keeps the old one:
// the lobby goes on working while t3-mint is broken.
func TestCredentialsRenewFailureKeepsLiveToken(t *testing.T) {
	f := newFakeT3(t)
	clock := newClock()
	c := newCreds(t, f, clock)
	ctx := context.Background()
	first, _ := c.Token(ctx, "wizard", f.srv.URL)
	c.Minter = MinterFunc(func(context.Context, string) (string, error) { return "", errors.New("sudo: a password is required") })
	clock.Advance(21 * 24 * time.Hour)
	got, err := c.Token(ctx, "wizard", f.srv.URL)
	if err != nil || got != first {
		t.Fatalf("Token = %q, %v; want the old token", got, err)
	}
	clock.Advance(10 * 24 * time.Hour) // now past expiry
	if _, err := c.Token(ctx, "wizard", f.srv.URL); err == nil {
		t.Fatal("an expired token was handed out")
	}
}

func TestCredentialsRenewSingleFlight(t *testing.T) {
	f := newFakeT3(t)
	clock := newClock()
	var mints atomic.Int32
	c := newCreds(t, f, clock)
	c.Minter = MinterFunc(func(ctx context.Context, u string) (string, error) {
		mints.Add(1)
		time.Sleep(10 * time.Millisecond)
		return f.mint(), nil
	})
	ctx := context.Background()
	stale, err := c.Token(ctx, "wizard", f.srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make([]string, 8)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], _ = c.Renew(ctx, "wizard", f.srv.URL, stale)
		}(i)
	}
	wg.Wait()
	if mints.Load() != 2 {
		t.Fatalf("minted %d times, want 2 (first token and one renewal)", mints.Load())
	}
	for _, r := range results {
		if r == "" || r == stale || r != results[0] {
			t.Fatalf("renew results %q", results)
		}
	}
}

func TestAuthorizeRejectsUsedCode(t *testing.T) {
	f := newFakeT3(t)
	code := f.mint()
	ctx := context.Background()
	if _, err := Authorize(ctx, nil, f.srv.URL, "agent-api", code, time.Now()); err != nil {
		t.Fatal(err)
	}
	_, err := Authorize(ctx, nil, f.srv.URL, "agent-api", code, time.Now())
	if err == nil {
		t.Fatal("a used pairing code was accepted")
	}
}
