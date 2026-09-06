package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"terminal-lobby/sessionio"
)

// The two fixtures are the statusLine payloads measured on 2026-09-06 against
// Claude Code 2.1.263: an enterprise seat, which carries no rate_limits object
// at all, and a subscriber seat, which carries all three windows. Recorded
// rather than hand-written so a payload-shape change fails here instead of
// reaching the box.
func statusLineFixture(t *testing.T, name string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "usage", name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return strings.TrimSpace(string(raw))
}

// usageEnvelope is what devvm/tl-usage-record puts on the wire: the statusLine
// payload untouched, plus the two facts the script knows and the payload does
// not.
func usageEnvelope(t *testing.T, osUser, tmuxSession, statusLine string) string {
	t.Helper()
	return `{"user":` + quote(t, osUser) + `,"tmux_session":` + quote(t, tmuxSession) +
		`,"statusline":` + statusLine + `}`
}

func quote(t *testing.T, s string) string {
	t.Helper()
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatalf("quote %q: %v", s, err)
	}
	return string(b)
}

// memRecorder stands in for the on-disk store while the handler is under test.
// It is also what proves the handler is testable without a filesystem, which is
// the point of spendRecorder being an interface.
type memRecorder struct {
	got []spendReading
	err error
}

func (m *memRecorder) Record(r spendReading) error {
	if m.err != nil {
		return m.err
	}
	m.got = append(m.got, r)
	return nil
}

func postUsage(t *testing.T, rec spendRecorder, remote, body string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/hooks/usage", strings.NewReader(body))
	r.RemoteAddr = remote
	localhostOnly(handleUsage(rec))(w, r)
	return w
}

// --- gating -----------------------------------------------------------------

// The recorder runs as the OS user on this box, so the endpoint is loopback
// only, exactly like /hooks/session-start next to it.
func TestUsageIsLoopbackOnly(t *testing.T) {
	for _, tc := range []struct {
		name, remote string
		want         int
	}{
		{"loopback v4", "127.0.0.1:5000", http.StatusNoContent},
		{"loopback v6", "[::1]:5000", http.StatusNoContent},
		{"LAN", "192.168.1.40:5000", http.StatusForbidden},
		{"public", "203.0.113.7:5000", http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := &memRecorder{}
			body := usageEnvelope(t, "wizard", "demo", statusLineFixture(t, "statusline_enterprise.json"))
			w := postUsage(t, rec, tc.remote, body)
			if w.Code != tc.want {
				t.Fatalf("code = %d, want %d (%s)", w.Code, tc.want, w.Body.String())
			}
			if tc.want != http.StatusNoContent && len(rec.got) != 0 {
				t.Fatalf("a refused request still recorded %d readings", len(rec.got))
			}
		})
	}
}

// --- validation -------------------------------------------------------------

func TestUsageRejectsMalformedJSON(t *testing.T) {
	for _, tc := range []struct{ name, body string }{
		{"truncated", `{"user":"wizard","tmux_session":"demo","statusline":{`},
		{"not an object", `["wizard"]`},
		{"empty", ``},
		{"null", `null`},
		{"trailing garbage", `{"user":"wizard"} oops`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := &memRecorder{}
			w := postUsage(t, rec, "127.0.0.1:5000", tc.body)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("code = %d, want 400 (%s)", w.Code, w.Body.String())
			}
			if len(rec.got) != 0 {
				t.Fatal("malformed JSON must not reach the store")
			}
		})
	}
}

func TestUsageRejectsMissingFields(t *testing.T) {
	sl := statusLineFixture(t, "statusline_enterprise.json")
	for _, tc := range []struct{ name, body string }{
		{"no user", `{"tmux_session":"demo","statusline":` + sl + `}`},
		{"no tmux session", `{"user":"wizard","statusline":` + sl + `}`},
		{"no statusline", `{"user":"wizard","tmux_session":"demo"}`},
		{"null statusline", `{"user":"wizard","tmux_session":"demo","statusline":null}`},
		{"no session id", `{"user":"wizard","tmux_session":"demo","statusline":{"cost":{"total_cost_usd":1}}}`},
		// A tmux name outside the lobby's alphabet is a name no session can
		// have, and it becomes a key in a per-user document.
		{"session name with a slash", usageEnvelope(t, "wizard", "de/mo", sl)},
		{"session name with a quote", usageEnvelope(t, "wizard", `de"mo`, sl)},
		{"session name too long", usageEnvelope(t, "wizard", strings.Repeat("a", 33), sl)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := &memRecorder{}
			w := postUsage(t, rec, "127.0.0.1:5000", tc.body)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("code = %d, want 400 (%s)", w.Code, w.Body.String())
			}
			if len(rec.got) != 0 {
				t.Fatal("an invalid payload must not reach the store")
			}
		})
	}
}

