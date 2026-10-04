package main

// Keeping a pre-warm slot ready for the composer's Send
// (docs/plans/2026-10-04-warm-slot-at-send-design.md).
//
// A slot runs the lobby's Claude mod it booted with, and a claim refuses one
// whose mod is not the installed one (slot_is_stale in tmux-user-attach). On
// 2026-10-04 three of four slow first prompts were the first create after an
// install: the slot had gone stale, nothing replaced it until Send, and Send
// then waited out a fresh boot. Two things here close that gap. A request for
// a slot replaces a stale one rather than answering that one exists, and a
// sweep notices a new mod id and replaces every stale slot, one per user per
// pass, so they do not all boot at once.

import (
	"context"
	"log"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

// slotModelRe and slotEffortRe are tmux-user-attach's MODEL_RE and EFFORT_RE:
// a value either side refuses would be a slot warmed under a name no claim
// derives. TestSlotFlagPatternsMatchTheScript pins them together.
var (
	slotModelRe  = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,31}(\[[a-z0-9]{1,4}\])?$`)
	slotEffortRe = regexp.MustCompile(`^[a-z]{1,12}$`)
)

// validSlotFlags answers whether a model and effort may name a slot. Empty is
// "no choice", which is always valid.
func validSlotFlags(model, effort string) bool {
	return (model == "" || slotModelRe.MatchString(model)) &&
		(effort == "" || slotEffortRe.MatchString(effort))
}

// modIDFile is where the package writes the installed mod's content hash,
// the same file tmux-user-attach reads.
const modIDFile = "/usr/share/terminal-lobby/claude-plugins/plugins/terminal-lobby/.mod-id"

// slotState is one pre-warm slot as tmux reports it. dir, model and effort
// are what the slot was warmed for; a slot warmed before they were stamped
// carries none.
type slotState struct {
	name               string
	modID              string
	speculative        bool
	dir, model, effort string
}

// stale answers whether a claim would refuse this slot.
func (s slotState) stale(installed string) bool {
	return installed != "" && s.modID != installed
}

// warmRequest is one slot to warm, as tmux-user-attach's warm-by-argument
// takes it.
type warmRequest struct {
	dir, model, effort string
	speculative        bool
}

var installedModID = func() string {
	b, err := os.ReadFile(modIDFile)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

var listSlots = func(osUser string) []slotState {
	out, err := tmuxCmd(osUser, "list-sessions", "-F", strings.Join([]string{
		"#{session_name}", "#{@tl_mod_id}", "#{" + speculativeOption + "}",
		"#{@tl_slot_dir}", "#{@tl_slot_model}", "#{@tl_slot_effort}",
	}, "\t")).Output()
	if err != nil {
		return nil
	}
	var slots []slotState
	for _, line := range strings.Split(strings.TrimRight(string(out), "\n"), "\n") {
		f := strings.Split(line, "\t")
		if len(f) != 6 || !strings.HasPrefix(f[0], poolSlotPrefix) {
			continue
		}
		slots = append(slots, slotState{
			name: f[0], modID: f[1], speculative: f[2] != "",
			dir: f[3], model: f[4], effort: f[5],
		})
	}
	return slots
}

// warmTimeout bounds one warm. The script returns once the slot's session
// exists; Claude boots inside it afterwards.
const warmTimeout = 15 * time.Second

// runWarm starts a slot through the script, as the user, the way runClaim
// claims one: an argument and not a unit instance, because an instance name
// carries one string and a slot is a directory, a model and an effort.
var runWarm = func(osUser string, w warmRequest) error {
	ctx, cancel := context.WithTimeout(context.Background(), warmTimeout)
	defer cancel()
	// The script starts the slot inside `systemd-run --user --scope`, so a tmux
	// server it spawns lands in the user's manager and not in this service's
	// cgroup, the reason tmux-user-attach exists.
	kind := "pool"
	if w.speculative {
		kind = "prewarm"
	}
	args := []string{"_", w.dir, "claude", w.model, w.effort, kind}
	var c *exec.Cmd
	if osUser == selfUser {
		c = exec.CommandContext(ctx, attachScript, args...)
	} else {
		c = exec.CommandContext(ctx, sudoBinary, append([]string{"-n", "-H", "-u", osUser, attachScript}, args...)...)
	}
	c.WaitDelay = time.Second
	out, err := c.CombinedOutput()
	if err != nil {
		log.Printf("slots: warming %+v for %s: %v (%s)", w, osUser, err, strings.TrimSpace(string(out)))
	}
	return err
}

var killSlot = func(osUser, name string) {
	if out, err := tmuxCmd(osUser, "kill-session", "-t", exactSession(name)).CombinedOutput(); err != nil {
		log.Printf("slots: dropping %s for %s: %v (%s)", name, osUser, err, strings.TrimSpace(string(out)))
	}
}

// slotDirsOf lists where this user's lobby creates sessions: their home and
// every project directory. A slot can only be for one of these
// (prewarmAllowedDir), so it is also where an unstamped slot's name is looked
// up.
var slotDirsOf = func(osUser string) []string {
	var dirs []string
	if home := homeOfUser(osUser); home != "" {
		dirs = append(dirs, home)
	}
	if l, err := layoutStoreInstance.load(osUser); err == nil {
		for _, p := range l.Projects {
			if p.Dir != "" {
				dirs = append(dirs, p.Dir)
			}
		}
	}
	return dirs
}

// placeSlot fills in the directory of a slot warmed before slots were
// stamped, by matching its name against the user's directories. It reports
// false when no directory folds to that name.
func placeSlot(osUser string, s *slotState) bool {
	if s.dir != "" {
		return true
	}
	for _, d := range slotDirsOf(osUser) {
		if prewarmSlotName(d, s.model, s.effort) == s.name {
			s.dir = d
			return true
		}
	}
	return false
}

// replaceStaleSlot rebuilds a stale slot as the kind it was, or drops it when
// it cannot be placed. The script's warm kills the stale session itself.
func replaceStaleSlot(osUser string, s slotState) {
	if !placeSlot(osUser, &s) {
		log.Printf("slots: dropping stale %s for %s, which matches none of their directories", s.name, osUser)
		killSlot(osUser, s.name)
		return
	}
	log.Printf("slots: replacing stale %s for %s", s.name, osUser)
	_ = runWarm(osUser, warmRequest{dir: s.dir, model: s.model, effort: s.effort, speculative: s.speculative})
}

// sweepStaleSlots replaces at most one stale slot per user and reports whether
// any were found, which is whether another pass is owed. One per pass is the
// stagger: Claudes booting together have been measured finishing together, up
// to 21s after the first started.
func sweepStaleSlots(users []string) bool {
	installed := installedModID()
	if installed == "" {
		return false
	}
	found := false
	for _, u := range users {
		for _, s := range listSlots(u) {
			if s.stale(installed) {
				found = true
				replaceStaleSlot(u, s)
				break
			}
		}
	}
	return found
}

// staleSweepInterval is the gap between two passes, and so between two slots
// of one user booting after an install. A Claude boots in 3 to 4.6s on a
// quiet box.
const staleSweepInterval = 5 * time.Second

// runStaleSlotSweep sweeps until no slot is stale, then reads only the mod id
// until it changes. It starts with a sweep, so a restart after an install
// begins at once.
func runStaleSlotSweep(stop <-chan struct{}) {
	t := time.NewTicker(staleSweepInterval)
	defer t.Stop()
	clean := ""
	for {
		if id := installedModID(); id != "" && id != clean {
			if !sweepStaleSlots(mappedOSUsers()) {
				clean = id
			}
		}
		select {
		case <-stop:
			return
		case <-t.C:
		}
	}
}

// prewarmInFlight lets a test wait for the warm a request started.
var prewarmInFlight sync.WaitGroup
