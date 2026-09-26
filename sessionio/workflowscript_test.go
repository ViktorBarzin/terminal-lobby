package sessionio

import (
	"reflect"
	"strings"
	"testing"
)

// The shapes of meta literal the Workflow scripts on this box use, sanitized:
// unquoted keys, single-quoted strings (some holding a double quote or an
// escaped single quote), trailing commas, phases with and without a detail,
// and one-line scripts that carry straight on after the closing brace. On all
// 78 runs here that have both a script and a run file, the literal's name,
// description and phases are the run file's workflowName, summary and phases.
func TestParseWorkflowScriptShapes(t *testing.T) {
	threePhases := []WorkflowPhase{
		{Index: 1, Title: "Survey", Detail: "read the diff and the design"},
		{Index: 2, Title: "Review", Detail: "two blind reviewers"},
		{Index: 3, Title: "Land", Detail: "merge, push and watch CI"},
	}
	for _, tc := range []struct {
		name string
		in   string
		want workflowMeta
	}{
		{"the common shape: one key a line, trailing commas", `export const meta = {
  name: 'review-change',
  description: 'Review the change in two passes and land it',
  phases: [
    { title: 'Survey', detail: 'read the diff and the design' },
    { title: 'Review', detail: 'two blind reviewers' },
    { title: 'Land', detail: 'merge, push and watch CI' },
  ],
}

const survey = await agent('Read the diff.', { label: 'survey' })
`, workflowMeta{Name: "review-change", Description: "Review the change in two passes and land it", Phases: threePhases}},

		{"one line, a semicolon straight after the brace",
			`export const meta = { name: 'quick-check', description: 'One pass over the tree' }; const r = await agent('Check it.')`,
			workflowMeta{Name: "quick-check", Description: "One pass over the tree"}},

		{"one line, a space before the semicolon",
			`export const meta = { name: 'quick-check', description: 'One pass over the tree' } ; const r = 1`,
			workflowMeta{Name: "quick-check", Description: "One pass over the tree"}},

		{"phases with no detail, on one line", `export const meta = {
  name: 'two-step',
  description: 'Build, then check',
  phases: [{ title: 'Build' }, { title: 'Check' }],
}
`, workflowMeta{Name: "two-step", Description: "Build, then check",
			Phases: []WorkflowPhase{{Index: 1, Title: "Build"}, {Index: 2, Title: "Check"}}}},

		{"a double quote inside single quotes, and an escaped single quote", `export const meta = {
  name: 'answer-card',
  description: 'Check the "answer card" end to end',
  phases: [
    { title: 'Check', detail: 'the author\'s own check' },
  ],
}`, workflowMeta{Name: "answer-card", Description: `Check the "answer card" end to end`,
			Phases: []WorkflowPhase{{Index: 1, Title: "Check", Detail: "the author's own check"}}}},

		{"keys it does not use are skipped", `export const meta = {
  name: 'tidy',
  description: 'Tidy the docs',
  whenToUse: 'after a release',
  version: 2,
  draft: false,
  owner: null,
  tags: ['docs', 'release'],
  phases: [{ title: 'Tidy', detail: 'one pass', weight: 1.5e2 }],
}`, workflowMeta{Name: "tidy", Description: "Tidy the docs",
			Phases: []WorkflowPhase{{Index: 1, Title: "Tidy", Detail: "one pass"}}}},

		{"JSON's own shape", `export const meta = {"name": "json-shaped", "description": "Quoted keys", "phases": [{"title": "Only", "detail": "d"}]}`,
			workflowMeta{Name: "json-shaped", Description: "Quoted keys",
				Phases: []WorkflowPhase{{Index: 1, Title: "Only", Detail: "d"}}}},

		{"a template literal with no interpolation", "export const meta = {\n  name: `templated`,\n  description: `Two\nlines`,\n}",
			workflowMeta{Name: "templated", Description: "Two\nlines"}},

		{"comments before and inside the literal", `// Written by the planner.
/* A block comment,
   over two lines. */
export const meta = {
  // the run's own name
  name: 'commented', /* inline */
  description: 'Has comments', // trailing
}`, workflowMeta{Name: "commented", Description: "Has comments"}},

		{"escapes", `export const meta = { name: 'esc', description: 'tab\there, café, \x41, \u{1F600}, 😀, back\\slash, joined \
line' }`, workflowMeta{Name: "esc", Description: "tab\there, café, A, 😀, 😀, back\\slash, joined line"}},

		{"a byte order mark and blank lines first", "\ufeff\n\n  export const meta = { name: 'bom', description: 'd' }",
			workflowMeta{Name: "bom", Description: "d"}},

		{"a duplicate key: the last one stands, as in JavaScript", `export const meta = { name: 'first', name: 'second', description: 'd' }`,
			workflowMeta{Name: "second", Description: "d"}},

		{"fields of the wrong type cost only themselves", `export const meta = { name: 7, description: 'still read', phases: 'none' }`,
			workflowMeta{Description: "still read"}},

		{"a phase that is not an object keeps its place", `export const meta = { name: 'n', description: 'd', phases: ['odd', { title: 'Second' }] }`,
			workflowMeta{Name: "n", Description: "d", Phases: []WorkflowPhase{{Index: 1}, {Index: 2, Title: "Second"}}}},

		{"an empty phases list", `export const meta = { name: 'n', description: 'd', phases: [] }`,
			workflowMeta{Name: "n", Description: "d"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := parseWorkflowScript([]byte(tc.in))
			if !ok {
				t.Fatalf("parseWorkflowScript did not read a meta from %q", tc.in)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("parseWorkflowScript\n got %+v\nwant %+v", got, tc.want)
			}
		})
	}
}

