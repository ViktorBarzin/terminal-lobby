package sessionio

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The mod's wire, pinned on both sides. testdata/mod-wire at the repo root
// holds one file per event type, each with every key that event can carry;
// the mod's tests check its shapers emit only those keys, and this test checks
// that ModEvent has a field for every one of them. A key the mod sends that no
// field takes is dropped without a word (the delta's `step` was, until
// 2026-10-04), so an unknown key fails here instead.
func TestEveryGoldenModEventDecodesWithNoKeyLeftOver(t *testing.T) {
	files, err := filepath.Glob(filepath.Join("..", "testdata", "mod-wire", "*.json"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no golden wire files (%v)", err)
	}
	types := map[string]bool{}
	for _, f := range files {
		if filepath.Base(f) == "hello.json" {
			continue // the hello body is session-events' modHello
		}
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.DisallowUnknownFields()
		var ev ModEvent
		if err := dec.Decode(&ev); err != nil {
			t.Errorf("%s: %v", filepath.Base(f), err)
			continue
		}
		if want := strings.TrimSuffix(filepath.Base(f), ".json"); ev.Type != want {
			t.Errorf("%s: type %q, want %q", filepath.Base(f), ev.Type, want)
		}
		types[ev.Type] = true
	}
	for _, typ := range []string{
		ModHistoryEvent, ModRowEvent, ModResultEvent, ModTurnStartEvent, ModDeltaEvent, ModTurnEndEvent,
		ModPromptEvent, ModAskEvent, ModPlanEvent, ModPermissionEvent, ModSettledEvent, ModModelEvent,
		ModAgentsEvent, ModAckEvent, ModByeEvent, ModSummaryEvent, ModLevelEvent, ModCommandFailedEvent,
	} {
		if !types[typ] {
			t.Errorf("no golden file for %q", typ)
		}
	}
}

// A command the mod acked and then could not carry out is a notice in the
// Text view, so the person who sent it knows it did not run.
func TestAFailedCommandIsANoticeInTheLog(t *testing.T) {
	f := NewModSource("demo", "", nil)
	f.Feed(ModEvent{Type: ModCommandFailedEvent, T: 1790900000000, ID: "c3.x", Op: "prompt", Error: "dropped: a hook refused it"})
	evs := f.Replay(0)
	if len(evs) != 1 || evs[0].Kind != KindError {
		t.Fatalf("log = %+v, want one error notice", evs)
	}
	if !strings.Contains(evs[0].Body, "prompt") || !strings.Contains(evs[0].Body, "a hook refused it") {
		t.Fatalf("notice = %q, want the op and the reason", evs[0].Body)
	}
}
