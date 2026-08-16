module github.com/viktorbarzin/terminal-lobby/session-events

go 1.22.2

require (
	terminal-lobby/sessionio v0.0.0
	terminal-lobby/telemetry v0.0.0
)

replace terminal-lobby/telemetry => ../telemetry

replace terminal-lobby/sessionio => ../sessionio
