package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"testing"
)

// The OpenAPI document is the contract a caller GENERATES a client from, so
// these are not style checks. A missing summary, a field with no description
// or a request body with no example each produce a worse generated client,
// and none of them fails anything else in the suite.

func loadOpenAPI(t *testing.T) map[string]any {
	t.Helper()
	var doc map[string]any
	if err := json.Unmarshal(openAPIRaw, &doc); err != nil {
		t.Fatalf("the embedded document is not valid JSON: %v", err)
	}
	return doc
}

func TestOpenAPIParses(t *testing.T) {
	doc := loadOpenAPI(t)
	if v, _ := doc["openapi"].(string); !strings.HasPrefix(v, "3.1") {
		t.Fatalf("openapi %q, want 3.1.x", v)
	}
	// What is served must be the same document, compacted.
	var served map[string]any
	if err := json.Unmarshal(openAPIDocument(), &served); err != nil {
		t.Fatalf("the served document is not valid JSON: %v", err)
	}
	if fmt.Sprint(served) != fmt.Sprint(doc) {
		t.Fatal("the served document differs from the embedded one")
	}
}

// Every route the mux serves is described, and nothing is described that the
// mux does not serve. A document that drifts from the service is worse than
// no document, because a generated client believes it.
func TestOpenAPIDescribesExactlyTheRealRoutes(t *testing.T) {
	doc := loadOpenAPI(t)
	paths, _ := doc["paths"].(map[string]any)

	described := map[string]bool{}
	for path, item := range paths {
		methods, _ := item.(map[string]any)
		for method := range methods {
			described[strings.ToUpper(method)+" "+path] = true
		}
	}

	real := map[string]bool{
		"GET /health":                           true,
		"GET /openapi.json":                     true,
		"GET /v1/conversations":                 true,
		"POST /v1/conversations":                true,
		"GET /v1/conversations/{id}":            true,
		"GET /v1/conversations/{id}/transcript": true,
		"POST /v1/conversations/{id}/messages":  true,
		"GET /v1/tasks/{id}":                    true,
		"POST /v1/tasks/{id}/cancel":            true,
	}
	// The v1 half of that list must match the auth test's list exactly, so
	// the two cannot drift apart.
	for _, r := range everyV1Route {
		if !real[r.method+" "+r.path2()] {
			t.Errorf("%s %s is served but missing from this test's list", r.method, r.path)
		}
	}

	for op := range real {
		if !described[op] {
			t.Errorf("%s is served but not described in the OpenAPI document", op)
		}
	}
	for op := range described {
		if !real[op] {
			t.Errorf("%s is described but not served", op)
		}
	}
}

// Every operation says what it is for and what it answers.
func TestOpenAPIEveryOperationIsDocumented(t *testing.T) {
	doc := loadOpenAPI(t)
	paths, _ := doc["paths"].(map[string]any)

	for path, item := range paths {
		methods, _ := item.(map[string]any)
		for method, raw := range methods {
			op, _ := raw.(map[string]any)
			where := strings.ToUpper(method) + " " + path

			for _, field := range []string{"operationId", "summary", "description"} {
				if s, _ := op[field].(string); strings.TrimSpace(s) == "" {
					t.Errorf("%s has no %s", where, field)
				}
			}
			// A summary is a sentence, not a restatement of the path.
			if s, _ := op["summary"].(string); len(s) < 15 {
				t.Errorf("%s summary %q is too short to teach a generator anything", where, s)
			}

			responses, _ := op["responses"].(map[string]any)
			if len(responses) == 0 {
				t.Errorf("%s documents no responses", where)
				continue
			}
			for code, r := range responses {
				resp, _ := r.(map[string]any)
				if _, isRef := resp["$ref"]; isRef {
					continue // a shared response, checked where it is defined
				}
				if s, _ := resp["description"].(string); strings.TrimSpace(s) == "" {
					t.Errorf("%s response %s has no description", where, code)
				}
			}
		}
	}
}

