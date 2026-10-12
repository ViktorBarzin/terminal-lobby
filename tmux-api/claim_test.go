package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// POST /sessions/claim: the New-session composer's Send claims a warm slot for
// the session it is creating, before its terminal attaches
// (docs/plans/2026-10-03-first-prompt-latency-design.md).

type claimCall struct {
	user string
	args []string
}

type resizeCall struct {
	user, name string
	cols, rows int
}

// stubClaim swaps the script runner and the resize for recorders. claimed is
// what the script reports.
func stubClaim(t *testing.T, claimed bool) (*[]claimCall, *[]resizeCall) {
	t.Helper()
	var calls []claimCall
	var resizes []resizeCall
	prevRun, prevResize := runClaim, resizeClaimed
	runClaim = func(osUser string, args []string) ([]byte, error) {
		calls = append(calls, claimCall{osUser, args})
		if claimed {
			return []byte("claimed\n"), nil
		}
		return nil, nil
	}
	resizeClaimed = func(osUser, name string, cols, rows int) error {
		resizes = append(resizes, resizeCall{osUser, name, cols, rows})
		return nil
	}
	t.Cleanup(func() { runClaim, resizeClaimed = prevRun, prevResize })
	return &calls, &resizes
}

func postClaim(t *testing.T, path, body, auth string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	handleClaim(rec, projectsReq(http.MethodPost, path, body, auth))
	var got map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	return rec, got
}

func TestAClaimRunsTheScriptInClaimModeAndSizesTheSession(t *testing.T) {
	me, _ := actAsFixture(t)
	home := homeOfUser(me)
	calls, resizes := stubClaim(t, true)

	rec, got := postClaim(t, "/sessions/claim",
		fmt.Sprintf(`{"name":"bw8k5gt9v314","dir":%q,"cmd":"claude","cols":45,"rows":30}`, home), "adminauth")

	if rec.Code != http.StatusOK || got["claimed"] != true {
		t.Fatalf("status %d body %v", rec.Code, got)
	}
	want := []string{"bw8k5gt9v314", home, "claude", "", "", "claim"}
	if len(*calls) != 1 || fmt.Sprint((*calls)[0].args) != fmt.Sprint(want) || (*calls)[0].user != me {
		t.Fatalf("ran %+v, want %v as %s", *calls, want, me)
	}
	// The status line takes a row of the browser's terminal.
	if len(*resizes) != 1 || (*resizes)[0] != (resizeCall{me, "bw8k5gt9v314", 45, 29}) {
		t.Fatalf("resized %+v", *resizes)
	}
}

func TestAnUnclaimedSlotIsNotResized(t *testing.T) {
	me, _ := actAsFixture(t)
	_, resizes := stubClaim(t, false)
	rec, got := postClaim(t, "/sessions/claim",
		fmt.Sprintf(`{"name":"bw8k5gt9v314","dir":%q,"cmd":"claude","cols":45,"rows":30}`, homeOfUser(me)), "adminauth")
	if rec.Code != http.StatusOK || got["claimed"] != false || len(*resizes) != 0 {
		t.Fatalf("status %d body %v resizes %v", rec.Code, got, *resizes)
	}
}

// Ungrouped has no project dir, and its session starts in the user's home.
func TestAClaimWithNoDirClaimsTheHomeSlot(t *testing.T) {
	me, _ := actAsFixture(t)
	calls, _ := stubClaim(t, true)
	postClaim(t, "/sessions/claim", `{"name":"bw8k5gt9v314","cmd":"claude"}`, "adminauth")
	if len(*calls) != 1 || (*calls)[0].args[1] != homeOfUser(me) {
		t.Fatalf("ran %+v", *calls)
	}
}

// What the attach path refuses, the claim refuses too: an administrator acting
// as someone attaches to their sessions and never creates one
// (tmux-attach.sh's foreign branch, the 2026-08-17 incident).
func TestAClaimUnderActAsDoesNothing(t *testing.T) {
	_, other := actAsFixture(t)
	calls, _ := stubClaim(t, true)
	rec, got := postClaim(t, "/sessions/claim?as="+other,
		`{"name":"bw8k5gt9v314","cmd":"claude"}`, "adminauth")
	if len(*calls) != 0 {
		t.Fatalf("claimed as %s: %+v", other, *calls)
	}
	if rec.Code != http.StatusOK || got["claimed"] != false {
		t.Fatalf("status %d body %v", rec.Code, got)
	}
}

