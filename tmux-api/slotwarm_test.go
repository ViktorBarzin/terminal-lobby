package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Keeping a slot warm for the composer's Send
// (docs/plans/2026-10-04-warm-slot-at-send-design.md): POST /sessions/prewarm
// replaces a stale slot instead of reporting that one exists, carries the
// model and effort, and a sweep replaces stale slots after an install.

type warmCall struct {
	user               string
	dir, model, effort string
	speculative        bool
}

type slotFixture struct {
	slots   map[string][]slotState
	warms   []warmCall
	killed  []string
	modID   string
	dirsFor map[string][]string
}

func stubSlots(t *testing.T) *slotFixture {
	t.Helper()
	f := &slotFixture{slots: map[string][]slotState{}, modID: "new", dirsFor: map[string][]string{}}
	prevList, prevMod, prevWarm, prevKill, prevDirs := listSlots, installedModID, runWarm, killSlot, slotDirsOf
	listSlots = func(osUser string) []slotState { return f.slots[osUser] }
	installedModID = func() string { return f.modID }
	runWarm = func(osUser string, w warmRequest) error {
		f.warms = append(f.warms, warmCall{osUser, w.dir, w.model, w.effort, w.speculative})
		return nil
	}
	killSlot = func(osUser, name string) { f.killed = append(f.killed, name) }
	slotDirsOf = func(osUser string) []string { return f.dirsFor[osUser] }
	t.Cleanup(func() {
		listSlots, installedModID, runWarm, killSlot, slotDirsOf = prevList, prevMod, prevWarm, prevKill, prevDirs
	})
	return f
}

func postPrewarm(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	handlePrewarm(rec, projectsReq(http.MethodPost, "/sessions/prewarm", body, "adminauth"))
	prewarmInFlight.Wait()
	return rec
}

func TestPrewarmWarmsASpeculativeSlotWithTheFlags(t *testing.T) {
	me, _ := actAsFixture(t)
	home := homeOfUser(me)
	f := stubSlots(t)

	rec := postPrewarm(t, fmt.Sprintf(`{"dir":%q,"model":"claude-sonnet-5","effort":"high"}`, home))

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status %d", rec.Code)
	}
	want := warmCall{me, home, "claude-sonnet-5", "high", true}
	if len(f.warms) != 1 || f.warms[0] != want {
		t.Fatalf("warmed %+v, want %+v", f.warms, want)
	}
}

func TestPrewarmLeavesACurrentSlotAlone(t *testing.T) {
	me, _ := actAsFixture(t)
	home := homeOfUser(me)
	f := stubSlots(t)
	f.slots[me] = []slotState{{name: prewarmSlotName(home, "", ""), modID: "new"}}

	postPrewarm(t, fmt.Sprintf(`{"dir":%q}`, home))

	if len(f.warms) != 0 {
		t.Fatalf("a current slot was rebuilt: %+v", f.warms)
	}
}

// The case behind three of the four slow first prompts on 2026-10-04: the
// composer asked, a slot of that name existed on the previous mod, and the
// answer was "already there".
func TestPrewarmReplacesAStaleSlotAsTheKindItWas(t *testing.T) {
	for _, speculative := range []bool{false, true} {
		me, _ := actAsFixture(t)
		home := homeOfUser(me)
		f := stubSlots(t)
		f.slots[me] = []slotState{{name: prewarmSlotName(home, "", ""), modID: "old", speculative: speculative}}

		postPrewarm(t, fmt.Sprintf(`{"dir":%q}`, home))

		want := warmCall{me, home, "", "", speculative}
		if len(f.warms) != 1 || f.warms[0] != want {
			t.Errorf("speculative=%v: warmed %+v, want %+v", speculative, f.warms, want)
		}
	}
}

func TestPrewarmRefusesFlagsThatAreNotTokens(t *testing.T) {
	me, _ := actAsFixture(t)
	home := homeOfUser(me)
	f := stubSlots(t)
	for _, body := range []string{
		fmt.Sprintf(`{"dir":%q,"model":"x;rm -rf ~"}`, home),
		fmt.Sprintf(`{"dir":%q,"effort":"HIGH'"}`, home),
	} {
		postPrewarm(t, body)
	}
	if len(f.warms) != 0 {
		t.Fatalf("warmed with an unsafe flag: %+v", f.warms)
	}
}

func TestPrewarmStillHonoursTheSpeculativeCap(t *testing.T) {
	me, _ := actAsFixture(t)
	home := homeOfUser(me)
	f := stubSlots(t)
	for i := 0; i < maxSpeculativeSlots; i++ {
		f.slots[me] = append(f.slots[me], slotState{name: fmt.Sprintf("%sx%d", poolSlotPrefix, i), modID: "new", speculative: true})
	}

	postPrewarm(t, fmt.Sprintf(`{"dir":%q,"model":"claude-sonnet-5"}`, home))

	if len(f.warms) != 0 {
		t.Fatalf("warmed past the cap: %+v", f.warms)
	}
}

