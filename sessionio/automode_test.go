package sessionio

import "testing"

// Approving a plan with "Yes, and use auto mode" writes no permission-mode
// record in that turn (Claude Code 2.1.283, qa-qlr3, 2026-09-27). The records
// after the approval are plan_mode_exit and then an auto_mode attachment; the
// next permission-mode record comes only after the following prompt. The
// attachment is the turn's only account of the mode the approval chose.
func TestNormalizeAutoModeAttachmentNamesTheMode(t *testing.T) {
	cases := []struct {
		name string
		line string
		want string
	}{
		{
			"auto mode",
			`{"type":"attachment","attachment":{"type":"auto_mode","autoModeConsentFlow":false,"bashFirst":true,"steerOnly":true,"bypass":false},"timestamp":"2026-09-27T08:58:50.792Z"}`,
			"auto",
		},
		{
			"bypassing permissions",
			`{"type":"attachment","attachment":{"type":"auto_mode","autoModeConsentFlow":false,"bashFirst":true,"steerOnly":true,"bypass":true}}`,
			"bypassPermissions",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out := NewNormalizer("demo").Line([]byte(tc.line))
			if len(out) != 1 || out[0].Kind != KindMeta || out[0].Meta != MetaPermissionMode || out[0].Body != tc.want {
				t.Fatalf("got %+v, want one permission-mode %q", out, tc.want)
			}
		})
	}
}

func TestNormalizeAutoModeAttachmentIgnoresOthers(t *testing.T) {
	lines := map[string]string{
		// Leaving auto mode does not say which mode it left for.
		"auto mode exit": `{"type":"attachment","attachment":{"type":"auto_mode_exit"}}`,
		"plan mode exit": `{"type":"attachment","attachment":{"type":"plan_mode_exit","planFilePath":"/p.md","planExists":true}}`,
		// A subagent's mode is not the session's.
		"a subagent's": `{"type":"attachment","isSidechain":true,"attachment":{"type":"auto_mode","bypass":false}}`,
	}
	for name, line := range lines {
		t.Run(name, func(t *testing.T) {
			if out := NewNormalizer("demo").Line([]byte(line)); len(out) != 0 {
				t.Fatalf("want nothing, got %+v", out)
			}
		})
	}
}
