package main

import (
	"testing"
	"time"
)

// cfg is the shape every test starts from: warn at 3 GiB, confirm a dead claude
// over two consecutive ticks, and ignore the prewarm pool.
const MiB = 1 << 20

func cfg() Config {
	return Config{
		PaneWarnBytes:  3 * GiB,
		ConfirmTicks:   2,
		SkipPrefixes:   []string{"__terminal_lobby_"},
		TombstoneGrace: 90 * time.Second,
	}
}

// live builds a session that looks entirely healthy, which each test then
// spoils in exactly one way. Sessions that differ from healthy in several
// places at once make it unclear which difference the assertion is about.
func live(name string) Session {
	return Session{
		Name:              name,
		ClaudeState:       "running",
		ClaudeAlive:       true,
		PaneBytes:         1 * GiB,
		PaneUnreclaimable: 500 * MiB,
		PaneLimit:         6 * GiB,
		TopIsClaude:       true,
	}
}

// now is a fixed clock, so a tombstone's age in a test is exact.
var now = time.Date(2026, 9, 1, 18, 0, 0, 0, time.UTC)

func snap(user, boot string, sessions ...Session) Snapshot {
	s := Snapshot{User: user, BootID: boot, Taken: now, Sessions: map[string]Session{}, Tombstones: map[string]int64{}}
	for _, sess := range sessions {
		s.Sessions[sess.Name] = sess
	}
	return s
}

// forgot stamps a deliberate kill of name, secs ago.
func forgot(s Snapshot, name string, secs int) Snapshot {
	s.Tombstones[name] = s.Taken.Add(-time.Duration(secs) * time.Second).Unix()
	return s
}

// only returns the single finding of a kind, failing when the count is not one.
// Most assertions here are "exactly one of these, and it says X".
func only(t *testing.T, got []Finding, kind Kind) Finding {
	t.Helper()
	var hits []Finding
	for _, f := range got {
		if f.Kind == kind {
			hits = append(hits, f)
		}
	}
	if len(hits) != 1 {
		t.Fatalf("want exactly 1 %s finding, got %d (all findings: %+v)", kind, len(hits), got)
	}
	return hits[0]
}

func none(t *testing.T, got []Finding, kind Kind) {
	t.Helper()
	for _, f := range got {
		if f.Kind == kind {
			t.Fatalf("want no %s finding, got %+v (all: %+v)", kind, f, got)
		}
	}
}

// --- seeding ---------------------------------------------------------------

// The first tick has nothing to compare against. A watcher that treated an
// empty previous snapshot as "everything just vanished" would alert on every
// session on the box each time it restarted.
func TestFirstTickSeedsWithoutDeaths(t *testing.T) {
	w := NewWatcher(cfg())
	got := w.Tick([]Snapshot{snap("wizard", "boot-1", live("immich"), live("f1"))})
	none(t, got, KindSessionDied)
	none(t, got, KindClaudeDied)
	none(t, got, KindRebooted)
}

// --- shape 2: the session left tmux ---------------------------------------

// A tombstone is what carries intent: tmux-persist-forget appends
// <session>\t<epoch> to <user>.forgotten.tsv. No tombstone means nobody ended
// this session on purpose.
func TestVanishedWithNoTombstoneIsADeath(t *testing.T) {
	w := NewWatcher(cfg())
	w.Tick([]Snapshot{snap("wizard", "boot-1", live("immich"), live("f1"))})

	f := only(t, w.Tick([]Snapshot{snap("wizard", "boot-1", live("f1"))}), KindSessionDied)
	if f.Session != "immich" || f.User != "wizard" {
		t.Fatalf("want wizard/immich, got %s/%s", f.User, f.Session)
	}
}

// A kill through the lobby calls tmux-persist-forget, which tombstones the name.
// That is a deliberate end and must not reach Slack.
func TestVanishedWithAFreshTombstoneIsAKill(t *testing.T) {
	w := NewWatcher(cfg())
	w.Tick([]Snapshot{snap("wizard", "boot-1", live("immich"), live("f1"))})

	got := w.Tick([]Snapshot{forgot(snap("wizard", "boot-1", live("f1")), "immich", 5)})
	none(t, got, KindSessionDied)
	only(t, got, KindSessionKilled)
}

