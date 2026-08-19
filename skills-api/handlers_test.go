package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"terminal-lobby/authuser"
	"terminal-lobby/skillscan"
)

// The tests run the REAL handler → op → skillscan path. Two seams make that
// possible without sudo and without touching a real home: homeBase points at a
// temp directory, and selfUser is cleared, which makes run() perform every op
// inline rather than re-execing (privop.go). So a "peer" here is another
// directory under the same temp root, which is exactly the shape production
// reaches through sudo.

func withHomeBase(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	oldBase, oldSelf := homeBase, selfUser
	homeBase, selfUser = dir, ""
	t.Cleanup(func() { homeBase, selfUser = oldBase, oldSelf })
	return dir
}

func withUserMap(t *testing.T, content string) {
	t.Helper()
	f := filepath.Join(t.TempDir(), "ttyd-user-map")
	if err := os.WriteFile(f, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	old := mapPath
	mapPath = f
	t.Cleanup(func() { mapPath = old })
}

func withAdmins(t *testing.T, content string) {
	t.Helper()
	f := filepath.Join(t.TempDir(), "ttyd-admins")
	if err := os.WriteFile(f, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	old := actAsGate
	actAsGate = &authuser.Gate{AdminsPath: f}
	t.Cleanup(func() { actAsGate = old })
}

// twoLocalUsers returns two distinct accounts that exist on this host, so
// resolveOSUser's user.Lookup gate passes without depending on deploy state.
// Mirrors the tmux-api and file-api helpers of the same name.
func twoLocalUsers(t *testing.T) (string, string) {
	t.Helper()
	me, err := user.Current()
	if err != nil {
		t.Fatalf("user.Current: %v", err)
	}
	other := "root"
	if me.Username == "root" {
		other = "nobody"
	}
	if _, err := user.Lookup(other); err != nil {
		t.Skipf("no second local account to test with: %v", err)
	}
	return me.Username, other
}

func withClock(t *testing.T, at time.Time) {
	t.Helper()
	old := now
	now = func() time.Time { return at }
	t.Cleanup(func() { now = old })
}

// writeSkill plants a skill in one user's home under the temp home base.
func writeSkill(t *testing.T, base, osUser, name string, files map[string]string) {
	t.Helper()
	root := skillscan.Root(filepath.Join(base, osUser))
	for rel, body := range files {
		mode := os.FileMode(0o644)
		if strings.HasPrefix(rel, "x:") {
			rel, mode = strings.TrimPrefix(rel, "x:"), 0o755
		}
		p := filepath.Join(root, name, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), mode); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(p, mode); err != nil {
			t.Fatal(err)
		}
	}
}

func get(t *testing.T, path, authUser string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, path, nil)
	if authUser != "" {
		r.Header.Set(authHeader, authUser)
	}
	return serve(t, r)
}

func post(t *testing.T, path, authUser, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	if authUser != "" {
		r.Header.Set(authHeader, authUser)
	}
	return serve(t, r)
}

// serve routes through the same mux main() builds, so a test cannot pass by
// calling a handler the service does not expose at that path.
func serve(t *testing.T, r *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /skills", handleInventory)
	mux.HandleFunc("GET /skills/view", handleView)
	mux.HandleFunc("GET /skills/diff", handleDiff)
	mux.HandleFunc("POST /skills/install", handleInstall)
	mux.HandleFunc("POST /skills/toggle", handleToggle)
	mux.HandleFunc("POST /skills/remove", handleRemove)
	mux.HandleFunc("POST /skills/plugin-update", handlePluginUpdate)
	mux.HandleFunc("POST /skills/restart", handleRestart)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	return w
}

func decodeInto(t *testing.T, w *httptest.ResponseRecorder, into any) {
	t.Helper()
	if err := json.Unmarshal(w.Body.Bytes(), into); err != nil {
		t.Fatalf("response is not JSON (%d): %v\n%s", w.Code, err, w.Body.String())
	}
}

// --- auth --------------------------------------------------------------------

