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

// A per-user unit runs as name@<user>. The release restarts the instances that
// are ALREADY enabled and enables nobody: enabling a user is a deliberate act
// with its own per-user configuration behind it.
//
// No unit in the manifest is templated today — tl-t3-sync@ was the one, and it
// went with ADR-0029. The machinery is kept and tested against a fixture,
// because the next per-user service would otherwise have to rebuild it and
// rediscover the failed-instance marker below.
func TestATemplatedUnitRestartsItsEnabledInstancesOnly(t *testing.T) {
	units := []Unit{{Name: "tl-peruser@", Template: true, Files: []string{"bin/tl-peruser"}}}
	got := RestartTargets(units, []string{"bin/tl-peruser"}, map[string][]string{
		"tl-peruser@": {"tl-peruser@wizard"},
	})
	if len(got) != 1 || got[0] != "tl-peruser@wizard" {
		t.Fatalf("want the enabled instance only, got %v", got)
	}
}

func TestATemplatedUnitWithNoEnabledInstancesRestartsNothing(t *testing.T) {
	units := []Unit{{Name: "tl-peruser@", Template: true, Files: []string{"bin/tl-peruser"}}}
	if got := RestartTargets(units, []string{"bin/tl-peruser"}, nil); len(got) != 0 {
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
	out := `  tl-peruser@wizard.service    loaded active   running Terminal Lobby per-user unit
` + "●" + ` tl-peruser@bob.service       loaded failed   failed  Terminal Lobby per-user unit
* tl-peruser@anca.service      loaded active   running Terminal Lobby per-user unit
`
	got := ParseUnitInstances("tl-peruser@", out)
	want := []string{"tl-peruser@anca", "tl-peruser@bob", "tl-peruser@wizard"}
	if !equal(got, want) {
		t.Fatalf("want %v, got %v", want, got)
	}
}

func TestUnrelatedUnitsAreNotCollected(t *testing.T) {
	out := "  tmux-api.service   loaded active running tmux API\n"
	if got := ParseUnitInstances("tl-peruser@", out); len(got) != 0 {
		t.Fatalf("want nothing, got %v", got)
	}
}

func TestEmptyListUnitsOutputYieldsNoInstances(t *testing.T) {
	if got := ParseUnitInstances("tl-peruser@", ""); len(got) != 0 {
		t.Fatalf("want nothing, got %v", got)
	}
}

// A revert downgrades the whole package and holds it, which stops every later
// deploy of ttyd, tmux-api and the SPA until a human runs `apt-mark unhold`.
// That price is right for a service a person's session runs through, and wrong
// for agent-api: nothing a person does touches it, it answers nothing until a
// credential is written, and its port is outside the block this package owns.
// A probe of it has to be able to fail without taking the box with it.
func TestAFailedAdvisoryProbeKeepsTheVersion(t *testing.T) {
	got := Decide([]Probe{
		{Name: "tmux-api /health", OK: true},
		{Name: "agent-api /health", OK: false, Advisory: true},
	})
	if got != Keep {
		t.Fatalf("want Keep when only an advisory probe failed, got %v", got)
	}
}

// The escape hatch is per-probe and does not widen. One advisory probe passing
// says nothing about the gating one beside it.
func TestAnAdvisoryProbeDoesNotExcuseAGatingOne(t *testing.T) {
	got := Decide([]Probe{
		{Name: "agent-api /health", OK: true, Advisory: true},
		{Name: "tmux-api /health", OK: false},
	})
	if got != RevertAndHold {
		t.Fatalf("want RevertAndHold when a gating probe failed, got %v", got)
	}
}

// Same reading as a run that probed nothing: advisory results alone have not
// shown that anything a person uses still works, so the release is unverified.
// Without this, marking every check advisory would turn verification off and
// still report success.
func TestARunOfOnlyAdvisoryProbesIsTreatedAsFailure(t *testing.T) {
	got := Decide([]Probe{
		{Name: "agent-api /health", OK: true, Advisory: true},
		{Name: "agent-api /v1 refuses anonymous", OK: true, Advisory: true},
	})
	if got != RevertAndHold {
		t.Fatalf("want RevertAndHold when no gating probe ran, got %v", got)
	}
}

// Verification runs under one shared deadline. An advisory check is the one
// most likely to be failing for a reason that will not clear inside it -- a
// port another process is holding stays held -- and probing it first would
// spend the budget that the checks deciding the box's fate need for their
// retries.
func TestGatingChecksAreProbedBeforeAdvisoryOnes(t *testing.T) {
	in := []Check{
		{Name: "agent-api /health", Advisory: true},
		{Name: "tmux-api /health"},
		{Name: "agent-api /v1 refuses anonymous", Advisory: true},
		{Name: "ttyd refuses anonymous"},
	}
	got := GatingFirst(in)
	if len(got) != len(in) {
		t.Fatalf("GatingFirst dropped checks: %d in, %d out", len(in), len(got))
	}
	var names []string
	for _, c := range got {
		names = append(names, c.Name)
	}
	want := []string{
		"tmux-api /health", "ttyd refuses anonymous",
		"agent-api /health", "agent-api /v1 refuses anonymous",
	}
	if !equal(names, want) {
		t.Errorf("want %v, got %v", want, names)
	}
}

// The live order, so a check added to the manifest between the two agent-api
// entries does not quietly land behind them.
func TestTheShippedChecksReorderToGatingFirst(t *testing.T) {
	ordered := GatingFirst(Package.Checks)
	seenAdvisory := false
	for _, c := range ordered {
		if c.Advisory {
			seenAdvisory = true
			continue
		}
		if seenAdvisory {
			t.Fatalf("gating check %q is probed after an advisory one", c.Name)
		}
	}
	if !seenAdvisory {
		t.Skip("no advisory check ships; nothing to order")
	}
}
