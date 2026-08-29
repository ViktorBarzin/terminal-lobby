package main

import (
	"terminal-lobby/telemetry"
)

// events is this service's usage-event emitter (docs/adr/0006-usage-telemetry.md).
// buildID is stamped at deploy time (-ldflags -X main.buildID=<rev>).
var (
	buildID = "dev"
	events  = telemetry.New("clipboard-upload", buildID, nil)
)

// diagEvents is this service's diagnostics emitter and timing is the request
// middleware over it (docs/adr/0008-client-diagnostics.md). Server-side
// duration is what lets a client-observed latency be split into network and
// server: the client stamps X-TL-Req and the middleware echoes it back.
var (
	diagEvents = telemetry.NewDiag("clipboard-upload", buildID, nil)
	timing     = telemetry.NewTiming(diagEvents, telemetry.TimingOpts{})
)
