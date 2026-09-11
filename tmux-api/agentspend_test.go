package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"terminal-lobby/sessionio"
	"terminal-lobby/spendstore"
)

// The whole suite runs on one clock: nowFixture, the moment the codex fixtures
// were measured against, so a rate-limit window is expired or live by
// arithmetic rather than by when the suite happens to run. In UTC that is
// 2026-09-06 21:26:40, which makes today 2026-09-06, the seven-day floor
// 2026-08-31 and the month floor 2026-09-01.

// agentSpendFixture points every seam the handler reads at scratch state, so a
// test can never see the box's real spend store, real home directory or real
// /proc. homes maps an OS user to the $HOME the codex reader should walk;
// a user absent from it has never run Codex.
func agentSpendFixture(t *testing.T, homes map[string]string) *spendstore.Store {
	t.Helper()

	oldStore := spendStoreInstance
	spendStoreInstance = spendstore.New(t.TempDir())
	t.Cleanup(func() { spendStoreInstance = oldStore })

	oldNow := spendNow
	spendNow = func() time.Time { return nowFixture }
	t.Cleanup(func() { spendNow = oldNow })

	oldHome := spendHomeDir
	spendHomeDir = func(osUser string) string { return homes[osUser] }
	t.Cleanup(func() { spendHomeDir = oldHome })

	// No live attribution by default: /proc walking is codexspend_test.go's
	// subject, and a handler test must not depend on what is running on the box.
	oldPanes := spendCodexPanes
	spendCodexPanes = func(string) []codexPane { return nil }
	t.Cleanup(func() { spendCodexPanes = oldPanes })

	return spendStoreInstance
}

// claudeReading is one statusLine reading in the shape the store keeps, taken
// daysBack whole days before the fixture clock.
func claudeReading(osUser, session, id, model string, cost float64, daysBack int) spendstore.Reading {
	return spendstore.Reading{
		User:        osUser,
		TmuxSession: session,
		Tool:        sessionio.HarnessClaude,
		SessionID:   id,
		Model:       model,
		CostUSD:     cost,
		Tokens:      spendstore.Tokens{Input: 1000, Output: 100},
		At:          nowFixture.AddDate(0, 0, -daysBack),
	}
}

func agentSpendReq(path, authUser string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, path, nil)
	if authUser != "" {
		r.Header.Set(authHeader, authUser)
	}
	return r
}

// serveAgentSpend runs the handler and decodes the body, failing on anything
// but a 200.
func serveAgentSpend(t *testing.T, path, authUser string) agentSpendBody {
	t.Helper()
	rec := httptest.NewRecorder()
	handleAgentSpend(rec, agentSpendReq(path, authUser))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET %s: got %d, want 200 (body %q)", path, rec.Code, rec.Body.String())
	}
	var body agentSpendBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	return body
}

func TestHandleAgentSpendRejectsOtherMethods(t *testing.T) {
	for _, m := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		rec := httptest.NewRecorder()
		handleAgentSpend(rec, httptest.NewRequest(m, "/agent-spend", nil))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s /agent-spend: got %d, want %d", m, rec.Code, http.StatusMethodNotAllowed)
		}
	}
}

func TestHandleAgentSpendRequiresAuth(t *testing.T) {
	rec := httptest.NewRecorder()
	handleAgentSpend(rec, agentSpendReq("/agent-spend", ""))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("GET /agent-spend without %s: got %d, want %d", authHeader, rec.Code, http.StatusUnauthorized)
	}
}

// An identity the map does not name has no OS user, so there is no store to
// read and no home to walk. 403, not an empty document.
func TestHandleAgentSpendUnknownUserForbidden(t *testing.T) {
	agentSpendFixture(t, nil)
	withUserMap(t, "# nobody\n")
	rec := httptest.NewRecorder()
	handleAgentSpend(rec, agentSpendReq("/agent-spend", "stranger"))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("GET /agent-spend as an unmapped user: got %d, want %d", rec.Code, http.StatusForbidden)
	}
}

