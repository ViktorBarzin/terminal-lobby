package main

import (
	"errors"
	"strings"
	"testing"
)

// The bind, and the one property this service cannot be allowed to lose: it
// does not listen where the box-wide setting says the OTHER services listen.
//
// getenv and resolveOK are the two seams bindAddresses takes, so no test here
// reads the real environment or the real resolver.
func getenv(pairs map[string]string) func(string) string {
	return func(k string) string { return pairs[k] }
}

func resolveOK(string) error { return nil }

// /etc/terminal-lobby.local.conf on this devvm sets TL_BIND=0.0.0.0, because
// the five browser-facing services sit behind an ingress on another host and
// cannot bind loopback. agent-api has no proxy in front of it: it is reached
// over the tailnet, where the Headscale ACL opens :8710 to tag:muse alone. A
// service that inherited TL_BIND would come up on the LAN the moment the
// package installed, with one bearer credential in front of a port that
// creates and drives Claude sessions as a real account.
func TestBindNeverInheritsTheBoxWideTLBind(t *testing.T) {
	addrs, err := bindAddresses(getenv(map[string]string{"TL_BIND": "0.0.0.0"}), resolveOK)
	if err != nil {
		t.Fatalf("bindAddresses: %v", err)
	}
	for _, addr := range addrs {
		if !strings.HasPrefix(addr, "127.0.0.1:") {
			t.Fatalf("bound %v with TL_BIND=0.0.0.0 in the environment, want loopback only", addrs)
		}
	}
	// And the operator who set it is told, rather than left to work out why
	// the caller cannot connect.
	note := ignoredBoxWideBind(addrs, "0.0.0.0")
	if !strings.Contains(note, "TL_BIND=0.0.0.0") || !strings.Contains(note, "TL_AGENT_BIND") {
		t.Fatalf("startup line %q names neither the setting it ignored nor the one to use", note)
	}
	if quiet := ignoredBoxWideBind(addrs, ""); quiet != "" {
		t.Fatalf("said %q about a TL_BIND nobody set", quiet)
	}
}

// Widening is this service's own key, and it adds an address rather than
// moving off loopback — tl-apply verifies the install by probing
// 127.0.0.1:8710, so a service that moved would fail its own verification.
func TestBindAddsTheTailnetAddressAndKeepsLoopback(t *testing.T) {
	addrs, err := bindAddresses(getenv(map[string]string{
		"TL_AGENT_BIND": "100.64.0.42",
		"TL_BIND":       "0.0.0.0",
	}), resolveOK)
	if err != nil {
		t.Fatalf("bindAddresses: %v", err)
	}
	want := []string{"127.0.0.1:8710", "100.64.0.42:8710"}
	if len(addrs) != len(want) {
		t.Fatalf("bound %v, want %v", addrs, want)
	}
	for i, w := range want {
		if addrs[i] != w {
			t.Fatalf("bound %v, want %v", addrs, want)
		}
	}
}

// The values that stop the service rather than moving it somewhere nobody
// chose.
func TestBindRefusals(t *testing.T) {
	for _, c := range []struct {
		name    string
		value   string
		resolve func(string) error
		want    string
	}{
		{"every interface", "0.0.0.0", resolveOK, "unspecified"},
		{"every interface, v6", "::", resolveOK, "unspecified"},
		{"a port and no address", ":9000", resolveOK, "every interface"},
		{"a name that does not resolve", "typo.viktorbarzin.lan", func(string) error {
			return errors.New("no such host")
		}, "cannot resolve"},
	} {
		t.Run(c.name, func(t *testing.T) {
			addrs, err := bindAddresses(getenv(map[string]string{"TL_AGENT_BIND": c.value}), c.resolve)
			if err == nil {
				t.Fatalf("bound %v, want a refusal", addrs)
			}
			if !strings.Contains(err.Error(), c.want) {
				t.Fatalf("refusal %q does not say why", err)
			}
		})
	}
}

// Binding past this host is possible — a LAN address is a literal that
// resolves — and it is never silent.
func TestBindWarning(t *testing.T) {
	for _, c := range []struct {
		name string
		addr string
		warn bool
	}{
		{"loopback", "127.0.0.1:8710", false},
		{"IPv6 loopback", "[::1]:8710", false},
		{"the tailnet", "100.64.0.42:8710", false},
		{"the far end of the tailnet range", "100.127.255.254:8710", false},
		{"a LAN address", "192.168.1.50:8710", true},
		{"a hostname says nothing either way", "devvm.viktorbarzin.lan:8710", false},
		{"an unparseable address", "nonsense", false},
	} {
		t.Run(c.name, func(t *testing.T) {
			got := bindWarning(c.addr, "wizard")
			if (got != "") != c.warn {
				t.Fatalf("bindWarning(%q) = %q, want a warning: %v", c.addr, got, c.warn)
			}
			if c.warn && !strings.Contains(got, "TL_AGENT_BIND") {
				t.Fatalf("the warning does not say what to change: %q", got)
			}
		})
	}
}
