package sessionio

import (
	"strings"
	"testing"
	"unicode/utf8"
)

// The panel's tool line is the timeline row's headline for the same call, so a
// reader recognises it in both places. These rows follow frontend-v2's
// describe() label choice per tool, with two differences the panel needs: a path
// stays whole rather than shortened, and everything fits in toolDetailMax.
func TestToolDetail(t *testing.T) {
	long := "/home/user/project/" + strings.Repeat("deeply/nested/", 10) + "agents.go"
	for _, tc := range []struct {
		name  string
		tool  string
		input string
		want  string
	}{
		{"bash command", "Bash", `{"command":"go test ./...","description":"Run the tests"}`, "go test ./..."},
		{"bash drops a leading cd", "Bash", `{"command":"cd /home/user/project && gh issue list --state open"}`, "gh issue list --state open"},
		{"bash cd on its own line", "Bash", `{"command":"cd /home/user/project\nmake build"}`, "make build …"},
		{"bash marks a multi-line script", "Bash", `{"command":"go test ./...\ngo vet ./..."}`, "go test ./... …"},
		{"bash with only a description", "Bash", `{"command":"","description":"Wait for CI"}`, "Wait for CI"},
		{"read keeps the whole path", "Read", `{"file_path":"/home/user/project/docs/triage.md"}`, "/home/user/project/docs/triage.md"},
		{"a long path keeps its file name", "Edit", `{"file_path":"` + long + `"}`, "…" + long[len(long)-(toolDetailMax-1):]},
		{"notebook", "NotebookEdit", `{"notebook_path":"/home/user/n.ipynb"}`, "/home/user/n.ipynb"},
		{"grep", "Grep", `{"pattern":"updated:<2026-06","path":"issues/"}`, "updated:<2026-06"},
		{"glob", "Glob", `{"pattern":"issues/**/*.md"}`, "issues/**/*.md"},
		{"web search", "WebSearch", `{"query":"claude code subagents"}`, "claude code subagents"},
		{"web fetch", "WebFetch", `{"url":"https://example.com/a","prompt":"summarise"}`, "https://example.com/a"},
		{"agent", "Agent", `{"description":"Check stale issues","subagent_type":"Explore","prompt":"Find them"}`, "Check stale issues"},
		{"task, the old name", "Task", `{"subagent_type":"Explore","prompt":"Find them"}`, "Explore"},
		{"skill", "Skill", `{"skill":"unslop","args":"x"}`, "unslop"},
		{"question", "AskUserQuestion", `{"questions":[{"question":"Which port?","header":"Port"}]}`, "Which port?"},
		{"todo list", "TodoWrite", `{"todos":[{"content":"a","status":"completed"},{"content":"b","status":"in_progress"},{"content":"c","status":"pending"}]}`, "1/3 done"},
		// Map iteration order would make this flaky; the first string in the
		// input as written is the only stable answer.
		{"unknown tool takes the first string as written", "mcp__tracker__search", `{"limit":5,"zeta":"first","alpha":"second"}`, "first"},
		{"newlines fold to one line", "Grep", "{\"pattern\":\"a\\nb\\tc\"}", "a b c"},
		{"no input", "Read", ``, ""},
		{"input that is not an object", "Bash", `"ls"`, ""},
		{"no string in the input", "StructuredOutput", `{"ok":true,"findings":[]}`, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := toolDetail(tc.tool, []byte(tc.input)); got != tc.want {
				t.Errorf("toolDetail(%s, %s)\n got %q\nwant %q", tc.tool, tc.input, got, tc.want)
			}
		})
	}
}

// Whatever the input, the line fits the contract's 120 characters, counted in
// runes, and is never cut inside one.
func TestToolDetailFitsTheLimit(t *testing.T) {
	for _, tc := range []struct {
		name  string
		tool  string
		input string
	}{
		{"ascii command", "Bash", `{"command":"` + strings.Repeat("x", 300) + `"}`},
		{"multibyte command", "Bash", `{"command":"` + strings.Repeat("жълт ", 80) + `"}`},
		{"multibyte path", "Read", `{"file_path":"/` + strings.Repeat("папка/", 40) + `файл.go"}`},
		{"unknown tool", "Mystery", `{"note":"` + strings.Repeat("é", 400) + `"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := toolDetail(tc.tool, []byte(tc.input))
			if n := utf8.RuneCountInString(got); n != toolDetailMax {
				t.Errorf("%d runes, want exactly %d (cut to the limit): %q", n, toolDetailMax, got)
			}
			if !utf8.ValidString(got) {
				t.Errorf("not valid UTF-8: %q", got)
			}
			if !strings.Contains(got, "…") {
				t.Errorf("a cut line should say so with an ellipsis: %q", got)
			}
		})
	}
}
