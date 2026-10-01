module github.com/viktorbarzin/terminal-lobby/session-events

go 1.22.2

require (
	terminal-lobby/authuser v0.0.0
	terminal-lobby/sessionio v0.0.0
	terminal-lobby/spendstore v0.0.0
	terminal-lobby/telemetry v0.0.0
)

require github.com/gorilla/websocket v1.5.3

replace terminal-lobby/telemetry => ../telemetry

replace terminal-lobby/sessionio => ../sessionio

replace terminal-lobby/authuser => ../authuser

replace terminal-lobby/spendstore => ../spendstore