func TestEveryEndpointRequiresAMappedIdentity(t *testing.T) {
	base := withHomeBase(t)
	me, _ := twoLocalUsers(t)
	withUserMap(t, "wiz="+me+"\n")
	writeSkill(t, base, me, "grilling", map[string]string{"SKILL.md": "x\n"})

	reads := []string{"/skills", "/skills/view?name=grilling", "/skills/diff?name=grilling"}
	writes := map[string]string{
		"/skills/install":       `{"owner":"other","name":"x"}`,
		"/skills/toggle":        `{"id":"x@skills-dir","enabled":false}`,
		"/skills/remove":        `{"name":"x"}`,
		"/skills/plugin-update": `{"plugin":"x@official"}`,
		"/skills/restart":       `{"session":"x"}`,
	}
	for _, p := range reads {
		if w := get(t, p, ""); w.Code != http.StatusUnauthorized {
			t.Errorf("GET %s without a header: %d, want 401", p, w.Code)
		}
		if w := get(t, p, "stranger"); w.Code != http.StatusForbidden {
			t.Errorf("GET %s as an unmapped identity: %d, want 403", p, w.Code)
		}
	}
	for p, body := range writes {
		if w := post(t, p, "", body); w.Code != http.StatusUnauthorized {
			t.Errorf("POST %s without a header: %d, want 401", p, w.Code)
		}
		if w := post(t, p, "stranger", body); w.Code != http.StatusForbidden {
			t.Errorf("POST %s as an unmapped identity: %d, want 403", p, w.Code)
		}
	}
}

func TestActAsIsRefusedForANonAdmin(t *testing.T) {
	base := withHomeBase(t)
	me, other := twoLocalUsers(t)
	withUserMap(t, fmt.Sprintf("wiz=%s\nother=%s\n", me, other))
	withAdmins(t, other+"\n") // the caller is NOT the admin
	writeSkill(t, base, other, "secret", map[string]string{"SKILL.md": "theirs\n"})

	if w := get(t, "/skills?as="+other, "wiz"); w.Code != http.StatusForbidden {
		t.Fatalf("act-as by a non-admin: %d, want 403", w.Code)
	}
}

func TestActAsIsHonouredForAnAdmin(t *testing.T) {
	base := withHomeBase(t)
	me, other := twoLocalUsers(t)
	withUserMap(t, fmt.Sprintf("wiz=%s\nother=%s\n", me, other))
	withAdmins(t, me+"\n")
	writeSkill(t, base, other, "theirs-only", map[string]string{"SKILL.md": "t\n"})

	w := get(t, "/skills?as="+other, "wiz")
	if w.Code != http.StatusOK {
		t.Fatalf("act-as by an admin: %d\n%s", w.Code, w.Body.String())
	}
	var inv inventory
	decodeInto(t, w, &inv)
	if inv.User != other {
		t.Errorf("inventory is for %q, want the acted-as user %q", inv.User, other)
	}
	if len(inv.Skills) != 1 || inv.Skills[0].Name != "theirs-only" {
		t.Errorf("acted-as inventory = %+v", inv.Skills)
	}
}

// --- GET /skills -------------------------------------------------------------

func TestInventoryReportsMineThePeersAndTheVerdicts(t *testing.T) {
	base := withHomeBase(t)
	me, other := twoLocalUsers(t)
	withUserMap(t, fmt.Sprintf("wiz=%s\nother=%s\n", me, other))

	writeSkill(t, base, me, "grilling", map[string]string{"SKILL.md": "---\nname: grilling\ndescription: Grill.\n---\n"})
	writeSkill(t, base, me, "tdd", map[string]string{"SKILL.md": "mine\n"})
	writeSkill(t, base, me, "file-issue", map[string]string{"SKILL.md": "shared\n"})
	writeSkill(t, base, other, "tdd", map[string]string{"SKILL.md": "theirs\n"})
	writeSkill(t, base, other, "file-issue", map[string]string{"SKILL.md": "shared\n"})
	writeSkill(t, base, other, "diagnose", map[string]string{"SKILL.md": "new\n"})

	w := get(t, "/skills", "wiz")
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	if got := w.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}
	var inv inventory
	decodeInto(t, w, &inv)

	if inv.User != me || len(inv.Skills) != 3 {
		t.Fatalf("mine = %+v", inv)
	}
	if len(inv.Peers) != 1 || inv.Peers[0].User != other {
		t.Fatalf("peers = %+v", inv.Peers)
	}
	verdicts := map[string]string{}
	for _, s := range inv.Peers[0].Skills {
		verdicts[s.Name] = s.Verdict
	}
	for name, want := range map[string]string{"tdd": "differs", "file-issue": "same", "diagnose": "absent"} {
		if verdicts[name] != want {
			t.Errorf("verdict[%s] = %q, want %q", name, verdicts[name], want)
		}
	}
}

