package release

import (
	"regexp"
	"strings"
	"testing"
)

// What the package installs for the T3 view (ADR-0044): the sidecar bundle
// tl-t3-view, the pinned T3 web client it serves, and the unit that runs it.

const (
	t3ViewDir     = "/usr/lib/terminal-lobby/tl-t3-view"
	t3ViewBundle  = t3ViewDir + "/tl-t3-view.mjs"
	t3ViewWebDir  = t3ViewDir + "/web"
	t3ViewUnit    = "/etc/systemd/system/tl-t3-view.service"
	t3ViewUnitSrc = "devvm/tl-t3-view.service"
)

func t3ViewUnitFile(t *testing.T) string {
	t.Helper()
	return repoFile(t, strings.Split(t3ViewUnitSrc, "/")...)
}

// The bundle is watched by its unit, so a new sidecar restarts it. The web
// client is a tree: the sidecar reads it per request, so it needs no restart,
// and T3 reloads once by itself when a hashed chunk it asks for has gone.
func TestTheT3ViewShipsItsBundleAndWebClient(t *testing.T) {
	f := shippedFile(t, t3ViewBundle)
	if f.Src != "bin/tl-t3-view.mjs" {
		t.Errorf("the bundle installs from %q, want bin/tl-t3-view.mjs", f.Src)
	}
	shippedTree(t, t3ViewWebDir)
	shippedFile(t, t3ViewUnit)
	var unit *Unit
	for i := range Package.Units {
		if Package.Units[i].Name == "tl-t3-view" {
			unit = &Package.Units[i]
		}
	}
	if unit == nil {
		t.Fatal("no tl-t3-view unit, so a new sidecar never restarts")
	}
	for _, want := range []string{t3ViewBundle, t3ViewUnit} {
		if !strings.Contains(strings.Join(unit.Files, " "), want) {
			t.Errorf("tl-t3-view does not watch %s", want)
		}
	}
}

// The sidecar's compiled-in default is where the package puts the web client;
// the unit runs the bundle where the package puts it.
func TestTheT3ViewRunsFromWhereThePackageInstallsIt(t *testing.T) {
	m := regexp.MustCompile(`TL_T3_VIEW_WEB_DIR"\) \?\? "([^"]+)"`).FindStringSubmatch(repoFile(t, "t3-view", "src", "config.ts"))
	if m == nil {
		t.Fatal("no TL_T3_VIEW_WEB_DIR default in t3-view/src/config.ts, so nothing here knows where the sidecar looks")
	}
	if m[1] != t3ViewWebDir {
		t.Errorf("the sidecar serves %s and the package installs the web client at %s", m[1], t3ViewWebDir)
	}
	unit := t3ViewUnitFile(t)
	if !regexp.MustCompile(`(?m)^ExecStart=/usr/bin/node ` + regexp.QuoteMeta(t3ViewBundle) + `$`).MatchString(unit) {
		t.Errorf("%s does not run node on %s", t3ViewUnitSrc, t3ViewBundle)
	}
}

// The sidecar verifies the proxy secret through tmux-api and refuses to start
// holding it (t3-view/src/config.ts). Every unit reads the same two config
// files, and the local one carries TL_PROXY_SECRET on this box, so the unit
// has to drop it after reading them.
func TestTheT3ViewUnitDropsTheProxySecret(t *testing.T) {
	unit := t3ViewUnitFile(t)
	for _, want := range []string{
		"EnvironmentFile=-" + ConfigPath,
		"EnvironmentFile=-" + LocalConfigPath,
		"UnsetEnvironment=TL_PROXY_SECRET",
		"User=wizard",
	} {
		if !regexp.MustCompile(`(?m)^` + regexp.QuoteMeta(want) + `$`).MatchString(unit) {
			t.Errorf("%s does not carry %s", t3ViewUnitSrc, want)
		}
	}
}

// A Node process with a cache per user and session has a reason to grow, so
// it gets a ceiling, like tl-session-watch.
func TestTheT3ViewUnitHasAMemoryCeiling(t *testing.T) {
	if !regexp.MustCompile(`(?m)^MemoryMax=\d+[MG]$`).MatchString(t3ViewUnitFile(t)) {
		t.Errorf("%s sets no MemoryMax", t3ViewUnitSrc)
	}
}

func TestTheT3ViewIsEnabled(t *testing.T) {
	for _, u := range Package.Enable {
		if u == "tl-t3-view" {
			return
		}
	}
	t.Error("tl-t3-view is not enabled; it would not come back after a reboot")
}

// The T3 view is a third view beside the Text view, which stays the default.
// A failed probe here means "this one view is not answering", and a revert
// would hold every later deploy of the lobby (Decide returns RevertAndHold),
// so its checks are advisory. They still assert the refusal, because a
// sidecar answering without credentials is worse than one that is down.
//
// The refusal has to be asked of a route that needs a credential. T3's apps
// read the environment descriptor, the token exchange and the session state
// before they have paired (ADR-0045), so those answer anyone and a 401 probe
// on them would always fail.
func TestTheT3ViewsChecksCannotDowngradeTheBox(t *testing.T) {
	credentialless := []string{"/.well-known/t3/environment", "/oauth/token", "/api/auth/session"}
	var seen, refusals int
	for _, c := range Package.Checks {
		if c.Unit != "tl-t3-view" {
			continue
		}
		seen++
		if !c.Advisory {
			t.Errorf("check %q is gating; the T3 view failing would revert and hold the package", c.Name)
		}
		if c.WantStatus == 401 {
			refusals++
			for _, path := range credentialless {
				if strings.HasSuffix(c.URL, path) {
					t.Errorf("check %q expects 401 from %s, which answers without a credential", c.Name, path)
				}
			}
		}
	}
	if seen == 0 {
		t.Fatal("tl-t3-view has no check at all")
	}
	if refusals == 0 {
		t.Error("no tl-t3-view check asserts that it refuses an anonymous request")
	}
}

// The build stages the web client from build-web.sh's output and bundles the
// sidecar against the same pinned checkout.
func TestTheBuildStagesTheT3View(t *testing.T) {
	build := buildScript(t)
	for _, want := range []string{
		"t3-view/scripts/build-web.sh",
		"t3-view/scripts/link-t3.sh",
		`t3-view/scripts/build-sidecar.sh -o "$STAGE/bin/tl-t3-view.mjs"`,
	} {
		if !strings.Contains(build, want) {
			t.Errorf("packaging/build-deb.sh does not run %s", want)
		}
	}
}
