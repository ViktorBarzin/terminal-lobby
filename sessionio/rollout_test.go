package sessionio

import "testing"

func TestBoxDraft(t *testing.T) {
	rule := "\x1b[38;5;244m────────────────\x1b[39m \x1b[38;5;208m↯\x1b[39m \x1b[38;5;244m─"
	below := "\x1b[38;5;244m────────────────"
	for _, c := range []struct {
		name      string
		box       string
		draft, ok bool
	}{
		{"empty", "\x1b[39m❯ ", false, true},
		{"suggestion", "\x1b[39m❯ \x1b[2mhow do I declare it online\x1b[0m", false, true},
		{"typed", "\x1b[39m❯ fix the build\x1b[7m \x1b[27m", true, true},
	} {
		draft, ok := BoxDraft("history\n" + rule + "\n" + c.box + "\n" + below + "\n")
		if draft != c.draft || ok != c.ok {
			t.Errorf("%s: BoxDraft = %v, %v; want %v, %v", c.name, draft, ok, c.draft, c.ok)
		}
	}
	if _, ok := BoxDraft("Do you want to proceed?\n❯ 1. Yes\n  2. No\n"); ok {
		t.Error("a menu cursor read as an input box")
	}
}

func TestResumeCommand(t *testing.T) {
	sid := "eefe8a5b-fa7b-4679-8a64-f3fcb919002e"
	for _, c := range []struct{ start, want string }{
		{`/bin/zsh -lic "claude --dangerously-skip-permissions"`,
			`/bin/zsh -lic "claude --dangerously-skip-permissions --resume ` + sid + `"`},
		{`zsh -lic "claude --resume 11111111-2222-3333-4444-555555555555 --dangerously-skip-permissions --effort max --model claude-opus-5-5"`,
			`zsh -lic "claude --dangerously-skip-permissions --effort max --model claude-opus-5-5 --resume ` + sid + `"`},
		{`/bin/zsh -lic "claude --continue --name x"`, `/bin/zsh -lic "claude --name x --resume ` + sid + `"`},
		{`/bin/zsh -lic "claude"`, `/bin/zsh -lic "claude --resume ` + sid + `"`},
	} {
		got, ok := ResumeCommand(c.start, sid)
		if !ok || got != c.want {
			t.Errorf("ResumeCommand(%q) = %q, %v; want %q", c.start, got, ok, c.want)
		}
	}
	for _, start := range []string{"bash", `/bin/zsh -lic "pi"`, `/bin/zsh -lic "claude; rm -rf /"`} {
		if got, ok := ResumeCommand(start, sid); ok {
			t.Errorf("ResumeCommand(%q) = %q, want refused", start, got)
		}
	}
	if _, ok := ResumeCommand(`/bin/zsh -lic "claude"`, "not-a-uuid"); ok {
		t.Error("a sid that is not a uuid was accepted")
	}
}

func TestParseRolloutSessions(t *testing.T) {
	got := parseRolloutSessions("a\tdone\t\t\t/p/x.jsonl\t\t/bin/zsh -lic \"claude\"\t/home/u\nbroken\n")
	if len(got) != 1 || got[0].Name != "a" || got[0].State != "done" || got[0].Transcript != "/p/x.jsonl" || got[0].Cwd != "/home/u" {
		t.Fatalf("parse = %+v", got)
	}
}