func TestInventoryFlagsAnUpdateOnlyWhenTheOwnerMovedOn(t *testing.T) {
	base := withHomeBase(t)
	me, other := twoLocalUsers(t)
	withUserMap(t, fmt.Sprintf("wiz=%s\nother=%s\n", me, other))
	at := time.Date(2026, 8, 19, 9, 12, 0, 0, time.UTC)
	withClock(t, at)

	// Two installed-from-peer skills: one the owner has since edited, one that
	// only the recipient has edited. Only the first has anything to pull.
	writeSkill(t, base, other, "moved-on", map[string]string{"SKILL.md": "v2\n"})
	writeSkill(t, base, other, "edited-here", map[string]string{"SKILL.md": "v1\n"})
	writeSkill(t, base, me, "moved-on", map[string]string{"SKILL.md": "v1\n"})
	writeSkill(t, base, me, "edited-here", map[string]string{"SKILL.md": "my tweak\n"})

	home := filepath.Join(base, me)
	man, _ := skillscan.LoadManifest(home)
	v1, err := skillscan.Hash(filepath.Join(skillscan.Root(home), "moved-on"))
	if err != nil {
		t.Fatal(err)
	}
	man.Record("moved-on", other, v1, at)
	// installed from the peer's v1, which is still what the peer has
	peerV1, err := skillscan.Hash(filepath.Join(skillscan.Root(filepath.Join(base, other)), "edited-here"))
	if err != nil {
		t.Fatal(err)
	}
	man.Record("edited-here", other, peerV1, at)
	if err := man.Save(home); err != nil {
		t.Fatal(err)
	}

	var inv inventory
	decodeInto(t, get(t, "/skills", "wiz"), &inv)
	by := map[string]skillRow{}
	for _, s := range inv.Skills {
		by[s.Name] = s
	}
	if !by["moved-on"].UpdateAvailable {
		t.Error("the owner changed their copy: want updateAvailable")
	}
	if by["edited-here"].UpdateAvailable {
		t.Error("only the local copy changed: there is nothing to pull")
	}
	if !by["edited-here"].LocallyModified {
		t.Error("want the local edit reported as locallyModified")
	}
}