// A period nobody offers is the caller's mistake. Answering it as All time
// would hand back a much larger number than they asked for.
func TestHandleAgentSpendRejectsUnknownPeriod(t *testing.T) {
	agentSpendFixture(t, nil)
	osA, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osA+"\n")
	rec := httptest.NewRecorder()
	handleAgentSpend(rec, agentSpendReq("/agent-spend?period=fortnight", "alice"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown period: got %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

// A box that runs neither agent answers 200 with both sections absent, which
// is what tells the frontend to leave the rail entry out.
func TestHandleAgentSpendWithNeitherToolOmitsBothSections(t *testing.T) {
	agentSpendFixture(t, nil)
	osA, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osA+"\n")

	body := serveAgentSpend(t, "/agent-spend", "alice")
	if body.Period != string(spendstore.PeriodToday) {
		t.Errorf("default period: got %q, want today", body.Period)
	}
	if body.Claude != nil {
		t.Errorf("claude section present with no claude data: %+v", body.Claude)
	}
	if body.Codex != nil {
		t.Errorf("codex section present with no codex data: %+v", body.Codex)
	}
}

func TestHandleAgentSpendClaudeOnly(t *testing.T) {
	store := agentSpendFixture(t, nil)
	osA, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osA+"\n")

	r := claudeReading(osA, "tl-1", "conv-1", "claude-opus-5", 0.25, 0)
	r.Windows = []spendstore.Window{
		{Name: spendstore.WindowFiveHour, UsedPercent: 22, ResetsAtSec: nowFixture.Add(time.Hour).Unix()},
		{Name: spendstore.WindowSevenDay, UsedPercent: 61, ResetsAtSec: nowFixture.Add(48 * time.Hour).Unix()},
	}
	if err := store.Record(r); err != nil {
		t.Fatalf("record: %v", err)
	}
	second := claudeReading(osA, "tl-2", "conv-2", "claude-haiku-4-5", 0.05, 0)
	if err := store.Record(second); err != nil {
		t.Fatalf("record: %v", err)
	}

	body := serveAgentSpend(t, "/agent-spend", "alice")
	if body.Codex != nil {
		t.Fatalf("codex section present for a box that has never run codex: %+v", body.Codex)
	}
	if body.Claude == nil {
		t.Fatal("claude section absent for a user with claude spend")
	}
	c := body.Claude
	if got, want := c.CostUSD, 0.30; !closeEnough(got, want) {
		t.Errorf("claude spend: got %v, want %v", got, want)
	}
	if got, want := c.Tokens.Input, int64(2000); got != want {
		t.Errorf("claude input tokens: got %d, want %d", got, want)
	}
	if len(c.Models) != 2 || c.Models[0].Model != "claude-opus-5" || c.Models[1].Model != "claude-haiku-4-5" {
		t.Errorf("model breakdown, dearest first: got %+v", c.Models)
	}
	if len(c.Windows) != 2 || c.Windows[0].Name != spendstore.WindowFiveHour {
		t.Errorf("windows: got %+v", c.Windows)
	}
	if len(c.Sessions) != 2 {
		t.Fatalf("session rows: got %d, want 2 (%+v)", len(c.Sessions), c.Sessions)
	}
	// Dearest conversation first, and the row names the tmux session so the
	// page can join it to the title it already has.
	if c.Sessions[0].Session != "tl-1" || !closeEnough(c.Sessions[0].CostUSD, 0.25) {
		t.Errorf("first session row: got %+v", c.Sessions[0])
	}
}

// A seat that reports no rate limits (every enterprise Claude seat, measured
// 2026-09-06) gets a section with spend and no windows, not a section with
// windows sitting at zero.
func TestHandleAgentSpendClaudeWithoutRateLimits(t *testing.T) {
	store := agentSpendFixture(t, nil)
	osA, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osA+"\n")
	if err := store.Record(claudeReading(osA, "tl-1", "conv-1", "claude-opus-5", 1.5, 0)); err != nil {
		t.Fatalf("record: %v", err)
	}

	body := serveAgentSpend(t, "/agent-spend", "alice")
	if body.Claude == nil {
		t.Fatal("claude section absent")
	}
	if len(body.Claude.Windows) != 0 {
		t.Fatalf("windows on a seat that reported none: %+v", body.Claude.Windows)
	}
}

// A window whose reset has passed describes a window that no longer exists.
func TestHandleAgentSpendDropsExpiredClaudeWindow(t *testing.T) {
	store := agentSpendFixture(t, nil)
	osA, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osA+"\n")

	r := claudeReading(osA, "tl-1", "conv-1", "claude-opus-5", 1, 0)
	r.Windows = []spendstore.Window{
		{Name: spendstore.WindowFiveHour, UsedPercent: 90, ResetsAtSec: nowFixture.Add(-time.Minute).Unix()},
		{Name: spendstore.WindowSevenDay, UsedPercent: 40, ResetsAtSec: nowFixture.Add(time.Hour).Unix()},
	}
	if err := store.Record(r); err != nil {
		t.Fatalf("record: %v", err)
	}

	body := serveAgentSpend(t, "/agent-spend", "alice")
	if body.Claude == nil {
		t.Fatal("claude section absent")
	}
	if len(body.Claude.Windows) != 1 || body.Claude.Windows[0].Name != spendstore.WindowSevenDay {
		t.Fatalf("expired window kept: %+v", body.Claude.Windows)
	}
}

