package release

import "testing"

const policyOutput = `terminal-lobby:
  Installed: 0.2.0
  Candidate: 0.2.0
  Version table:
 *** 0.2.0 100
        100 /var/lib/dpkg/status
     0.1.9 500
        500 https://forgejo.viktorbarzin.me/api/packages/viktor/debian noble/main amd64 Packages
     0.1.8 500
        500 https://forgejo.viktorbarzin.me/api/packages/viktor/debian noble/main amd64 Packages
`

func TestThePreviousVersionIsTheNewestOneThatIsNotInstalled(t *testing.T) {
	got, err := PreviousVersion(policyOutput)
	if err != nil {
		t.Fatal(err)
	}
	if got != "0.1.9" {
		t.Fatalf("want 0.1.9, got %q", got)
	}
}

// The priority column is numeric and sits on its own line. Parsing that as a
// version would make the box try to install "100".
func TestThePriorityLinesAreNotMistakenForVersions(t *testing.T) {
	got, err := PreviousVersion(policyOutput)
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"100", "500"} {
		if got == bad {
			t.Fatalf("parsed the priority column as a version: %q", got)
		}
	}
}

func TestNothingToRevertToWhenOnlyOneVersionIsKnown(t *testing.T) {
	only := `terminal-lobby:
  Installed: 0.1.0
  Candidate: 0.1.0
  Version table:
 *** 0.1.0 100
        100 /var/lib/dpkg/status
`
	got, err := PreviousVersion(only)
	if err != nil {
		t.Fatal(err)
	}
	if got != "" {
		t.Fatalf("want no previous version, got %q", got)
	}
}

func TestAPackageThatIsNotInstalledHasNothingToRevertTo(t *testing.T) {
	none := `terminal-lobby:
  Installed: (none)
  Candidate: 0.1.0
  Version table:
     0.1.0 500
        500 https://forgejo.viktorbarzin.me/api/packages/viktor/debian noble/main amd64 Packages
`
	got, err := PreviousVersion(none)
	if err != nil {
		t.Fatal(err)
	}
	if got != "" {
		t.Fatalf("nothing is installed, so nothing was replaced; got %q", got)
	}
}

func TestUnreadablePolicyOutputIsAnError(t *testing.T) {
	if _, err := PreviousVersion("N: Unable to locate package terminal-lobby\n"); err == nil {
		t.Fatal("expected an error rather than a silent empty answer")
	}
}
