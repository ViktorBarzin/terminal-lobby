package main

import "terminal-lobby/telemetry"

// events is this service's usage-event emitter (docs/adr/0005-usage-telemetry.md).
// buildID is stamped at deploy time (-ldflags -X main.buildID=<rev>).
var (
	buildID = "dev"
	events  = telemetry.New("session-events", buildID, nil)
)
