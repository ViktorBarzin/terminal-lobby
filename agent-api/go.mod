module agent-api

go 1.22

require terminal-lobby/authuser v0.0.0

replace terminal-lobby/authuser => ../authuser

require terminal-lobby/sessionio v0.0.0

replace terminal-lobby/sessionio => ../sessionio

require terminal-lobby/telemetry v0.0.0

replace terminal-lobby/telemetry => ../telemetry