// The tombstone file is append-only and never pruned, so a name killed weeks ago
// still has a row. Without the age check, a session that reused that name and
// then genuinely died would be written off as a deliberate kill — which is the
// one failure this whole alert exists to prevent.
func TestVanishedWithAStaleTombstoneIsStillADeath(t *testing.T) {
	w := NewWatcher(cfg())
	w.Tick([]Snapshot{snap("wizard", "boot-1", live("immich"), live("f1"))})

	got := w.Tick([]Snapshot{forgot(snap("wizard", "boot-1", live("f1")), "immich", 600)})
	only(t, got, KindSessionDied)
	none(t, got, KindSessionKilled)
}

// A tombstone for a session that is still running says nothing about it: the
// name was killed in an earlier life and created again.
func TestATombstoneForALiveSessionSaysNothing(t *testing.T) {
	w := NewWatcher(cfg())
	s := forgot(snap("wizard", "boot-1", live("immich")), "immich", 5)
	w.Tick([]Snapshot{s})
	got := w.Tick([]Snapshot{s})
	none(t, got, KindSessionDied)
	none(t, got, KindSessionKilled)
}

// A death is one episode, not one per tick. Without this the journal carries a
// line every 30s for as long as the row sits in the manifest.
func TestADeathIsReportedOnce(t *testing.T) {
	w := NewWatcher(cfg())
	w.Tick([]Snapshot{snap("wizard", "boot-1", live("immich"))})

	cur := snap("wizard", "boot-1")

	only(t, w.Tick([]Snapshot{cur}), KindSessionDied)
	none(t, w.Tick([]Snapshot{cur}), KindSessionDied)
	none(t, w.Tick([]Snapshot{cur}), KindSessionDied)
}

// A restored session that dies again is a new episode and reports again.
func TestARestoredSessionCanDieAgain(t *testing.T) {
	w := NewWatcher(cfg())
	w.Tick([]Snapshot{snap("wizard", "boot-1", live("immich"))})

	gone := snap("wizard", "boot-1")
	only(t, w.Tick([]Snapshot{gone}), KindSessionDied)

	w.Tick([]Snapshot{snap("wizard", "boot-1", live("immich"))}) // restored
	only(t, w.Tick([]Snapshot{gone}), KindSessionDied)
}

// --- shape 1: claude died where the session survived ----------------------

// A clean exit clears the stamp (measured 2026-09-01), and a SIGKILL cannot run
// the hook that would. So a stamp with no claude behind it is a death.
func TestStampWithNoClaudeIsADeath(t *testing.T) {
	w := NewWatcher(cfg())
	dead := live("typeahead")
	dead.ClaudeAlive = false

	w.Tick([]Snapshot{snap("wizard", "boot-1", dead)})
	f := only(t, w.Tick([]Snapshot{snap("wizard", "boot-1", dead)}), KindClaudeDied)
	if f.Session != "typeahead" {
		t.Fatalf("want typeahead, got %s", f.Session)
	}
	if f.State != "running" {
		t.Fatalf("want the stamp carried into the finding, got %q", f.State)
	}
}

// Restarting claude to pick up a new skill set (session.claude_restarted) leaves
// a tick where the stamp is set and the process is briefly gone. Confirming over
// two ticks is what keeps that from paging anyone.
func TestABriefGapIsNotADeath(t *testing.T) {
	w := NewWatcher(cfg())
	dead := live("mpocock-skills")
	dead.ClaudeAlive = false

	w.Tick([]Snapshot{snap("wizard", "boot-1", live("mpocock-skills"))})
	none(t, w.Tick([]Snapshot{snap("wizard", "boot-1", dead)}), KindClaudeDied)
	none(t, w.Tick([]Snapshot{snap("wizard", "boot-1", live("mpocock-skills"))}), KindClaudeDied)
}

// A session that never ran claude has no stamp, so there is nothing to conclude
// from the absence of a claude process.
func TestNoStampMeansNoClaimAboutClaude(t *testing.T) {
	w := NewWatcher(cfg())
	shell := live("wireuard")
	shell.ClaudeState = ""
	shell.ClaudeAlive = false

	w.Tick([]Snapshot{snap("wizard", "boot-1", shell)})
	none(t, w.Tick([]Snapshot{snap("wizard", "boot-1", shell)}), KindClaudeDied)
}

