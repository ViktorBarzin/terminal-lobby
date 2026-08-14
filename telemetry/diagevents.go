package telemetry

// The diagnostics catalog — a CLOSED vocabulary, for the same reasons as the
// usage one (events.go): the browser intake accepts names from the client, and
// a typo would mint a series nobody queries.
//
// Adding a record = add it here, in the same commit as the call site, and to
// the vocabulary table in docs/adr/0008-client-diagnostics.md.
//
// Every diagnostics record additionally carries the correlation attributes
// tl.tab, tl.parent, tl.device, tl.session, tl.conn, tl.client and tl.role.
// tl.client names the surface; tl.role distinguishes lobby from terminal,
// because vanilla index.html serves both roles from one file.
//
// The no-content rule is unchanged from ADR-0006: records say how the app
// performed and how it failed, never what was typed into it. tl.trace carries
// input GEOMETRY and control keys — pointer positions, wheel deltas,
// Enter/Escape/modifier chords — never typed characters.
var knownDiagEvents = map[string]bool{
	// -- windowed measurement ------------------------------------------------
	// Emitted only while a tab is visible AND saw traffic in the window.
	// Latency fields are absent from windows where nobody typed.
	"perf.rollup": true, // tl.win_s, tl.input.*, tl.echo.* (+tl.echo.unmatched),
	// tl.render.*, tl.jank.n, tl.longtask.*, tl.ws.*, tl.api.*

	// -- liveness and death --------------------------------------------------
	"app.alive": true, // idle or hidden heartbeat: ids + tl.alive_s + tl.state
	"app.died":  true, // previous page life ended without a pagehide (tl.prev_tab)

	// -- connection health ---------------------------------------------------
	"conn.opened":  true, // tl.token_ms, tl.handshake_ms, tl.conn
	"conn.dropped": true, // tl.code, tl.up_s, tl.reconnect_n, tl.down_ms, tl.reason
	"term.stall":   true, // input sent, no output back past the threshold

	// -- failures ------------------------------------------------------------
	"app.exception": true, // tl.msg, tl.src, tl.stack, tl.n, tl.kind
	"api.slow":      true, // tl.ep, tl.status, tl.ms, tl.req
	"diag.incident": true, // tl.kind + tl.trace, the flight recorder

	// -- server side ---------------------------------------------------------
	"api.served":  true, // one handler's duration, joined by tl.req
	"api.rollup":  true, // 60s per-service distribution by endpoint group
	"term.ready":  true, // iframe boot -> first byte -> first paint
	"app.context": true, // navigation timing + device/network context at boot

	// -- intake health -------------------------------------------------------
	// Each channel reports its own rejections on its own channel, so a
	// diagnostics problem never shows up as a usage anomaly.
	"api.rejected": true, // a diag record refused: unknown name, over cap
}

// IsKnownDiag reports whether name is in the diagnostics catalog.
func IsKnownDiag(name string) bool { return knownDiagEvents[name] }

// KnownDiagEvents lists the catalog, for the intake handler's error message
// and for tests that assert docs and code agree.
func KnownDiagEvents() []string {
	out := make([]string, 0, len(knownDiagEvents))
	for k := range knownDiagEvents {
		out = append(out, k)
	}
	return out
}
