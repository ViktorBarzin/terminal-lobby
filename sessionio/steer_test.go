package sessionio

import (
	"strings"
	"testing"
)

// The three shapes a message the lobby sends a subagent takes on disk, each
// captured from a live send on CLI 2.1.288 (2026-10-03).
const (
	// A busy subagent takes it at its next tool boundary, as an attachment.
	steerAttachment = `{"isSidechain":true,"agentId":"aec3617dc33e56261","attachment":{"type":"queued_command","prompt":"The person watching this session in the lobby says:\n\nstop the sleeps now, run echo STEERED3 and finish.","source_uuid":"402d5d23","origin":{"kind":"coordinator","plugin":"terminal-lobby"},"isMeta":true},"type":"attachment","uuid":"38a9ee50","timestamp":"2026-10-03T20:45:16.743Z"}`
	// An idle teammate takes it as a user record in the team's envelope.
	steerTeammate = `{"isSidechain":true,"agentId":"atm-b8c50a44e9707ecc","type":"user","message":{"role":"user","content":"<teammate-message teammate_id=\"team-lead\" summary=\"The person watching this session in the lobby says:\">\nThe person watching this session in the lobby says:\n\nrun echo WOKEN and reply woke.\n</teammate-message>"},"uuid":"71cba587","timestamp":"2026-10-03T20:46:13.656Z"}`
	// The same attachment delivers every background task's notification.
	taskNotice = `{"isSidechain":true,"agentId":"aec3617dc33e56261","attachment":{"type":"queued_command","prompt":"<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command finished</summary>\n</task-notification>","origin":{"kind":"coordinator"},"isMeta":true},"type":"attachment","uuid":"9a","timestamp":"2026-10-03T20:45:17Z"}`
	// The main model's own SendMessage to a subagent: not the person.
	coordinatorMessage = `{"isSidechain":true,"agentId":"a7","attachment":{"type":"queued_command","prompt":"stop the sleeps now","origin":{"kind":"coordinator"},"isMeta":true},"type":"attachment","uuid":"9b","timestamp":"2026-10-03T20:45:18Z"}`
)

func userEvents(evs []Event) []Event {
	var out []Event
	for _, e := range evs {
		if e.Kind == KindUser {
			out = append(out, e)
		}
	}
	return out
}

// In the agent's own stream, what the person sent reads as theirs: a user
// bubble of the words they typed, without the line that tells the agent who
// is speaking, and marked as a steer.
func TestAgentStreamShowsTheMessageThePersonSent(t *testing.T) {
	for _, c := range []struct{ name, line, want string }{
		{"taken at a tool boundary", steerAttachment, "stop the sleeps now, run echo STEERED3 and finish."},
		{"taken by an idle teammate", steerTeammate, "run echo WOKEN and reply woke."},
	} {
		t.Run(c.name, func(t *testing.T) {
			got := userEvents(NewAgentNormalizer("demo").Line([]byte(c.line)))
			if len(got) != 1 || got[0].Body != c.want || !got[0].Steer {
				t.Fatalf("user events = %+v, want one steer bubble %q", got, c.want)
			}
		})
	}
}

// Everything else that arrives the same way stays as it was.
func TestAgentStreamLeavesOtherQueuedMessagesAlone(t *testing.T) {
	for _, line := range []string{taskNotice, coordinatorMessage} {
		for _, e := range NewAgentNormalizer("demo").Line([]byte(line)) {
			if e.Kind == KindUser || e.Steer {
				t.Fatalf("%s rendered as a person's message: %+v", line[:60], e)
			}
		}
	}
}

// The session's own stream never shows a subagent's messages as the reader's.
func TestSessionStreamDoesNotShowASteerAsAPrompt(t *testing.T) {
	for _, line := range []string{steerAttachment, steerTeammate} {
		for _, e := range NewNormalizer("demo").Line([]byte(line)) {
			if e.Steer || (e.Kind == KindUser && !e.Sidechain) {
				t.Fatalf("session stream drew it as the reader's prompt: %+v", e)
			}
		}
	}
}

func TestSteerTextNeedsThePrefix(t *testing.T) {
	cases := map[string]string{
		SteerPrefix + "\n\nhello":  "hello",
		"  " + SteerPrefix + " hi": "hi",
		"<teammate-message teammate_id=\"team-lead\" summary=\"x\">\n" + SteerPrefix + "\n\nwrapped\n</teammate-message>": "wrapped",
	}
	for in, want := range cases {
		if got, ok := steerText(in); !ok || got != want {
			t.Errorf("steerText(%q) = %q, %v; want %q", in, got, ok, want)
		}
	}
	for _, in := range []string{"hello", SteerPrefix, "<teammate-message>\nnot ours\n</teammate-message>", "x " + SteerPrefix + " y"} {
		if got, ok := steerText(in); ok {
			t.Errorf("steerText(%q) = %q, want no match", in, got)
		}
	}
	if strings.Contains(SteerPrefix, "\n") {
		t.Fatal("the prefix is matched as one line")
	}
}