func TestAClaimRefusesWhatItCannotClaim(t *testing.T) {
	actAsFixture(t)
	calls, _ := stubClaim(t, true)
	for _, body := range []string{
		`{"name":"fix-the-deploy","cmd":"claude"}`,             // not a minted id
		`{"name":"bw8k5gt9v314","cmd":"claude","dir":"/etc"}`,  // not one of the user's dirs
		`{"name":"bw8k5gt9v314","cmd":"claude","dir":"rel"}`,   // not absolute
		`{"name":"bw8k5gt9v314","cmd":"shell"}`,                // only claude is pooled
		`{"name":"bw8k5gt9v314","cmd":"claude","model":"x y"}`, // not a model the script takes
	} {
		rec, got := postClaim(t, "/sessions/claim", body, "adminauth")
		if rec.Code != http.StatusOK || got["claimed"] != false {
			t.Errorf("%s: status %d body %v", body, rec.Code, got)
		}
	}
	if len(*calls) != 0 {
		t.Fatalf("ran the script for a refused claim: %+v", *calls)
	}
}

func TestAClaimNeedsPOST(t *testing.T) {
	actAsFixture(t)
	stubClaim(t, true)
	rec := httptest.NewRecorder()
	handleClaim(rec, projectsReq(http.MethodGet, "/sessions/claim", "", "adminauth"))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status %d", rec.Code)
	}
}

// A size outside what a terminal can be is ignored, and the claim stands.
func TestAClaimIgnoresANonsenseSize(t *testing.T) {
	me, _ := actAsFixture(t)
	_, resizes := stubClaim(t, true)
	postClaim(t, "/sessions/claim",
		fmt.Sprintf(`{"name":"bw8k5gt9v314","dir":%q,"cmd":"claude","cols":0,"rows":99999}`, homeOfUser(me)), "adminauth")
	if len(*resizes) != 0 {
		t.Fatalf("resized to %+v", *resizes)
	}
}

// A claim that names a project places the new session in it on the server,
// under the layout store's lock. A client with no terminal of its own (the T3
// view's sidecar) creates sessions this way, and a read-modify-write of the
// whole layout from there would race the SPA's own PUT /layout.
func TestAClaimPlacesTheSessionInTheProjectItNames(t *testing.T) {
	me, _ := actAsFixture(t)
	withTempLayoutStore(t)
	stubClaim(t, true)
	if err := layoutStoreInstance.save(me, Layout{Version: 1, Projects: []Project{
		{Name: "lobby", Sessions: []string{"older"}},
		{Name: "other", Sessions: []string{}},
	}, Ungrouped: []string{}}); err != nil {
		t.Fatal(err)
	}
	rec, got := postClaim(t, "/sessions/claim", `{"name":"bw8k5gt9v314","cmd":"claude","project":"lobby"}`, "adminauth")
	if rec.Code != http.StatusOK || got["claimed"] != true || got["placed"] != true {
		t.Fatalf("status %d body %v", rec.Code, got)
	}
	l, _ := layoutStoreInstance.load(me)
	if fmt.Sprint(l.Projects[0].Sessions) != "[older bw8k5gt9v314]" || len(l.Projects[1].Sessions) != 0 {
		t.Fatalf("layout %+v", l.Projects)
	}
	// A second claim of the same name does not place it twice.
	postClaim(t, "/sessions/claim", `{"name":"bw8k5gt9v314","cmd":"claude","project":"other"}`, "adminauth")
	l, _ = layoutStoreInstance.load(me)
	if fmt.Sprint(l.Projects[0].Sessions) != "[older bw8k5gt9v314]" || len(l.Projects[1].Sessions) != 0 {
		t.Fatalf("placed twice: %+v", l.Projects)
	}
}

func TestAClaimPlacesNothingItDidNotClaimOrCannotFind(t *testing.T) {
	me, _ := actAsFixture(t)
	withTempLayoutStore(t)
	if err := layoutStoreInstance.save(me, Layout{Version: 1, Projects: []Project{{Name: "lobby", Sessions: []string{}}}, Ungrouped: []string{}}); err != nil {
		t.Fatal(err)
	}
	stubClaim(t, false)
	_, got := postClaim(t, "/sessions/claim", `{"name":"bw8k5gt9v314","cmd":"claude","project":"lobby"}`, "adminauth")
	if got["placed"] == true {
		t.Fatalf("placed an unclaimed session: %v", got)
	}
	stubClaim(t, true)
	_, got = postClaim(t, "/sessions/claim", `{"name":"cw8k5gt9v314","cmd":"claude","project":"no such"}`, "adminauth")
	if got["claimed"] != true || got["placed"] == true {
		t.Fatalf("body %v", got)
	}
	l, _ := layoutStoreInstance.load(me)
	if len(l.Projects[0].Sessions) != 0 || len(l.Ungrouped) != 0 {
		t.Fatalf("layout changed: %+v", l)
	}
}
