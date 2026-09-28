package sessionio

import (
	"strconv"
	"testing"
	"time"
)

// OptionLastActivity is when the session last did something a person would
// call using it: a prompt they sent, or a turn that finished. Written by
// devvm/claude-tmux-state on those two events and no others.
//
// Before it, the lobby's "last used" was the newest moment a read-write client
// was attached, so opening a session counted as using it. On 2026-09-27 emo
// clicked through his sessions in about 35 seconds and twelve of them read the
// same minute, monitors among them, whose last prompt was eleven days earlier.

// stale is an old stamp every case starts from, so a write shows as a jump to
// now and a non-write leaves it exactly as it was.
const stale = "1000"

func freshStamp(t *testing.T, got string, before int64) {
	t.Helper()
	at, err := strconv.ParseInt(got, 10, 64)
	if err != nil || at < before || at > time.Now().Unix()+1 {
		t.Fatalf("%s = %q, want the current unix second (>= %d)", OptionLastActivity, got, before)
	}
}

func TestAPromptStampsLastActivity(t *testing.T) {
	e := newHookEnv(t)
	e.set(t, OptionLastActivity, stale)
	before := time.Now().Unix()

	e.fire(t, "running", "userprompt_human.json")

	freshStamp(t, e.opt(t, OptionLastActivity), before)
}

func TestAFinishedTurnStampsLastActivity(t *testing.T) {
	e := newHookEnv(t)
	e.fire(t, "running", "userprompt_human.json")
	e.set(t, OptionLastActivity, stale)
	before := time.Now().Unix()

	e.fire(t, "done", "stop_tasks_finished.json")

	freshStamp(t, e.opt(t, OptionLastActivity), before)
}

// Tool calls happen hundreds of times a turn and say nothing a prompt and the
// turn's end do not already say. A background task's completion arrives as a
// synthetic prompt, and the Stop of the turn it starts is what stamps it.
func TestOnlyPromptsAndFinishedTurnsStampLastActivity(t *testing.T) {
	// Short subtest names: the tmux socket is named after the test, and a
	// fixture's full name pushes its path past the unix socket limit.
	for _, fx := range []struct{ name, mode, fixture string }{
		{"pre", "running", "pre_main.json"},
		{"post", "running", "post_agent_launch.json"},
		{"tasknote", "running", "userprompt_notification_agent.json"},
		{"start", "done", "sessionstart.json"},
		{"notify", "notify", "notification.json"},
	} {
		t.Run(fx.name, func(t *testing.T) {
			e := newHookEnv(t)
			e.set(t, OptionLastActivity, stale)

			e.fire(t, fx.mode, fx.fixture)

			if got := e.opt(t, OptionLastActivity); got != stale {
				t.Fatalf("%s moved to %q on %s, want it left at %s", OptionLastActivity, got, fx.fixture, stale)
			}
		})
	}
}
