package main

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// Bringing back a conversation the pane memory cap killed.
//
// Each tmux pane on the devvm has a 6G memory cap. When it fills (with what
// claude started: dev servers, tsc, test workers, and files it wrote to the
// RAM-backed /tmp) the kernel kills the largest processes in the pane, and
// sometimes that is the claude. The pane's command is `zsh -lic "claude …"`, so
// the tmux session goes with it. Every claude kill between 2026-09-13 and
// 2026-09-25 ended that way, mid-turn, and none of the five sessions came back
// on its own.
//
// The conversation itself survives in its transcript, so the watcher asks
// tmux-persist to restore the session with `claude --resume`, and passes a first
// message telling the resumed claude what happened so it carries on. Viktor's
// calls, 2026-09-26: only pane cap kills (not earlyoom or a box-wide OOM), at
// most once per session per hour, and the resumed claude continues on its own.

// resumeMessage is the resumed claude's first prompt.
const resumeMessage = "This session was killed by the devvm's 6 GiB per-pane memory limit in the middle of your last turn, and was resumed automatically. " +
	"Your background agents and workflows from before the kill are gone. " +
	"Processes the old pane started, such as dev servers and test runs, may be dead or may still be running as leftovers, so check with ps before starting more. " +
	"Check what actually finished, then carry on with the task. " +
	"The pane filled up last time, so keep memory down, for example fewer parallel test workers and no leftover dev servers. " +
	"If it is killed again within the hour it will not be resumed."

// killMemory is how long a kill record is kept for matching. A session's death
// is reported one tick after the kill for session_died and a few ticks after
// for claude_died; ten minutes covers both with room, and stops a pid the
// kernel later reuses from matching an old kill.
const killMemory = 10 * time.Minute

// ResumeAction is one session to bring back.
type ResumeAction struct {
	User    string
	Session string
}

// Resumer decides which deaths were pane cap kills and which of those to
// resume. It holds no tmux or kernel handle, so every decision is testable.
type Resumer struct {
	every  time.Duration
	pids   map[string][]int     // user/session -> the claude pids last seen alive in it
	killed map[int]time.Time    // pid -> when the kernel killed it under a cgroup cap
	last   map[string]time.Time // user/session -> the last automatic resume
}

func NewResumer(every time.Duration) *Resumer {
	return &Resumer{
		every:  every,
		pids:   map[string][]int{},
		killed: map[int]time.Time{},
		last:   map[string]time.Time{},
	}
}

func resumeKey(user, session string) string { return user + "/" + session }

// Killed records a pane cap kill.
func (r *Resumer) Killed(pid int, at time.Time) { r.killed[pid] = at }

// Observe records each session's live claude pids. A tick showing no claude
// keeps the pids from before, because a claude_died is reported only after the
// confirm ticks, by which time the pane shows none. Sessions that are gone are
// forgotten, which is why the caller runs Decide first.
func (r *Resumer) Observe(snaps []Snapshot) {
	for _, snap := range snaps {
		present := map[string]bool{}
		for name, s := range snap.Sessions {
			key := resumeKey(snap.User, name)
			present[key] = true
			if len(s.ClaudePIDs) > 0 {
				r.pids[key] = append([]int(nil), s.ClaudePIDs...)
			}
		}
		prefix := snap.User + "/"
		for key := range r.pids {
			if strings.HasPrefix(key, prefix) && !present[key] {
				delete(r.pids, key)
			}
		}
	}
}

// Decide returns the sessions to resume, plus a resume_skipped finding for each
// cap kill that came within the hour of the last resume of that session.
func (r *Resumer) Decide(findings []Finding, now time.Time) ([]ResumeAction, []Finding) {
	for pid, at := range r.killed {
		if now.Sub(at) > killMemory {
			delete(r.killed, pid)
		}
	}
	var acts []ResumeAction
	var notes []Finding
	for _, f := range findings {
		if f.Kind != KindSessionDied && f.Kind != KindClaudeDied {
			continue
		}
		key := resumeKey(f.User, f.Session)
		if !r.capKilled(key) {
			continue
		}
		if at, ok := r.last[key]; ok && now.Sub(at) < r.every {
			notes = append(notes, Finding{Kind: KindResumeSkipped, User: f.User, Session: f.Session,
				Error: fmt.Sprintf("resumed %s ago", now.Sub(at).Round(time.Minute))})
			continue
		}
		r.last[key] = now
		acts = append(acts, ResumeAction{User: f.User, Session: f.Session})
	}
	return acts, notes
}

func (r *Resumer) capKilled(key string) bool {
	for _, pid := range r.pids[key] {
		if _, ok := r.killed[pid]; ok {
			return true
		}
	}
	return false
}

// runResume asks tmux-persist to bring the session back with the message. It
// restores from the newest snapshot holding the session, or resumes in place
// when the session survived as a bare shell.
//
// Only while the user's tmux server is running. tmux-persist runs tmux through
// runuser, so with no server up it would start one as a child of this watcher:
// inside its sandbox (read-only home), its 128M memory cap, and its cgroup,
// which systemd empties on every watcher restart. The prewarm slot session
// keeps each user's server alive, so this is the rare case.
func runResume(tmuxPersist string, a ResumeAction) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if _, err := asUser(a.User, tmuxBinary, "list-sessions"); err != nil {
		return fmt.Errorf("tmux server for %s is not running, not starting one from the watcher", a.User)
	}
	out, err := exec.CommandContext(ctx, tmuxPersist, "restore-one", a.User, a.Session, resumeMessage).CombinedOutput()
	text := strings.TrimSpace(string(out))
	if err != nil {
		return fmt.Errorf("%v: %s", err, text)
	}
	if strings.Contains(text, "WARN") {
		return fmt.Errorf("%s", text)
	}
	return nil
}
