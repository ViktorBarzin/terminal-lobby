package main

import (
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"terminal-lobby/sessionio"
	"terminal-lobby/spendstore"
)

// POST /hooks/pi-usage: what a pi conversation has spent, posted by the lobby's
// pi extension when a turn settles (devvm/pi-extension.js).

func postPiUsage(t *testing.T, rec spendRecorder, remote, body string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/hooks/pi-usage", strings.NewReader(body))
	r.RemoteAddr = remote
	localhostOnly(handlePiUsage(rec))(w, r)
	return w
}

// piReading is the body the extension posts: running totals for the whole
// conversation, as pi's own session statistics add them up.
const piReading = `{"user":"wizard","tmux_session":"k7m2q9x4tpz3","sessionId":"0199a2f4-7c1e-7b3a-9d2e-3f4a5b6c7d8e",` +
	`"model":"anthropic/claude-opus-5","costUsd":0.4125,` +
	`"tokens":{"input":1200,"output":3400,"cacheRead":52000,"cacheWrite":8000}}`

func TestPiUsageIsLoopbackOnly(t *testing.T) {
	for _, tc := range []struct {
		remote string
		want   int
	}{
		{"127.0.0.1:5000", http.StatusNoContent},
		{"[::1]:5000", http.StatusNoContent},
		{"192.168.1.40:5000", http.StatusForbidden},
		{"203.0.113.7:5000", http.StatusForbidden},
	} {
		rec := &memRecorder{}
		if w := postPiUsage(t, rec, tc.remote, piReading); w.Code != tc.want {
			t.Errorf("%s: code %d, want %d (%s)", tc.remote, w.Code, tc.want, w.Body.String())
		}
		if tc.want != http.StatusNoContent && len(rec.got) != 0 {
			t.Errorf("%s: a refused request recorded a reading", tc.remote)
		}
	}
}

func TestPiUsageRecordsAReadingAsPi(t *testing.T) {
	rec := &memRecorder{}
	if w := postPiUsage(t, rec, "127.0.0.1:5000", piReading); w.Code != http.StatusNoContent {
		t.Fatalf("code %d, want 204 (%s)", w.Code, w.Body.String())
	}
	if len(rec.got) != 1 {
		t.Fatalf("recorded %d readings, want 1", len(rec.got))
	}
	got := rec.got[0]
	if got.Tool != sessionio.HarnessPi {
		t.Errorf("Tool = %q, want pi", got.Tool)
	}
	if got.User != "wizard" || got.TmuxSession != "k7m2q9x4tpz3" || got.SessionID != "0199a2f4-7c1e-7b3a-9d2e-3f4a5b6c7d8e" {
		t.Errorf("identity = %q %q %q", got.User, got.TmuxSession, got.SessionID)
	}
	if got.Model != "anthropic/claude-opus-5" || got.CostUSD != 0.4125 {
		t.Errorf("model %q, cost %v", got.Model, got.CostUSD)
	}
	if got.At.IsZero() {
		t.Error("the reading carries no time, so it lands on no day")
	}
	if len(got.Windows) != 0 {
		t.Errorf("a pi reading named rate-limit windows: %+v", got.Windows)
	}
}

// Pi counts input the way Anthropic reports it: fresh input, with cache reads
// and cache writes as separate figures on top. The store's Input is every input
// token, with the two cache figures as parts of it, so they are added in.
func TestPiUsageKeepsTheStoresTokenShape(t *testing.T) {
	rec := &memRecorder{}
	postPiUsage(t, rec, "127.0.0.1:5000", piReading)
	if len(rec.got) != 1 {
		t.Fatal("nothing recorded")
	}
	want := spendstore.Tokens{Input: 1200 + 52000 + 8000, Output: 3400, CacheRead: 52000, CacheCreation: 8000}
	if rec.got[0].Tokens != want {
		t.Fatalf("tokens = %+v, want %+v", rec.got[0].Tokens, want)
	}
}

