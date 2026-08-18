package sessionio

import "testing"

// Loading a skill injects its whole SKILL.md as an isMeta user record — 312 of
// them across this box's transcripts, median 3,125 characters, up to 23,342 —
// and it rendered as an enormous assistant message nobody wrote or wanted to
// read (Viktor, 2026-08-18). The load is worth one line; the body is not.
func TestSkillLoad(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   string
		want string
		ok   bool
	}{
		{
			name: "a personal skill is named by its directory",
			in:   "Base directory for this skill: /home/wizard/.claude/skills/doc-tone\n\n# doc-tone\n…",
			want: "doc-tone", ok: true,
		},
		{
			// The CLI spells this one `superpowers:brainstorming`, and so does
			// the composer's `/` menu — the version in the path is not part of
			// the name.
			name: "a plugin's skill keeps its namespace",
			in: "Base directory for this skill: /home/wizard/.claude/plugins/cache/" +
				"claude-plugins-official/superpowers/5.1.0/skills/brainstorming\n\n# …",
			want: "superpowers:brainstorming", ok: true,
		},
		{
			// 37 of these records do not have the marker on the first line.
			name: "the marker need not be the first line",
			in:   "\n\nBase directory for this skill: /home/wizard/.claude/skills/wrap-up\n…",
			want: "wrap-up", ok: true,
		},
		{name: "ordinary prose is not a skill load", in: "let's load the grilling skill", ok: false},
		{name: "empty", in: "", ok: false},
		{
			name: "a marker naming nothing is not a load",
			in:   "Base directory for this skill:   \n",
			ok:   false,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := skillLoad(tc.in)
			if ok != tc.ok {
				t.Fatalf("ok = %v, want %v (got %q)", ok, tc.ok, got)
			}
			if ok && got != tc.want {
				t.Errorf("skillLoad() = %q, want %q", got, tc.want)
			}
		})
	}
}
