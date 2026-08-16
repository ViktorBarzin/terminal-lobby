package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// stubGrid replaces the two tmux-touching seams so these tests stay pure units.
// It records what got pinned, which is the only side effect worth asserting.
func stubGrid(t *testing.T, live ...string) *[]string {
	t.Helper()
	oldExists, oldPin := sessionExists, pinGrid
	set := map[string]bool{}
	for _, s := range live {
		set[s] = true
	}
	pinned := []string{}
	sessionExists = func(osUser, name string) bool { return set[osUser+"/"+name] }
	pinGrid = func(osUser, name string) error {
		pinned = append(pinned, osUser+"/"+name)
		return nil
	}
	t.Cleanup(func() { sessionExists, pinGrid = oldExists, oldPin })
	return &pinned
}

// attachAs posts to the internal endpoint the way tmux-attach.sh does.
func attachAs(t *testing.T, owner, name, guest, requested string) (int, string) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{
		"owner": owner, "name": name, "guest": guest,
		"tty": "/dev/pts/7", "requested": requested,
	})
	req := projectsReq(http.MethodPost, "/internal/attach", string(body), "")
	req.Header.Set("X-Internal-Token", "secret-tok")
	rec := httptest.NewRecorder()
	handleInternalAttach(rec, req)
	var resp struct{ Mode string }
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	return rec.Code, resp.Mode
}

func seedShare(t *testing.T, owner, name, guest, mode string) {
	t.Helper()
	rec := httptest.NewRecorder()
	handleShares(rec, projectsReq(http.MethodPost, "/shares",
		`{"name":"`+name+`","guest":"`+guest+`","mode":"`+mode+`"}`, owner))
	if rec.Code != http.StatusCreated {
		t.Fatalf("seed share %s/%s -> %s: %d", owner, name, guest, rec.Code)
	}
}

// The rule the whole design rests on: a client may ask for LESS access than the
// server grants, never more. Asking to watch is always honoured; asking to
// drive is honoured only if the server already said so.
func TestWatchRequestCanOnlyDowngrade(t *testing.T) {
	swapShareStore(t)
	me, other := twoLocalUsers(t)
	withUserMap(t, me+"="+me+"\n"+other+"="+other+"\n")
	withInternalToken(t, "secret-tok")
	stubGrid(t, me+"/main")

	for _, tc := range []struct {
		name, granted, requested, want string
	}{
		{"rw share, asks to watch", "rw", "ro", "ro"},
		{"rw share, asks nothing", "rw", "", "rw"},
		{"rw share, asks to drive", "rw", "rw", "rw"},
		{"ro share, asks to drive", "ro", "rw", "ro"},
		{"ro share, asks nothing", "ro", "", "ro"},
		{"ro share, asks to watch", "ro", "ro", "ro"},
		{"rw share, junk request", "rw", "sideways", "rw"},
		{"ro share, junk request", "ro", "sideways", "ro"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			swapShareStore(t)
			seedShare(t, me, "main", other, tc.granted)
			code, mode := attachAs(t, me, "main", other, tc.requested)
			if code != http.StatusOK {
				t.Fatalf("got %d, want 200", code)
			}
			if mode != tc.want {
				t.Errorf("granted=%s requested=%q: mode = %q, want %q",
					tc.granted, tc.requested, mode, tc.want)
			}
		})
	}
}

// Watch mode has to work on your OWN session too — that is the two-device case,
// and there is no share row to authorize it. Owning the session IS the
// authorization; a self attach is never denied.
func TestSelfAttachNeedsNoShare(t *testing.T) {
	swapShareStore(t)
	me, _ := twoLocalUsers(t)
	withUserMap(t, me+"="+me+"\n")
	withInternalToken(t, "secret-tok")
	stubGrid(t, me+"/main")

	if code, mode := attachAs(t, me, "main", me, "ro"); code != http.StatusOK || mode != "ro" {
		t.Errorf("self watch: got %d/%q, want 200/ro", code, mode)
	}
	if code, mode := attachAs(t, me, "main", me, ""); code != http.StatusOK || mode != "rw" {
		t.Errorf("self drive: got %d/%q, want 200/rw", code, mode)
	}
	if ss, _ := shareStoreInstance.load(); len(ss.Shares) != 0 {
		t.Errorf("a self attach invented a share row: %+v", ss.Shares)
	}
}

