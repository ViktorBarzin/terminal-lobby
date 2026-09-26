package main

import (
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"sort"
	"testing"
	"time"

	"terminal-lobby/sessionio"
	"terminal-lobby/spendstore"
)

// The Pi section of GET /agent-spend: pi's own dollar figures, recorded by the
// lobby's pi extension through session-events' POST /hooks/pi-usage, served in
// exactly the shape the Claude section has.

func piReading(osUser, session, id, model string, cost float64, daysBack int) spendstore.Reading {
	return spendstore.Reading{
		User:        osUser,
		TmuxSession: session,
		Tool:        sessionio.HarnessPi,
		SessionID:   id,
		Model:       model,
		CostUSD:     cost,
		Tokens:      spendstore.Tokens{Input: 5000, Output: 700, CacheRead: 4000},
		At:          nowFixture.AddDate(0, 0, -daysBack),
	}
}

func TestHandleAgentSpendServesAPiSection(t *testing.T) {
	store := agentSpendFixture(t, nil)
	osA, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osA+"\n")

	claude := claudeReading(osA, "tl-1", "conv-1", "claude-opus-5", 1.5, 0)
	claude.Windows = []spendstore.Window{{Name: spendstore.WindowFiveHour, UsedPercent: 40, ResetsAtSec: nowFixture.Add(time.Hour).Unix()}}
	for _, r := range []spendstore.Reading{
		claude,
		piReading(osA, "pi-1", "0199a2f4-aaaa", "anthropic/claude-opus-5", 0.4, 0),
		piReading(osA, "pi-2", "0199a2f4-bbbb", "openai/gpt-4o", 0.1, 0),
	} {
		if err := store.Record(r); err != nil {
			t.Fatalf("record: %v", err)
		}
	}

	body := serveAgentSpend(t, "/agent-spend", "alice")
	if body.Pi == nil {
		t.Fatal("no pi section for a user with pi spend")
	}
	p := body.Pi
	if !closeEnough(p.CostUSD, 0.5) {
		t.Errorf("pi spend = %v, want 0.5, and none of Claude's", p.CostUSD)
	}
	if p.Tokens.Input != 10000 || p.Tokens.CacheRead != 8000 {
		t.Errorf("pi tokens = %+v", p.Tokens)
	}
	if len(p.Models) != 2 || p.Models[0].Model != "anthropic/claude-opus-5" || p.Models[1].Model != "openai/gpt-4o" {
		t.Errorf("pi models, dearest first = %+v", p.Models)
	}
	if len(p.Sessions) != 2 || p.Sessions[0].Session != "pi-1" || p.Sessions[0].SessionID != "0199a2f4-aaaa" {
		t.Errorf("pi sessions = %+v", p.Sessions)
	}
	// Claude's rate-limit windows are Claude's seat, not pi's.
	if len(p.Windows) != 0 {
		t.Errorf("the pi section carried windows: %+v", p.Windows)
	}
	// And Claude's section is still Claude's alone.
	if body.Claude == nil || !closeEnough(body.Claude.CostUSD, 1.5) || len(body.Claude.Sessions) != 1 {
		t.Errorf("claude section = %+v", body.Claude)
	}
}

// Exactly the Claude section's shape: the same keys, so the page draws both
// with one component.
func TestThePiSectionHasTheClaudeSectionsShape(t *testing.T) {
	store := agentSpendFixture(t, nil)
	osA, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osA+"\n")
	for _, r := range []spendstore.Reading{
		claudeReading(osA, "tl-1", "conv-1", "claude-opus-5", 1, 0),
		piReading(osA, "pi-1", "0199a2f4-aaaa", "anthropic/claude-opus-5", 1, 0),
	} {
		if err := store.Record(r); err != nil {
			t.Fatal(err)
		}
	}
	rec := httptest.NewRecorder()
	handleAgentSpend(rec, agentSpendReq("/agent-spend", "alice"))
	var raw map[string]map[string]any
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	raw = map[string]map[string]any{}
	for _, k := range []string{"claude", "pi"} {
		var section map[string]any
		if err := json.Unmarshal(doc[k], &section); err != nil {
			t.Fatalf("section %s: %v (%s)", k, err, rec.Body.String())
		}
		raw[k] = section
	}
	keys := func(m map[string]any) []string {
		var out []string
		for k := range m {
			if k != "windows" { // present only for a seat that reports rate limits
				out = append(out, k)
			}
		}
		sort.Strings(out)
		return out
	}
	if !reflect.DeepEqual(keys(raw["claude"]), keys(raw["pi"])) {
		t.Fatalf("claude keys %v, pi keys %v", keys(raw["claude"]), keys(raw["pi"]))
	}
}

// A user who has never run pi has no pi section, which is what lets the page
// leave the heading out.
func TestHandleAgentSpendWithoutPiHasNoPiSection(t *testing.T) {
	store := agentSpendFixture(t, nil)
	osA, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osA+"\n")
	if err := store.Record(claudeReading(osA, "tl-1", "conv-1", "claude-opus-5", 1, 0)); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	handleAgentSpend(rec, agentSpendReq("/agent-spend", "alice"))
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	if _, ok := doc["pi"]; ok {
		t.Fatalf("a pi section for a user who never ran pi: %s", rec.Body.String())
	}
}

// Present with a zero for a quiet period, as Claude's is: a section that
// vanished when the period changed would read as a bug.
func TestHandleAgentSpendKeepsThePiSectionForAQuietPeriod(t *testing.T) {
	store := agentSpendFixture(t, nil)
	osA, _ := twoLocalUsers(t)
	withUserMap(t, "alice="+osA+"\n")
	if err := store.Record(piReading(osA, "pi-1", "0199a2f4-aaaa", "anthropic/claude-opus-5", 2, 3)); err != nil {
		t.Fatal(err)
	}
	body := serveAgentSpend(t, "/agent-spend?period=today", "alice")
	if body.Pi == nil || body.Pi.CostUSD != 0 || len(body.Pi.Sessions) != 0 {
		t.Fatalf("pi section for a quiet day = %+v", body.Pi)
	}
	week := serveAgentSpend(t, "/agent-spend?period=7d", "alice")
	if week.Pi == nil || !closeEnough(week.Pi.CostUSD, 2) {
		t.Fatalf("pi section for the week = %+v", week.Pi)
	}
}

// The sidebar figure beside a pi session asks for the pi section alone.
func TestHandleAgentSpendCanAskForPiOnly(t *testing.T) {
	admin, _ := actAsFixture(t)
	home := codexHome(t, currentFixture())
	store := agentSpendFixture(t, map[string]string{admin: home})
	for _, r := range []spendstore.Reading{
		claudeReading(admin, "tl-1", "conv-1", "claude-opus-5", 3, 0),
		piReading(admin, "pi-1", "0199a2f4-aaaa", "anthropic/claude-opus-5", 1, 0),
	} {
		if err := store.Record(r); err != nil {
			t.Fatal(err)
		}
	}
	asked := 0
	spendCodexPanes = func(string) []codexPane {
		asked++
		return nil
	}
	body := serveAgentSpend(t, "/agent-spend?tool=pi", "adminauth")
	if body.Pi == nil || body.Claude != nil || body.Codex != nil {
		t.Fatalf("tool=pi answered %+v, want the pi section alone", body)
	}
	if asked != 0 {
		t.Fatalf("the codex rollouts were walked %d times for tool=pi", asked)
	}
	all := serveAgentSpend(t, "/agent-spend", "adminauth")
	if all.Pi == nil || all.Claude == nil || all.Codex == nil {
		t.Fatalf("without the filter: %+v, want all three sections", all)
	}
}
