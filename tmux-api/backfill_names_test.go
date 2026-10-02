package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A session titled BEFORE ADR-0022 shipped keeps its minted id: nothing
// retitles it, so the rule that renames on a title never fires for it. Measured
// on the box the day ADR-0022 landed — 29 of wizard's sessions were titled and
// every one of them still read as an id in `tmux ls`, which is the complaint
// the ADR exists to answer.

func TestBackfillRenamesATitledIDSession(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withTempLayoutStore(t)
	swapAssignmentStore(t)
	swapTitleStore(t)
	argvFile := withTmuxStub(t, "")

	sessions := []Session{
		{Name: "6j0wjvxxf7e5", Title: "Restore feature session naming"},
	}
	backfillDerivedNames(osSelf, sessions)

	argv := recordedArgv(t, argvFile)
	for _, want := range []string{"rename-session", "restore-feature-session-naming"} {
		if !strings.Contains(argv, want+"\n") {
			t.Errorf("argv missing %q:\n%s", want, argv)
		}
	}
	// The row being served has to move too, or the poll hands the lobby a name
	// the tmux server no longer answers to.
	if sessions[0].Name != "restore-feature-session-naming" {
		t.Errorf("served name = %q, want the derived one", sessions[0].Name)
	}
}

func TestBackfillLeavesEverythingElseAlone(t *testing.T) {
	cases := []struct {
		what    string
		session Session
	}{
		// The whole point of the restriction. Somebody typed `beads`; a title
		// arriving later must not overwrite the name they chose.
		{"a name a person chose", Session{Name: "beads", Title: "Bead triage"}},
		{"an untitled id", Session{Name: "4txnmy85ftja"}},
		{"a name already derived from its title", Session{Name: "deploy", Title: "Deploy"}},
		{"a reserved prefix", Session{Name: "qa-run-17", Title: "QA run"}},
		{"a pool slot", Session{Name: poolSlotPrefix + "code", Title: "Pool"}},
		// Nothing usable survives, so there is nothing to rename to.
		{"a title that derives nothing", Session{Name: "0qwwchjmxv9c", Title: "日本語 🎉"}},
	}
	for _, c := range cases {
		t.Run(c.what, func(t *testing.T) {
			osSelf, _ := twoLocalUsers(t)
			withTempLayoutStore(t)
			swapAssignmentStore(t)
			swapTitleStore(t)
			argvFile := withTmuxStub(t, "")

			sessions := []Session{c.session}
			backfillDerivedNames(osSelf, sessions)

			if argv := recordedArgv(t, argvFile); strings.Contains(argv, "rename-session") {
				t.Errorf("renamed %q:\n%s", c.session.Name, argv)
			}
			if sessions[0].Name != c.session.Name {
				t.Errorf("served name moved to %q", sessions[0].Name)
			}
		})
	}
}

// Two ids carrying the same title must not both ask for the same name: tmux
// would refuse the second, and the pass would retry it on every poll forever.
func TestBackfillSuffixesASecondSessionWithTheSameTitle(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withTempLayoutStore(t)
	swapAssignmentStore(t)
	swapTitleStore(t)
	withTmuxStub(t, "")

	sessions := []Session{
		{Name: "6j0wjvxxf7e5", Title: "Deploy"},
		{Name: "0qwwchjmxv9c", Title: "Deploy"},
	}
	backfillDerivedNames(osSelf, sessions)

	if sessions[0].Name != "deploy" || sessions[1].Name != "deploy-2" {
		t.Errorf("names = %q, %q; want deploy and deploy-2", sessions[0].Name, sessions[1].Name)
	}
}

// A name whose image directory is real belongs to a session that holds it or
// held it, so a derived name steps around it the way it steps around a live
// one. Measured live on 2026-10-02: two conversations autotitled onto
// image-word-identification and image-word-identification-2, both orphans of an
// earlier round, so their uploads went into those directories and deleting the
// conversations deleted them.
func TestDerivedNameStepsAroundAnEarlierSessionsImages(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withTempLayoutStore(t)
	swapAssignmentStore(t)
	swapTitleStore(t)
	root := swapImageStore(t)
	argvFile := withTmuxStub(t, "")
	for _, d := range []string{"image-word-identification", "image-word-identification-2"} {
		if err := os.MkdirAll(filepath.Join(root, osSelf, d), 0o700); err != nil {
			t.Fatal(err)
		}
	}

	sessions := []Session{{Name: "6j0wjvxxf7e5", Title: "Image word identification"}}
	backfillDerivedNames(osSelf, sessions)

	if sessions[0].Name != "image-word-identification-3" {
		t.Errorf("served name = %q, want image-word-identification-3", sessions[0].Name)
	}
	if argv := recordedArgv(t, argvFile); !strings.Contains(argv, "image-word-identification-3\n") {
		t.Errorf("argv did not rename to the free name:\n%s", argv)
	}
}

// A link left by a rename holds nothing of its own (renameImageDir replaces
// it), so it does not push a derived name onto a suffix.
func TestDerivedNameTakesANameThatIsOnlyALink(t *testing.T) {
	osSelf, _ := twoLocalUsers(t)
	withTempLayoutStore(t)
	swapAssignmentStore(t)
	swapTitleStore(t)
	root := swapImageStore(t)
	withTmuxStub(t, "")
	if err := os.MkdirAll(filepath.Join(root, osSelf, "elsewhere"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("elsewhere", filepath.Join(root, osSelf, "deploy")); err != nil {
		t.Fatal(err)
	}

	sessions := []Session{{Name: "6j0wjvxxf7e5", Title: "Deploy"}}
	backfillDerivedNames(osSelf, sessions)

	if sessions[0].Name != "deploy" {
		t.Errorf("served name = %q, want deploy", sessions[0].Name)
	}
}
