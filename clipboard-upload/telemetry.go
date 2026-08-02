package main

import (
	"net/http"
	"strings"

	"terminal-lobby/telemetry"
)

// events is this service's usage-event emitter (docs/adr/0005-usage-telemetry.md).
// buildID is stamped at deploy time (-ldflags -X main.buildID=<rev>).
var (
	buildID = "dev"
	events  = telemetry.New("clipboard-upload", buildID, nil)
)

// osUserQuiet resolves the caller for TELEMETRY ONLY: same header→OS-user map
// as resolveOSUser, but it never writes a response. Some paths (a generic
// dropped file) legitimately never resolve a user because they don't need one;
// attributing their event must not be able to fail their request.
func osUserQuiet(r *http.Request) string {
	local := r.Header.Get(authHeader)
	if i := strings.IndexByte(local, '@'); i > 0 {
		local = local[:i]
	}
	return loadUserMap()[local]
}
