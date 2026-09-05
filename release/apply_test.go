package release

import (
	"os"
	"path/filepath"
	"testing"
)

// tree writes files under a fresh root and returns it. A nil body means the
// file is absent, which is how a first install looks.
func tree(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for rel, body := range files {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestNothingChangedWhenTheBytesAreIdentical(t *testing.T) {
	files := map[string]string{"bin/tmux-api": "ELF-1", "share/index.html": "<html>"}
	changed, err := Changed(tree(t, files), tree(t, files), keys(files))
	if err != nil {
		t.Fatal(err)
	}
	if len(changed) != 0 {
		t.Fatalf("want nothing changed, got %v", changed)
	}
}

func TestOnlyTheFileWhoseBytesMovedIsReportedChanged(t *testing.T) {
	installed := tree(t, map[string]string{"bin/tmux-api": "ELF-1", "bin/file-api": "ELF-A"})
	incoming := tree(t, map[string]string{"bin/tmux-api": "ELF-2", "bin/file-api": "ELF-A"})

	changed, err := Changed(installed, incoming, []string{"bin/tmux-api", "bin/file-api"})
	if err != nil {
		t.Fatal(err)
	}
	if len(changed) != 1 || changed[0] != "bin/tmux-api" {
		t.Fatalf("want only bin/tmux-api changed, got %v", changed)
	}
}

func TestAFileAbsentOnTheBoxCountsAsChanged(t *testing.T) {
	installed := tree(t, map[string]string{})
	incoming := tree(t, map[string]string{"bin/skills-api": "ELF-new"})

	changed, err := Changed(installed, incoming, []string{"bin/skills-api"})
	if err != nil {
		t.Fatal(err)
	}
	if len(changed) != 1 || changed[0] != "bin/skills-api" {
		t.Fatalf("a first install must report the file as changed, got %v", changed)
	}
}

// The property the three deploy scripts hand-maintain: a needless restart drops
// every attached terminal's WebSocket, and every Text-view client's SSE stream.
func TestOnlyUnitsOwningAChangedFileRestart(t *testing.T) {
	units := []Unit{
		{Name: "tmux-api", Files: []string{"bin/tmux-api"}},
		{Name: "session-events", Files: []string{"bin/session-events"}},
		{Name: "ttyd", Files: []string{"bin/ttyd", "share/index.html"}},
	}
	got := RestartSet(units, []string{"bin/tmux-api"})
	if len(got) != 1 || got[0] != "tmux-api" {
		t.Fatalf("a tmux-api-only release must not restart ttyd or session-events, got %v", got)
	}
}

func TestAUnitWithSeveralFilesRestartsOnceWhenMoreThanOneChanged(t *testing.T) {
	units := []Unit{{Name: "ttyd", Files: []string{"bin/ttyd", "share/index.html"}}}
	got := RestartSet(units, []string{"bin/ttyd", "share/index.html"})
	if len(got) != 1 || got[0] != "ttyd" {
		t.Fatalf("want ttyd once, got %v", got)
	}
}

func TestAChangeNoUnitOwnsRestartsNothing(t *testing.T) {
	units := []Unit{{Name: "ttyd", Files: []string{"bin/ttyd"}}}
	// The webfonts are served from the shared asset dir by clipboard-upload's
	// exact-path whitelist, so shipping one restarts no service. This used to
	// say share/term.html, which was the same shape until the page was deleted.
	if got := RestartSet(units, []string{"frontend/fonts/tl-symbols.woff2"}); len(got) != 0 {
		t.Fatalf("want no restarts, got %v", got)
	}
}

func TestTheRestartSetIsDeterministic(t *testing.T) {
	units := []Unit{
		{Name: "ttyd", Files: []string{"bin/ttyd"}},
		{Name: "tmux-api", Files: []string{"bin/tmux-api"}},
	}
	changed := []string{"bin/tmux-api", "bin/ttyd"}
	first := RestartSet(units, changed)
	for i := 0; i < 5; i++ {
		if got := RestartSet(units, changed); !equal(got, first) {
			t.Fatalf("restart set is not deterministic: %v then %v", first, got)
		}
	}
}

func TestAPassingVerifyKeepsTheVersion(t *testing.T) {
	if got := Decide([]Probe{{Name: "tmux-api /health", OK: true}, {Name: "file-api 401", OK: true}}); got != Keep {
		t.Fatalf("want Keep, got %v", got)
	}
}

func TestASingleFailedProbeRevertsAndHolds(t *testing.T) {
	got := Decide([]Probe{{Name: "tmux-api /health", OK: true}, {Name: "session-events /health", OK: false}})
	if got != RevertAndHold {
		t.Fatalf("want RevertAndHold, got %v", got)
	}
}

// A release that verified nothing has not been shown to work. Failing closed
// costs a revert; failing open leaves users inside an unverified version.
func TestVerifyingNothingIsTreatedAsFailure(t *testing.T) {
	if got := Decide(nil); got != RevertAndHold {
		t.Fatalf("want RevertAndHold when no probe ran, got %v", got)
	}
}

func keys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// tl-t3-sync runs as tl-t3-sync@<user>. The release restarts the instances that
// are ALREADY enabled and enables nobody: enabling a user needs a hand-written
// env file carrying their port allocation.
func TestATemplatedUnitRestartsItsEnabledInstancesOnly(t *testing.T) {
	units := []Unit{{Name: "tl-t3-sync@", Template: true, Files: []string{"bin/tl-t3-sync"}}}
	got := RestartTargets(units, []string{"bin/tl-t3-sync"}, map[string][]string{
		"tl-t3-sync@": {"tl-t3-sync@wizard"},
	})
	if len(got) != 1 || got[0] != "tl-t3-sync@wizard" {
		t.Fatalf("want the enabled instance only, got %v", got)
	}
}

func TestATemplatedUnitWithNoEnabledInstancesRestartsNothing(t *testing.T) {
	units := []Unit{{Name: "tl-t3-sync@", Template: true, Files: []string{"bin/tl-t3-sync"}}}
	if got := RestartTargets(units, []string{"bin/tl-t3-sync"}, nil); len(got) != 0 {
		t.Fatalf("a template with no enabled instances must restart nothing, got %v", got)
	}
}

func TestRestartTargetsLeavesPlainUnitsAlone(t *testing.T) {
	units := []Unit{{Name: "tmux-api", Files: []string{"bin/tmux-api"}}}
	got := RestartTargets(units, []string{"bin/tmux-api"}, nil)
	if len(got) != 1 || got[0] != "tmux-api" {
		t.Fatalf("want tmux-api, got %v", got)
	}
}

// dpkg has already replaced the files by the time postinst runs, so what
// changed has to be captured before it unpacks. preinst snapshots; postinst
// compares against what is now on disk.
func TestASnapshotTakenBeforeUnpackNamesWhatMoved(t *testing.T) {
	root := tree(t, map[string]string{"bin/tmux-api": "ELF-1", "bin/file-api": "ELF-A"})
	paths := []string{"bin/tmux-api", "bin/file-api"}

	before, err := Snapshot(root, paths)
	if err != nil {
		t.Fatal(err)
	}
	// dpkg unpacks a new tmux-api over the old one.
	if err := os.WriteFile(filepath.Join(root, "bin/tmux-api"), []byte("ELF-2"), 0o644); err != nil {
		t.Fatal(err)
	}

	changed, err := ChangedSince(root, before, paths)
	if err != nil {
		t.Fatal(err)
	}
	if len(changed) != 1 || changed[0] != "bin/tmux-api" {
		t.Fatalf("want only bin/tmux-api, got %v", changed)
	}
}

func TestAFirstInstallSnapshotsNothingAndReportsEverythingChanged(t *testing.T) {
	root := t.TempDir()
	paths := []string{"bin/skills-api"}

	before, err := Snapshot(root, paths)
	if err != nil {
		t.Fatal(err)
	}
	if len(before) != 0 {
		t.Fatalf("nothing is installed yet; want an empty snapshot, got %v", before)
	}
	if err := os.MkdirAll(filepath.Join(root, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "bin/skills-api"), []byte("ELF"), 0o644); err != nil {
		t.Fatal(err)
	}

	changed, err := ChangedSince(root, before, paths)
	if err != nil {
		t.Fatal(err)
	}
	if len(changed) != 1 {
		t.Fatalf("a first install must restart everything it ships, got %v", changed)
	}
}

// A reinstall of the same version must disturb nobody.
func TestReinstallingTheSameBytesChangesNothing(t *testing.T) {
	root := tree(t, map[string]string{"bin/tmux-api": "ELF-1"})
	paths := []string{"bin/tmux-api"}

	before, err := Snapshot(root, paths)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "bin/tmux-api"), []byte("ELF-1"), 0o644); err != nil {
		t.Fatal(err)
	}
	changed, err := ChangedSince(root, before, paths)
	if err != nil {
		t.Fatal(err)
	}
	if len(changed) != 0 {
		t.Fatalf("reinstalling identical bytes must restart nothing, got %v", changed)
	}
}