func TestClaudeDeathIsReportedOnce(t *testing.T) {
	w := NewWatcher(cfg())
	dead := live("typeahead")
	dead.ClaudeAlive = false

	w.Tick([]Snapshot{snap("wizard", "boot-1", dead)})
	only(t, w.Tick([]Snapshot{snap("wizard", "boot-1", dead)}), KindClaudeDied)
	none(t, w.Tick([]Snapshot{snap("wizard", "boot-1", dead)}), KindClaudeDied)
}

// The prewarm pool slot holds a claude nobody is talking to. Its death costs no
// conversation, so it is not news.
func TestPrewarmPoolIsIgnored(t *testing.T) {
	w := NewWatcher(cfg())
	pool := live("__terminal_lobby_prewarmed_pool_slot__home_wizard_code")
	pool.ClaudeAlive = false

	w.Tick([]Snapshot{snap("wizard", "boot-1", pool)})
	none(t, w.Tick([]Snapshot{snap("wizard", "boot-1", pool)}), KindClaudeDied)

	none(t, w.Tick([]Snapshot{snap("wizard", "boot-1")}), KindSessionDied)
}

// --- reboots --------------------------------------------------------------

// Every session leaves tmux on a reboot and tmux-persist restores them, so the
// per-session signal means something different and the storm is not the story.
// The restore gap is.
func TestARebootIsOneFindingWithTheRestoreGap(t *testing.T) {
	w := NewWatcher(cfg())
	w.Tick([]Snapshot{snap("wizard", "boot-1", live("a"), live("b"), live("c"))})

	after := snap("wizard", "boot-2", live("a"), live("b")) // c did not come back

	got := w.Tick([]Snapshot{after})
	f := only(t, got, KindRebooted)
	if f.Before != 3 || f.After != 2 {
		t.Fatalf("want 3 before / 2 restored, got %d/%d", f.Before, f.After)
	}
	none(t, got, KindSessionDied)
	none(t, got, KindSessionKilled)
}

// --- the pane pre-warning ------------------------------------------------

// The gate is what makes a 3 GiB threshold safe: a claude at 3 GiB is ~6x its
// normal size, and the cap will pick it next.
func TestPaneOverThresholdWithClaudeFattestWarns(t *testing.T) {
	w := NewWatcher(cfg())
	big := live("infra")
	big.PaneBytes = 4 * GiB
	big.PaneUnreclaimable = 4 * GiB

	f := only(t, w.Tick([]Snapshot{snap("wizard", "boot-1", big)}), KindPaneNearCap)
	if f.Session != "infra" || f.PaneBytes != 4*GiB || f.PaneLimit != 6*GiB {
		t.Fatalf("want infra 4GiB/6GiB, got %s %d/%d", f.Session, f.PaneBytes, f.PaneLimit)
	}
}

// A test run or a build being the fattest process means the cap will eat the
// build, which is the mechanism working as designed. 1 of the 3 kills in the 7
// days before this was written was exactly that.
func TestPaneOverThresholdWithABuildFattestStaysQuiet(t *testing.T) {
	w := NewWatcher(cfg())
	big := live("infra")
	big.PaneBytes = 5 * GiB
	big.PaneUnreclaimable = 5 * GiB
	big.TopIsClaude = false

	none(t, w.Tick([]Snapshot{snap("wizard", "boot-1", big)}), KindPaneNearCap)
}

func TestPaneUnderThresholdStaysQuiet(t *testing.T) {
	w := NewWatcher(cfg())
	none(t, w.Tick([]Snapshot{snap("wizard", "boot-1", live("infra"))}), KindPaneNearCap)
}

// An uncapped pane has nothing about to kill it, so the warning would name a
// risk that does not exist.
func TestUncappedPaneStaysQuiet(t *testing.T) {
	w := NewWatcher(cfg())
	big := live("infra")
	big.PaneBytes = 5 * GiB
	big.PaneUnreclaimable = 5 * GiB
	big.PaneLimit = 0

	none(t, w.Tick([]Snapshot{snap("wizard", "boot-1", big)}), KindPaneNearCap)
}