// A store that cannot write must not answer 204: the recorder would then have
// every reason to believe the reading landed.
func TestUsageFailsWhenTheStoreCannot(t *testing.T) {
	rec := &memRecorder{err: errors.New("disk full")}
	body := usageEnvelope(t, "wizard", "demo", statusLineFixture(t, "statusline_enterprise.json"))
	w := postUsage(t, rec, "127.0.0.1:5000", body)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("code = %d, want 500 (%s)", w.Code, w.Body.String())
	}
}

// --- what gets recorded -----------------------------------------------------

// An enterprise seat reports spend and no windows. The section built on this
// shows a dollar figure and nothing else, so an empty window list has to be
// exactly what the store receives rather than three zeroed windows.
func TestUsageRecordsAnEnterpriseReading(t *testing.T) {
	rec := &memRecorder{}
	body := usageEnvelope(t, "wizard", "demo", statusLineFixture(t, "statusline_enterprise.json"))
	if w := postUsage(t, rec, "127.0.0.1:5000", body); w.Code != http.StatusNoContent {
		t.Fatalf("code = %d, want 204 (%s)", w.Code, w.Body.String())
	}
	if len(rec.got) != 1 {
		t.Fatalf("recorded %d readings, want 1", len(rec.got))
	}
	r := rec.got[0]
	if r.User != "wizard" || r.TmuxSession != "demo" {
		t.Fatalf("reading is for %s/%s, want wizard/demo", r.User, r.TmuxSession)
	}
	if r.Tool != sessionio.HarnessClaude {
		t.Fatalf("tool = %q, want %q", r.Tool, sessionio.HarnessClaude)
	}
	if r.SessionID != "3d0f5a2e-8c41-4b7a-9f60-1e2d3c4b5a69" {
		t.Fatalf("session id = %q", r.SessionID)
	}
	if r.Model != "claude-opus-5" {
		t.Fatalf("model = %q, want claude-opus-5", r.Model)
	}
	if r.CostUSD != 0.329 {
		t.Fatalf("cost = %v, want 0.329", r.CostUSD)
	}
	if r.InputTokens != 58794 || r.OutputTokens != 12 {
		t.Fatalf("tokens = %d in / %d out, want 58794 / 12", r.InputTokens, r.OutputTokens)
	}
	if len(r.Windows) != 0 {
		t.Fatalf("windows = %+v, want none for a seat that reports no rate_limits", r.Windows)
	}
	if r.At.IsZero() {
		t.Fatal("the reading carries no timestamp, so nothing downstream can put it in a period")
	}
}

// A subscriber seat carries all three windows. Each is recorded under the key
// Claude Code uses, with its reset instant, because a window whose reset has
// passed is dropped at display time and that decision needs the instant.
func TestUsageRecordsSubscriberWindows(t *testing.T) {
	rec := &memRecorder{}
	body := usageEnvelope(t, "wizard", "demo", statusLineFixture(t, "statusline_subscriber.json"))
	if w := postUsage(t, rec, "127.0.0.1:5000", body); w.Code != http.StatusNoContent {
		t.Fatalf("code = %d, want 204 (%s)", w.Code, w.Body.String())
	}
	r := rec.got[0]
	if r.CostUSD != 1.75 {
		t.Fatalf("cost = %v, want 1.75", r.CostUSD)
	}
	want := []spendWindow{
		{Name: windowFiveHour, UsedPercent: 37, ResetsAt: time.Unix(1788730052, 0)},
		{Name: windowSevenDay, UsedPercent: 61, ResetsAt: time.Unix(1788757961, 0)},
		{Name: windowSpendLimit, UsedPercent: 4, ResetsAt: time.Unix(1789000000, 0)},
	}
	if len(r.Windows) != len(want) {
		t.Fatalf("windows = %+v, want %d of them", r.Windows, len(want))
	}
	for i, w := range want {
		got := r.Windows[i]
		if got.Name != w.Name || got.UsedPercent != w.UsedPercent || !got.ResetsAt.Equal(w.ResetsAt) {
			t.Errorf("window %d = %+v, want %+v", i, got, w)
		}
	}
}