func TestPiUsageRejectsWhatCannotBeStored(t *testing.T) {
	for name, body := range map[string]string{
		"not json":         `{"user":"wizard",`,
		"trailing data":    piReading + ` {}`,
		"no user":          strings.Replace(piReading, `"user":"wizard",`, ``, 1),
		"no session id":    strings.Replace(piReading, `"sessionId":"0199a2f4-7c1e-7b3a-9d2e-3f4a5b6c7d8e",`, ``, 1),
		"odd session id":   strings.Replace(piReading, `0199a2f4-7c1e-7b3a-9d2e-3f4a5b6c7d8e`, `../../etc`, 1),
		"bad tmux session": strings.Replace(piReading, `k7m2q9x4tpz3`, `a b`, 1),
		"negative cost":    strings.Replace(piReading, `0.4125`, `-1`, 1),
		"negative tokens":  strings.Replace(piReading, `"output":3400`, `"output":-5`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			rec := &memRecorder{}
			if w := postPiUsage(t, rec, "127.0.0.1:5000", body); w.Code != http.StatusBadRequest {
				t.Fatalf("code %d, want 400 (%s)", w.Code, w.Body.String())
			}
			if len(rec.got) != 0 {
				t.Fatal("a refused body reached the store")
			}
		})
	}
}

// A model name is shown on the Agent spend page, so it is held to the shape of
// a pi reference; one outside it is dropped and the spend still counts.
func TestPiUsageKeepsTheSpendOfAnOddModel(t *testing.T) {
	rec := &memRecorder{}
	body := strings.Replace(piReading, `anthropic/claude-opus-5`, `<b>odd</b>`, 1)
	if w := postPiUsage(t, rec, "127.0.0.1:5000", body); w.Code != http.StatusNoContent {
		t.Fatalf("code %d (%s)", w.Code, w.Body.String())
	}
	if len(rec.got) != 1 || rec.got[0].Model != "" || rec.got[0].CostUSD != 0.4125 {
		t.Fatalf("got %+v, want the reading with no model", rec.got)
	}
}

func TestPiUsageFailsWhenTheStoreCannot(t *testing.T) {
	rec := &memRecorder{err: os.ErrPermission}
	if w := postPiUsage(t, rec, "127.0.0.1:5000", piReading); w.Code != http.StatusInternalServerError {
		t.Fatalf("code %d, want 500", w.Code)
	}
}

// The same two gates as /hooks/usage, and the same on-disk store.
func TestPiUsageRouteIsGated(t *testing.T) {
	raw, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	line := ""
	for _, l := range strings.Split(string(raw), "\n") {
		if strings.Contains(l, `"POST /hooks/pi-usage"`) {
			line = l
			break
		}
	}
	if line == "" {
		t.Fatal("main.go does not register POST /hooks/pi-usage")
	}
	for _, want := range []string{"localhostOnly(", "peerOwnsClaim(", "handlePiUsage(spend)"} {
		if !strings.Contains(line, want) {
			t.Errorf("POST /hooks/pi-usage lacks %s:\n%s", want, line)
		}
	}
	// The same store instance as /hooks/usage: its lock is what keeps a Claude
	// reading and a pi reading for one user from overwriting each other.
	if !strings.Contains(string(raw), "spend := spendstore.New(") || !strings.Contains(string(raw), "handleUsage(spend)") {
		t.Error("the two spend routes do not share one on-disk store")
	}
}

// Running totals, against a real store: a reading REPLACES the session row and
// moves the day by the difference, so the same total posted three times is one
// charge, and a bigger total adds only what is new.
func TestPiUsageReachesTheOnDiskStore(t *testing.T) {
	store := spendstore.New(t.TempDir())
	for i := 0; i < 3; i++ {
		if w := postPiUsage(t, store, "127.0.0.1:5000", piReading); w.Code != http.StatusNoContent {
			t.Fatalf("post %d: code %d (%s)", i, w.Code, w.Body.String())
		}
	}
	later := strings.Replace(piReading, `0.4125`, `0.5`, 1)
	if w := postPiUsage(t, store, "127.0.0.1:5000", later); w.Code != http.StatusNoContent {
		t.Fatalf("later post: code %d", w.Code)
	}
	doc, err := store.Load("wizard")
	if err != nil {
		t.Fatal(err)
	}
	if len(doc.Sessions) != 1 || doc.Sessions[0].CostUSD != 0.5 || doc.Sessions[0].Tool != sessionio.HarnessPi {
		t.Fatalf("session rows = %+v, want one pi row at 0.5", doc.Sessions)
	}
	var day float64
	for _, d := range doc.Days {
		if d.Tool == sessionio.HarnessPi {
			day += d.CostUSD
		}
	}
	if math.Abs(day-0.5) > 1e-9 {
		t.Fatalf("day rollup = %v, want 0.5: a running total posted again is not a new charge", day)
	}
}