// Every request body carries at least one worked example. The brief calls for
// it because a generator with an example produces a client that sends the
// right shape first time.
func TestOpenAPIEveryRequestBodyHasAnExample(t *testing.T) {
	doc := loadOpenAPI(t)
	paths, _ := doc["paths"].(map[string]any)

	bodies := 0
	for path, item := range paths {
		methods, _ := item.(map[string]any)
		for method, raw := range methods {
			op, _ := raw.(map[string]any)
			body, ok := op["requestBody"].(map[string]any)
			if !ok {
				continue
			}
			bodies++
			where := strings.ToUpper(method) + " " + path
			content, _ := body["content"].(map[string]any)
			media, _ := content["application/json"].(map[string]any)
			if media == nil {
				t.Errorf("%s request body is not application/json", where)
				continue
			}
			_, single := media["example"]
			examples, multiple := media["examples"].(map[string]any)
			if !single && (!multiple || len(examples) == 0) {
				t.Errorf("%s request body carries no example", where)
			}
			for name, ex := range examples {
				e, _ := ex.(map[string]any)
				if _, has := e["value"]; !has {
					t.Errorf("%s example %q has no value", where, name)
				}
				if s, _ := e["summary"].(string); strings.TrimSpace(s) == "" {
					t.Errorf("%s example %q has no summary saying what it shows", where, name)
				}
			}
		}
	}
	if bodies != 2 {
		t.Fatalf("%d request bodies found, want 2 (create and send) — the check may be looking in the wrong place", bodies)
	}
}

// Every field of every schema is described, recursively. This is the check
// that most directly improves a generated client: a property with no
// description becomes a parameter a caller has to guess at.
func TestOpenAPIEverySchemaFieldIsDescribed(t *testing.T) {
	doc := loadOpenAPI(t)
	components, _ := doc["components"].(map[string]any)
	schemas, _ := components["schemas"].(map[string]any)
	if len(schemas) == 0 {
		t.Fatal("no schemas found")
	}

	var names []string
	for name := range schemas {
		names = append(names, name)
	}
	sort.Strings(names)

	for _, name := range names {
		schema, _ := schemas[name].(map[string]any)
		checkSchema(t, name, schema)
	}
}

// checkSchema asserts that a schema and each of its properties says what it
// is, following nested objects and array items.
func checkSchema(t *testing.T, where string, schema map[string]any) {
	t.Helper()
	if _, isRef := schema["$ref"]; isRef {
		return
	}
	if s, _ := schema["description"].(string); strings.TrimSpace(s) == "" {
		t.Errorf("schema %s has no description", where)
	}
	props, _ := schema["properties"].(map[string]any)
	for name, raw := range props {
		p, _ := raw.(map[string]any)
		if p == nil {
			t.Errorf("%s.%s is not a schema", where, name)
			continue
		}
		if _, isRef := p["$ref"]; isRef {
			continue
		}
		if s, _ := p["description"].(string); strings.TrimSpace(s) == "" {
			t.Errorf("%s.%s has no description", where, name)
		}
		if items, ok := p["items"].(map[string]any); ok {
			checkSchema(t, where+"."+name+"[]", items)
		}
		if _, ok := p["properties"]; ok {
			checkSchema(t, where+"."+name, p)
		}
	}
}

// Every parameter and every shared response is described too.
func TestOpenAPIComponentsAreDocumented(t *testing.T) {
	doc := loadOpenAPI(t)
	components, _ := doc["components"].(map[string]any)

	params, _ := components["parameters"].(map[string]any)
	for name, raw := range params {
		p, _ := raw.(map[string]any)
		if s, _ := p["description"].(string); strings.TrimSpace(s) == "" {
			t.Errorf("parameter %s has no description", name)
		}
		if _, has := p["example"]; !has {
			t.Errorf("parameter %s has no example", name)
		}
	}

	responses, _ := components["responses"].(map[string]any)
	for name, raw := range responses {
		r, _ := raw.(map[string]any)
		if s, _ := r["description"].(string); strings.TrimSpace(s) == "" {
			t.Errorf("response %s has no description", name)
		}
	}

	schemes, _ := components["securitySchemes"].(map[string]any)
	bearer, _ := schemes["bearerAuth"].(map[string]any)
	if bearer["scheme"] != "bearer" || bearer["type"] != "http" {
		t.Fatalf("the security scheme is not HTTP bearer: %v", bearer)
	}
	if s, _ := bearer["description"].(string); strings.TrimSpace(s) == "" {
		t.Error("the security scheme has no description saying how a caller gets one")
	}
}

