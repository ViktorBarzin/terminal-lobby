package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

const managedFixture = `{
  "model": "claude-opus-5",
  "modelPicker": {
    "replaceBuiltInOptions": true,
    "options": [
      {"model": "claude-opus-5"},
      {"model": "claude-opus-5[1m]"},
      {"model": "claude-sonnet-5"},
      {"model": "claude-opus-5"}
    ]
  }
}`

func writeFixture(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "managed-settings.json")
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// The slugs come from Claude Code's own picker, in its order, deduped.
func TestLoadModelsReadsTheManagedPicker(t *testing.T) {
	m := loadModels(writeFixture(t, managedFixture))
	want := []string{"claude-opus-5", "claude-opus-5[1m]", "claude-sonnet-5"}
	if len(m.Allowed) != len(want) {
		t.Fatalf("got %v, want %v", m.Allowed, want)
	}
	for i := range want {
		if m.Allowed[i] != want[i] {
			t.Fatalf("got %v, want %v (order is the picker's)", m.Allowed, want)
		}
	}
	if m.Default != "claude-opus-5" {
		t.Errorf("default %q", m.Default)
	}
}

// Not knowing the list must ACCEPT everything, never refuse everything. The
// list exists so a caller can choose well; it is not a security boundary, and
// a moved config file must not turn into an outage.
func TestAnUnknownModelListAcceptsAnything(t *testing.T) {
	for _, tc := range []struct{ name, path string }{
		{"missing file", filepath.Join(t.TempDir(), "absent.json")},
		{"not json", writeFixture(t, "{{{")},
		{"no picker", writeFixture(t, `{"model":"claude-opus-5"}`)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := loadModels(tc.path)
			if len(m.Allowed) != 0 {
				t.Fatalf("Allowed = %v, want empty", m.Allowed)
			}
			if !m.permits("anything-at-all") {
				t.Error("an unknown list refused a model; it must accept every one")
			}
		})
	}
}

func TestPermitsOnlyWhatThePickerOffers(t *testing.T) {
	m := loadModels(writeFixture(t, managedFixture))
	for _, ok := range []string{"", "claude-opus-5", "claude-opus-5[1m]", "claude-sonnet-5"} {
		if !m.permits(ok) {
			t.Errorf("refused %q, which the picker offers", ok)
		}
	}
	for _, bad := range []string{"claude-haiku-4-5-20251001", "gpt-4", "opus"} {
		if m.permits(bad) {
			t.Errorf("accepted %q, which this box does not offer", bad)
		}
	}
}

// The served document must carry the real slugs, because the caller generates
// its client from it. A hardcoded enum would hand somebody a model this
// workstation does not have.
func TestTheDocumentAdvertisesTheRealModels(t *testing.T) {
	body := openAPIWithModels(loadModels(writeFixture(t, managedFixture)))
	var doc map[string]any
	if err := json.Unmarshal(body, &doc); err != nil {
		t.Fatalf("served document is not JSON: %v", err)
	}
	f, ok := modelField(doc)
	if !ok {
		t.Fatal("no model field in the served document")
	}
	enum, _ := f["enum"].([]any)
	if len(enum) != 3 || enum[0] != "claude-opus-5" {
		t.Fatalf("enum = %v, want the picker's three slugs", enum)
	}
	if d, _ := f["description"].(string); d == "" || !contains(d, "claude-opus-5") {
		t.Errorf("description does not name the default: %q", d)
	}
}

// With no list, the document is served exactly as embedded: a free string
// whose description tells the caller to omit it.
func TestTheDocumentStaysFreeFormWithNoList(t *testing.T) {
	body := openAPIWithModels(models{})
	var doc map[string]any
	if err := json.Unmarshal(body, &doc); err != nil {
		t.Fatal(err)
	}
	f, _ := modelField(doc)
	if _, has := f["enum"]; has {
		t.Error("an unknown list still advertised an enum, which would be a guess")
	}
}

func contains(h, n string) bool { return len(h) >= len(n) && (len(n) == 0 || indexOf(h, n) >= 0) }
func indexOf(h, n string) int {
	for i := 0; i+len(n) <= len(h); i++ {
		if h[i:i+len(n)] == n {
			return i
		}
	}
	return -1
}
