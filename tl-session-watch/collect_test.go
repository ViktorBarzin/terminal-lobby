package main

import (
	"reflect"
	"testing"
)

func TestParseUserMap(t *testing.T) {
	in := `# Generated from roster.yaml by roster_engine.py — DO NOT EDIT BY HAND.
# <authentik_user>=<os_user>; consumed by t3-dispatch.
vbarzin=wizard
emil.barzin=emo

vbarzin=wizard
`
	// The right-hand side is the OS user, and a user listed twice is watched
	// once: two Authentik identities can map to one account.
	want := []string{"wizard", "emo"}
	if got := parseUserMap(in); !reflect.DeepEqual(got, want) {
		t.Fatalf("want %v, got %v", want, got)
	}
}

func TestParseUserMapIgnoresMalformedLines(t *testing.T) {
	if got := parseUserMap("nonsense\n=orphan\ntrailing=\n"); len(got) != 0 {
		t.Fatalf("want no users from lines with no usable right-hand side, got %v", got)
	}
}

func TestParseSessionList(t *testing.T) {
	// tmux rejects newlines in session names but not tabs, so the split has to
	// come off the LAST separators rather than the first. Two options now ride
	// each row, so it is the last TWO.
	in := "alerts\trunning\ta:a1 w:w1\nclaude\t\t\nwith\tname\tdone\t\n"
	got := parseSessionList(in)

	if len(got) != 3 {
		t.Fatalf("want 3 sessions, got %d: %+v", len(got), got)
	}
	if got["alerts"].ClaudeState != "running" {
		t.Errorf("alerts: want running, got %q", got["alerts"].ClaudeState)
	}
	if got["alerts"].Background != "a:a1 w:w1" {
		t.Errorf("alerts: want the outstanding-work tokens, got %q", got["alerts"].Background)
	}
	if got["claude"].ClaudeState != "" {
		t.Errorf("an unset stamp must read as empty, got %q", got["claude"].ClaudeState)
	}
	if got["claude"].Background != "" {
		t.Errorf("an unset @claude_bg must read as empty, got %q", got["claude"].Background)
	}
	if s, ok := got["with\tname"]; !ok || s.ClaudeState != "done" {
		t.Errorf("a tab in the name must stay in the name, got %+v", got)
	}
}

// A row from a tmux that predates the second option carries one separator, and
// the watcher's whole job is noticing sessions going away — so a shape it does
// not recognise must still yield the session and its state rather than
// vanishing, which would read as a death.
func TestParseSessionListToleratesARowWithoutTheBackgroundField(t *testing.T) {
	got := parseSessionList("alerts\trunning\n")

	if len(got) != 1 {
		t.Fatalf("want 1 session, got %d: %+v", len(got), got)
	}
	if got["alerts"].ClaudeState != "running" || got["alerts"].Background != "" {
		t.Errorf("old-shape row: got %+v", got["alerts"])
	}
}

func TestParsePaneList(t *testing.T) {
	in := "alerts\t1234\nalerts\t1235\nf1\t99\n"
	got := parsePaneList(in)

	if !reflect.DeepEqual(got["alerts"], []int{1234, 1235}) {
		t.Errorf("want both alerts panes, got %v", got["alerts"])
	}
	if !reflect.DeepEqual(got["f1"], []int{99}) {
		t.Errorf("want f1 pane 99, got %v", got["f1"])
	}
}

func TestParsePaneListSkipsUnparseablePids(t *testing.T) {
	if got := parsePaneList("alerts\tnotapid\nf1\t7\n"); len(got) != 1 {
		t.Fatalf("want only the parseable row, got %v", got)
	}
}

func TestParseTombstones(t *testing.T) {
	// <session>\t<epoch>, appended once per deliberate kill.
	in := "reflection\t1788286792\n" +
		"drill-shape2\t1788286655\n" +
		"\n"
	got := parseTombstones(in)

	if got["reflection"] != 1788286792 || got["drill-shape2"] != 1788286655 {
		t.Fatalf("want both kills with their epochs, got %v", got)
	}
}

func TestParseTombstonesKeepsTheNewestRowPerName(t *testing.T) {
	// The file is append-only, so a reused session name accumulates rows. Only
	// the latest kill can explain a disappearance happening now.
	got := parseTombstones("immich\t1000\nimmich\t5000\nimmich\t3000\n")
	if got["immich"] != 5000 {
		t.Fatalf("want the newest epoch 5000, got %d", got["immich"])
	}
}

func TestParseTombstonesSkipsMalformedRows(t *testing.T) {
	got := parseTombstones("noepoch\nimmich\tnotanumber\nf1\t42\n")
	if len(got) != 1 || got["f1"] != 42 {
		t.Fatalf("want only the parseable row, got %v", got)
	}
}

