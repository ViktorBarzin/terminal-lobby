package main

import (
	"strings"
	"testing"
)

// The line format is logfmt because that is what LogQL parses without a
// hand-written regexp, and every field these lines carry becomes something an
// alert rule can group by.
func TestLineIsLogfmt(t *testing.T) {
	got := Line(Finding{
		Kind: KindSessionDied, User: "wizard", Session: "immich", State: "running",
	})
	for _, want := range []string{
		`event=session_died`,
		`user=wizard`,
		`session=immich`,
		`state=running`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("want %q in %q", want, got)
		}
	}
}

func TestLineQuotesValuesThatNeedIt(t *testing.T) {
	// A session name may hold spaces, quotes and tabs. Unquoted, they would
	// split one record into several fields and misattribute the death.
	got := Line(Finding{Kind: KindSessionDied, User: "wizard", Session: `a "b" c`})
	if !strings.Contains(got, `session="a \"b\" c"`) {
		t.Fatalf("want the name quoted and escaped, got %q", got)
	}
}

func TestPaneLineCarriesTheNumbers(t *testing.T) {
	got := Line(Finding{
		Kind: KindPaneNearCap, User: "emo", Session: "infra",
		PaneBytes: 4 << 30, PaneLimit: 6 << 30,
	})
	for _, want := range []string{`event=pane_near_cap`, `pane_bytes=4294967296`, `pane_limit=6442450944`} {
		if !strings.Contains(got, want) {
			t.Errorf("want %q in %q", want, got)
		}
	}
}

func TestRebootLineCarriesTheRestoreGap(t *testing.T) {
	got := Line(Finding{Kind: KindRebooted, User: "wizard", Before: 20, After: 18})
	for _, want := range []string{`event=rebooted`, `before=20`, `after=18`} {
		if !strings.Contains(got, want) {
			t.Errorf("want %q in %q", want, got)
		}
	}
	// A reboot is about the box, not one session, so an empty session field
	// would read as a session literally named "".
	if strings.Contains(got, "session=") {
		t.Errorf("a reboot line names no session, got %q", got)
	}
}

func TestHeartbeatSaysWhatItSaw(t *testing.T) {
	// The heartbeat is what SessionWatchSilent waits for, so it has to appear
	// every tick regardless of whether anything was found.
	got := Heartbeat(2, 31)
	for _, want := range []string{`event=heartbeat`, `users=2`, `sessions=31`} {
		if !strings.Contains(got, want) {
			t.Errorf("want %q in %q", want, got)
		}
	}
}

// --- the exported metric --------------------------------------------------

func TestRenderTextfile(t *testing.T) {
	snaps := []Snapshot{{
		User: "wizard",
		Sessions: map[string]Session{
			"immich": {Name: "immich", PaneBytes: 1 << 30, PaneLimit: 6 << 30, TopIsClaude: true},
		},
	}}
	got := renderTextfile(snaps)

	for _, want := range []string{
		`# TYPE tl_pane_memory_bytes gauge`,
		`tl_pane_memory_bytes{user="wizard",session="immich"} 1073741824`,
		`tl_pane_memory_max_bytes{user="wizard",session="immich"} 6442450944`,
		`tl_pane_top_is_claude{user="wizard",session="immich"} 1`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("want %q in:\n%s", want, got)
		}
	}
}

func TestRenderTextfileEscapesLabelValues(t *testing.T) {
	// An unescaped quote or backslash in a session name makes the whole file
	// unparseable, which takes out every series in it, not just this one.
	snaps := []Snapshot{{
		User:     "wizard",
		Sessions: map[string]Session{`a"b\c`: {Name: `a"b\c`, PaneBytes: 1, PaneLimit: 2}},
	}}
	got := renderTextfile(snaps)
	if !strings.Contains(got, `session="a\"b\\c"`) {
		t.Fatalf("want the label value escaped, got:\n%s", got)
	}
}

func TestRenderTextfileEndsWithANewline(t *testing.T) {
	// node_exporter rejects a textfile whose last line is unterminated.
	got := renderTextfile([]Snapshot{{
		User:     "wizard",
		Sessions: map[string]Session{"a": {Name: "a", PaneBytes: 1, PaneLimit: 2}},
	}})
	if !strings.HasSuffix(got, "\n") {
		t.Fatal("want a trailing newline")
	}
}

func TestRenderTextfileIsStableAcrossRuns(t *testing.T) {
	// Map iteration order is random, and a file whose line order churns every
	// 30 seconds makes a diff useless for working out what changed.
	snaps := []Snapshot{{
		User: "wizard",
		Sessions: map[string]Session{
			"c": {Name: "c", PaneBytes: 3, PaneLimit: 9},
			"a": {Name: "a", PaneBytes: 1, PaneLimit: 9},
			"b": {Name: "b", PaneBytes: 2, PaneLimit: 9},
		},
	}}
	first := renderTextfile(snaps)
	for i := 0; i < 20; i++ {
		if renderTextfile(snaps) != first {
			t.Fatal("output order is not stable across runs")
		}
	}
	ai, bi, ci := strings.Index(first, `"a"`), strings.Index(first, `"b"`), strings.Index(first, `"c"`)
	if !(ai < bi && bi < ci) {
		t.Fatalf("want sessions in name order, got a=%d b=%d c=%d", ai, bi, ci)
	}
}

