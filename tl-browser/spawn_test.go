package main

import (
	"reflect"
	"sort"
	"testing"
)

func TestSystemdRunArgvIsExact(t *testing.T) {
	got := systemdRunArgs("tl-browser-s12-4321", []string{"node", "/usr/lib/terminal-lobby/tl-browser-host/host.mjs"})
	want := []string{
		"systemd-run", "--user", "--scope", "--quiet", "--collect",
		"--slice=tl-browser.slice",
		"--unit=tl-browser-s12-4321",
		"-p", "MemoryHigh=1G",
		"-p", "MemoryMax=1536M",
		"-p", "CPUQuota=300%",
		"-p", "CPUWeight=50",
		"--",
		"node", "/usr/lib/terminal-lobby/tl-browser-host/host.mjs",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("systemd-run argv\n got %q\nwant %q", got, want)
	}
}

func TestSystemdSpawnerNamesEachRespawn(t *testing.T) {
	s := SystemdSpawner{Base: "tl-browser-s12-4321"}
	first, err := s.Command([]string{"node", "host.mjs"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if first.Unit != "tl-browser-s12-4321" {
		t.Fatalf("first unit = %s", first.Unit)
	}
	// A respawn right after an exit can race systemd collecting the old scope,
	// so later ones carry the spawn count.
	second, _ := s.Command([]string{"node", "host.mjs"}, 2)
	if second.Unit != "tl-browser-s12-4321-2" {
		t.Fatalf("second unit = %s", second.Unit)
	}
	if second.Argv[0] != "systemd-run" {
		t.Fatalf("argv = %q", second.Argv)
	}
}

func TestDirectSpawnerRunsTheHostItself(t *testing.T) {
	c, err := DirectSpawner{}.Command([]string{"node", "host.mjs"}, 3)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(c.Argv, []string{"node", "host.mjs"}) || c.Unit != "" {
		t.Fatalf("direct = %+v", c)
	}
}

func TestUnitBase(t *testing.T) {
	cases := []struct {
		name, sessionID string
		ppid, pid       int
		want            string
	}{
		{"tmux session", "$12", 100, 4321, "tl-browser-s12-4321"},
		{"outside tmux, named by the parent", "", 100, 4321, "tl-browser-100-4321"},
		{"odd characters dropped", "$1\n2/;", 100, 7, "tl-browser-s12-7"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := unitBase(c.sessionID, c.ppid, c.pid); got != c.want {
				t.Fatalf("unitBase = %s, want %s", got, c.want)
			}
		})
	}
}

func TestPassthroughEnv(t *testing.T) {
	in := []string{
		"TMUX=/tmp/tmux-1000/default,1,0",
		"TMUX_PANE=%3",
		"XDG_RUNTIME_DIR=/run/user/1000",
		"HOME=/home/u",
		"PATH=/usr/bin",
		"TL_BROWSER_IDLE_FREEZE_MS=1000",
		"TL_BROWSER_HOST=/x/host.mjs",
		"ANTHROPIC_API_KEY=secret",
		"CLAUDECODE=1",
		"TMUXX=no",
	}
	got := passthroughEnv(in)
	sort.Strings(got)
	want := []string{
		"HOME=/home/u",
		"PATH=/usr/bin",
		"TL_BROWSER_HOST=/x/host.mjs",
		"TL_BROWSER_IDLE_FREEZE_MS=1000",
		"TMUX=/tmp/tmux-1000/default,1,0",
		"TMUX_PANE=%3",
		"XDG_RUNTIME_DIR=/run/user/1000",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("passthroughEnv\n got %q\nwant %q", got, want)
	}
}