func TestCgroupPath(t *testing.T) {
	in := "0::/user.slice/user-1000.slice/user@1000.service/app.slice/tmux-spawn-fee89d67.scope\n"
	want := "/user.slice/user-1000.slice/user@1000.service/app.slice/tmux-spawn-fee89d67.scope"
	if got := cgroupPath(in); got != want {
		t.Fatalf("want %q, got %q", want, got)
	}
}

func TestCgroupPathOnV1Lines(t *testing.T) {
	// A cgroup v1 hierarchy has no unified line to take, and guessing at one
	// would attach a pane to the wrong scope.
	if got := cgroupPath("11:memory:/user.slice\n1:name=systemd:/user.slice\n"); got != "" {
		t.Fatalf("want no path when there is no unified entry, got %q", got)
	}
}

func TestIsClaude(t *testing.T) {
	// comm is the unreliable half: the pane cap notes record the binary
	// reporting its version string, and a re-exec'd child reporting something
	// else again. The exe link is what settles it.
	cases := []struct {
		name string
		exe  string
		comm string
		want bool
	}{
		{"exe under the versions dir", "/home/wizard/.local/share/claude/versions/2.1.251", "claude", true},
		{"exe says claude, comm says a version", "/home/wizard/.local/share/claude/versions/2.1.252", "2.1.252", true},
		{"exe unreadable, comm is claude", "", "claude", true},
		{"the launching shell", "/usr/bin/zsh", "zsh", false},
		{"a test run", "/usr/bin/node", "node (vitest 27)", false},
		{"a python build", "/usr/bin/python3", "python3", false},
		{"t3-serve reporting MainThread", "/usr/local/bin/t3-serve", "MainThread", false},
	}
	for _, c := range cases {
		if got := isClaude(c.exe, c.comm); got != c.want {
			t.Errorf("%s: isClaude(%q, %q) = %v, want %v", c.name, c.exe, c.comm, got, c.want)
		}
	}
}

func TestPickTopRanksByRSS(t *testing.T) {
	// The kernel ranks by RSS at the cap, so this must rank the same way or the
	// warning names the wrong victim. Numbers from the 2026-08-16 cap test:
	// python3 at 5.44 GiB was chosen over claude at 457 MB.
	in := []procSample{
		{Pid: 1, RSSBytes: 457 << 20, IsClaude: true},
		{Pid: 2, RSSBytes: 5570 << 20, IsClaude: false},
		{Pid: 3, RSSBytes: 12 << 20, IsClaude: false},
	}
	top := pickTop(in)
	if top.Pid != 2 || top.IsClaude {
		t.Fatalf("want pid 2 and not a claude, got %+v", top)
	}
}

func TestPickTopOnAnEmptyPane(t *testing.T) {
	// Stale scopes with no processes exist on the box; reading one must not
	// claim a claude is the fattest thing in it.
	if top := pickTop(nil); top.Pid != 0 || top.IsClaude {
		t.Fatalf("want a zero sample for an empty pane, got %+v", top)
	}
}

// --- the process tree ------------------------------------------------------
//
// Liveness cannot be read off cgroup membership. Measured 2026-09-01: emo's
// claude sits in a run-r*.scope at 2.09 GB while the tmux-spawn scope for the
// same pane holds only the shell and reports memory.current 0. A watcher that
// asked the pane's scope "is a claude in here" called four of emo's live
// conversations dead. tmux owns the pane pid, so the process tree under it is
// what actually answers the question.

func TestParseChildren(t *testing.T) {
	if got := parseChildren("1501091 1501099 \n"); !reflect.DeepEqual(got, []int{1501091, 1501099}) {
		t.Fatalf("want both children, got %v", got)
	}
	if got := parseChildren(""); len(got) != 0 {
		t.Fatalf("want none for a leaf, got %v", got)
	}
}

func TestProcTreeCollectsEveryDescendant(t *testing.T) {
	kids := map[int][]int{
		10: {11, 12}, // shell -> claude, and something else
		11: {13},     // claude -> an MCP server
		13: {14},     // and its child
	}
	got := procTree(10, func(pid int) []int { return kids[pid] })

	want := map[int]bool{10: true, 11: true, 12: true, 13: true, 14: true}
	if len(got) != len(want) {
		t.Fatalf("want %d pids, got %v", len(want), got)
	}
	for _, pid := range got {
		if !want[pid] {
			t.Fatalf("unexpected pid %d in %v", pid, got)
		}
	}
}

func TestProcTreeTerminatesOnACycle(t *testing.T) {
	// /proc is a live filesystem read without a lock, so a pid can appear as its
	// own ancestor mid-walk. This must return rather than spin.
	got := procTree(1, func(pid int) []int { return []int{1, 2} })
	if len(got) > 3 {
		t.Fatalf("walk did not settle: %v", got)
	}
}