// systemd marks a FAILED unit with a bullet, not an asterisk. Reading only the
// asterisk form silently skips a failed instance -- which is exactly the one a
// release most needs to restart.
func TestEnabledInstancesReadsBothMarkers(t *testing.T) {
	out := `  tl-t3-sync@wizard.service    loaded active   running Terminal Lobby T3 syncer
` + "●" + ` tl-t3-sync@bob.service       loaded failed   failed  Terminal Lobby T3 syncer
* tl-t3-sync@anca.service      loaded active   running Terminal Lobby T3 syncer
`
	got := ParseUnitInstances("tl-t3-sync@", out)
	want := []string{"tl-t3-sync@anca", "tl-t3-sync@bob", "tl-t3-sync@wizard"}
	if !equal(got, want) {
		t.Fatalf("want %v, got %v", want, got)
	}
}

func TestUnrelatedUnitsAreNotCollected(t *testing.T) {
	out := "  tmux-api.service   loaded active running tmux API\n"
	if got := ParseUnitInstances("tl-t3-sync@", out); len(got) != 0 {
		t.Fatalf("want nothing, got %v", got)
	}
}

func TestEmptyListUnitsOutputYieldsNoInstances(t *testing.T) {
	if got := ParseUnitInstances("tl-t3-sync@", ""); len(got) != 0 {
		t.Fatalf("want nothing, got %v", got)
	}
}
