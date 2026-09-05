package sessionio

import (
	"strings"
	"testing"
)

// Every assistant record names the model that wrote it and the effort it wrote
// at, so the transcript — not the pane — is where a Claude session's live
// setting comes from. A stock pane says nothing about the model: the line under
// the input belongs to whatever statusLine command the account configured.
func TestNormalizeReportsTheModelAndEffortOnce(t *testing.T) {
	n := NewNormalizer("demo")
	line := `{"type":"assistant","effort":"max","message":{"role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"hi"}]},"uuid":"UU"}`

	got := modelEvent(n.Line([]byte(strings.Replace(line, "UU", "a1", 1))))
	if got == nil {
		t.Fatal("the first assistant record reported no model")
	}
	if got.Model == nil || got.Model.Model != "claude-opus-5" || got.Model.Effort != "max" {
		t.Fatalf("model event = %+v", got)
	}

	// The same pair on every turn would put a marker in the transcript for
	// something that did not change.
	if again := modelEvent(n.Line([]byte(strings.Replace(line, "UU", "a2", 1)))); again != nil {
		t.Fatalf("the unchanged model was reported again: %+v", again.Model)
	}
}

func TestNormalizeReportsTheModelWhenItChanges(t *testing.T) {
	n := NewNormalizer("demo")
	n.Line([]byte(`{"type":"assistant","effort":"max","message":{"role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"hi"}]},"uuid":"a1"}`))
	got := modelEvent(n.Line([]byte(`{"type":"assistant","effort":"high","message":{"role":"assistant","model":"claude-sonnet-5","content":[{"type":"text","text":"hi"}]},"uuid":"a2"}`)))

	if got == nil {
		t.Fatal("a changed model was not reported")
	}
	if got.Model.Model != "claude-sonnet-5" || got.Model.Effort != "high" {
		t.Fatalf("model event = %+v", got.Model)
	}
}

// A sidechain is a subagent, which runs on whatever model it was dispatched
// with. Reporting that as the session's model would show Haiku on a thread the
// operator is driving on Opus.
func TestNormalizeIgnoresASubagentsModel(t *testing.T) {
	n := NewNormalizer("demo")
	n.Line([]byte(`{"type":"assistant","effort":"max","message":{"role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"hi"}]},"uuid":"a1"}`))
	got := modelEvent(n.Line([]byte(`{"type":"assistant","isSidechain":true,"effort":"low","message":{"role":"assistant","model":"claude-haiku-4-5","content":[{"type":"text","text":"sub"}]},"uuid":"a2"}`)))
	if got != nil {
		t.Fatalf("a subagent's model was reported as the session's: %+v", got.Model)
	}
}

