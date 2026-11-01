package main

// What /mcp changes in a caller's message before it reaches T3.
//
// The pass-through forwards bodies as they are (t3client/forward.go says why),
// with two exceptions, both on tools/call:
//
//   - A caller's pin (TL_CALLER_PINS, pins.go) applies to t3_thread_launch the
//     way it applies to POST /v1/conversations: the pinned values replace what
//     the caller sent, including nothing. T3 names the settings differently, so
//     a pin is translated (launchModes below has the map). The model and
//     effort pins also apply to t3_thread_configure, which can change a
//     thread's model after launch.
//   - A wait is capped at maxWaitSeconds, the same ceiling ?wait= has on /v1.
//     T3 waits ten minutes by default and up to an hour, and a request held
//     that long is cut by the edge (330 s) or this server's write deadline
//     first, which the caller would see as a dropped connection. With the cap,
//     T3 answers timedOut: true and the caller waits again.
//
// "inherit" means the box default here as on /v1, reached differently. /v1
// drops the caller's value so claude falls back to managed settings. T3 has
// no such fallback for a call made outside a thread (a fresh T3 has no
// default model, which is why t3client always sends modelSelection), so /mcp
// writes the box's default model and effort, read from the same managed
// settings, into the call (resolveMCPPin). A caller pinned that way always
// runs what the box runs, and a stale model it names never reaches T3. When
// managed settings name no default, inherit forces nothing.

import (
	"bytes"
	"encoding/json"
	"strconv"
)

// claudeInstance is T3's provider instance for Claude. Every T3 the lobby
// runs has it, under this id.
const claudeInstance = "claudeAgent"

// launchModes maps claude's --permission-mode, the vocabulary pins use, onto
// t3_thread_launch's runtimeMode and interactionMode (T3 v0.1.5,
// packages/contracts/src/providerPolicy.ts).
//
//	bypassPermissions  full-access         default
//	acceptEdits        auto-accept-edits   default
//	default            approval-required   default
//	plan               approval-required   plan
//
// Plan is an interaction mode in T3 and a permission mode in claude, so a pin
// to any other mode also sets interactionMode to default: a caller pinned to
// bypass cannot launch a thread that stops at a plan nobody will approve.
// T3's fourth runtime mode, "auto", has no claude equivalent and no pin maps
// to it.
var launchModes = map[string]struct{ runtime, interaction string }{
	"bypassPermissions": {"full-access", "default"},
	"acceptEdits":       {"auto-accept-edits", "default"},
	"default":           {"approval-required", "default"},
	"plan":              {"approval-required", "plan"},
}

// waitTools are the tools that block until something finishes and wait T3's
// default (ten minutes) when the caller names no timeoutMs.
var waitTools = map[string]bool{
	"t3_thread_wait":     true,
	"t3_background_wait": true,
}

// resolveMCPPin replaces "inherit" for model and effort with the box's
// defaults, or with nothing when the box names none. permission_mode is left
// as it is: pinLaunchArgs maps only the four real modes.
func resolveMCPPin(p callerPin, box models) callerPin {
	if p.Model == pinInherit {
		p.Model = box.Default
	}
	if p.Effort == pinInherit {
		p.Effort = box.DefaultEffort
	}
	return p
}

// pinned is the value a pin field forces, or "" when it forces nothing.
func pinned(v string) string {
	if v == pinInherit {
		return ""
	}
	return v
}

// pinLaunchArgs applies a caller's pin to t3_thread_launch arguments in place
// and names the fields whose value changed.
func pinLaunchArgs(a map[string]any, pin callerPin) []string {
	var changed []string
	if sel, ok := pinSelection(a["modelSelection"], pin); ok && !sameJSON(a["modelSelection"], sel) {
		a["modelSelection"] = sel
		changed = append(changed, "modelSelection")
	}
	if m, ok := launchModes[pinned(pin.PermissionMode)]; ok {
		if a["runtimeMode"] != m.runtime {
			a["runtimeMode"] = m.runtime
			changed = append(changed, "runtimeMode")
		}
		if a["interactionMode"] != m.interaction {
			a["interactionMode"] = m.interaction
			changed = append(changed, "interactionMode")
		}
	}
	return changed
}

// pinConfigureArgs applies a caller's pin to t3_thread_configure arguments,
// so a pinned thread cannot be moved to another model after launch. The tool
// takes modelSelection and nothing else (T3 v0.1.5: "Permission modes stay"),
// and without one it only reads, so only a selection the caller sent is
// rewritten; the permission pin has nothing to act on here.
func pinConfigureArgs(a map[string]any, pin callerPin) []string {
	cur, present := a["modelSelection"]
	if !present || cur == nil {
		return nil
	}
	if sel, ok := pinSelection(cur, pin); ok && !sameJSON(cur, sel) {
		a["modelSelection"] = sel
		return []string{"modelSelection"}
	}
	return nil
}

