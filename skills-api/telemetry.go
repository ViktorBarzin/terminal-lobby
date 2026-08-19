package main

import "terminal-lobby/telemetry"

// events is this service's usage-event emitter (docs/adr/0006-usage-telemetry.md).
// buildID is stamped at deploy time (-ldflags -X main.buildID=<rev>).
var (
	buildID = "dev"
	events  = telemetry.New("skills-api", buildID, nil)
)

// diagEvents is this service's diagnostics emitter and timing is the request
// middleware over it (docs/adr/0008-client-diagnostics.md).
var (
	diagEvents = telemetry.NewDiag("skills-api", buildID, nil)
	timing     = telemetry.NewTiming(diagEvents, telemetry.TimingOpts{})
)