// A pane sitting above the line for an hour is one episode. Re-crossing it after
// dropping back is a new one.
func TestPaneWarningIsPerEpisode(t *testing.T) {
	w := NewWatcher(cfg())
	big := live("infra")
	big.PaneBytes = 4 * GiB
	big.PaneUnreclaimable = 4 * GiB

	only(t, w.Tick([]Snapshot{snap("wizard", "boot-1", big)}), KindPaneNearCap)
	none(t, w.Tick([]Snapshot{snap("wizard", "boot-1", big)}), KindPaneNearCap)

	w.Tick([]Snapshot{snap("wizard", "boot-1", live("infra"))}) // dropped back
	only(t, w.Tick([]Snapshot{snap("wizard", "boot-1", big)}), KindPaneNearCap)
}

// --- users are independent ----------------------------------------------

// wizard and emo share the box and nothing else. One user's reboot detection or
// death bookkeeping must not touch the other's.
func TestUsersDoNotShareState(t *testing.T) {
	w := NewWatcher(cfg())
	w.Tick([]Snapshot{
		snap("wizard", "boot-1", live("immich")),
		snap("emo", "boot-1", live("immich")),
	})

	wizGone := snap("wizard", "boot-1")

	got := w.Tick([]Snapshot{wizGone, snap("emo", "boot-1", live("immich"))})
	f := only(t, got, KindSessionDied)
	if f.User != "wizard" {
		t.Fatalf("emo's identically-named session was implicated: %+v", f)
	}
}

// --- what "near the cap" has to mean ---------------------------------------
//
// memory.current is the wrong number, and the box proved it. The "issues" pane
// read 6143 MB of a 6144 MB cap while holding only 624 MB anon and 3 MB shmem;
// the other 5272 MB was page cache, 5131 MB of it cold inactive_file. Its
// memory.events showed max=45450 with oom_kill=0 — the cap had been reached
// forty-five thousand times and had never killed anything, because each time the
// kernel simply reclaimed cache.
//
// So current riding at the cap is normal for any pane doing file I/O, and a
// threshold on it fires on every busy pane forever. What forces a kill is the
// memory that CANNOT be reclaimed: anon plus shmem, since the user slice sets
// memory.swap.max=0 and neither can be paged out.

func TestPaneAtTheCapOnCacheAloneStaysQuiet(t *testing.T) {
	// The "issues" pane exactly as measured 2026-09-01 19:10.
	w := NewWatcher(cfg())
	s := live("issues")
	s.PaneBytes = 6143 * MiB
	s.PaneUnreclaimable = 628 * MiB
	s.PaneLimit = 6144 * MiB

	none(t, w.Tick([]Snapshot{snap("wizard", "boot-1", s)}), KindPaneNearCap)
}

func TestPaneWithUnreclaimablePastTheThresholdWarns(t *testing.T) {
	// The same pane 40 minutes earlier, when /tmp was 95% full: anon 783 MB plus
	// shmem 3641 MB, none of it reclaimable with swap disabled.
	w := NewWatcher(cfg())
	s := live("issues")
	s.PaneBytes = 4627 * MiB
	s.PaneUnreclaimable = 4424 * MiB
	s.PaneLimit = 6144 * MiB

	f := only(t, w.Tick([]Snapshot{snap("wizard", "boot-1", s)}), KindPaneNearCap)
	if f.PaneUnreclaimable != 4424*MiB {
		t.Errorf("want the unreclaimable figure carried into the finding, got %d", f.PaneUnreclaimable)
	}
	if f.PaneBytes != 4627*MiB {
		t.Errorf("want memory.current carried too, so the reader can see the split, got %d", f.PaneBytes)
	}
}

// A pane whose cache alone is huge must not warn even when current exceeds the
// threshold by a wide margin.
func TestCacheHeavyPaneWellOverTheThresholdStaysQuiet(t *testing.T) {
	w := NewWatcher(cfg())
	s := live("infra")
	s.PaneBytes = 5 * GiB
	s.PaneUnreclaimable = 400 * MiB
	s.PaneLimit = 6 * GiB

	none(t, w.Tick([]Snapshot{snap("wizard", "boot-1", s)}), KindPaneNearCap)
}