// Codex needs nothing recorded: the rollout the CLI already wrote carries the
// account's windows, its plan and its credit balance.
func TestHandleAgentSpendCodexOnly(t *testing.T) {
	osA, _ := twoLocalUsers(t)
	home := codexHome(t, currentFixture())
	agentSpendFixture(t, map[string]string{osA: home})
	withUserMap(t, "alice="+osA+"\n")

	body := serveAgentSpend(t, "/agent-spend", "alice")
	if body.Claude != nil {
		t.Fatalf("claude section present for a box with no claude spend: %+v", body.Claude)
	}
	if body.Codex == nil {
		t.Fatal("codex section absent for a user with rollouts")
	}
	x := body.Codex
	if x.Plan != "plus" {
		t.Errorf("plan: got %q, want plus", x.Plan)
	}
	if len(x.Windows) != 2 {
		t.Fatalf("windows: got %+v, want the 5-hour and the weekly", x.Windows)
	}
	if x.Windows[0].Label != "5-hour limit" || x.Windows[0].UsedPercent != 2 {
		t.Errorf("5-hour window: got %+v", x.Windows[0])
	}
	if x.Windows[1].Label != "weekly limit" || x.Windows[1].UsedPercent != 4 {
		t.Errorf("weekly window: got %+v", x.Windows[1])
	}
	// has_credits is false in the fixture, so there is no balance to show.
	if x.Credits != nil {
		t.Errorf("credits shown for an account that has none: %+v", x.Credits)
	}
	// Nothing was attributed to a pane, and the account-wide reading still
	// stands on its own.
	if len(x.Sessions) != 0 {
		t.Errorf("session rows without live attribution: %+v", x.Sessions)
	}
}

// The two halves are independent: a box running both agents gets both sections
// in one document.
func TestHandleAgentSpendWithBothTools(t *testing.T) {
	osA, _ := twoLocalUsers(t)
	home := codexHome(t, currentFixture())
	store := agentSpendFixture(t, map[string]string{osA: home})
	withUserMap(t, "alice="+osA+"\n")
	if err := store.Record(claudeReading(osA, "tl-1", "conv-1", "claude-opus-5", 2, 0)); err != nil {
		t.Fatalf("record: %v", err)
	}

	body := serveAgentSpend(t, "/agent-spend", "alice")
	if body.Claude == nil || body.Codex == nil {
		t.Fatalf("want both sections, got claude=%v codex=%v", body.Claude != nil, body.Codex != nil)
	}
}

// Every period the page offers, against the same document. The dates are
// chosen off the fixture clock: today is 2026-09-06, so the seven-day floor is
// 2026-08-31 and the month floor is 2026-09-01.
func TestHandleAgentSpendPeriodBoundaries(t *testing.T) {
	store := agentSpendFixture(t, nil)
	osA, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osA+"\n")

	for _, r := range []spendstore.Reading{
		claudeReading(osA, "tl-today", "conv-today", "claude-opus-5", 1, 0),   // 09-06
		claudeReading(osA, "tl-month", "conv-month", "claude-opus-5", 2, 5),   // 09-01
		claudeReading(osA, "tl-week", "conv-week", "claude-opus-5", 4, 6),     // 08-31, the last day inside 7 days
		claudeReading(osA, "tl-before", "conv-before", "claude-opus-5", 8, 7), // 08-30, one day outside
	} {
		if err := store.Record(r); err != nil {
			t.Fatalf("record: %v", err)
		}
	}

	for _, tc := range []struct {
		period   string
		wantCost float64
		wantRows int
	}{
		{"today", 1, 1},
		{"7d", 1 + 2 + 4, 3},
		{"month", 1 + 2, 2},
		{"all", 1 + 2 + 4 + 8, 4},
	} {
		t.Run(tc.period, func(t *testing.T) {
			body := serveAgentSpend(t, "/agent-spend?period="+tc.period, "alice")
			if body.Period != tc.period {
				t.Errorf("period echoed: got %q, want %q", body.Period, tc.period)
			}
			if body.Claude == nil {
				t.Fatal("claude section absent")
			}
			if !closeEnough(body.Claude.CostUSD, tc.wantCost) {
				t.Errorf("%s spend: got %v, want %v", tc.period, body.Claude.CostUSD, tc.wantCost)
			}
			if len(body.Claude.Sessions) != tc.wantRows {
				t.Errorf("%s session rows: got %d, want %d (%+v)", tc.period, len(body.Claude.Sessions), tc.wantRows, body.Claude.Sessions)
			}
		})
	}
}

