package main

import (
	"net/http"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// pinsEnv is a getenv that knows only TL_CALLER_PINS.
func pinsEnv(raw string) func(string) string {
	return func(k string) string {
		if k == "TL_CALLER_PINS" {
			return raw
		}
		return ""
	}
}

func TestCallerPinsParses(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want map[string]callerPin
	}{
		{"unset", "", nil},
		{"blank", "  ", nil},
		{
			"one caller, every field",
			"muse:model=claude-opus-5-5,effort=xhigh,permission_mode=bypassPermissions",
			map[string]callerPin{"muse": {Model: "claude-opus-5-5", Effort: "xhigh", PermissionMode: "bypassPermissions"}},
		},
		{
			"two callers, spaces, one field each",
			" muse : effort=xhigh ; homelab:permission_mode=plan ",
			map[string]callerPin{
				"muse":    {Effort: "xhigh"},
				"homelab": {PermissionMode: "plan"},
			},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, bad := callerPins(pinsEnv(c.raw))
			if len(bad) != 0 {
				t.Fatalf("refused %v", bad)
			}
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("got %+v, want %+v", got, c.want)
			}
		})
	}
}

// A bad entry is left out and named, never half-applied: a pin that is
// partly there would launch a session nobody configured. The other callers'
// pins still hold.
func TestCallerPinsRefusesABadEntryAndKeepsTheRest(t *testing.T) {
	for _, bad := range []string{
		"nocolon",
		":effort=high",
		"muse:",
		"muse:effort",
		"muse:effort=ultra",
		"muse:permission_mode=yolo",
		"muse:model=bad model",
		"muse:colour=blue",
		"muse:effort=high,effort=low",
	} {
		got, refused := callerPins(pinsEnv(bad + ";homelab:effort=low"))
		if len(refused) != 1 {
			t.Errorf("%q: refused %v, want exactly one", bad, refused)
		}
		if _, ok := got["muse"]; ok {
			t.Errorf("%q: muse was pinned anyway: %+v", bad, got["muse"])
		}
		if got["homelab"] != (callerPin{Effort: "low"}) {
			t.Errorf("%q: the good entry was lost: %+v", bad, got)
		}
	}
}

// Viktor's ask (2026-10-09): Muse's sessions start on Opus 5.5 in bypass at
// xhigh, whatever its connector sends. It was sending claude-opus-5, max and
// "default", which is manual mode, so its sessions waited on approvals nobody
// was there to give.
func TestAPinnedCallerGetsThePinWhateverItSends(t *testing.T) {
	h := newHarness(t)
	h.srv.CallerPins = map[string]callerPin{testActor: {
		Model: "claude-opus-5-5", Effort: "xhigh", PermissionMode: "bypassPermissions",
	}}
	cwd := filepath.Join(h.homeBase, testOSUser, "code", "infra")

	for i, body := range []string{
		`{"cwd":` + jsonString(cwd) + `,"model":"claude-opus-5","effort":"max","permission_mode":"default"`,
		`{"cwd":` + jsonString(cwd),
	} {
		name := []string{"pin-explicit", "pin-omitted"}[i]
		h.decodeJSON(h.call("POST", "/v1/conversations", body+`,"name":"`+name+`"}`), http.StatusCreated, nil)
		created := h.sessions.createCalls()
		got := created[len(created)-1].Command[0]
		for _, want := range []string{"--model claude-opus-5-5", "--effort xhigh", "--permission-mode bypassPermissions"} {
			if !strings.Contains(got, want) {
				t.Errorf("%s: command %q lacks %q", name, got, want)
			}
		}
		for _, gone := range []string{"claude-opus-5 ", "--effort max", "--permission-mode default"} {
			if strings.Contains(got+" ", gone) {
				t.Errorf("%s: command %q still carries %q", name, got, gone)
			}
		}
	}
}

