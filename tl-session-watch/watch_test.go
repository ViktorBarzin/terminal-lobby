package main

import (
	"testing"
	"time"
)

// cfg is the shape every test starts from: warn at 5 GiB and stand down below
// 4.5 GiB, confirm a dead claude over two consecutive ticks, and ignore the
// prewarm pool.
func cfg() Config {
	return Config{
		PaneWarnBytes:  5 * GiB,
		PaneClearBytes: 4608 * MiB,
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

// ided gives a session the identity tmux keeps across a rename: session_id and
// session_created, which collect.go reads as "$<id>:<created>".
func ided(s Session, id string) Session {
	s.ID = id
	return s
}

// Autotitle renames a new session a few seconds after it starts, and a backfill
// renames old ones, so the old name leaves tmux with no tombstone. That read as
// a death: all 8 session_died lines in the 40 hours to 2026-09-24 08:00 were
// renames, bw8k5gt9v314 becoming books-sent-to-anca-s-kindle among them. The
// session is still there under its new name, and its identity says so.
func TestVanishedByRenameIsNotADeath(t *testing.T) {
	w := NewWatcher(cfg())
	w.Tick([]Snapshot{snap("wizard", "boot-1", ided(live("bw8k5gt9v314"), "$5:1790143332"), live("f1"))})

	got := w.Tick([]Snapshot{snap("wizard", "boot-1", ided(live("books-sent-to-anca-s-kindle"), "$5:1790143332"), live("f1"))})
	none(t, got, KindSessionDied)
	none(t, got, KindSessionKilled)
}

// tmux numbers sessions afresh when its server restarts, so a $N on its own can
// belong to an unrelated session later. The creation time is what separates a
// rename from a reused number, and a reused number must not hide a real death.
func TestAReusedTmuxNumberIsStillADeath(t *testing.T) {
	w := NewWatcher(cfg())
	w.Tick([]Snapshot{snap("wizard", "boot-1", ided(live("immich"), "$5:1790143332"))})

	f := only(t, w.Tick([]Snapshot{snap("wizard", "boot-1", ided(live("other"), "$5:1790150000"))}), KindSessionDied)
	if f.Session != "immich" {
		t.Fatalf("want immich reported, got %s", f.Session)
	}
}

// A session with no identity, from a row that did not carry one, keeps the old
// rule. Two empty identities are not a match, or every vanished session with an
// empty ID would be written off as a rename of any other.
func TestVanishedWithNoIdentityKeepsTheOldRule(t *testing.T) {
	w := NewWatcher(cfg())
	w.Tick([]Snapshot{snap("wizard", "boot-1", live("immich"))})

	only(t, w.Tick([]Snapshot{snap("wizard", "boot-1", live("other"))}), KindSessionDied)
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

	w.Tick([]Snapshot{snap("wizard", "boot-1", live("typeahead"))})
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

	w.Tick([]Snapshot{snap("wizard", "boot-1", live("typeahead"))})
	w.Tick([]Snapshot{snap("wizard", "boot-1", dead)})
	only(t, w.Tick([]Snapshot{snap("wizard", "boot-1", dead)}), KindClaudeDied)
	none(t, w.Tick([]Snapshot{snap("wizard", "boot-1", dead)}), KindClaudeDied)
}

// A claude already dead when the watcher starts died while nobody was
// watching, and the watcher has no way to say when. Before this, every restart
// announced it again 30 seconds in: 5 of the 6 claude_died lines in the 72 hours
// to 2026-09-24 came exactly one tick after a restart, all for ny-reibursment
// and polarized-sunglasses-with-photoc, whose claudes had been gone for hours,
// and every terminal-lobby deploy restarts this watcher.
func TestADeadClaudeFoundAtStartIsNotANewDeath(t *testing.T) {
	w := NewWatcher(cfg())
	dead := live("ny-reibursment")
	dead.ClaudeAlive = false

	none(t, w.Tick([]Snapshot{snap("wizard", "boot-1", dead)}), KindClaudeDied)
	none(t, w.Tick([]Snapshot{snap("wizard", "boot-1", dead)}), KindClaudeDied)
	none(t, w.Tick([]Snapshot{snap("wizard", "boot-1", dead)}), KindClaudeDied)
}

// Seeding must not blind the watcher to the same session later. Once that
// claude is running again, dying again is a death this watcher saw.
func TestAClaudeRevivedAfterStartIsWatchedAgain(t *testing.T) {
	w := NewWatcher(cfg())
	dead := live("ny-reibursment")
	dead.ClaudeAlive = false

	w.Tick([]Snapshot{snap("wizard", "boot-1", dead)})
	w.Tick([]Snapshot{snap("wizard", "boot-1", live("ny-reibursment"))})
	w.Tick([]Snapshot{snap("wizard", "boot-1", dead)})
	only(t, w.Tick([]Snapshot{snap("wizard", "boot-1", dead)}), KindClaudeDied)
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

func TestPaneOverThresholdWarns(t *testing.T) {
	w := NewWatcher(cfg())
	big := live("infra")
	big.PaneBytes = 5500 * MiB
	big.PaneUnreclaimable = 5500 * MiB

	f := only(t, w.Tick([]Snapshot{snap("wizard", "boot-1", big)}), KindPaneNearCap)
	if f.Session != "infra" || f.PaneBytes != 5500*MiB || f.PaneLimit != 6*GiB {
		t.Fatalf("want infra 5500MiB/6GiB, got %s %d/%d", f.Session, f.PaneBytes, f.PaneLimit)
	}
}

// Claude is ~0.4 GB and is the largest single process in almost every pane it
// sits in, so "claude is fattest" filtered nothing: 212 warnings in the 26 days
// to 2026-09-26 against 5 claude kills. And when a build is fattest the cap
// takes the build and then the claude: on 2026-09-24 it killed ~30 vitest
// workers first and the conversation after them. A claude anywhere in a pane
// this full is at risk.
func TestPaneOverThresholdWarnsWhateverIsFattest(t *testing.T) {
	w := NewWatcher(cfg())
	big := live("infra")
	big.PaneBytes = 5500 * MiB
	big.PaneUnreclaimable = 5500 * MiB
	big.TopIsClaude = false

	only(t, w.Tick([]Snapshot{snap("wizard", "boot-1", big)}), KindPaneNearCap)
}

// A pane with no claude in it holds no conversation to lose.
func TestPaneOverThresholdWithNoClaudeStaysQuiet(t *testing.T) {
	w := NewWatcher(cfg())
	big := live("infra")
	big.ClaudeState = ""
	big.ClaudeAlive = false
	big.TopIsClaude = false
	big.PaneBytes = 5500 * MiB
	big.PaneUnreclaimable = 5500 * MiB

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
	big.PaneBytes = 5500 * MiB
	big.PaneUnreclaimable = 5500 * MiB
	big.PaneLimit = 0

	none(t, w.Tick([]Snapshot{snap("wizard", "boot-1", big)}), KindPaneNearCap)
}

// A pane sitting above the line for an hour is one episode. Re-crossing it after
// dropping back is a new one.
func TestPaneWarningIsPerEpisode(t *testing.T) {
	w := NewWatcher(cfg())
	big := live("infra")
	big.PaneBytes = 5500 * MiB
	big.PaneUnreclaimable = 5500 * MiB

	only(t, w.Tick([]Snapshot{snap("wizard", "boot-1", big)}), KindPaneNearCap)
	none(t, w.Tick([]Snapshot{snap("wizard", "boot-1", big)}), KindPaneNearCap)

	w.Tick([]Snapshot{snap("wizard", "boot-1", live("infra"))}) // dropped back
	only(t, w.Tick([]Snapshot{snap("wizard", "boot-1", big)}), KindPaneNearCap)
}

// A pane hovering around the line is one episode. Without the gap between the
// warn and clear levels, every dip and return was a fresh warning and a fresh
// Slack post.
func TestPaneHoveringAtTheLineWarnsOnce(t *testing.T) {
	w := NewWatcher(cfg())
	at := func(unreclaimable uint64) []Snapshot {
		s := live("infra")
		s.PaneBytes = unreclaimable
		s.PaneUnreclaimable = unreclaimable
		return []Snapshot{snap("wizard", "boot-1", s)}
	}

	only(t, w.Tick(at(5*GiB)), KindPaneNearCap)
	none(t, w.Tick(at(4800*MiB)), KindPaneNearCap) // dipped, still above clear
	none(t, w.Tick(at(5200*MiB)), KindPaneNearCap)

	none(t, w.Tick(at(4*GiB)), KindPaneNearCap) // below clear: episode over
	only(t, w.Tick(at(5*GiB)), KindPaneNearCap)
}

// A clear level left unset, or set above the warn level, collapses to the warn
// level rather than leaving an episode open forever or never.
func TestPaneClearLevelDefaultsToWarnLevel(t *testing.T) {
	c := cfg()
	c.PaneClearBytes = 0
	w := NewWatcher(c)
	at := func(unreclaimable uint64) []Snapshot {
		s := live("infra")
		s.PaneUnreclaimable = unreclaimable
		return []Snapshot{snap("wizard", "boot-1", s)}
	}

	only(t, w.Tick(at(5*GiB)), KindPaneNearCap)
	none(t, w.Tick(at(5*GiB-1)), KindPaneNearCap)
	only(t, w.Tick(at(5*GiB)), KindPaneNearCap)
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
// memory the cap cannot drop as cache: anon plus shmem. (Panes could not swap
// when this was measured; since 2026-09-02 they can, within 4 GiB per user.)

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
	// Shaped like the same pane 40 minutes earlier, when /tmp was 95% full and
	// shmem made up most of it, scaled past today's 5 GiB line. The measured
	// 4424 MB now sits under it: that pane was never killed.
	w := NewWatcher(cfg())
	s := live("issues")
	s.PaneBytes = 5400 * MiB
	s.PaneUnreclaimable = 5200 * MiB
	s.PaneLimit = 6144 * MiB

	f := only(t, w.Tick([]Snapshot{snap("wizard", "boot-1", s)}), KindPaneNearCap)
	if f.PaneUnreclaimable != 5200*MiB {
		t.Errorf("want the unreclaimable figure carried into the finding, got %d", f.PaneUnreclaimable)
	}
	if f.PaneBytes != 5400*MiB {
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