func TestInventorySurvivesAnUnreadablePeer(t *testing.T) {
	base := withHomeBase(t)
	me, other := twoLocalUsers(t)
	withUserMap(t, fmt.Sprintf("wiz=%s\nother=%s\n", me, other))
	writeSkill(t, base, me, "mine", map[string]string{"SKILL.md": "m\n"})

	// The peer's home exists but its skills directory cannot be read.
	root := skillscan.Root(filepath.Join(base, other))
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(root, 0o000); err != nil {
		t.Skipf("cannot make a directory unreadable here: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(root, 0o755) })
	if os.Geteuid() == 0 {
		t.Skip("running as root: an unreadable directory is still readable")
	}

	w := get(t, "/skills", "wiz")
	if w.Code != http.StatusOK {
		t.Fatalf("one unreadable peer must not fail the whole panel: %d", w.Code)
	}
	var inv inventory
	decodeInto(t, w, &inv)
	if len(inv.Skills) != 1 {
		t.Errorf("the caller's own skills should still be listed: %+v", inv.Skills)
	}
	if len(inv.Peers) != 1 || !inv.Peers[0].Unreachable {
		t.Errorf("want the peer marked unreachable: %+v", inv.Peers)
	}
}

// --- view + diff -------------------------------------------------------------

func TestViewReadsAPeersSkillAndCountsExecutables(t *testing.T) {
	base := withHomeBase(t)
	me, other := twoLocalUsers(t)
	withUserMap(t, fmt.Sprintf("wiz=%s\nother=%s\n", me, other))
	writeSkill(t, base, other, "diagnose", map[string]string{
		"SKILL.md":       "---\nname: diagnose\ndescription: Debug it.\n---\nbody\n",
		"x:scripts/a.sh": "echo a\n",
	})

	w := get(t, "/skills/view?owner="+other+"&name=diagnose", "wiz")
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	var got struct {
		Owner   string    `json:"owner"`
		SkillMd string    `json:"skillmd"`
		Files   []fileRow `json:"files"`
		Stat    *statRow  `json:"stat"`
	}
	decodeInto(t, w, &got)
	if got.Owner != other || !strings.Contains(got.SkillMd, "Debug it.") {
		t.Errorf("view = %+v", got)
	}
	if len(got.Files) != 2 || got.Stat.Executable != 1 {
		t.Errorf("files/exec = %+v %+v", got.Files, got.Stat)
	}
}

func TestViewRefusesAnOwnerWhoIsNotATerminalAccount(t *testing.T) {
	withHomeBase(t)
	me, _ := twoLocalUsers(t)
	withUserMap(t, "wiz="+me+"\n")
	for _, owner := range []string{"root", "nobody", "../etc", "daemon"} {
		w := get(t, "/skills/view?owner="+owner+"&name=x", "wiz")
		if w.Code != http.StatusForbidden {
			t.Errorf("owner=%q: %d, want 403", owner, w.Code)
		}
	}
}

func TestViewAndDiffRejectAnInvalidName(t *testing.T) {
	withHomeBase(t)
	me, _ := twoLocalUsers(t)
	withUserMap(t, "wiz="+me+"\n")
	for _, name := range []string{"", "../escape", "a/b", "Caps"} {
		if w := get(t, "/skills/view?name="+name, "wiz"); w.Code != http.StatusBadRequest {
			t.Errorf("view name=%q: %d, want 400", name, w.Code)
		}
		if w := get(t, "/skills/diff?name="+name, "wiz"); w.Code != http.StatusBadRequest {
			t.Errorf("diff name=%q: %d, want 400", name, w.Code)
		}
	}
}

func TestDiffShowsTheChangedLinesAndTheVerdict(t *testing.T) {
	base := withHomeBase(t)
	me, other := twoLocalUsers(t)
	withUserMap(t, fmt.Sprintf("wiz=%s\nother=%s\n", me, other))
	writeSkill(t, base, me, "tdd", map[string]string{"SKILL.md": "alpha\nbeta\n"})
	writeSkill(t, base, other, "tdd", map[string]string{"SKILL.md": "alpha\nBETA\n"})
	writeSkill(t, base, other, "solo", map[string]string{"SKILL.md": "only theirs\n"})

	var got struct {
		Verdict string `json:"verdict"`
		Diff    string `json:"diff"`
	}
	decodeInto(t, get(t, "/skills/diff?owner="+other+"&name=tdd", "wiz"), &got)
	if got.Verdict != "differs" || !strings.Contains(got.Diff, "-beta") || !strings.Contains(got.Diff, "+BETA") {
		t.Errorf("diff = %+v", got)
	}

	got.Diff, got.Verdict = "", ""
	decodeInto(t, get(t, "/skills/diff?owner="+other+"&name=solo", "wiz"), &got)
	if got.Verdict != "absent" || got.Diff != "" {
		t.Errorf("a skill the caller does not have: %+v", got)
	}
}

// --- install -----------------------------------------------------------------

func TestInstallCopiesAPeersSkillAndRecordsWhereItCameFrom(t *testing.T) {
	base := withHomeBase(t)
	me, other := twoLocalUsers(t)
	withUserMap(t, fmt.Sprintf("wiz=%s\nother=%s\n", me, other))
	at := time.Date(2026, 8, 19, 9, 12, 0, 0, time.UTC)
	withClock(t, at)
	writeSkill(t, base, other, "diagnose", map[string]string{
		"SKILL.md":       "---\nname: diagnose\n---\nbody\n",
		"x:scripts/a.sh": "echo a\n",
	})

	w := post(t, "/skills/install", "wiz", fmt.Sprintf(`{"owner":%q,"name":"diagnose"}`, other))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	home := filepath.Join(base, me)
	dst := filepath.Join(skillscan.Root(home), "diagnose")
	if _, err := os.Stat(filepath.Join(dst, "SKILL.md")); err != nil {
		t.Fatalf("the skill did not land: %v", err)
	}
	fi, err := os.Stat(filepath.Join(dst, "scripts", "a.sh"))
	if err != nil || fi.Mode().Perm() != 0o755 {
		t.Errorf("executable bit lost: %v %v", fi, err)
	}
	man, _ := skillscan.LoadManifest(home)
	p := man.Installed["diagnose"]
	if p.From != other || p.InstalledAt != "2026-08-19T09:12:00Z" || p.SourceHash == "" {
		t.Errorf("provenance = %+v", p)
	}
	// And the owner's copy is untouched.
	if _, err := os.Stat(filepath.Join(skillscan.Root(filepath.Join(base, other)), "diagnose", "SKILL.md")); err != nil {
		t.Errorf("the owner's skill should be untouched: %v", err)
	}
}

func TestInstallRefusesACollisionThenReplacesWithABackup(t *testing.T) {
	base := withHomeBase(t)
	me, other := twoLocalUsers(t)
	withUserMap(t, fmt.Sprintf("wiz=%s\nother=%s\n", me, other))
	withClock(t, time.Date(2026, 8, 19, 9, 12, 0, 0, time.UTC))
	writeSkill(t, base, me, "tdd", map[string]string{"SKILL.md": "mine\n"})
	writeSkill(t, base, other, "tdd", map[string]string{"SKILL.md": "theirs\n"})

	w := post(t, "/skills/install", "wiz", fmt.Sprintf(`{"owner":%q,"name":"tdd"}`, other))
	if w.Code != http.StatusConflict {
		t.Fatalf("a taken name must answer 409, got %d: %s", w.Code, w.Body.String())
	}
	mine := filepath.Join(skillscan.Root(filepath.Join(base, me)), "tdd", "SKILL.md")
	if body, _ := os.ReadFile(mine); string(body) != "mine\n" {
		t.Fatalf("the refusal changed my copy: %q", body)
	}

	w = post(t, "/skills/install", "wiz", fmt.Sprintf(`{"owner":%q,"name":"tdd","replace":true}`, other))
	if w.Code != http.StatusOK {
		t.Fatalf("replace: %d %s", w.Code, w.Body.String())
	}
	var got struct{ Backup string }
	decodeInto(t, w, &got)
	if got.Backup == "" {
		t.Fatal("a replace must report where the old copy went")
	}
	if body, _ := os.ReadFile(filepath.Join(got.Backup, "SKILL.md")); string(body) != "mine\n" {
		t.Errorf("backup content = %q", body)
	}
	if body, _ := os.ReadFile(mine); string(body) != "theirs\n" {
		t.Errorf("installed content = %q", body)
	}
}

func TestInstallRejectsNonsense(t *testing.T) {
	base := withHomeBase(t)
	me, other := twoLocalUsers(t)
	withUserMap(t, fmt.Sprintf("wiz=%s\nother=%s\n", me, other))
	writeSkill(t, base, me, "mine", map[string]string{"SKILL.md": "m\n"})

	cases := map[string]struct {
		body string
		want int
	}{
		"own skill": {fmt.Sprintf(`{"owner":%q,"name":"mine"}`, me), http.StatusBadRequest},
		// "notauser" is not in the identity map, so it is not a peer whatever the
		// passwd database says — the service will not read out of its home.
		"unmapped owner": {`{"owner":"notauser","name":"x"}`, http.StatusForbidden},
		"bad name":       {fmt.Sprintf(`{"owner":%q,"name":"../etc"}`, other), http.StatusBadRequest},
		"unknown field":  {fmt.Sprintf(`{"owner":%q,"name":"x","sudo":true}`, other), http.StatusBadRequest},
		"not json":       {`{`, http.StatusBadRequest},
		"missing skill":  {fmt.Sprintf(`{"owner":%q,"name":"nope"}`, other), http.StatusNotFound},
	}
	for name, c := range cases {
		if w := post(t, "/skills/install", "wiz", c.body); w.Code != c.want {
			t.Errorf("%s: %d, want %d (%s)", name, w.Code, c.want, strings.TrimSpace(w.Body.String()))
		}
	}
}

// --- toggle + remove ---------------------------------------------------------

func TestToggleWritesEnabledPluginsAndValidatesTheID(t *testing.T) {
	base := withHomeBase(t)
	me, _ := twoLocalUsers(t)
	withUserMap(t, "wiz="+me+"\n")
	writeSkill(t, base, me, "caveman", map[string]string{"SKILL.md": "c\n"})

	if w := post(t, "/skills/toggle", "wiz", `{"id":"caveman@skills-dir","enabled":false}`); w.Code != http.StatusOK {
		t.Fatalf("toggle: %d %s", w.Code, w.Body.String())
	}
	var inv inventory
	decodeInto(t, get(t, "/skills", "wiz"), &inv)
	if len(inv.Skills) != 1 || inv.Skills[0].Enabled {
		t.Errorf("want caveman disabled: %+v", inv.Skills)
	}
	if w := post(t, "/skills/toggle", "wiz", `{"id":"caveman@skills-dir","enabled":true}`); w.Code != http.StatusOK {
		t.Fatal("re-enabling should work")
	}
	decodeInto(t, get(t, "/skills", "wiz"), &inv)
	if !inv.Skills[0].Enabled {
		t.Error("want caveman enabled again")
	}

	for _, id := range []string{"", "no-at-sign", "a@b@c", "../x@skills-dir", "x@"} {
		body := fmt.Sprintf(`{"id":%q,"enabled":false}`, id)
		if w := post(t, "/skills/toggle", "wiz", body); w.Code != http.StatusBadRequest {
			t.Errorf("id=%q: %d, want 400", id, w.Code)
		}
	}
}

func TestRemoveBacksUpAndForgets(t *testing.T) {
	base := withHomeBase(t)
	me, other := twoLocalUsers(t)
	withUserMap(t, fmt.Sprintf("wiz=%s\nother=%s\n", me, other))
	at := time.Date(2026, 8, 19, 9, 12, 0, 0, time.UTC)
	withClock(t, at)
	writeSkill(t, base, me, "diagnose", map[string]string{"SKILL.md": "d\n"})
	home := filepath.Join(base, me)
	man, _ := skillscan.LoadManifest(home)
	man.Record("diagnose", other, "sha256:x", at)
	if err := man.Save(home); err != nil {
		t.Fatal(err)
	}

	w := post(t, "/skills/remove", "wiz", `{"name":"diagnose"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("remove: %d %s", w.Code, w.Body.String())
	}
	var got struct{ Backup string }
	decodeInto(t, w, &got)
	if body, _ := os.ReadFile(filepath.Join(got.Backup, "SKILL.md")); string(body) != "d\n" {
		t.Errorf("the removed skill must be recoverable, backup held %q", body)
	}
	if _, err := os.Stat(filepath.Join(skillscan.Root(home), "diagnose")); !os.IsNotExist(err) {
		t.Error("the skill should be gone from the skills directory")
	}
	again, _ := skillscan.LoadManifest(home)
	if _, ok := again.Installed["diagnose"]; ok {
		t.Error("provenance should have been forgotten")
	}
	if w := post(t, "/skills/remove", "wiz", `{"name":"diagnose"}`); w.Code != http.StatusNotFound {
		t.Errorf("removing it twice: %d, want 404", w.Code)
	}
}
