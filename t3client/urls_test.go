package t3client

import (
	"strings"
	"testing"
)

func TestEncodeURIComponent(t *testing.T) {
	cases := map[string]string{
		"mcp:abc":                        "mcp%3Aabc",
		"import:claudeAgent:x-y":         "import%3AclaudeAgent%3Ax-y",
		"a b/c?d#e&f=g+h":                "a%20b%2Fc%3Fd%23e%26f%3Dg%2Bh",
		"AZaz09-_.!~*'()":                "AZaz09-_.!~*'()",
		"é":                              "%C3%A9",
		"5c1f6b8e-2d7b-4b55-8a0f-1a9d2c": "5c1f6b8e-2d7b-4b55-8a0f-1a9d2c",
		"%":                              "%25",
	}
	for in, want := range cases {
		if got := EncodeURIComponent(in); got != want {
			t.Errorf("EncodeURIComponent(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestThreadURLs(t *testing.T) {
	loc := Location{User: "wizard", Host: "t3.example.org", EnvironmentID: "env-1"}
	id := "mcp:launch:abc"
	if got, want := loc.WebURL(id), "https://t3.example.org/env-1/mcp%3Alaunch%3Aabc"; got != want {
		t.Errorf("WebURL = %q, want %q", got, want)
	}
	if got, want := loc.AppURL(id), "t3code://threads/env-1/mcp:launch:abc"; got != want {
		t.Errorf("AppURL = %q, want %q", got, want)
	}
}

func TestHosts(t *testing.T) {
	h, err := ParseHosts("wizard=t3.viktorbarzin.me, ancamilea=t3-anca.example.org", "viktorbarzin.me")
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]string{
		"wizard":    "t3.viktorbarzin.me",
		"ancamilea": "t3-anca.example.org",
		"emo":       "t3-emo.viktorbarzin.me",
	}
	for u, want := range cases {
		if got := h.Host(u); got != want {
			t.Errorf("Host(%q) = %q, want %q", u, got, want)
		}
	}
}

func TestParseHostsRejects(t *testing.T) {
	for _, spec := range []string{"wizard", "=x.org", "wizard=", "wizard=a.org,wizard=b.org", "../x=a.org", "wizard=a.org/path", "wizard=https://a.org"} {
		if _, err := ParseHosts(spec, "d.org"); err == nil {
			t.Errorf("ParseHosts(%q) accepted", spec)
		}
	}
	if _, err := ParseHosts("", ""); err == nil {
		t.Error("an empty domain was accepted")
	}
}

func TestHostsFromEnv(t *testing.T) {
	env := map[string]string{"TL_T3_HOSTS": "wizard=t3.viktorbarzin.me"}
	h, err := HostsFromEnv(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if got := h.Host("emo"); got != "t3-emo."+DefaultDomain {
		t.Errorf("default host = %q", got)
	}
	env["TL_T3_DOMAIN"] = "example.org"
	h, err = HostsFromEnv(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if got := h.Host("emo"); got != "t3-emo.example.org" {
		t.Errorf("host with TL_T3_DOMAIN = %q", got)
	}
	if !strings.Contains(h.Host("wizard"), "t3.viktorbarzin.me") {
		t.Errorf("override lost: %q", h.Host("wizard"))
	}
}
