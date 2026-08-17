package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// attachFull posts to the internal endpoint like attachAs, but returns the
// WHOLE answer — the create flag is what tmux-attach.sh needs in order to make
// a session on the target's behalf rather than only attaching an existing one.
func attachFull(t *testing.T, owner, name, guest, requested string) (int, string, bool) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{
		"owner": owner, "name": name, "guest": guest,
		"tty": "/dev/pts/7", "requested": requested,
	})
	req := projectsReq(http.MethodPost, "/internal/attach", string(body), "")
	req.Header.Set("X-Internal-Token", "secret-tok")
	rec := httptest.NewRecorder()
	handleInternalAttach(rec, req)
	var resp struct {
		Mode   string `json:"mode"`
		Create bool   `json:"create"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	return rec.Code, resp.Mode, resp.Create
}

// attachFixture wires the admin list, user map and internal token for the
// internal-attach tests. Identity-mapped (me=me), matching watch_test.go — this
// endpoint is reached by tmux-attach.sh with OS users already resolved, so the
// header→map path is not what these tests are about.
func attachFixture(t *testing.T) (string, string) {
	t.Helper()
	swapShareStore(t)
	admin, other := twoLocalUsers(t)
	withUserMap(t, admin+"="+admin+"\n"+other+"="+other+"\n")
	withAdmins(t, admin+"\n")
	withInternalToken(t, "secret-tok")
	return admin, other
}

// The share store is empty and always will be for this path: being an admin is
// the authorization, so no grant has to exist and none is created.
func TestAdminAttachesAForeignSessionWithoutAShare(t *testing.T) {
	admin, other := attachFixture(t)
	stubGrid(t, other+"/work")

	code, mode, create := attachFull(t, other, "work", admin, "")
	if code != http.StatusOK {
		t.Fatalf("admin attach: status %d, want 200", code)
	}
	if mode != shareModeRW {
		t.Fatalf("admin attach: mode %q, want rw", mode)
	}
	if create {
		t.Fatal("create=true for a session that already exists")
	}

	// And no share row was invented along the way.
	ss, err := shareStoreInstance.load()
	if err != nil {
		t.Fatalf("share load: %v", err)
	}
	if len(ss.Shares) != 0 {
		t.Fatalf("admin attach created %d share rows, want 0", len(ss.Shares))
	}
}

// An act-as attach NEVER spawns a session in the target's account. It used to:
// `create` was returned whenever the caller held the owner's own access and the
// session was missing, which is reachable only from this branch. On 2026-08-17
// that turned a remembered session name into a live session inside emo's
// account (`Council-tax`, 08:02:24) — wizard's work, running as them, appearing
// in their sidebar as their own. There is nothing to watch on a session that is
// not running, and starting one is not watching, so the answer carries no
// instruction to spawn and the attach simply fails.
//
// The assertion reads an ABSENT field as false deliberately: absent and false
// mean the same thing to tmux-attach.sh, so this holds whether the field is
// dropped from the wire or explicitly false.
func TestAdminNeverSpawnsASessionInAnotherAccount(t *testing.T) {
	admin, other := attachFixture(t)
	stubGrid(t) // nothing live

	code, _, create := attachFull(t, other, "brandnew", admin, "")
	if code != http.StatusOK {
		t.Fatalf("admin attach to absent session: status %d, want 200", code)
	}
	if create {
		t.Fatal("create=true: an act-as attach must never start a session in another account")
	}
}

// The "nothing to watch" fallback is SELF-ONLY, for the same reason it already
// excludes a guest holding a share: it exists so your own not-yet-started
// session comes into being when you open it, and an admin acting as someone
// else has no session of their own here to start. Without this, asking to watch
// an absent session in a lens came back rw — a read-write client in their
// account, arrived at by asking for less access.
func TestAdminWatchOfAnAbsentSessionStaysReadOnly(t *testing.T) {
	admin, other := attachFixture(t)
	pinned := stubGrid(t) // nothing live

	code, mode, create := attachFull(t, other, "brandnew", admin, shareModeRO)
	if code != http.StatusOK {
		t.Fatalf("admin watch of absent session: status %d, want 200", code)
	}
	if mode != shareModeRO {
		t.Fatalf("mode %q, want ro — asking to watch cannot come back read-write", mode)
	}
	if create {
		t.Fatal("create=true on a watch request")
	}
	if len(*pinned) != 0 {
		t.Fatalf("pinned a session that does not exist: %v", *pinned)
	}
}

// The pre-existing SELF ONLY rule, unchanged: a guest holding a read-only
// share on a session that is not running must NOT be handed rw+create. That
// would promote them whenever the owner's session happened to be missing.
func TestGuestWithAShareNeverGetsCreate(t *testing.T) {
	admin, other := attachFixture(t)
	stubGrid(t) // nothing live

	// other shares an absent session with admin, read-only.
	seedShare(t, other, "ghost", admin, shareModeRO)

	// Take the admin out of the admin list so the share is the only authority.
	withAdmins(t, "")

	code, mode, create := attachFull(t, other, "ghost", admin, "")
	if code != http.StatusOK {
		t.Fatalf("shared attach: status %d", code)
	}
	if mode != shareModeRO {
		t.Fatalf("mode %q, want ro — a share's ceiling is not raised by absence", mode)
	}
	if create {
		t.Fatal("create=true for a mere guest; that is an escalation")
	}
}

// A non-admin with no share is refused exactly as before — the admin branch
// must not have opened a hole for everyone else.
func TestNonAdminForeignAttachStillNeedsAShare(t *testing.T) {
	admin, other := attachFixture(t)
	stubGrid(t, admin+"/private")

	code, _, _ := attachFull(t, admin, "private", other, "")
	if code != http.StatusForbidden {
		t.Fatalf("unshared foreign attach by a non-admin: status %d, want 403", code)
	}
}

// An admin may still deliberately watch: the downgrade-only rule applies to
// them like anyone else, and a read-only attach pins the grid.
func TestAdminMayStillAskToWatch(t *testing.T) {
	admin, other := attachFixture(t)
	pinned := stubGrid(t, other+"/work")

	code, mode, create := attachFull(t, other, "work", admin, shareModeRO)
	if code != http.StatusOK {
		t.Fatalf("admin watch: status %d", code)
	}
	if mode != shareModeRO {
		t.Fatalf("admin asked to watch, got %q", mode)
	}
	if create {
		t.Fatal("create=true on a watch request")
	}
	if len(*pinned) != 1 || (*pinned)[0] != other+"/work" {
		t.Fatalf("read-only admin attach pinned %v, want [%s/work]", *pinned, other)
	}
}

// Self-attach is unchanged by any of this.
func TestSelfAttachStillNeedsNoAdminRights(t *testing.T) {
	_, other := attachFixture(t)
	stubGrid(t, other+"/mine")

	code, mode, create := attachFull(t, other, "mine", other, "")
	if code != http.StatusOK {
		t.Fatalf("self attach: status %d", code)
	}
	if mode != shareModeRW {
		t.Fatalf("self attach mode %q, want rw", mode)
	}
	if create {
		t.Fatal("create=true for an existing self attach")
	}
}

// An admin may only act as a MAPPED user here too, not any Unix account.
func TestAdminAttachToAnUnmappedOwnerIsRefused(t *testing.T) {
	admin, _ := attachFixture(t)
	stubGrid(t, "daemon/work")

	code, _, _ := attachFull(t, "daemon", "work", admin, "")
	if code != http.StatusForbidden {
		t.Fatalf("admin attach to unmapped owner: status %d, want 403", code)
	}
}
