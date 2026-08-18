package sessionio

import (
	"encoding/json"
	"testing"
)

// A real reading, trimmed of the per-tool tables that make up most of its
// 14,930 characters. Copied from a transcript on this box (2026-08-18, CLI
// 2.1.234) rather than hand-written, because the exact spacing — two trailing
// spaces after the Model line, the blank line before each table — is what the
// parse has to survive.
const realContextReading = "## Context Usage\n" +
	"\n" +
	"**Model:** claude-opus-5  \n" +
	"**Tokens:** 65.2k / 1m (7%)\n" +
	"\n" +
	"### Estimated usage by category\n" +
	"\n" +
	"| Category | Tokens | Percentage |\n" +
	"|----------|--------|------------|\n" +
	"| System prompt | 3.5k | 0.4% |\n" +
	"| System tools | 18k | 1.8% |\n" +
	"| MCP tools (deferred) | 95.3k | 9.5% |\n" +
	"| Custom agents | 71 | 0.0% |\n" +
	"| Messages | 25.8k | 2.6% |\n" +
	"| Free space | 934.8k | 93.5% |\n" +
	"\n" +
	"### MCP Tools\n" +
	"\n" +
	"| Tool | Server | Tokens |\n" +
	"|------|--------|--------|\n" +
	"| mcp__claude_ai_Asana__authenticate | claude_ai_Asana | 172 |\n"

func TestContextReading(t *testing.T) {
	got, ok := contextReading(realContextReading)
	if !ok {
		t.Fatal("a real /context record was not recognised as a reading")
	}
	if got.Model != "claude-opus-5" {
		t.Errorf("model = %q, want claude-opus-5", got.Model)
	}
	// The CLI rounds for display and we keep its numbers rather than inventing
	// precision it did not publish: 65.2k is 65,200, not a token count we
	// derived ourselves.
	if got.UsedTokens != 65200 {
		t.Errorf("usedTokens = %d, want 65200", got.UsedTokens)
	}
	// A 1m ceiling is why the meter reads the CLI instead of assuming 200k —
	// that assumption would have been wrong by a factor of five here.
	if got.MaxTokens != 1_000_000 {
		t.Errorf("maxTokens = %d, want 1000000", got.MaxTokens)
	}
	if got.Percent != 7 {
		t.Errorf("percent = %v, want 7", got.Percent)
	}
}

// The category table is the breakdown worth carrying. The MCP/agent/memory/skill
// tables below it are what make the record 14.9 KB, and they stop at the next
// heading — carrying them would put a phone's whole SSE budget into one row.
func TestContextReadingCarriesOnlyTheCategoryTable(t *testing.T) {
	got, ok := contextReading(realContextReading)
	if !ok {
		t.Fatal("not recognised")
	}
	want := []ContextCategory{
		{Name: "System prompt", Tokens: 3500, Percent: 0.4},
		{Name: "System tools", Tokens: 18000, Percent: 1.8},
		{Name: "MCP tools (deferred)", Tokens: 95300, Percent: 9.5},
		{Name: "Custom agents", Tokens: 71, Percent: 0},
		{Name: "Messages", Tokens: 25800, Percent: 2.6},
		{Name: "Free space", Tokens: 934800, Percent: 93.5},
	}
	if len(got.Categories) != len(want) {
		t.Fatalf("got %d categories, want %d: %+v", len(got.Categories), len(want), got.Categories)
	}
	for i, w := range want {
		if got.Categories[i] != w {
			t.Errorf("category %d = %+v, want %+v", i, got.Categories[i], w)
		}
	}
}

func TestContextReadingRejectsWhatIsNotOne(t *testing.T) {
	for _, tc := range []struct{ name, in string }{
		{"empty", ""},
		{"ordinary prose", "let's check the context usage before we compact"},
		{
			// A message that merely quotes the heading is not a reading. This
			// document itself does exactly that, and so does any session
			// discussing the feature.
			"a heading quoted mid-message",
			"the record starts with\n\n## Context Usage\n\nwhich is how we spot it",
		},
		{"the heading with no tokens line", "## Context Usage\n\n**Model:** claude-opus-5\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got, ok := contextReading(tc.in); ok {
				t.Errorf("recognised %q as a reading: %+v", tc.in, got)
			}
		})
	}
}

// Every shape the token field takes across the categories of a real reading.
func TestContextTokens(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want int64
		ok   bool
	}{
		{"71", 71, true},
		{"18k", 18000, true},
		{"3.5k", 3500, true},
		{"934.8k", 934800, true},
		{"1m", 1_000_000, true},
		{"1.2m", 1_200_000, true},
		{"200k", 200000, true},
		{"", 0, false},
		{"lots", 0, false},
	} {
		t.Run(tc.in, func(t *testing.T) {
			got, ok := contextTokens(tc.in)
			if ok != tc.ok || got != tc.want {
				t.Errorf("contextTokens(%q) = %d,%v; want %d,%v", tc.in, got, ok, tc.want, tc.ok)
			}
		})
	}
}

func recordLine(t *testing.T, rec map[string]any) []byte {
	t.Helper()
	b, err := json.Marshal(rec)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

// The reading is a session-state fact, not something anybody said, so it leaves
// the normalizer as one meta event carrying structure — not as the
// 14,930-character markdown block attributed to Claude that it renders as
// today.
func TestNormalizeEmitsAContextReading(t *testing.T) {
	n := NewNormalizer("demo")
	out := n.Line(recordLine(t, map[string]any{
		"type":   "user",
		"isMeta": true,
		"uuid":   "c1",
		// Real records carry the markdown as a plain content string.
		"message": map[string]any{"role": "user", "content": realContextReading},
	}))

	if len(out) != 1 {
		t.Fatalf("want exactly 1 event, got %d: %+v", len(out), out)
	}
	e := out[0]
	if e.Kind != KindMeta || e.Meta != MetaContext {
		t.Fatalf("kind/meta = %v/%v, want %v/%v", e.Kind, e.Meta, KindMeta, MetaContext)
	}
	if e.Context == nil {
		t.Fatal("no reading on the event")
	}
	if e.Context.UsedTokens != 65200 || e.Context.MaxTokens != 1_000_000 {
		t.Errorf("reading = %+v", e.Context)
	}
	// The body is where the 14.9 KB would ride if we carried the markdown.
	if e.Body != "" {
		t.Errorf("body should be empty, got %d chars", len(e.Body))
	}
}

// A session discussing this feature quotes the heading constantly — including
// the one this was built in. Those are ordinary messages and must stay so.
func TestNormalizeLeavesAQuotedHeadingAlone(t *testing.T) {
	n := NewNormalizer("demo")
	body := "we look for\n\n## Context Usage\n\nat the start of the record"
	out := n.Line(recordLine(t, map[string]any{
		"type": "assistant", "uuid": "q1",
		"message": map[string]any{"role": "assistant", "content": []any{
			map[string]any{"type": "text", "text": body},
		}},
	}))
	if len(out) != 1 || out[0].Kind != KindText || out[0].Body != body {
		t.Fatalf("a quoted heading was not left as text: %+v", out)
	}
}