// A day rollup that exists outside the requested period still counts as data,
// so the section renders with a zero figure rather than vanishing when someone
// flips the period to Today. A page that disappears reads as a bug.
func TestHandleAgentSpendKeepsTheSectionForAQuietPeriod(t *testing.T) {
	store := agentSpendFixture(t, nil)
	osA, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osA+"\n")
	if err := store.Record(claudeReading(osA, "tl-1", "conv-1", "claude-opus-5", 3, 20)); err != nil {
		t.Fatalf("record: %v", err)
	}

	body := serveAgentSpend(t, "/agent-spend?period=today", "alice")
	if body.Claude == nil {
		t.Fatal("claude section absent for a user whose spend is older than the period")
	}
	if body.Claude.CostUSD != 0 {
		t.Errorf("spend today: got %v, want 0", body.Claude.CostUSD)
	}
	if len(body.Claude.Sessions) != 0 {
		t.Errorf("session rows today: got %+v", body.Claude.Sessions)
	}
	if len(body.Claude.Models) != 0 {
		t.Errorf("model rows today: got %+v", body.Claude.Models)
	}
}

// ?as= reaches both halves: an admin acting as someone else reads that
// person's store and walks that person's home, not their own.
func TestHandleAgentSpendFollowsActAs(t *testing.T) {
	admin, other := actAsFixture(t)
	home := codexHome(t, currentFixture())
	store := agentSpendFixture(t, map[string]string{other: home})
	if err := store.Record(claudeReading(admin, "tl-admin", "conv-admin", "claude-opus-5", 99, 0)); err != nil {
		t.Fatalf("record: %v", err)
	}
	if err := store.Record(claudeReading(other, "tl-other", "conv-other", "claude-opus-5", 7, 0)); err != nil {
		t.Fatalf("record: %v", err)
	}

	body := serveAgentSpend(t, "/agent-spend?as="+other, "adminauth")
	if body.Claude == nil {
		t.Fatal("claude section absent")
	}
	if !closeEnough(body.Claude.CostUSD, 7) {
		t.Errorf("spend under ?as=: got %v, want the target's 7 rather than the admin's 99", body.Claude.CostUSD)
	}
	if body.Codex == nil {
		t.Fatal("codex section absent: the codex half did not follow ?as= to the target's home")
	}

	// And without the switch the admin sees their own figures, with no codex
	// section because they have no rollouts.
	own := serveAgentSpend(t, "/agent-spend", "adminauth")
	if own.Claude == nil || !closeEnough(own.Claude.CostUSD, 99) {
		t.Errorf("admin's own spend: got %+v, want 99", own.Claude)
	}
	if own.Codex != nil {
		t.Errorf("codex section for a user with no rollouts: %+v", own.Codex)
	}
}

// A non-admin cannot read anyone else's figures.
func TestHandleAgentSpendRefusesActAsFromNonAdmin(t *testing.T) {
	admin, _ := actAsFixture(t)
	agentSpendFixture(t, nil)
	rec := httptest.NewRecorder()
	handleAgentSpend(rec, agentSpendReq("/agent-spend?as="+admin, "otherauth"))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("non-admin ?as=: got %d, want %d", rec.Code, http.StatusForbidden)
	}
}

// The browser must not cache a figure the user just watched move.
func TestHandleAgentSpendIsNotCached(t *testing.T) {
	agentSpendFixture(t, nil)
	osA, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osA+"\n")
	rec := httptest.NewRecorder()
	handleAgentSpend(rec, agentSpendReq("/agent-spend", "alice"))
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("cache-control: got %q, want no-store", got)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("content-type: got %q, want application/json", got)
	}
}

