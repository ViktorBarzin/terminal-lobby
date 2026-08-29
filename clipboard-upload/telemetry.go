package main

import (
	"net/http"

	"terminal-lobby/telemetry"
)

// events is this service's usage-event emitter (docs/adr/0006-usage-telemetry.md).
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
	// Resolve rather than reading the header directly, so this honours the
	// configured header name and the mode like every other caller. The error is
	// deliberately dropped: an unattributable event is still an event.
	id, err := actAsGate.Resolve(r)
	if err != nil {
		return ""
	}
	return id.RealOSUser
}

// diagEvents is this service's diagnostics emitter and timing is the request
// middleware over it (docs/adr/0008-client-diagnostics.md). Server-side
// duration is what lets a client-observed latency be split into network and
// server: the client stamps X-TL-Req and the middleware echoes it back.
var (
	diagEvents = telemetry.NewDiag("clipboard-upload", buildID, nil)
	timing     = telemetry.NewTiming(diagEvents, telemetry.TimingOpts{})
)