func TestSweepReplacesOneStaleSlotPerUserPerPass(t *testing.T) {
	f := stubSlots(t)
	f.slots["a"] = []slotState{
		{name: prewarmSlotName("/a", "", ""), modID: "new", dir: "/a"},
		{name: prewarmSlotName("/a/x", "", ""), modID: "old", dir: "/a/x"},
		{name: prewarmSlotName("/a/y", "m", ""), modID: "old", dir: "/a/y", model: "m", speculative: true},
	}
	f.slots["b"] = []slotState{{name: prewarmSlotName("/b", "", ""), modID: "new", dir: "/b"}}

	if left := sweepStaleSlots([]string{"a", "b"}); !left {
		t.Fatal("the pass said nothing stale was left, with one still to go")
	}
	if len(f.warms) != 1 || f.warms[0] != (warmCall{"a", "/a/x", "", "", false}) {
		t.Fatalf("warmed %+v", f.warms)
	}

	f.slots["a"] = f.slots["a"][:1]
	f.warms = nil
	if left := sweepStaleSlots([]string{"a", "b"}); left || len(f.warms) != 0 {
		t.Fatalf("a pass over current slots warmed %+v (left=%v)", f.warms, left)
	}
}

// Slots warmed before they carried @tl_slot_dir: the folded name is matched
// against the places this user's lobby creates sessions.
func TestSweepPlacesAnUnstampedSlotByItsName(t *testing.T) {
	f := stubSlots(t)
	f.dirsFor["a"] = []string{"/home/a", "/home/a/code/"}
	f.slots["a"] = []slotState{{name: prewarmSlotName("/home/a/code", "", ""), modID: "old"}}

	sweepStaleSlots([]string{"a"})

	if len(f.warms) != 1 || f.warms[0] != (warmCall{"a", "/home/a/code/", "", "", false}) {
		t.Fatalf("warmed %+v", f.warms)
	}
}

// A stale slot nobody can place is an old-mod Claude that no claim will take.
func TestSweepDropsAStaleSlotItCannotPlace(t *testing.T) {
	f := stubSlots(t)
	name := prewarmSlotName("/gone", "", "")
	f.slots["a"] = []slotState{{name: name, modID: "old"}}

	sweepStaleSlots([]string{"a"})

	if len(f.warms) != 0 || len(f.killed) != 1 || f.killed[0] != name {
		t.Fatalf("warmed %+v, killed %v", f.warms, f.killed)
	}
}

// No mod id file is a box without the package, where nothing is ever stale.
func TestSweepDoesNothingWithoutAnInstalledMod(t *testing.T) {
	f := stubSlots(t)
	f.modID = ""
	f.slots["a"] = []slotState{{name: prewarmSlotName("/a", "", ""), modID: "old", dir: "/a"}}

	if left := sweepStaleSlots([]string{"a"}); left || len(f.warms)+len(f.killed) != 0 {
		t.Fatalf("swept with no mod installed: %+v %v", f.warms, f.killed)
	}
}

func TestAClaimPassesTheFlagsAndSaysWhatItFound(t *testing.T) {
	me, _ := actAsFixture(t)
	home := homeOfUser(me)
	calls, _ := stubClaim(t, false)
	prev := runClaim
	runClaim = func(osUser string, args []string) ([]byte, error) {
		_, _ = prev(osUser, args)
		return []byte("stale\n"), nil
	}

	rec, got := postClaim(t, "/sessions/claim",
		fmt.Sprintf(`{"name":"bw8k5gt9v314","dir":%q,"cmd":"claude","model":"claude-sonnet-5","effort":"high"}`, home), "adminauth")

	if rec.Code != http.StatusOK || got["claimed"] != false || got["found"] != "stale" {
		t.Fatalf("status %d body %v", rec.Code, got)
	}
	want := []string{"bw8k5gt9v314", home, "claude", "claude-sonnet-5", "high", "claim"}
	if len(*calls) != 1 || fmt.Sprint((*calls)[0].args) != fmt.Sprint(want) {
		t.Fatalf("ran %+v, want %v", *calls, want)
	}
}

// The two token classes gate what reaches `$SHELL -lic`, and the script gates
// them again; a value one side accepts and the other does not would be a slot
// warmed under a name no claim derives.
func TestSlotFlagPatternsMatchTheScript(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "devvm", "tmux-user-attach"))
	if err != nil {
		t.Skipf("tmux-user-attach not readable: %v", err)
	}
	for _, want := range []string{
		"MODEL_RE='" + slotModelRe.String() + "'",
		"EFFORT_RE='" + slotEffortRe.String() + "'",
	} {
		if !strings.Contains(string(b), want) {
			t.Errorf("tmux-user-attach does not contain %q", want)
		}
	}
}
