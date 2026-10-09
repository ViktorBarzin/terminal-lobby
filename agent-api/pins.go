package main

import (
	"fmt"
	"strings"
)

// callerPin is the launch settings this box forces on one caller's new
// conversations, from TL_CALLER_PINS. A field left empty is the caller's to
// choose; a field set replaces whatever the caller sent, including nothing.
//
// It exists because an external caller's client is not ours to edit. Muse's
// connector kept sending model=claude-opus-5 and permission_mode=default
// (manual mode) from its own stale notes after Viktor wanted Opus 5.5 in
// bypass (2026-10-09), and a manual-mode session has nobody to approve its
// prompts, so it hangs.
type callerPin struct {
	Model          string
	Effort         string
	PermissionMode string
}

// apply overwrites the request fields the pin names.
func (p callerPin) apply(req *createRequest) {
	if p.Model != "" {
		req.Model = p.Model
	}
	if p.Effort != "" {
		req.Effort = p.Effort
	}
	if p.PermissionMode != "" {
		req.PermissionMode = p.PermissionMode
	}
}

// callerPins reads TL_CALLER_PINS: entries separated by ';', each
// "<caller>:<key>=<value>,..." with keys model, effort and permission_mode,
// e.g. "muse:model=claude-opus-5-5,effort=xhigh,permission_mode=bypassPermissions".
//
// An entry that does not parse is left out WHOLE and described in the second
// return, so the caller can log it: half a pin would launch a session nobody
// configured. Values pass the same checks a request body does.
func callerPins(getenv func(string) string) (map[string]callerPin, []string) {
	var pins map[string]callerPin
	var refused []string
	for _, entry := range strings.Split(getenv("TL_CALLER_PINS"), ";") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		name, pin, err := parsePin(entry)
		if err != nil {
			refused = append(refused, fmt.Sprintf("%q: %v", entry, err))
			continue
		}
		if pins == nil {
			pins = map[string]callerPin{}
		}
		pins[name] = pin
	}
	return pins, refused
}

func parsePin(entry string) (string, callerPin, error) {
	var pin callerPin
	name, fields, ok := strings.Cut(entry, ":")
	name = strings.TrimSpace(name)
	if !ok || name == "" {
		return "", pin, fmt.Errorf("want <caller>:<key>=<value>,...")
	}
	seen := map[string]bool{}
	for _, field := range strings.Split(fields, ",") {
		key, value, ok := strings.Cut(strings.TrimSpace(field), "=")
		key, value = strings.TrimSpace(key), strings.TrimSpace(value)
		if !ok || key == "" || value == "" {
			return "", pin, fmt.Errorf("field %q is not <key>=<value>", field)
		}
		if seen[key] {
			return "", pin, fmt.Errorf("%s is set twice", key)
		}
		seen[key] = true
		switch key {
		case "model":
			if !argValueRe.MatchString(value) {
				return "", pin, fmt.Errorf("model %q is not a model name", value)
			}
			pin.Model = value
		case "effort":
			if !efforts[value] {
				return "", pin, fmt.Errorf("effort %q is not one of %v", value, effortOrder)
			}
			pin.Effort = value
		case "permission_mode":
			if !permissionModes[value] {
				return "", pin, fmt.Errorf("permission_mode %q is not one of default, acceptEdits, bypassPermissions, plan", value)
			}
			pin.PermissionMode = value
		default:
			return "", pin, fmt.Errorf("unknown key %q; want model, effort or permission_mode", key)
		}
	}
	return name, pin, nil
}
