package release

import (
	"strings"
	"testing"
)

func TestEveryUnitsFilesArePackageFiles(t *testing.T) {
	owned := make(map[string]bool)
	for _, f := range Package.Files {
		owned[f.Dest] = true
	}
	for _, u := range Package.Units {
		for _, f := range u.Files {
			if !owned[f] && !Package.ExternalFile(f) {
				t.Errorf("unit %s watches %s, which no package file installs and which is not declared external", u.Name, f)
			}
		}
	}
}

// dpkg removes files that a new version stops shipping. The lobby's chunks are
// content-hashed and a tab on the previous build still requests the old names —
// as does a rollback — so the served asset directory is installed additively by
// the maintainer script and pruned by age, never owned by dpkg.
func TestTheServedAssetDirectoryIsNotPackageOwned(t *testing.T) {
	for _, f := range Package.Files {
		if strings.HasPrefix(f.Dest, ServedAssetDir+"/") {
			t.Errorf("%s is dpkg-owned; upgrading would delete chunks that open tabs still request", f.Dest)
		}
	}
	if Package.AssetPayload == "" {
		t.Fatal("the package must carry the chunks as a payload for the maintainer script to install additively")
	}
	if !strings.HasPrefix(Package.AssetPayload, "/usr/share/") {
		t.Errorf("the payload belongs under /usr/share, got %q", Package.AssetPayload)
	}
}

// The identity map and the admin list are generated from the roster by the
// hourly reconcile and have exactly one writer. Packaging them would make a
// second one.
func TestTheGeneratedIdentityFilesAreNotShipped(t *testing.T) {
	for _, f := range Package.Files {
		switch f.Dest {
		case "/etc/ttyd-user-map", "/etc/ttyd-admins":
			t.Errorf("%s is generated from roster.yaml; the package must not write it", f.Dest)
		}
	}
}

func TestTheSudoersGrantIsShippedAndValidated(t *testing.T) {
	var found *File
	for i, f := range Package.Files {
		if f.Dest == "/etc/sudoers.d/ttyd-users" {
			found = &Package.Files[i]
		}
	}
	if found == nil {
		t.Fatal("the sudo grant every attach depends on must ship with the application")
	}
	if found.Mode != 0o440 {
		t.Errorf("sudoers grant mode is %o, want 440", found.Mode)
	}
	if !found.Validate {
		t.Error("a malformed sudoers grant locks everyone out; it must be validated before install")
	}
}

func TestEveryShippedBinaryHasAUnitOrIsDeliberatelyUnmanaged(t *testing.T) {
	watched := make(map[string]bool)
	for _, u := range Package.Units {
		for _, f := range u.Files {
			watched[f] = true
		}
	}
	// tl-t3-bridge is spawned by T3 per turn, not run as a unit; the helper
	// scripts are invoked by ttyd and by sessions.
	for _, f := range Package.Files {
		if !strings.HasPrefix(f.Dest, "/usr/local/bin/") || f.Unmanaged {
			continue
		}
		if !watched[f.Dest] {
			t.Errorf("%s is shipped, has no unit watching it, and is not marked unmanaged", f.Dest)
		}
	}
}

func TestEveryServiceUnitHasAtLeastOneCheck(t *testing.T) {
	checked := map[string]bool{}
	for _, c := range Package.Checks {
		checked[c.Unit] = true
	}
	for _, u := range Package.Units {
		// The templated syncer may have no enabled instance to probe.
		if u.Template {
			continue
		}
		if !checked[u.Name] {
			t.Errorf("unit %s has no check; a release could break it and still verify clean", u.Name)
		}
	}
}

// An authed surface answering 200 without credentials is a worse outcome than
// one that is down, so the checks assert the refusal as well as the health.
func TestTheAuthedSurfacesAreProbedUnauthenticated(t *testing.T) {
	var refusals int
	for _, c := range Package.Checks {
		if c.WantStatus == 401 {
			refusals++
		}
	}
	if refusals == 0 {
		t.Fatal("no check asserts that an authed surface refuses an unauthenticated request")
	}
}