// The two open routes declare no security, and every other one inherits the
// document's. A generated client that sent no credential to /v1 would get 401
// on every call, which is a bad first experience of a contract.
func TestOpenAPISecurityMatchesTheGate(t *testing.T) {
	doc := loadOpenAPI(t)
	if _, ok := doc["security"].([]any); !ok {
		t.Fatal("the document declares no default security")
	}
	paths, _ := doc["paths"].(map[string]any)

	open := map[string]bool{"/health": true, "/openapi.json": true}
	for path, item := range paths {
		methods, _ := item.(map[string]any)
		for method, raw := range methods {
			op, _ := raw.(map[string]any)
			sec, declared := op["security"].([]any)
			switch {
			case open[path]:
				if !declared || len(sec) != 0 {
					t.Errorf("%s %s should declare security: [] (it needs no credential)", method, path)
				}
			default:
				if declared {
					t.Errorf("%s %s overrides the document's security; it should inherit it", method, path)
				}
				// And it must document the refusal a caller will meet.
				responses, _ := op["responses"].(map[string]any)
				if _, has := responses["401"]; !has {
					t.Errorf("%s %s does not document its 401", method, path)
				}
			}
		}
	}
}

// The status vocabulary in the document is the one the code uses. A client
// generated from a stale enum would fail to match a status it was handed.
func TestOpenAPITaskStatusEnumMatchesTheCode(t *testing.T) {
	doc := loadOpenAPI(t)
	components, _ := doc["components"].(map[string]any)
	schemas, _ := components["schemas"].(map[string]any)
	task, _ := schemas["Task"].(map[string]any)
	props, _ := task["properties"].(map[string]any)
	status, _ := props["status"].(map[string]any)
	raw, _ := status["enum"].([]any)

	var documented []string
	for _, v := range raw {
		s, _ := v.(string)
		documented = append(documented, s)
	}
	sort.Strings(documented)

	code := []string{
		string(StatusAccepted), string(StatusRunning), string(StatusNeedsInput),
		string(StatusDone), string(StatusFailed), string(StatusCancelled),
	}
	sort.Strings(code)

	if strings.Join(documented, ",") != strings.Join(code, ",") {
		t.Fatalf("the documented statuses %v do not match the code's %v", documented, code)
	}
}

// Same for the conversation state vocabulary, which is this service's own
// mapping over @claude_state rather than a value it passes through.
func TestOpenAPIConversationStateEnumMatchesTheCode(t *testing.T) {
	doc := loadOpenAPI(t)
	components, _ := doc["components"].(map[string]any)
	schemas, _ := components["schemas"].(map[string]any)
	conv, _ := schemas["Conversation"].(map[string]any)
	props, _ := conv["properties"].(map[string]any)
	state, _ := props["state"].(map[string]any)
	raw, _ := state["enum"].([]any)

	documented := map[string]bool{}
	for _, v := range raw {
		s, _ := v.(string)
		documented[s] = true
	}
	// Every value stateName can produce must be in the enum.
	for _, in := range []string{"running", "awaiting", "done", "", "something-new"} {
		if got := stateName(in); !documented[got] {
			t.Errorf("stateName(%q) = %q, which the document does not list", in, got)
		}
	}
	// …and the one state that does not come from @claude_state at all: the
	// suspend mark overrides it, so conversationFrom is where it is produced.
	if !documented[stateSuspendedName] {
		t.Errorf("a suspended conversation reports %q, which the document does not list", stateSuspendedName)
	}
	if len(documented) != 5 {
		t.Errorf("the document lists %d states, want 5", len(documented))
	}
}