// Anything the parser does not understand means no meta, never a guess: the
// run then reads as it would with no script at all. That covers a script
// caught mid-write, a literal that is not pure (the Workflow tool asks for no
// variables, calls or interpolation), and anything past the parser's bounds.
func TestParseWorkflowScriptRefusesWhatItDoesNotUnderstand(t *testing.T) {
	whole := `export const meta = {
  name: 'review-change',
  description: 'Review the change',
  phases: [{ title: 'Survey', detail: 'read it' }],
}
`
	for _, tc := range []struct {
		name string
		in   string
	}{
		{"an empty file", ""},
		{"caught mid-write", whole[:len(whole)/2]},
		{"cut off just before the closing brace", whole[:strings.LastIndex(whole, "}")]},
		{"no meta: the script starts with code", "const x = 1\nexport const meta = { name: 'late', description: 'd' }"},
		{"meta is a variable", "export const meta = base"},
		{"meta is a list", "export const meta = [{ name: 'n' }]"},
		{"meta is a string", "export const meta = 'n'"},
		{"let rather than const", "export let meta = { name: 'n', description: 'd' }"},
		{"no export", "const meta = { name: 'n', description: 'd' }"},
		{"words run together", "export constmeta = { name: 'n', description: 'd' }"},
		{"a type annotation", "export const meta: Meta = { name: 'n', description: 'd' }"},
		{"an interpolation", "export const meta = { name: `n-${x}`, description: 'd' }"},
		{"a call", "export const meta = { name: String(1), description: 'd' }"},
		{"a variable as a value", "export const meta = { name: NAME, description: 'd' }"},
		{"undefined as a value", "export const meta = { name: 'n', description: undefined }"},
		{"a spread", "export const meta = { ...base, name: 'n' }"},
		{"a computed key", "export const meta = { ['name']: 'n' }"},
		{"a shorthand property", "export const meta = { name, description: 'd' }"},
		{"a method", "export const meta = { name() { return 'n' } }"},
		{"a concatenation", "export const meta = { name: 'a' + 'b', description: 'd' }"},
		{"a hole in a list", "export const meta = { name: 'n', phases: [{ title: 'A' }, , { title: 'B' }] }"},
		{"two commas", "export const meta = { name: 'n',, description: 'd' }"},
		{"a missing comma", "export const meta = { name: 'n' description: 'd' }"},
		{"an unterminated string", "export const meta = { name: 'n, description: 'd' }"},
		{"a line break inside a quoted string", "export const meta = { name: 'two\nlines', description: 'd' }"},
		{"an octal escape", `export const meta = { name: '\101', description: 'd' }`},
		{"a bad hex escape", `export const meta = { name: '\xZZ', description: 'd' }`},
		{"a bad unicode escape", `export const meta = { name: '\u12', description: 'd' }`},
		{"a code point past the last", `export const meta = { name: '\u{110000}', description: 'd' }`},
		{"an unterminated block comment", "/* never closed\nexport const meta = { name: 'n', description: 'd' }"},
		{"nested past the depth bound", "export const meta = { name: 'n', deep: " + strings.Repeat("[", maxMetaDepth+1) + strings.Repeat("]", maxMetaDepth+1) + " }"},
		{"a literal past the size bound", "export const meta = { name: 'n', description: '" + strings.Repeat("x", maxMetaBytes) + "' }"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got, ok := parseWorkflowScript([]byte(tc.in)); ok {
				t.Fatalf("parseWorkflowScript read %+v from %q, want no meta", got, tc.in)
			}
		})
	}
}

// Nesting up to the bound is fine: the bound is there to stop a hostile file
// from walking the parser's stack, not to limit an honest literal.
func TestParseWorkflowScriptNestsUpToItsBound(t *testing.T) {
	in := "export const meta = { name: 'n', description: 'd', deep: " +
		strings.Repeat("[", maxMetaDepth) + strings.Repeat("]", maxMetaDepth) + " }"
	if _, ok := parseWorkflowScript([]byte(in)); !ok {
		t.Fatalf("a literal nested %d deep below its top was refused", maxMetaDepth)
	}
}

// The script's file name carries the run it belongs to: <name>-wf_<runId>.js,
// where the name is the workflow's own and may hold hyphens of its own.
func TestWorkflowScriptRun(t *testing.T) {
	for _, tc := range []struct {
		name   string
		wantID string
		wantOK bool
	}{
		{"text-view-native-images-wf_5cbd0d6a-44b.js", "wf_5cbd0d6a-44b", true},
		{"marginalia-check-wf_99a3d61f-4e9.js", "wf_99a3d61f-4e9", true},
		{"a-name-with-wf_-in-it-wf_0a1b2c3d-4e5.js", "wf_0a1b2c3d-4e5", true},
		{"wf_0a1b2c3d-4e5.js", "wf_0a1b2c3d-4e5", true},
		{"review-wf_.js", "", false},
		{"review-wf_0a1b2c3d-4e5.json", "", false},
		{"review-wf_0a1b2c3d-4e5.js.tmp", "", false},
		{"reviewwf_0a1b2c3d-4e5.js", "", false},
		{"review.js", "", false},
		{"", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			id, ok := WorkflowScriptRun(tc.name)
			if id != tc.wantID || ok != tc.wantOK {
				t.Errorf("WorkflowScriptRun(%q) = %q, %v; want %q, %v", tc.name, id, ok, tc.wantID, tc.wantOK)
			}
		})
	}
}
