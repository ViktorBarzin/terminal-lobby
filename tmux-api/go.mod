module tmux-api

go 1.22

toolchain go1.22.2

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
