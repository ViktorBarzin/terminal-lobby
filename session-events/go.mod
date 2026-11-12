module github.com/viktorbarzin/terminal-lobby/session-events

go 1.25.0

require (
	terminal-lobby/authuser v0.0.0
	terminal-lobby/sessionio v0.0.0
	terminal-lobby/spendstore v0.0.0
	terminal-lobby/telemetry v0.0.0
)

require github.com/gorilla/websocket v1.5.3

require (
	github.com/ViktorBarzin/telemetry/go v0.2.0 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/getsentry/sentry-go v0.50.0 // indirect
	github.com/google/uuid v1.3.0 // indirect
	github.com/segmentio/analytics-go/v3 v3.4.0 // indirect
	go.opentelemetry.io/otel v1.46.0 // indirect
	go.opentelemetry.io/otel/trace v1.46.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
	golang.org/x/text v0.41.0 // indirect
)

replace terminal-lobby/telemetry => ../telemetry

replace terminal-lobby/sessionio => ../sessionio

replace terminal-lobby/authuser => ../authuser

replace terminal-lobby/spendstore => ../spendstore
