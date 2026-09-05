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

func modelEvent(evs []Event) *Event {
	for i := range evs {
		if evs[i].Kind == KindMeta && evs[i].Meta == MetaModel {
			return &evs[i]
		}
	}
	return nil
}