// A conversation past the retention window keeps a row in the store as the
// baseline the next reading is differenced against. It has no name and no model
// left, so the page must not list it — under All time it would otherwise be a
// blank row carrying a running total.
func TestHandleAgentSpendLeavesRetiredRowsOut(t *testing.T) {
	store := agentSpendFixture(t, nil)
	osA, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osA+"\n")
	// The first conversation ages out; the second is what runs the fold.
	if err := store.Record(claudeReading(osA, "tl-old", "conv-old", "claude-opus-5", 4, 40)); err != nil {
		t.Fatalf("record: %v", err)
	}
	if err := store.Record(claudeReading(osA, "tl-new", "conv-new", "claude-opus-5", 1, 0)); err != nil {
		t.Fatalf("record: %v", err)
	}

	body := serveAgentSpend(t, "/agent-spend?period=all", "alice")
	if body.Claude == nil {
		t.Fatal("claude section absent")
	}
	for _, s := range body.Claude.Sessions {
		if s.SessionID == "conv-old" {
			t.Fatalf("a retired row reached the page: %+v", s)
		}
	}
	if len(body.Claude.Sessions) != 1 {
		t.Fatalf("session rows: got %+v, want only the live conversation", body.Claude.Sessions)
	}
	// The money is still there: the days hold it.
	if !closeEnough(body.Claude.CostUSD, 5) {
		t.Errorf("all time: got %v, want 5", body.Claude.CostUSD)
	}
}

// A user who has never run Codex must not pay for the pane walk that only a
// Codex reading needs. The walk shells out to tmux twice per request, and the
// sidebar polls this endpoint every 30 seconds per open tab.
func TestHandleAgentSpendSkipsTheCodexWalkWithoutRollouts(t *testing.T) {
	agentSpendFixture(t, map[string]string{})
	osA, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osA+"\n")
	// A home with no ~/.codex at all, which is the Claude-only box.
	spendHomeDir = func(string) string { return t.TempDir() }

	asked := 0
	spendCodexPanes = func(string) []codexPane {
		asked++
		return nil
	}

	body := serveAgentSpend(t, "/agent-spend", "alice")
	if body.Codex != nil {
		t.Fatalf("codex section for a user with no rollouts: %+v", body.Codex)
	}
	if asked != 0 {
		t.Fatalf("the pane walk ran %d times for a user with no ~/.codex", asked)
	}
}

// The sidebar figure follows the attached session's tool and reads one number
// out of one section. Asking for that section alone is what keeps a tab
// attached to Claude from walking the Codex rollouts every thirty seconds.
func TestHandleAgentSpendCanAskForOneToolOnly(t *testing.T) {
	admin, other := actAsFixture(t)
	home := codexHome(t, currentFixture())
	store := agentSpendFixture(t, map[string]string{admin: home})
	if err := store.Record(claudeReading(admin, "tl-1", "conv-1", "claude-opus-5", 3, 0)); err != nil {
		t.Fatalf("record: %v", err)
	}
	_ = other

	both := serveAgentSpend(t, "/agent-spend", "adminauth")
	if both.Claude == nil || both.Codex == nil {
		t.Fatalf("without the filter: %+v, want both sections", both)
	}

	claudeOnly := serveAgentSpend(t, "/agent-spend?tool=claude", "adminauth")
	if claudeOnly.Claude == nil {
		t.Error("tool=claude dropped the claude section")
	}
	if claudeOnly.Codex != nil {
		t.Errorf("tool=claude carried a codex section: %+v", claudeOnly.Codex)
	}

	codexOnly := serveAgentSpend(t, "/agent-spend?tool=codex", "adminauth")
	if codexOnly.Codex == nil {
		t.Error("tool=codex dropped the codex section")
	}
	if codexOnly.Claude != nil {
		t.Errorf("tool=codex carried a claude section: %+v", codexOnly.Claude)
	}

	// And the codex half is not merely dropped from the answer: it is not read.
	asked := 0
	spendCodexPanes = func(string) []codexPane {
		asked++
		return nil
	}
	serveAgentSpend(t, "/agent-spend?tool=claude", "adminauth")
	if asked != 0 {
		t.Fatalf("the codex rollouts were walked %d times for tool=claude", asked)
	}
}

// An unknown tool is a caller's mistake, and answering it with everything would
// hand back more than was asked for.
func TestHandleAgentSpendRejectsAnUnknownTool(t *testing.T) {
	agentSpendFixture(t, nil)
	osA, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osA+"\n")
	rec := httptest.NewRecorder()
	handleAgentSpend(rec, agentSpendReq("/agent-spend?tool=shell", "alice"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("tool=shell: got %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

// closeEnough compares dollars without asking two float64 sums to be identical.
func closeEnough(a, b float64) bool {
	d := a - b
	return d < 1e-9 && d > -1e-9
}
