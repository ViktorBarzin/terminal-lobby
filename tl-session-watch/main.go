package main

// tl-session-watch — says when a Claude session on this box dies.
//
// The problem it solves is that sessions have been disappearing and the only
// way anyone noticed was by looking at the sidebar and counting. Two shapes of
// loss, measured on 2026-09-01:
//
//   - a session leaves tmux entirely. Lobby-created panes run `zsh -lic claude`,
//     so claude's death closes the pane and the last pane closing ends the
//     session. This is what happens to sessions the lobby made.
//   - claude dies inside a pane that survives, leaving a shell where the
//     conversation was. This is what happens to a claude someone started by
//     hand in a shell pane.
//
// Telling either apart from a deliberate kill is the whole difficulty, and
// tmux-persist already answers it: a kill through the lobby calls
// tmux-persist-forget, so a manifest row that outlives its session means nobody
// ended that session on purpose. The stamp-based scheme this replaced could not
// work, because claude does not run its SessionEnd hook on the SIGHUP tmux sends
// and the hook's clear branch never logged anything either way.
//
// Design: infra/docs/plans/2026-09-01-devvm-session-loss-alerting.md

import (
	"flag"
	"log"
	"os"
	"time"
)

const GiB = 1 << 30

func main() {
	var (
		interval = flag.Duration("interval", 30*time.Second,
			"how often to look. The floor on how fast a pane can be seen approaching its cap.")
		paneWarn = flag.Uint64("pane-warn-bytes", 3*GiB,
			"warn when a pane's UNRECLAIMABLE memory (anon + shmem) reaches this AND its largest process is a claude. Not memory.current, which rides up to the cap on reclaimable cache in any pane doing file I/O")
		confirm = flag.Int("confirm-ticks", 2,
			"consecutive ticks a stamp-with-no-claude must hold before it counts as a death")
		textfile = flag.String("textfile", "/var/lib/node_exporter/textfile/tl_panes.prom",
			"where to write the pane metric for node_exporter's textfile collector; empty disables it")
		once = flag.Bool("once", false, "take one look and exit, for a drill or a smoke test")
		addr = flag.String("health-addr", "127.0.0.1:7689",
			"loopback address for /health, which reports stale once ticks stop")
	)
	flag.Parse()

	log.SetFlags(0) // journald stamps the lines; a second timestamp reads as noise

	w := NewWatcher(Config{
		PaneWarnBytes: *paneWarn,
		ConfirmTicks:  *confirm,
		// The prewarm slot holds a claude nobody is talking to, so losing one
		// costs no conversation.
		SkipPrefixes: []string{"__terminal_lobby_"},
	})

	users := Users()
	if len(users) == 0 {
		log.Println("event=no_users_to_watch")
		os.Exit(1)
	}
	bootID := BootID()
	clock := &tickClock{}
	if !*once {
		serveHealth(*addr, clock, *interval, log.Printf)
	}
	log.Printf("event=started users=%d interval=%s pane_warn_bytes=%d", len(users), *interval, *paneWarn)

	tick := func() {
		snaps := Collect(users, bootID)

		// -once is a smoke test, and seeding on the first look means it would
		// report nothing whatever the box looked like. Run the comparison twice
		// so the standing conditions (a dead claude, a pane near its cap) are
		// reachable in one invocation.
		findings := w.Tick(snaps)
		if *once {
			findings = append(findings, w.Tick(snaps)...)
		}

		total := 0
		for _, s := range snaps {
			total += len(s.Sessions)
		}
		for _, f := range findings {
			// session_killed is the deliberate case. It is recorded so that a
			// false positive can be told apart from a missed kill afterwards,
			// and no alert rule selects it.
			log.Println(Line(f))
		}
		log.Println(Heartbeat(len(snaps), total))
		clock.mark(time.Now())

		if err := WriteTextfile(*textfile, snaps); err != nil {
			// A metric that cannot be written must not stop the alerting half.
			log.Printf("event=textfile_write_failed error=%q", err.Error())
		}
	}

	if *once {
		tick()
		return
	}

	t := time.NewTicker(*interval)
	defer t.Stop()
	tick()
	for range t.C {
		tick()
	}
}
