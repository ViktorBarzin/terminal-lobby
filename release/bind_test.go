package release

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// ttyd took neither TL_BIND nor TL_PROXY_SECRET (TL-5). It has no support for a
// shared secret at all — the -H header it trusts is the whole of its auth — so
// the only lever it has is where it listens, and it was ignoring the one
// variable that says. An operator who narrowed TL_BIND, or who set the secret,
// still shipped a terminal on 7681 that answered a self-asserted header from
// anywhere.
//
// Verified live before this landed, because a silently ignored flag here fails
// open: ttyd 1.7.7-40e79c7 with -i 127.0.0.1 binds 127.0.0.1, and with
// -i 0.0.0.0 binds 0.0.0.0, both confirmed with ss.
func TestTtydHonoursTheBindAddress(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "devvm", "ttyd.service"))
	if err != nil {
		t.Fatal(err)
	}
	unit := string(b)

	var exec string
	for _, line := range strings.Split(unit, "\n") {
		if strings.HasPrefix(line, "ExecStart=") {
			exec = line
		}
	}
	if exec == "" {
		t.Fatal("no ExecStart in devvm/ttyd.service")
	}
	if !strings.Contains(exec, "-i ${TL_BIND}") {
		t.Errorf("ttyd's ExecStart does not pass -i ${TL_BIND}: %s", exec)
	}
	// systemd substitutes an unset ${VAR} as an empty argument, and `-i ""`
	// stops ttyd from starting. The unit's own Environment= is applied before
	// either EnvironmentFile, so it is the floor when no config file exists.
	if !strings.Contains(unit, "Environment=TL_BIND=") {
		t.Error("devvm/ttyd.service passes -i ${TL_BIND} with no Environment=TL_BIND= fallback; " +
			"a box with no config file would start ttyd with an empty -i")
	}
	// And that floor is loopback, for the same reason the five compiled
	// defaults below are: a box with no config file must not put a terminal
	// that trusts a self-asserted header on every interface.
	if !strings.Contains(unit, "Environment=TL_BIND=127.0.0.1") {
		t.Error("devvm/ttyd.service's TL_BIND floor is not 127.0.0.1; with no config " +
			"file present that opens 7681 to the network (TL-3, TL-5)")
	}
}

// The compiled defaults are the floor a process falls to when no configuration
// reaches it at all, and they are the half of TL-3 that does not depend on an
// operator. The shipped conffile already says TL_BIND=127.0.0.1; a unit whose
// optional EnvironmentFile is absent has to land on the same address, or five
// services and ttyd bind every interface with TL_AUTH_HEADER as the only thing
// authenticating a request. Widening stays an explicit act, made in the file
// where the operator also sets TL_PROXY_SECRET.
//
// Read out of the sources rather than imported: these are five separate Go
// modules and release requires none of them.
func TestCompiledBindDefaultsAreLoopback(t *testing.T) {
	cases := map[string]*regexp.Regexp{
		"clipboard-upload/main.go": regexp.MustCompile(`listenAddr\s*=\s*"([^"]*)"`),
		"tmux-api/main.go":         regexp.MustCompile(`listenAddr\s*=\s*"([^"]*)"`),
		"file-api/main.go":         regexp.MustCompile(`listenAddr\s*=\s*"([^"]*)"`),
		"skills-api/main.go":       regexp.MustCompile(`listenAddr\s*=\s*"([^"]*)"`),
		// session-events has no constant; its flag default is the same floor.
		"session-events/main.go": regexp.MustCompile(`flag\.String\("addr",\s*"([^"]*)"`),
	}
	for rel, re := range cases {
		b, err := os.ReadFile(filepath.Join("..", filepath.FromSlash(rel)))
		if err != nil {
			t.Fatal(err)
		}
		m := re.FindSubmatch(b)
		if m == nil {
			t.Fatalf("%s: no compiled listen address matched %s", rel, re)
		}
		if got := string(m[1]); !strings.HasPrefix(got, "127.0.0.1:") {
			t.Errorf("%s compiles in %q; with no config file that binds every interface, "+
				"and the identity header is all that authenticates a request (TL-3)", rel, got)
		}
	}
}

// TL_PROXY_SECRET must stay unset by the migration. The snippet runs in
// postinst on a box whose proxy is not sending the header yet, so writing a
// live value would refuse every request at the next restart — the outage the
// two-file split exists to avoid. What it owes the operator is the instruction
// and an honest line in the install log.
func TestMigrationNamesTheSecretWithoutSettingIt(t *testing.T) {
	for _, line := range strings.Split(MigrateConfigSnippet, "\n") {
		l := strings.TrimSpace(line)
		if strings.HasPrefix(l, "TL_PROXY_SECRET=") {
			t.Fatalf("the migration writes a live secret (%q); the proxy is not sending one yet", l)
		}
	}
	for _, want := range []string{"TL_PROXY_SECRET", "X-TL-Proxy-Secret"} {
		if !strings.Contains(MigrateConfigSnippet, want) {
			t.Errorf("the migration never mentions %s", want)
		}
	}
	// The snippet is what widens the bind on an upgraded box, so it is the
	// place that owes the operator a word about what that opens.
	if !strings.Contains(MigrateConfigSnippet, "echo \"terminal-lobby: TL_BIND=0.0.0.0") {
		t.Error("the migration widens the bind without saying so in the install log")
	}
}

// The shipped config is where an operator reads what the secret covers. It
// covers the five HTTP services; ttyd is not one of them.
func TestShippedConfigSaysWhatTheSecretCovers(t *testing.T) {
	cfg := DefaultConfig()
	for _, want := range []string{"X-TL-Proxy-Secret", "ttyd"} {
		if !strings.Contains(cfg, want) {
			t.Errorf("DefaultConfig() never mentions %s", want)
		}
	}
}
