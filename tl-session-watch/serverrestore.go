package main

import (
	"context"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// Bringing back a user's sessions after their whole tmux server died.
//
// All of a user's sessions live in one tmux server, so when that server dies
// every conversation goes with it at once. On 2026-11-01 16:15:17 emo's server
// segfaulted (tmux 3.4, a focus event from a terminal whose session had just
// been killed) and took 13 sessions. The watcher reported 13 session_died lines
// and nothing restored them: tmux-persist's restore ran only at boot, and the
// box had not rebooted. The server stayed down for 19.5 hours, until emo opened
// the lobby again.
//
// A crash is told apart from the ordinary ways sessions end by its shape: at
// least two sessions die in the same tick, none of them was killed on purpose,
// and the user is left with no sessions at all. One session ending alone also
// empties a server, but that is someone typing /exit in their only session.
//
// The restore is tmux-persist's own `restore <user>`, the one the boot service
// runs: every session in the user's newest snapshot that is not live comes back
// with `claude --resume`. Viktor's call, 2026-11-02.

// minCrashDeaths is how many sessions must die in one tick, with nothing left,
// for it to count as the server dying rather than its last session ending.
const minCrashDeaths = 2

// systemdRunBinary starts the restore as a transient unit of PID 1.
var systemdRunBinary = "/usr/bin/systemd-run"

// ServerRestorer decides which users' servers to restore. Like Resumer it holds
// no tmux handle, so every decision is testable.
type ServerRestorer struct {
	every time.Duration
	last  map[string]time.Time // user -> the last automatic server restore
}

func NewServerRestorer(every time.Duration) *ServerRestorer {
	return &ServerRestorer{every: every, last: map[string]time.Time{}}
}

// Decide returns the users whose server died this tick and should be restored,
// plus a server_died finding for each death and a resume_skipped for each one
// inside the hour of the last restore. A server that crashes again that soon is
// left down, so a crash loop shows up instead of being hidden by restores.
func (r *ServerRestorer) Decide(findings []Finding, snaps []Snapshot, now time.Time) ([]string, []Finding) {
	died := map[string]int{}
	killed := map[string]int{}
	for _, f := range findings {
		switch f.Kind {
		case KindSessionDied:
			died[f.User]++
		case KindSessionKilled:
			killed[f.User]++
		}
	}
	var users []string
	var notes []Finding
	for _, s := range snaps {
		u := s.User
		if len(s.Sessions) != 0 || died[u] < minCrashDeaths || killed[u] != 0 {
			continue
		}
		notes = append(notes, Finding{Kind: KindServerDied, User: u, Before: died[u]})
		if at, ok := r.last[u]; ok && now.Sub(at) < r.every {
			notes = append(notes, Finding{Kind: KindResumeSkipped, User: u,
				Error: fmt.Sprintf("server restored %s ago", now.Sub(at).Round(time.Minute))})
			continue
		}
		r.last[u] = now
		users = append(users, u)
	}
	return users, notes
}

// serverRestoreArgv runs `tmux-persist restore <user>` as a transient service
// of PID 1, outside this watcher. The watcher's sandbox (read-only home, 128M
// memory cap, a cgroup systemd empties on every restart) would otherwise be
// inherited by the new tmux server and every claude in it. tmux-persist then
// moves the server into the user's own systemd manager, as it does at boot.
func serverRestoreArgv(tmuxPersist, user string, now time.Time) []string {
	return []string{
		systemdRunBinary,
		"--unit=tl-server-restore-" + user + "-" + strconv.FormatInt(now.Unix(), 10),
		"--description=Restore " + user + "'s tmux sessions after their server died",
		"--collect",
		"--wait",
		"--quiet",
		tmuxPersist, "restore", user,
	}
}

// runServerRestore starts the restore and waits for it, so a failure reaches
// the journal as server_restore_failed rather than only in the transient unit's
// own log.
func runServerRestore(tmuxPersist, user string, now time.Time) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	argv := serverRestoreArgv(tmuxPersist, user, now)
	out, err := exec.CommandContext(ctx, argv[0], argv[1:]...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}