// --- attributing a pane ----------------------------------------------------

func TestPaneFactsFindsClaudeAnywhereInTheTree(t *testing.T) {
	// The build being the fattest process does not mean the conversation is gone.
	samples := []procSample{
		{Pid: 10, RSSBytes: 5 << 30, IsClaude: false},
		{Pid: 11, RSSBytes: 500 << 20, IsClaude: true},
	}
	got := paneFacts(Session{}, samples, func(int) (uint64, uint64, uint64) { return 5 << 30, 5 << 30, 6 << 30 })

	if !got.ClaudeAlive {
		t.Error("want ClaudeAlive when a claude is anywhere in the tree")
	}
	if got.TopIsClaude {
		t.Error("want TopIsClaude false when the build is larger")
	}
}

func TestPaneFactsReadsMemoryFromTheTopProcessCgroup(t *testing.T) {
	// emo's shape: the pane's own scope reports 0 and the scope holding claude
	// reports 2.09 GB. The cap that will fire is the one around the big process.
	samples := []procSample{
		{Pid: 1501087, RSSBytes: 3 << 20, IsClaude: false},   // the shell
		{Pid: 1501091, RSSBytes: 2094133248, IsClaude: true}, // claude
	}
	memOf := func(pid int) (uint64, uint64, uint64) {
		if pid == 1501091 {
			return 2094133248, 2094133248, 6 << 30
		}
		return 0, 0, 6 << 30 // the tmux-spawn scope, holding only the shell
	}
	got := paneFacts(Session{}, samples, memOf)

	if got.PaneBytes != 2094133248 {
		t.Errorf("want the claude scope's 2.09 GB, got %d", got.PaneBytes)
	}
	if got.PaneLimit != 6<<30 {
		t.Errorf("want the 6 GiB cap, got %d", got.PaneLimit)
	}
	if !got.ClaudeAlive || !got.TopIsClaude {
		t.Errorf("want a live claude that is also the fattest, got %+v", got)
	}
}

func TestPaneFactsClaimsNothingForAnEmptyPane(t *testing.T) {
	got := paneFacts(Session{}, nil, func(int) (uint64, uint64, uint64) { return 9, 9, 9 })
	if got.ClaudeAlive || got.TopIsClaude || got.PaneBytes != 0 {
		t.Fatalf("want no claims about an empty pane, got %+v", got)
	}
}

func TestPaneFactsKeepsTheLargestPaneAcrossCalls(t *testing.T) {
	// A session with several panes reports the one whose cap bites first.
	s := paneFacts(Session{}, []procSample{{Pid: 1, RSSBytes: 4 << 30, IsClaude: true}},
		func(int) (uint64, uint64, uint64) { return 4 << 30, 4 << 30, 6 << 30 })
	s = paneFacts(s, []procSample{{Pid: 2, RSSBytes: 1 << 30, IsClaude: false}},
		func(int) (uint64, uint64, uint64) { return 1 << 30, 1 << 30, 6 << 30 })

	if s.PaneBytes != 4<<30 {
		t.Errorf("want the larger pane retained, got %d", s.PaneBytes)
	}
	if !s.ClaudeAlive {
		t.Error("a second, smaller pane must not unset a claude found in the first")
	}
}

// --- running as another user ----------------------------------------------
//
// sudo opens a PAM session, and PAM logs an open/close pair plus the command
// for every invocation. At two tmux calls per user every 30 seconds that is
// ~360 journal lines an hour of pure bookkeeping, and `sudo` is in promtail's
// identifier allowlist, so all of it would ship to Loki and spend 30 days of
// retention and part of a shared stream budget on nothing. setpriv changes uid
// without PAM, which a root process does not need anyway.

func TestAsUserArgvNeedsNoPrivilegeForItself(t *testing.T) {
	got := asUserArgv(true, "wizard", "wizard", 1000, 1000, "/usr/bin/tmux", []string{"list-sessions"})
	want := []string{"/usr/bin/tmux", "list-sessions"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("want a bare exec for our own user, got %v", got)
	}
}

func TestAsUserArgvUsesSetprivWhenRoot(t *testing.T) {
	got := asUserArgv(true, "root", "emo", 1002, 1002, "/usr/bin/tmux", []string{"list-sessions"})
	want := []string{
		"/usr/bin/setpriv", "--reuid=1002", "--regid=1002", "--init-groups",
		"/usr/bin/tmux", "list-sessions",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("want setpriv, got %v", got)
	}
}

