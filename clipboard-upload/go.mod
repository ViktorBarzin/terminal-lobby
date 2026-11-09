module clipboard-upload

go 1.25.0

require terminal-lobby/telemetry v0.0.0

replace terminal-lobby/telemetry => ../telemetry

require terminal-lobby/authuser v0.0.0

replace terminal-lobby/authuser => ../authuser

require terminal-lobby/clipstore v0.0.0

require (
	github.com/ViktorBarzin/telemetry/go v0.1.0 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/getsentry/sentry-go v0.50.0 // indirect
	github.com/google/uuid v1.3.0 // indirect
	github.com/segmentio/analytics-go/v3 v3.4.0 // indirect
	go.opentelemetry.io/otel v1.46.0 // indirect
	go.opentelemetry.io/otel/trace v1.46.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
	golang.org/x/text v0.41.0 // indirect
)

replace terminal-lobby/clipstore => ../clipstore
