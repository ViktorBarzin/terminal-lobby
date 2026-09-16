package main

// The OpenAPI document.
//
// It is load-bearing in a way a description usually is not: the first caller
// has no SDK and no hand-written client, it READS this and generates one. So
// every endpoint carries a summary saying what it is for, every field carries
// a description in words rather than a restatement of its name, and every
// request body carries at least one worked example. A field described as "the
// cwd" teaches a generator nothing; a field described as "must be inside the
// account's own code directory, symlinks resolved" stops it generating a
// client that sends /etc and is surprised by the 400.
//
// Baked into the binary with go:embed rather than shipped as a file, so the
// document a running service serves is the one that was built with it and
// there is no deploy step that can leave the two out of step. It is a .json
// file rather than a Go literal so it reads and diffs as what it is; the
// tests parse it and assert the properties above.

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"log"
	"sync"
)

//go:embed openapi.json
var openAPIRaw []byte

var (
	openAPIOnce sync.Once
	openAPIBody []byte
)

// openAPIDocument returns the document to serve: compacted when it parses,
// and the source bytes when it does not — a document that will not compact
// still tells a reader more than an empty body would, and validateOpenAPI has
// already refused to start the service in that case.
func openAPIDocument() []byte {
	openAPIOnce.Do(func() {
		var out bytes.Buffer
		if err := json.Compact(&out, openAPIRaw); err != nil {
			openAPIBody = openAPIRaw
			return
		}
		openAPIBody = out.Bytes()
	})
	return openAPIBody
}

// validateOpenAPI fails the service at startup if the embedded document will
// not parse. A broken contract is worth refusing to start for: a caller
// discovering it at client-generation time is a much more confusing failure
// than a service that says so in its first log line.
func validateOpenAPI() {
	var doc map[string]any
	if err := json.Unmarshal(openAPIRaw, &doc); err != nil {
		log.Fatalf("agent-api: the embedded OpenAPI document is not valid JSON: %v", err)
	}
}