func TestAsUserArgvFallsBackToSudoWhenNotRoot(t *testing.T) {
	// A single-user install, or the unit run as wizard: setpriv cannot change uid
	// without privilege, and the sudoers grant the rest of the lobby uses can.
	got := asUserArgv(false, "wizard", "emo", 1002, 1002, "/usr/bin/tmux", []string{"list-sessions"})
	want := []string{"/usr/bin/sudo", "-n", "-u", "emo", "/usr/bin/tmux", "list-sessions"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("want the sudo fallback, got %v", got)
	}
}

// --- reading the unreclaimable figure --------------------------------------

func TestParseMemStatUnreclaimable(t *testing.T) {
	// The real memory.stat of the "issues" pane, 2026-09-01 19:10. Only anon and
	// shmem count: 5131 MB of the file total was cold inactive_file, which the
	// cap reclaims rather than kills for.
	in := `anon 654311424
file 5528823808
kernel 104857600
sock 0
shmem 3145728
inactive_anon 312475648
active_anon 346030080
inactive_file 5380705280
active_file 143654912
slab 96468992
`
	if got := parseMemStatUnreclaimable(in); got != 654311424+3145728 {
		t.Fatalf("want anon+shmem = %d, got %d", 654311424+3145728, got)
	}
}

func TestParseMemStatUnreclaimableOnAnEmptyFile(t *testing.T) {
	if got := parseMemStatUnreclaimable(""); got != 0 {
		t.Fatalf("want 0 for a scope with no stats, got %d", got)
	}
}

// A field named anonymously similar must not be counted: anon_thp is already
// included in anon, so adding it would double-count transparent huge pages.
func TestParseMemStatUnreclaimableIgnoresAnonThp(t *testing.T) {
	got := parseMemStatUnreclaimable("anon 1000\nanon_thp 900\nshmem 5\n")
	if got != 1005 {
		t.Fatalf("want 1005, got %d", got)
	}
}

func TestPaneFactsCarriesUnreclaimableSeparately(t *testing.T) {
	// current at the cap, unreclaimable nowhere near it: the shape that must not
	// warn.
	got := paneFacts(Session{}, []procSample{{Pid: 1, RSSBytes: 500 << 20, IsClaude: true}},
		func(int) (uint64, uint64, uint64) { return 6143 << 20, 628 << 20, 6144 << 20 })

	if got.PaneBytes != 6143<<20 {
		t.Errorf("want memory.current 6143MB, got %d", got.PaneBytes>>20)
	}
	if got.PaneUnreclaimable != 628<<20 {
		t.Errorf("want unreclaimable 628MB, got %d", got.PaneUnreclaimable>>20)
	}
}

func TestMergeIntentTakesBothSources(t *testing.T) {
	// A deliberate ending is recorded in one of two places depending on how it
	// happened: the lobby's DELETE writes a tombstone, and a clean /exit writes
	// a clean-exit row. The watcher must not care which.
	got := mergeIntent(
		map[string]int64{"killed-in-lobby": 100},
		map[string]int64{"exited-cleanly": 200})
	want := map[string]int64{"killed-in-lobby": 100, "exited-cleanly": 200}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestMergeIntentKeepsTheNewestRecordPerName(t *testing.T) {
	// Both files are append-only and a name can be reused, so the freshest
	// record is the one that decides whether the ending was recent enough to
	// explain a disappearance.
	got := mergeIntent(
		map[string]int64{"f1": 5000, "immich": 9000},
		map[string]int64{"f1": 7000, "immich": 1000})
	want := map[string]int64{"f1": 7000, "immich": 9000}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestMergeIntentSurvivesEitherSideBeingAbsent(t *testing.T) {
	// A user who has never had a session killed has no tombstone file, and one
	// who has never exited cleanly has no clean-exit file. Reading a missing
	// file yields nil, which must not panic or erase the other source.
	if got := mergeIntent(nil, map[string]int64{"f1": 1}); !reflect.DeepEqual(got, map[string]int64{"f1": 1}) {
		t.Fatalf("nil tombstones: got %v", got)
	}
	if got := mergeIntent(map[string]int64{"f1": 1}, nil); !reflect.DeepEqual(got, map[string]int64{"f1": 1}) {
		t.Fatalf("nil clean exits: got %v", got)
	}
	if got := mergeIntent(nil, nil); len(got) != 0 {
		t.Fatalf("both nil: got %v", got)
	}
}

func TestCleanExitsPathIsUnderThePerUserRuntimeDir(t *testing.T) {
	// /run/user/<uid> is mode 0700 and owned by the user, so the hook can write
	// there without a sudo grant and no other user can forge a record. Root,
	// which is what the watcher runs as, can still read it.
	if got := cleanExitsFn(1002); got != "/run/user/1002/tl-clean-exit.tsv" {
		t.Fatalf("got %q", got)
	}
}
