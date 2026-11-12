module tmux-api

go 1.25.0

require github.com/SherClockHolmes/webpush-go v1.4.0

require (
	github.com/golang-jwt/jwt/v5 v5.2.1 // indirect
	golang.org/x/crypto v0.31.0 // indirect
	terminal-lobby/telemetry v0.0.0
)

replace terminal-lobby/telemetry => ../telemetry

require terminal-lobby/sessionio v0.0.0

replace terminal-lobby/sessionio => ../sessionio

require terminal-lobby/authuser v0.0.0

replace terminal-lobby/authuser => ../authuser

require (
	terminal-lobby/slug v0.0.0
	terminal-lobby/spendstore v0.0.0
)

replace terminal-lobby/slug => ../slug

replace terminal-lobby/spendstore => ../spendstore

require terminal-lobby/clipstore v0.0.0

replace terminal-lobby/clipstore => ../clipstore

require (
	github.com/ViktorBarzin/telemetry/go v0.2.0
	terminal-lobby/t3client v0.0.0
)

require (
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/getsentry/sentry-go v0.50.0 // indirect
	github.com/google/uuid v1.3.0 // indirect
	github.com/segmentio/analytics-go/v3 v3.4.0 // indirect
	go.opentelemetry.io/otel v1.46.0 // indirect
	go.opentelemetry.io/otel/trace v1.46.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
	golang.org/x/text v0.41.0 // indirect
)

replace terminal-lobby/t3client => ../t3client
