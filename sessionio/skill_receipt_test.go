package sessionio

import (
	"encoding/json"
	"strings"
	"testing"
)

// The receipt, not the marker.
//
// skillLoad detects a load by the string "Base directory for this skill:".
// Measured across 409 transcripts on 2026-09-04: 340 skill bodies carry it and
// collapse to one line, and 24 do NOT and render in full — median 16,584
// characters, 248,757 in total, of which workflow-authoring is 14. Every one of
// the 364 is preceded by the Skill tool's own result, "Launching skill: <name>",
// so that is the signal that catches all of them.
func TestSkillReceipt(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   string
		want string
		ok   bool
	}{
		{name: "names the skill", in: "Launching skill: grilling", want: "grilling", ok: true},
		{
			name: "a plugin's skill keeps its namespace",
			in:   "Launching skill: superpowers:brainstorming",
			want: "superpowers:brainstorming", ok: true,
		},
		{
			// The 14 workflow-authoring records are this shape: a bundled skill
			// whose body carries no marker at all.
			name: "a bundled skill is named the same way",
			in:   "Launching skill: workflow-authoring",
			want: "workflow-authoring", ok: true,
		},
		{
			name: "trailing whitespace is not part of the name",
			in:   "Launching skill: doc-tone\n",
			want: "doc-tone", ok: true,
		},
		{name: "a name is required", in: "Launching skill: ", ok: false},
		{name: "prose that mentions launching a skill is not a receipt", in: "I am launching skill: x", ok: false},
		{name: "an error result is not a receipt", in: `Error: no such skill "nope"`, ok: false},
		{name: "empty", in: "", ok: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := skillReceipt(tc.in)
			if ok != tc.ok {
				t.Fatalf("ok = %v, want %v (got %q)", ok, tc.ok, got)
			}
			if ok && got != tc.want {
				t.Errorf("skillReceipt() = %q, want %q", got, tc.want)
			}
		})
	}
}

// metaUser is the isMeta user record a skill body arrives as.
func metaUser(text string) []byte {
	b, _ := json.Marshal(map[string]any{
		"type":    "user",
		"isMeta":  true,
		"uuid":    "u-body",
		"message": map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": text}}},
	})
	return b
}

func skillCall(name string) []byte {
	b, _ := json.Marshal(map[string]any{
		"type": "assistant",
		"uuid": "a-call",
		"message": map[string]any{"role": "assistant", "content": []any{
			map[string]any{"type": "tool_use", "id": "tu_s", "name": "Skill", "input": map[string]any{"skill": name}},
		}},
	})
	return b
}

func skillResult(text string) []byte {
	b, _ := json.Marshal(map[string]any{
		"type": "user",
		"uuid": "u-res",
		"message": map[string]any{"content": []any{
			map[string]any{"type": "tool_result", "tool_use_id": "tu_s", "content": text},
		}},
	})
	return b
}

func onlySkill(t *testing.T, evs []Event) Event {
	t.Helper()
	var found []Event
	for _, e := range evs {
		if e.Kind == KindMeta && e.Meta == MetaSkill {
			found = append(found, e)
		}
	}
	if len(found) != 1 {
		t.Fatalf("want exactly 1 meta:skill, got %d in %v", len(found), kinds(evs))
	}
	return found[0]
}