// A session nobody has started yet cannot be watched — there is no grid to
// consume and no pty to read. Falling back to rw lets the normal create path
// bring it into being rather than failing the attach outright.
func TestWatchingASessionThatDoesNotExistFallsBackToDriving(t *testing.T) {
	swapShareStore(t)
	me, _ := twoLocalUsers(t)
	withUserMap(t, me+"="+me+"\n")
	withInternalToken(t, "secret-tok")
	pinned := stubGrid(t) // no live sessions

	code, mode := attachAs(t, me, "main", me, "ro")
	if code != http.StatusOK || mode != "rw" {
		t.Errorf("watch a non-existent session: got %d/%q, want 200/rw", code, mode)
	}
	if len(*pinned) != 0 {
		t.Errorf("pinned a session that does not exist: %v", *pinned)
	}
}

// The "nothing to watch" fallback is SELF-ONLY. Applying it to a shared attach
// would hand a guest rw whenever the owner's session happened to be missing —
// an escalation past what their share grants, and a racy one, since the session
// can appear between the check and the attach.
func TestAMissingSessionNeverUpgradesAGuest(t *testing.T) {
	swapShareStore(t)
	me, other := twoLocalUsers(t)
	withUserMap(t, me+"="+me+"\n"+other+"="+other+"\n")
	withInternalToken(t, "secret-tok")
	pinned := stubGrid(t) // the owner's session does not exist

	seedShare(t, me, "main", other, "ro")
	code, mode := attachAs(t, me, "main", other, "")
	if code != http.StatusOK {
		t.Fatalf("got %d, want 200", code)
	}
	if mode != "ro" {
		t.Errorf("guest with an ro share on a missing session: mode = %q, want ro", mode)
	}
	if len(*pinned) != 0 {
		t.Errorf("pinned a session that does not exist: %v", *pinned)
	}
}

// Pinning is what makes the invariant hold once the read-write client leaves,
// so it must happen on the way in to EVERY read-only attach — and never on a
// read-write one, which would freeze a grid nobody asked to freeze.
func TestPinningHappensExactlyOnReadOnlyAttaches(t *testing.T) {
	me, other := twoLocalUsers(t)
	withUserMap(t, me+"="+me+"\n"+other+"="+other+"\n")
	withInternalToken(t, "secret-tok")

	t.Run("foreign read-only attach pins", func(t *testing.T) {
		swapShareStore(t)
		pinned := stubGrid(t, me+"/main")
		seedShare(t, me, "main", other, "ro")
		attachAs(t, me, "main", other, "")
		if len(*pinned) != 1 || (*pinned)[0] != me+"/main" {
			t.Errorf("pinned = %v, want [%s/main]", *pinned, me)
		}
	})

	t.Run("foreign read-write attach does not pin", func(t *testing.T) {
		swapShareStore(t)
		pinned := stubGrid(t, me+"/main")
		seedShare(t, me, "main", other, "rw")
		attachAs(t, me, "main", other, "")
		if len(*pinned) != 0 {
			t.Errorf("pinned on a read-write attach: %v", *pinned)
		}
	})

	t.Run("self watch pins the owner's session", func(t *testing.T) {
		swapShareStore(t)
		pinned := stubGrid(t, me+"/main")
		attachAs(t, me, "main", me, "ro")
		if len(*pinned) != 1 || (*pinned)[0] != me+"/main" {
			t.Errorf("pinned = %v, want [%s/main]", *pinned, me)
		}
	})
}

// owner and name reach tmux commands, so a self attach — which skips the share
// table, and with it the validation that matching a stored row implied — has to
// check them itself.
func TestSelfAttachValidatesItsIdentifiers(t *testing.T) {
	swapShareStore(t)
	me, _ := twoLocalUsers(t)
	withUserMap(t, me+"="+me+"\n")
	withInternalToken(t, "secret-tok")
	stubGrid(t)

	for _, tc := range []struct{ owner, name string }{
		{me, "bad name!"},
		{me, "main;id"},
		{me, ""},
		{"bad user!", "bad user!"},
		{"root;id", "root;id"},
	} {
		if code, _ := attachAs(t, tc.owner, tc.name, tc.owner, "ro"); code != http.StatusBadRequest {
			t.Errorf("attach owner=%q name=%q: got %d, want 400", tc.owner, tc.name, code)
		}
	}
}

// A guest still cannot reach a session nobody shared with them, whatever they
// ask for. Watch mode must not have opened a side door.
func TestUnsharedAttachIsStillDenied(t *testing.T) {
	swapShareStore(t)
	me, other := twoLocalUsers(t)
	withUserMap(t, me+"="+me+"\n"+other+"="+other+"\n")
	withInternalToken(t, "secret-tok")
	stubGrid(t, me+"/secret")

	for _, requested := range []string{"", "ro", "rw"} {
		if code, _ := attachAs(t, me, "secret", other, requested); code != http.StatusForbidden {
			t.Errorf("unshared attach requesting %q: got %d, want 403", requested, code)
		}
	}
}