// The permission modes and efforts a caller may send are the ones the document
// lists.
func TestOpenAPIEnumsMatchTheValidators(t *testing.T) {
	doc := loadOpenAPI(t)
	components, _ := doc["components"].(map[string]any)
	schemas, _ := components["schemas"].(map[string]any)
	req, _ := schemas["CreateConversationRequest"].(map[string]any)
	props, _ := req["properties"].(map[string]any)

	for _, c := range []struct {
		field string
		want  map[string]bool
	}{
		{"permission_mode", permissionModes},
		{"effort", efforts},
	} {
		p, _ := props[c.field].(map[string]any)
		raw, _ := p["enum"].([]any)
		documented := map[string]bool{}
		for _, v := range raw {
			s, _ := v.(string)
			documented[s] = true
		}
		if len(documented) != len(c.want) {
			t.Errorf("%s: document lists %d values, the validator accepts %d", c.field, len(documented), len(c.want))
		}
		for v := range c.want {
			if !documented[v] {
				t.Errorf("%s: the validator accepts %q, which the document does not list", c.field, v)
			}
		}
		for v := range documented {
			if !c.want[v] {
				t.Errorf("%s: the document lists %q, which the validator refuses", c.field, v)
			}
		}
	}
}

// The document's own worked examples must satisfy the service's validators.
// An example a generator copies and the service then refuses is the worst
// kind of documentation bug.
func TestOpenAPICreateExamplesWouldBeAccepted(t *testing.T) {
	doc := loadOpenAPI(t)
	paths, _ := doc["paths"].(map[string]any)
	item, _ := paths["/v1/conversations"].(map[string]any)
	post, _ := item["post"].(map[string]any)
	body, _ := post["requestBody"].(map[string]any)
	content, _ := body["content"].(map[string]any)
	media, _ := content["application/json"].(map[string]any)
	examples, _ := media["examples"].(map[string]any)

	if len(examples) == 0 {
		t.Fatal("no examples to check")
	}
	for name, raw := range examples {
		ex, _ := raw.(map[string]any)
		value, _ := ex["value"].(map[string]any)

		if cwd, _ := value["cwd"].(string); !strings.HasPrefix(cwd, "/home/") || !strings.Contains(cwd, "/code") {
			t.Errorf("example %q has cwd %q, which the allowlist would refuse", name, cwd)
		}
		if m, ok := value["model"].(string); ok && !argValueRe.MatchString(m) {
			t.Errorf("example %q has model %q, which the validator refuses", name, m)
		}
		if e, ok := value["effort"].(string); ok && !efforts[e] {
			t.Errorf("example %q has effort %q, which the validator refuses", name, e)
		}
		if pm, ok := value["permission_mode"].(string); ok && !permissionModes[pm] {
			t.Errorf("example %q has permission_mode %q, which the validator refuses", name, pm)
		}
		if n, ok := value["name"].(string); ok && !conversationNameRe.MatchString(n) {
			t.Errorf("example %q has name %q, which the validator refuses", name, n)
		}
		// And no field the service would reject as unknown.
		for field := range value {
			switch field {
			case "cwd", "model", "effort", "permission_mode", "name":
			default:
				t.Errorf("example %q sends %q, which the service rejects as an unknown field", name, field)
			}
		}
	}
}

// The document names the port the service actually listens on.
func TestOpenAPIServerNamesTheRealPort(t *testing.T) {
	doc := loadOpenAPI(t)
	servers, _ := doc["servers"].([]any)
	if len(servers) == 0 {
		t.Fatal("no servers declared")
	}
	s, _ := servers[0].(map[string]any)
	url, _ := s["url"].(string)
	_, port, _ := strings.Cut(listenAddr, ":")
	if !strings.HasSuffix(url, ":"+port) {
		t.Fatalf("the document's server URL %q does not name the listen port %q", url, port)
	}
}

// path2 is the route's path with the id placeholders the document uses. The
// auth test's list carries concrete ids, because it makes real requests.
func (r request) path2() string {
	p := strings.ReplaceAll(r.path, "/conversations/c1", "/conversations/{id}")
	return strings.ReplaceAll(p, "/tasks/t1", "/tasks/{id}")
}
