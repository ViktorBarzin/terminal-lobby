package main

import (
	"encoding/json"
	"log"
	"os"
)

// DefaultManagedSettingsPath is where Claude Code's managed settings live on
// this workstation. It carries the model list the CLI's own picker offers.
const DefaultManagedSettingsPath = "/etc/claude-code/managed-settings.json"

// efforts is claude's reasoning ladder, as `claude --help` states it. It is
// FIVE rungs, not three: xhigh and max exist and were being refused with a 400
// while the CLI accepted them happily.
var efforts = map[string]bool{
	"low": true, "medium": true, "high": true, "xhigh": true, "max": true,
}

// effortOrder is the ladder in ladder order, for the OpenAPI enum. A map has
// none, and a caller reading the document should see low..max rather than
// whatever order Go's iteration happened to produce.
var effortOrder = []string{"low", "medium", "high", "xhigh", "max"}

// managedSettings is the part of Claude Code's managed settings this service
// reads: the model picker's rows, which name the exact slugs this box offers,
// and the default those rows fall back to.
type managedSettings struct {
	Model       string `json:"model"`
	ModelPicker struct {
		Options []struct {
			Model string `json:"model"`
		} `json:"options"`
	} `json:"modelPicker"`
}

// models is the model list as advertised and validated.
type models struct {
	// Allowed is the slugs a caller may ask for. EMPTY means "could not tell",
	// and every caller that reads this must then accept anything: the list is
	// here so a caller can choose well, not as a security boundary, and
	// refusing every model because a config file moved would turn a cosmetic
	// problem into an outage.
	Allowed []string
	// Default is what a session gets when the caller omits the field. Reported
	// so the document can say so rather than leaving the caller to guess.
	Default string
}

// loadModels reads the slugs Claude Code's own picker offers.
//
// It is deliberately forgiving. A missing file, bad JSON or an empty picker
// all mean the same thing — nobody said — and produce an empty list, which
// restores exactly the behaviour this service had before: accept any string
// and let the harness reject it at session start.
func loadModels(path string) models {
	if path == "" {
		path = DefaultManagedSettingsPath
	}
	b, err := os.ReadFile(path)
	if err != nil {
		log.Printf("agent-api: no model list (%v); any model will be accepted and the harness decides", err)
		return models{}
	}
	var s managedSettings
	if err := json.Unmarshal(b, &s); err != nil {
		log.Printf("agent-api: model list in %s is not valid JSON (%v); any model will be accepted", path, err)
		return models{}
	}
	out := models{Default: s.Model}
	seen := map[string]bool{}
	for _, o := range s.ModelPicker.Options {
		if o.Model == "" || seen[o.Model] {
			continue
		}
		seen[o.Model] = true
		out.Allowed = append(out.Allowed, o.Model)
	}
	return out
}

// permits reports whether a caller may ask for this model. An unknown list
// permits everything, for the reason models.Allowed gives.
func (m models) permits(model string) bool {
	if model == "" || len(m.Allowed) == 0 {
		return true
	}
	for _, a := range m.Allowed {
		if a == model {
			return true
		}
	}
	return false
}
