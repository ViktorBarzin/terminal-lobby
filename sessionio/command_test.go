package sessionio

import "testing"

// A slash command the operator ran is written into the transcript as MARKUP,
// not as the line they typed:
//
//	<command-message>wrap-up</command-message>
//	<command-name>/wrap-up</command-name>
//
// Rendered verbatim that is a pair of angle-bracket tags in the chat where the
// command should be — which is what Viktor reported on 2026-08-18 as the
// command "not appearing". The text view shows a user bubble as plain text (it
// is not markdown), so nothing downstream was going to make sense of it.
func TestCommandLine(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   string
		want string
		ok   bool
	}{
		{
			// The real shape, from view-as on 2026-08-18.
			name: "message then name",
			in:   "<command-message>wrap-up</command-message>\n<command-name>/wrap-up</command-name>",
			want: "/wrap-up",
			ok:   true,
		},
		{
			// The other order, indented — as /model and /compact are written.
			name: "name first, indented, with empty args",
			in: "<command-name>/model</command-name>\n            " +
				"<command-message>model</command-message>\n            <command-args></command-args>",
			want: "/model",
			ok:   true,
		},
		{
			name: "args are part of the line the operator typed",
			in: "<command-name>/doc-tone</command-name>\n<command-message>doc-tone</command-message>\n" +
				"<command-args>docs/plan.md</command-args>",
			want: "/doc-tone docs/plan.md",
			ok:   true,
		},
		{
			name: "a namespaced plugin command",
			in:   "<command-name>/superpowers:brainstorming</command-name>\n<command-args></command-args>",
			want: "/superpowers:brainstorming",
			ok:   true,
		},
		{
			// A command name recorded without its leading slash still reads as
			// one in the chat.
			name: "restores a missing slash",
			in:   "<command-name>help</command-name>",
			want: "/help",
			ok:   true,
		},
		{name: "ordinary prose is left alone", in: "please run the deploy", ok: false},
		{name: "prose that merely mentions the tag", in: "grep for <command-name> in the source", ok: false},
		{name: "empty", in: "", ok: false},
		{
			// Markup with no name in it is not a command line; better to leave
			// the raw text than to invent an empty "/".
			name: "no name element",
			in:   "<command-message>wrap-up</command-message>",
			ok:   false,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := commandLine(tc.in)
			if ok != tc.ok {
				t.Fatalf("ok = %v, want %v (got %q)", ok, tc.ok, got)
			}
			if ok && got != tc.want {
				t.Errorf("commandLine() = %q, want %q", got, tc.want)
			}
		})
	}
}

// End to end through the normalizer: the event the text view renders must carry
// the command, and must still be a USER event so it opens a turn the way the
// prompt it stands for would.
func TestSlashCommandBecomesAUserEvent(t *testing.T) {
	line := `{"type":"user","message":{"role":"user","content":"<command-message>wrap-up</command-message>\n<command-name>/wrap-up</command-name>"},"timestamp":"2026-08-18T06:03:10.220Z","sessionId":"x","uuid":"u1"}`
	evs := (&Normalizer{}).Line([]byte(line))
	if len(evs) != 1 {
		t.Fatalf("got %d events, want 1: %+v", len(evs), evs)
	}
	if evs[0].Kind != KindUser {
		t.Errorf("kind = %q, want %q", evs[0].Kind, KindUser)
	}
	if evs[0].Body != "/wrap-up" {
		t.Errorf("body = %q, want %q", evs[0].Body, "/wrap-up")
	}
}

// An ordinary prompt must be untouched by any of this.
func TestOrdinaryPromptIsUnchanged(t *testing.T) {
	line := `{"type":"user","message":{"role":"user","content":"deploy the thing"},"timestamp":"2026-08-18T06:03:10.220Z","sessionId":"x","uuid":"u2"}`
	evs := (&Normalizer{}).Line([]byte(line))
	if len(evs) != 1 || evs[0].Body != "deploy the thing" {
		t.Fatalf("got %+v", evs)
	}
}