// The whole sequence, as the transcript writes it: the Skill tool_use, its
// receipt, then the body as an isMeta user record.
func TestSkillLoadEndToEnd(t *testing.T) {
	bundled := "# Workflow authoring reference\n\n" + strings.Repeat("x", 16_000)
	marked := "Base directory for this skill: /home/wizard/.claude/skills/grilling\n\nInterview…"

	for _, tc := range []struct {
		name   string
		result string
		body   string
		want   string
	}{
		{
			name:   "a bundled skill, whose body carries no marker",
			result: "Launching skill: workflow-authoring",
			body:   bundled,
			want:   "workflow-authoring",
		},
		{
			name:   "a filesystem skill, whose body carries one",
			result: "Launching skill: grilling",
			body:   marked,
			want:   "grilling",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			n := NewNormalizer("s")
			var got []Event
			got = append(got, n.Line(skillCall(tc.want))...)
			got = append(got, n.Line(skillResult(tc.result))...)
			got = append(got, n.Line(metaUser(tc.body))...)

			skill := onlySkill(t, got)
			if skill.Body != tc.want {
				t.Errorf("name = %q, want %q", skill.Body, tc.want)
			}
			if skill.Bytes != int64(len(tc.body)) {
				t.Errorf("bytes = %d, want %d", skill.Bytes, len(tc.body))
			}
			// The body must not be on the wire: collapsing it is the point.
			for _, e := range got {
				if strings.Contains(e.Body, "xxxxxxxxxx") {
					t.Errorf("the %s event carries the skill body", e.Kind)
				}
				if e.Kind == KindUser {
					t.Errorf("the skill body became a user message: %q", e.Body)
				}
			}
		})
	}
}

// A body with the marker and no receipt before it still collapses: the marker
// path stays as the fallback.
func TestSkillLoadWithoutAReceipt(t *testing.T) {
	n := NewNormalizer("s")
	body := "Base directory for this skill: /home/wizard/.claude/skills/doc-tone\n\n# doc-tone"
	skill := onlySkill(t, n.Line(metaUser(body)))
	if skill.Body != "doc-tone" {
		t.Errorf("name = %q, want %q", skill.Body, "doc-tone")
	}
	if skill.Bytes != int64(len(body)) {
		t.Errorf("bytes = %d, want %d", skill.Bytes, len(body))
	}
}

// A receipt that is never followed by a body must not swallow the next isMeta
// record that happens along. The Skill tool can fail — a name that does not
// resolve — and nothing is injected then.
func TestAFailedSkillDoesNotSwallowTheNextRecord(t *testing.T) {
	n := NewNormalizer("s")
	n.Line(skillCall("nope"))
	n.Line(skillResult(`Error: no skill named "nope"`))
	for _, e := range n.Line(metaUser("<system-reminder>something else entirely</system-reminder>")) {
		if e.Kind == KindMeta && e.Meta == MetaSkill {
			t.Errorf("a failed Skill call turned the next record into a skill load: %q", e.Body)
		}
	}
}

// One receipt, one body. A second isMeta record must not be claimed by the same
// pending receipt — a skill's SKILL.md is followed by all sorts of injected text.
func TestAReceiptIsSpentOnce(t *testing.T) {
	n := NewNormalizer("s")
	n.Line(skillCall("grilling"))
	n.Line(skillResult("Launching skill: grilling"))
	first := onlySkill(t, n.Line(metaUser("Interview the user relentlessly…")))
	if first.Body != "grilling" {
		t.Fatalf("name = %q", first.Body)
	}
	for _, e := range n.Line(metaUser("<system-reminder>a later reminder</system-reminder>")) {
		if e.Kind == KindMeta && e.Meta == MetaSkill {
			t.Errorf("the receipt was spent twice: %q", e.Body)
		}
	}
}

// The Skill tool call keeps its own event. The renderer folds the two into one
// card, and needs both: the call carries the name and the args, the meta event
// carries the size of what was collapsed.
func TestTheSkillCallKeepsItsEvent(t *testing.T) {
	n := NewNormalizer("s")
	got := n.Line(skillCall("grilling"))
	var use *Event
	for i := range got {
		if got[i].Kind == KindToolUse && got[i].Tool == "Skill" {
			use = &got[i]
		}
	}
	if use == nil {
		t.Fatalf("no Skill tool_use event: %v", kinds(got))
	}
	if !strings.Contains(use.Body, "grilling") {
		t.Errorf("the call lost its input: %q", use.Body)
	}
}
