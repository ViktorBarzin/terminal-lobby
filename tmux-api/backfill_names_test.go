package main

import (
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