// pinSelection is the modelSelection a pin asks for, built from the caller's
// own. ok is false when the pin says nothing about the model or effort, or
// names an effort with no model to attach it to: modelSelection requires a
// model, and inventing one is worse than letting the model's default effort
// apply.
//
// Effort is T3's "effort" option ([{id, value}], or the legacy {effort: v}
// object T3 still accepts). Its values are claude's (low to max), which is
// what a pin may name.
func pinSelection(cur any, pin callerPin) (map[string]any, bool) {
	model, effort := pinned(pin.Model), pinned(pin.Effort)
	if model == "" && effort == "" {
		return nil, false
	}
	sel := map[string]any{}
	if m, ok := cur.(map[string]any); ok {
		for k, v := range m {
			sel[k] = v
		}
	}
	if model != "" {
		inst, _ := sel["instanceId"].(string)
		if inst == "" {
			inst, _ = sel["provider"].(string)
		}
		if inst != claudeInstance {
			// Another provider's options mean nothing to Claude.
			delete(sel, "options")
		}
		delete(sel, "provider")
		sel["instanceId"] = claudeInstance
		sel["model"] = model
	}
	if effort != "" {
		if m, _ := sel["model"].(string); m == "" {
			return nil, false
		}
		sel["options"] = withEffort(sel["options"], effort)
	}
	return sel, true
}

// withEffort sets the effort option in either of T3's option shapes.
func withEffort(opts any, effort string) any {
	switch o := opts.(type) {
	case map[string]any:
		out := map[string]any{}
		for k, v := range o {
			out[k] = v
		}
		out["effort"] = effort
		return out
	case []any:
		out := make([]any, 0, len(o)+1)
		set := false
		for _, e := range o {
			if m, ok := e.(map[string]any); ok && m["id"] == "effort" {
				if !set {
					out = append(out, map[string]any{"id": "effort", "value": effort})
					set = true
				}
				continue
			}
			out = append(out, e)
		}
		if !set {
			out = append(out, map[string]any{"id": "effort", "value": effort})
		}
		return out
	default:
		return []any{map[string]any{"id": "effort", "value": effort}}
	}
}

// capWaitArgs holds timeoutMs to capMs, in place, and names it when it moved.
// A wait tool with no timeoutMs gets the cap; any tool whose numeric
// timeoutMs is over it is lowered. A timeoutMs that is not a number is left
// for T3 to refuse.
func capWaitArgs(tool string, a map[string]any, capMs int64) []string {
	limit := json.Number(strconv.FormatInt(capMs, 10))
	v, present := a["timeoutMs"]
	if !present {
		if !waitTools[tool] {
			return nil
		}
		a["timeoutMs"] = limit
		return []string{"timeoutMs"}
	}
	n, ok := v.(json.Number)
	if !ok {
		return nil
	}
	f, err := n.Float64()
	if err != nil || f <= float64(capMs) {
		return nil
	}
	a["timeoutMs"] = limit
	return []string{"timeoutMs"}
}

// rewriteMCPBody applies the pin and the wait cap to one JSON-RPC message.
// It returns the body unchanged, the same bytes, whenever nothing applies or
// the message cannot be read: T3 is the one to state what is wrong with it.
func rewriteMCPBody(body []byte, pin *callerPin, capMs int64) ([]byte, []string) {
	var msg map[string]json.RawMessage
	if json.Unmarshal(body, &msg) != nil {
		return body, nil
	}
	var method string
	if json.Unmarshal(msg["method"], &method) != nil || method != "tools/call" {
		return body, nil
	}
	var params map[string]json.RawMessage
	if json.Unmarshal(msg["params"], &params) != nil || params == nil {
		return body, nil
	}
	var name string
	if json.Unmarshal(params["name"], &name) != nil {
		return body, nil
	}
	a := map[string]any{}
	if raw, ok := params["arguments"]; ok && !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		decoded, err := decodeArgs(raw)
		if err != nil {
			return body, nil
		}
		a = decoded
	}

	var changed []string
	if pin != nil {
		switch name {
		case "t3_thread_launch":
			changed = append(changed, pinLaunchArgs(a, *pin)...)
		case "t3_thread_configure":
			changed = append(changed, pinConfigureArgs(a, *pin)...)
		}
	}
	changed = append(changed, capWaitArgs(name, a, capMs)...)
	if len(changed) == 0 {
		return body, nil
	}

	var err error
	if params["arguments"], err = encodeJSON(a); err != nil {
		return body, nil
	}
	if msg["params"], err = encodeJSON(params); err != nil {
		return body, nil
	}
	out, err := encodeJSON(msg)
	if err != nil {
		return body, nil
	}
	return out, changed
}

// decodeArgs reads a JSON object keeping numbers as written, so an id or a
// size the rewrite does not touch is not rounded through a float64.
func decodeArgs(raw json.RawMessage) (map[string]any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var a map[string]any
	if err := dec.Decode(&a); err != nil {
		return nil, err
	}
	if a == nil {
		a = map[string]any{}
	}
	return a, nil
}

// encodeJSON marshals without HTML escaping, so a prompt's "<" reaches T3 as
// the caller wrote it.
func encodeJSON(v any) (json.RawMessage, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

func sameJSON(a, b any) bool {
	x, err1 := json.Marshal(a)
	y, err2 := json.Marshal(b)
	return err1 == nil && err2 == nil && bytes.Equal(x, y)
}
