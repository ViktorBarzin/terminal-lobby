package main

import "time"

// How long POST /prompt waits for a pane to be able to take text, when the
// caller asks it to (the `awaitReady` field).
//
// Sized from a real boot on 2026-09-04: Claude Code draws its `❯` about 1.6s
// after the session is created and is reading keys from about 1.9s, while the
// first rung of the browser's retry ladder arrives at 700ms. So a wait of a few
// seconds is what turns a cold create into a single attempt instead of three,
// and the ladder is still what bounds the whole thing — a pane that never draws
// a prompt costs this wait per rung and then gets its text anyway, because the
// last rung asks for no wait at all.
//
// The poll is sessionio's own default spelled out, since the cost of the wait
// is one `capture-pane` per tick and that is worth reading here.
const (
	PromptReadyWait = 4 * time.Second
	PromptReadyPoll = 200 * time.Millisecond
)