// The rate_limits object drifts: a seat may report one window and not another,
// and a version may add a key this build has never seen. A window that is
// absent is recorded as absent rather than as zero percent, which would read as
// a real measurement of an empty window.
func TestUsageRecordsOnlyTheWindowsThePayloadCarries(t *testing.T) {
	rec := &memRecorder{}
	sl := `{"session_id":"s1","model":{"id":"claude-opus-5"},` +
		`"cost":{"total_cost_usd":0.5},` +
		`"rate_limits":{"seven_day":{"used_percentage":61,"resets_at":1788757961}}}`
	if w := postUsage(t, rec, "127.0.0.1:5000", usageEnvelope(t, "wizard", "demo", sl)); w.Code != http.StatusNoContent {
		t.Fatalf("code = %d, want 204 (%s)", w.Code, w.Body.String())
	}
	r := rec.got[0]
	if len(r.Windows) != 1 || r.Windows[0].Name != windowSevenDay {
		t.Fatalf("windows = %+v, want only the weekly one", r.Windows)
	}
}

// A window with no resets_at is still a reading — the percentage is the number
// the bar draws — so it is kept, with a zero instant meaning "no reset known".
func TestUsageKeepsAWindowWithNoResetInstant(t *testing.T) {
	rec := &memRecorder{}
	sl := `{"session_id":"s1","cost":{"total_cost_usd":0.5},` +
		`"rate_limits":{"five_hour":{"used_percentage":12}}}`
	if w := postUsage(t, rec, "127.0.0.1:5000", usageEnvelope(t, "wizard", "demo", sl)); w.Code != http.StatusNoContent {
		t.Fatalf("code = %d, want 204 (%s)", w.Code, w.Body.String())
	}
	r := rec.got[0]
	if len(r.Windows) != 1 {
		t.Fatalf("windows = %+v, want the one the payload carried", r.Windows)
	}
	if !r.Windows[0].ResetsAt.IsZero() {
		t.Fatalf("resets at %v, want the zero instant", r.Windows[0].ResetsAt)
	}
}

// A session that has spent nothing yet is a real reading, not a missing one:
// the page has to be able to say a session cost zero.
func TestUsageAcceptsAZeroCost(t *testing.T) {
	rec := &memRecorder{}
	sl := `{"session_id":"s1","model":{"id":"claude-opus-5"},"cost":{"total_cost_usd":0}}`
	if w := postUsage(t, rec, "127.0.0.1:5000", usageEnvelope(t, "wizard", "demo", sl)); w.Code != http.StatusNoContent {
		t.Fatalf("code = %d, want 204 (%s)", w.Code, w.Body.String())
	}
	if len(rec.got) != 1 || rec.got[0].CostUSD != 0 {
		t.Fatalf("readings = %+v, want one at zero", rec.got)
	}
}

// The route has to stay wired to the gate. A /hooks/* path served without
// localhostOnly is reachable from anywhere the port is, and the port widens
// with TL_BIND.
func TestUsageRouteIsGated(t *testing.T) {
	raw, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	line := ""
	for _, l := range strings.Split(string(raw), "\n") {
		if strings.Contains(l, `"POST /hooks/usage"`) {
			line = l
			break
		}
	}
	if line == "" {
		t.Fatal("main.go no longer registers POST /hooks/usage")
	}
	if !strings.Contains(line, "localhostOnly(") || !strings.Contains(line, "peerOwnsClaim(") {
		t.Errorf("POST /hooks/usage is not behind both gates:\n%s", line)
	}
}