// A record with no model on it — an older transcript, or a line the CLI writes
// without one — must not report an empty model over a real one.
func TestNormalizeIgnoresARecordThatNamesNoModel(t *testing.T) {
	n := NewNormalizer("demo")
	n.Line([]byte(`{"type":"assistant","effort":"max","message":{"role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"hi"}]},"uuid":"a1"}`))
	got := modelEvent(n.Line([]byte(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"more"}]},"uuid":"a2"}`)))
	if got != nil {
		t.Fatalf("a record with no model reported one: %+v", got.Model)
	}
}

// The snapshot an arriving reader gets has to carry the model too, or a chip
// would sit blank until the session's next turn.
func TestSessionStateCarriesTheModel(t *testing.T) {
	f := NewFileSource("demo", "", 0)
	n := NewNormalizer("demo")
	for _, e := range n.Line([]byte(`{"type":"assistant","effort":"xhigh","message":{"role":"assistant","model":"claude-sonnet-5","content":[{"type":"text","text":"hi"}]},"uuid":"a1"}`)) {
		f.Append(e)
	}
	st := f.State(10)
	if st.Model == nil || st.Model.Model != "claude-sonnet-5" || st.Model.Effort != "xhigh" {
		t.Fatalf("session state model = %+v", st.Model)
	}
}

// The `/model` receipt is what makes a change visible BEFORE the session takes
// another turn. Without it a reader arriving in that window is shown the model
// that answered last, which is the one the change just replaced.
func TestNormalizeReportsAModelChangeFromItsReceipt(t *testing.T) {
	n := NewNormalizer("demo")
	n.Line([]byte(`{"type":"assistant","effort":"max","message":{"role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"hi"}]},"uuid":"a1"}`))

	got := modelEvent(n.Line([]byte(`{"type":"user","isMeta":true,"message":{"role":"user","content":[{"type":"text","text":"<local-command-stdout>Set model to ` + "`" + `Sonnet 5` + "`" + ` for this session only</local-command-stdout>"}]},"uuid":"a2"}`)))
	if got == nil {
		t.Fatal("the receipt reported no model change")
	}
	// The word the picker uses, not the sentence the receipt is written in.
	if got.Model.Model != "sonnet" {
		t.Fatalf("model event = %+v", got.Model)
	}
	// And the effort in force rides along, because the pair is what a reader
	// is shown and the receipt says nothing about the other half.
	if got.Model.Effort != "max" {
		t.Fatalf("the effort was dropped: %+v", got.Model)
	}
}

// "Kept model as X" is what the command answers when the pick was the model
// already in force. It names the same model, so it is not a change.
func TestNormalizeIgnoresAReceiptThatChangedNothing(t *testing.T) {
	n := NewNormalizer("demo")
	n.Line([]byte(`{"type":"assistant","message":{"role":"assistant","model":"claude-haiku-4-5","content":[{"type":"text","text":"hi"}]},"uuid":"a1"}`))
	// The assistant record spells it claude-haiku-4-5; the receipt spells it
	// "Haiku 4.5". Both have to read as haiku or every change would report twice.
	first := modelEvent(n.Line([]byte(`{"type":"user","isMeta":true,"message":{"role":"user","content":[{"type":"text","text":"<local-command-stdout>Kept model as Haiku 4.5</local-command-stdout>"}]},"uuid":"a2"}`)))
	if first != nil {
		t.Fatalf("a receipt naming the model already in force reported a change: %+v", first.Model)
	}
}

func TestModelFromReceiptReadsEveryShapeTheCommandAnswersWith(t *testing.T) {
	for line, want := range map[string]string{
		"Set model to `Sonnet 5` for this session only":                  "sonnet",
		"Set model to Opus 5 and saved as your default for new sessions": "opus",
		"Set model to Opus 5 (1M context) and saved as your default":     "opus",
		"Kept model as Haiku 4.5":                                        "haiku",
	} {
		got, ok := ModelFromReceipt(line)
		if !ok || got != want {
			t.Errorf("ModelFromReceipt(%q) = %q, %v; want %q", line, got, ok, want)
		}
	}
	for _, line := range []string{"", "Set effort to high", "the model is fine"} {
		if got, ok := ModelFromReceipt(line); ok {
			t.Errorf("ModelFromReceipt(%q) = %q, want no match", line, got)
		}
	}
}

// The effort has the same gap the model had: an assistant record names the
// level a TURN ran at, so until the session takes another one the newest record
// still reports the level the change replaced. `/effort` writes its own
// receipt, and that is what closes it.
func TestNormalizeReportsAnEffortChangeFromItsReceipt(t *testing.T) {
	n := NewNormalizer("demo")
	n.Line([]byte(`{"type":"assistant","effort":"medium","message":{"role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"hi"}]},"uuid":"a1"}`))

	got := modelEvent(n.Line([]byte(`{"type":"user","isMeta":true,"message":{"role":"user","content":[{"type":"text","text":"<local-command-stdout>Set effort level to xhigh (this session only): Deeper reasoning than high</local-command-stdout>"}]},"uuid":"a2"}`)))
	if got == nil {
		t.Fatal("the receipt reported no effort change")
	}
	if got.Model.Effort != "xhigh" {
		t.Fatalf("model event = %+v", got.Model)
	}
	// The model in force rides along: a reader is shown the pair, and this
	// receipt says nothing about the other half.
	if got.Model.Model != "claude-opus-5" {
		t.Fatalf("the model was dropped: %+v", got.Model)
	}
}

func TestNormalizeIgnoresAnEffortReceiptThatChangedNothing(t *testing.T) {
	n := NewNormalizer("demo")
	n.Line([]byte(`{"type":"assistant","effort":"high","message":{"role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"hi"}]},"uuid":"a1"}`))
	got := modelEvent(n.Line([]byte(`{"type":"user","isMeta":true,"message":{"role":"user","content":[{"type":"text","text":"<local-command-stdout>Set effort level to high (this session only): Comprehensive</local-command-stdout>"}]},"uuid":"a2"}`)))
	if got != nil {
		t.Fatalf("a receipt naming the level already in force reported a change: %+v", got.Model)
	}
}

func TestEffortFromReceiptReadsOnlyTheCommandsOwnAnswer(t *testing.T) {
	for line, want := range map[string]string{
		"Set effort level to xhigh (this session only): Deeper reasoning":      "xhigh",
		"Set effort level to ultracode (this session only): xhigh + workflows": "ultracode",
		"Set effort level to low (this session only): Quick, straightforward":  "low",
	} {
		got, ok := EffortFromReceipt(line)
		if !ok || got != want {
			t.Errorf("EffortFromReceipt(%q) = %q, %v; want %q", line, got, ok, want)
		}
	}
	// Prose that merely names levels is not a receipt. The first of these is a
	// real skill description that sits in transcripts.
	for _, line := range []string{
		"effort level (low/medium: fewer, high-confidence findings; high→max: broader)",
		"CLAUDE_CODE_EFFORT_LEVEL=max overrides this session",
		"Set model to `Sonnet 5` for this session only",
		"Set effort level to sideways (this session only)",
	} {
		if got, ok := EffortFromReceipt(line); ok {
			t.Errorf("EffortFromReceipt(%q) = %q, want no match", line, got)
		}
	}
}

// A RECEIPT NAMES THE FAMILY, A TURN NAMES THE SLUG, and the turn is the better
// answer. The receipt is what makes a change visible immediately; the assistant
// record that follows it says exactly which build answered. Treating the two as
// the same reading left a session reporting `opus` for the rest of its life,
// which is the half of "which model is this" that the slug exists to give.
func TestNormalizeUpgradesTheReceiptsFamilyToTheSlug(t *testing.T) {
	n := NewNormalizer("demo")
	n.Line([]byte(`{"type":"user","isMeta":true,"message":{"role":"user","content":[{"type":"text","text":"<local-command-stdout>Set model to ` + "`" + `Opus 5` + "`" + ` for this session only</local-command-stdout>"}]},"uuid":"a1"}`))

	got := modelEvent(n.Line([]byte(`{"type":"assistant","effort":"xhigh","message":{"role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"hi"}]},"uuid":"a2"}`)))
	if got == nil {
		t.Fatal("the turn did not replace the receipt's word with the slug")
	}
	if got.Model.Model != "claude-opus-5" {
		t.Fatalf("model event = %+v", got.Model)
	}

	// And it settles there: the same slug on every turn afterwards says nothing
	// new, and a later receipt naming the same family does not undo it.
	if again := modelEvent(n.Line([]byte(`{"type":"assistant","effort":"xhigh","message":{"role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"more"}]},"uuid":"a3"}`))); again != nil {
		t.Fatalf("the unchanged slug was reported again: %+v", again.Model)
	}
	if back := modelEvent(n.Line([]byte(`{"type":"user","isMeta":true,"message":{"role":"user","content":[{"type":"text","text":"<local-command-stdout>Kept model as Opus 5</local-command-stdout>"}]},"uuid":"a4"}`))); back != nil {
		t.Fatalf("a receipt walked the slug back to its family: %+v", back.Model)
	}
}

func modelEvent(evs []Event) *Event {
	for i := range evs {
		if evs[i].Kind == KindMeta && evs[i].Meta == MetaModel {
			return &evs[i]
		}
	}
	return nil
}
