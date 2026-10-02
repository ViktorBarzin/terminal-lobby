package main

import (
	"bufio"
	"context"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	"terminal-lobby/sessionio"
	"terminal-lobby/telemetry"
)

// Restarting the Claudes that predate the lobby's mod (ADR-0036).
//
// A Claude started before the mod existed never says hello, so its Text view
// has no stream. Viktor, 2026-10-02: restart the sessions that are safe to
// restart. Safe means Claude is idle, no background work is outstanding, no
// dialog is up, and nothing is typed on its input line; a busy session is
// restarted the next time it is safe, so every session converges.
//
// It restarts on the same conversation (`claude --resume <id>`) with the flags
// the session was started with. A restart that does not bring a mod up (an
// install older than 2.1.287, or mods turned off for that account) is not
// tried again for the same conversation, so nothing restarts in a loop.

// RolloutInterval is how often sessions are checked.
const RolloutInterval = time.Minute

// rolloutDriver is the half of the Injector the restart uses.
type rolloutDriver interface {
	RolloutSessions(osUser string) ([]sessionio.RolloutSession, error)
	CapturePaneStyled(osUser, session string) (string, error)
	Respawn(osUser, session, dir, cmd string) error
}

type rollout struct {
	hub   *modHub
	drv   rolloutDriver
	users func() []string
	now   func() time.Time

	mu    sync.Mutex
	tried map[string]time.Time // user\x00session\x00sid → when it was restarted
}

func newRollout(hub *modHub, drv rolloutDriver, users func() []string) *rollout {
	return &rollout{hub: hub, drv: drv, users: users, now: time.Now, tried: map[string]time.Time{}}
}

// safe reports whether a session that predates the mod may be restarted now,
// and the conversation to restart it on.
func rolloutSafe(s sessionio.RolloutSession) (sid string, ok bool) {
	if s.Transcript == "" || s.Suspended != "" {
		return "", false
	}
	if s.State == sessionio.StateRunning || s.State == sessionio.StateAwaiting {
		return "", false
	}
	if s.Background != "" || s.Ask != "" {
		return "", false
	}
	return sessionio.ClaudeIDFromTranscript(s.Transcript), true
}

// once checks every session of every user and restarts the safe ones.
func (ro *rollout) once(ctx context.Context) {
	for _, user := range ro.users() {
		// Only once a Claude of theirs has loaded the mod. Until then a restart
		// would bring back a Claude without one (mods not enabled yet, or an
		// install older than 2.1.287), and it is never tried twice.
		if !ro.hub.hasGreeted(user) {
			continue
		}
		list, err := ro.drv.RolloutSessions(user)
		if err != nil {
			continue
		}
		for _, s := range list {
			if ctx.Err() != nil {
				return
			}
			if ro.hub.conn(user, s.Name) != nil {
				continue // already talking to the lobby
			}
			sid, ok := rolloutSafe(s)
			if !ok {
				continue
			}
			key := user + "\x00" + s.Name + "\x00" + sid
			ro.mu.Lock()
			_, tried := ro.tried[key]
			ro.mu.Unlock()
			if tried {
				// Restarted once already. Either its mod is on its way, or it
				// never comes for this install; neither is helped by another.
				continue
			}
			cmd, ok := restartCommand(s, sid)
			if !ok {
				continue
			}
			styled, err := ro.drv.CapturePaneStyled(user, s.Name)
			if err != nil {
				continue
			}
			if draft, box := sessionio.BoxDraft(styled); !box || draft {
				// No input box is a dialog or a screen we do not know; words in
				// it are somebody's draft. Either way, not now.
				continue
			}
			ro.mu.Lock()
			ro.tried[key] = ro.now()
			ro.mu.Unlock()
			if err := ro.drv.Respawn(user, s.Name, s.Cwd, cmd); err != nil {
				log.Printf("rollout %s/%s: respawn: %v", user, s.Name, err)
				continue
			}
			log.Printf("rollout %s/%s: restarted on %s for the lobby's mod", user, s.Name, sid)
			events.Emit("mod.rollout_restart", user, telemetry.Attrs{"tl.session": s.Name})
		}
	}
}

// restartCommand is what the session restarts with: the start command with
// --resume, or for a prewarmed pool slot, which holds no conversation yet, the
// start command as it was.
func restartCommand(s sessionio.RolloutSession, sid string) (string, bool) {
	if strings.HasPrefix(s.Name, sessionio.PoolSlotPrefix) {
		return s.Start, strings.Contains(s.Start, "claude")
	}
	return sessionio.ResumeCommand(s.Start, sid)
}

func (ro *rollout) run(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			ro.once(ctx)
		}
	}
}

// mapUsers reads the OS users out of the identity map (`identity=osuser` per
// line): the accounts the lobby serves.
func mapUsers(path string) func() []string {
	return func() []string {
		f, err := os.Open(path)
		if err != nil {
			return nil
		}
		defer f.Close()
		seen := map[string]bool{}
		var out []string
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			_, u, ok := strings.Cut(line, "=")
			u = strings.TrimSpace(u)
			if !ok || u == "" || seen[u] || !modSessionRe.MatchString(u) {
				continue
			}
			seen[u] = true
			out = append(out, u)
		}
		return out
	}
}