// A pin covers only the fields it names; the rest stay the caller's.
func TestAPinLeavesUnnamedFieldsToTheCaller(t *testing.T) {
	h := newHarness(t)
	h.srv.CallerPins = map[string]callerPin{testActor: {PermissionMode: "bypassPermissions"}}
	cwd := filepath.Join(h.homeBase, testOSUser, "code", "infra")

	h.decodeJSON(h.call("POST", "/v1/conversations",
		`{"cwd":`+jsonString(cwd)+`,"model":"claude-sonnet-5","effort":"low","permission_mode":"plan"}`), http.StatusCreated, nil)
	created := h.sessions.createCalls()
	got := stripRules(created[len(created)-1].Command[0])
	for _, want := range []string{"--model claude-sonnet-5", "--effort low", "--permission-mode bypassPermissions"} {
		if !strings.Contains(got, want) {
			t.Errorf("command %q lacks %q", got, want)
		}
	}
}

// Another caller is untouched by muse's pin.
func TestAPinBindsOnlyItsCaller(t *testing.T) {
	h := newHarness(t)
	h.srv.CallerPins = map[string]callerPin{"someone-else": {Model: "claude-opus-5-5", PermissionMode: "bypassPermissions"}}
	cwd := filepath.Join(h.homeBase, testOSUser, "code", "infra")

	h.decodeJSON(h.call("POST", "/v1/conversations",
		`{"cwd":`+jsonString(cwd)+`,"model":"claude-sonnet-5","permission_mode":"plan"}`), http.StatusCreated, nil)
	created := h.sessions.createCalls()
	got := created[len(created)-1].Command[0]
	if !strings.Contains(got, "--model claude-sonnet-5") || !strings.Contains(got, "--permission-mode plan") {
		t.Errorf("command %q, want the caller's own choices", got)
	}
}

// "inherit" drops the caller's value so the box's own default applies: no
// --model or --effort reaches claude, and managed-settings decides. Viktor,
// 2026-10-09: Muse follows the box default rather than a slug someone has to
// bump on every release.
func TestAnInheritPinDropsTheCallersValue(t *testing.T) {
	h := newHarness(t)
	h.srv.CallerPins = map[string]callerPin{testActor: {
		Model: pinInherit, Effort: pinInherit, PermissionMode: "bypassPermissions",
	}}
	cwd := filepath.Join(h.homeBase, testOSUser, "code", "infra")

	h.decodeJSON(h.call("POST", "/v1/conversations",
		`{"cwd":`+jsonString(cwd)+`,"model":"claude-opus-5","effort":"max","permission_mode":"default"}`), http.StatusCreated, nil)
	created := h.sessions.createCalls()
	got := created[len(created)-1].Command[0]
	for _, gone := range []string{"--model", "--effort", "--permission-mode default"} {
		if strings.Contains(got, gone) {
			t.Errorf("command %q still carries %q", got, gone)
		}
	}
	if !strings.Contains(got, "--permission-mode bypassPermissions") {
		t.Errorf("command %q lacks the pinned mode", got)
	}
}

// inherit on permission_mode gives this API's own default, bypass, rather
// than whatever the caller asked for.
func TestAnInheritPermissionModeGivesTheAPIDefault(t *testing.T) {
	h := newHarness(t)
	h.srv.CallerPins = map[string]callerPin{testActor: {PermissionMode: pinInherit}}
	cwd := filepath.Join(h.homeBase, testOSUser, "code", "infra")

	h.decodeJSON(h.call("POST", "/v1/conversations",
		`{"cwd":`+jsonString(cwd)+`,"permission_mode":"default"}`), http.StatusCreated, nil)
	created := h.sessions.createCalls()
	if got := created[len(created)-1].Command[0]; !strings.Contains(got, "--permission-mode "+defaultPermissionMode) {
		t.Errorf("command %q, want --permission-mode %s", got, defaultPermissionMode)
	}
}

func TestCallerPinsAcceptsInherit(t *testing.T) {
	got, bad := callerPins(pinsEnv("muse:model=inherit,effort=inherit,permission_mode=inherit"))
	if len(bad) != 0 {
		t.Fatalf("refused %v", bad)
	}
	want := callerPin{Model: pinInherit, Effort: pinInherit, PermissionMode: pinInherit}
	if got["muse"] != want {
		t.Fatalf("got %+v, want %+v", got["muse"], want)
	}
}
