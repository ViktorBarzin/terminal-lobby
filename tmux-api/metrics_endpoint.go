package main

// /metrics — the lobby's Prometheus surface.
//
// WHY. On 2026-09-12 the devvm stalled badly enough that a user could not work
// for about three hours, and nothing alerted. Reviewing the coverage that day:
// the only scrape target on this host is node_exporter, so t3-serve, tmux-api
// and ttyd were invisible to Prometheus entirely. SessionWatchSilent is a
// dead-man switch on tl-session-watch's journal and T3ProbeLegDown watches the
// probe from inside the cluster, but nothing could answer "is the lobby up".
//
// ADR-0006 anticipated this. It chose Loki for usage events because a line on
// stdout needs no new service, and recorded in the same breath that "long-term
// trends would need counters in Prometheus (26 weeks)". This is that half, and
// it does not replace the event stream: Loki answers what happened in a
// session, Prometheus answers whether the service is up and how slow it is.
//
// WHAT THIS EXPOSES, AND WHERE. No auth, deliberately, and the accurate
// version of that claim rather than the comfortable one: this service listens
// on 0.0.0.0:7684 in production (TL_BIND in /etc/terminal-lobby.local.conf),
// so /metrics answers anyone who can reach the box on the internal VLAN. The
// API routes beside it are gated by TL_PROXY_SECRET; this one is not.
//
// That is judged acceptable because of what is in it: request counts, request
// latencies, an uptime, a build id, and per-OS-user session COUNTS. No session
// names, no project names, no paths, no content. The one identifier it leaks
// is the set of OS usernames, which node_exporter on the same host and port
// range already exposes far more about. If the sensitivity bar ever moves,
// gate it on the same X-TL-Proxy-Secret the other routes use and have the
// scrape send the header.
//
// A SUCCESSFUL SCRAPE IS THE LIVENESS SIGNAL, which is the one design
// constraint worth stating. Every gauge below can be unknown without the
// endpoint failing: tmux may be unreachable, a user may have no server
// running. The handler still answers 200 with the build and uptime it always
// knows, because a scrape that 500s when tmux hiccups turns a working service
// into a page.

import (
	"fmt"
	"net/http"
	"time"
)

var processStart = time.Now()

// sessionCounter is a seam, not indirection for its own sake: it lets the
// tests exercise the tmux-is-down path, which is the behaviour that matters
// most here and cannot be produced on demand from a real tmux.
var sessionCounter = liveSessionCounts

// liveSessionCounts reads one list-sessions per mapped user through the same
// cached machinery the rest of the service uses, so a scrape costs no more
// than a poll already does.
func liveSessionCounts() map[string]int {
	out := map[string]int{}
	for _, u := range mappedOSUsers() {
		sessions, _ := userSessionsAndActivity(u)
		out[u] = len(sessions)
	}
	return out
}

func handleMetrics(w http.ResponseWriter, r *http.Request) {
	// Build and uptime first and unconditionally. These are what make the
	// scrape meaningful when everything below is unavailable.
	metrics.SetGauge("tl_build_info", map[string]string{"version": buildID}, 1)
	metrics.SetGauge("tl_uptime_seconds", nil, time.Since(processStart).Seconds())

	// Per-user session counts. OS usernames are a closed set from the roster,
	// so they are safe as a label; session names are user-supplied and never
	// become one. Same rule the event stream follows for Loki.
	if counts := sessionCounter(); counts != nil {
		total := 0
		for user, n := range counts {
			metrics.SetGauge("tl_sessions", map[string]string{"user": user}, float64(n))
			total += n
		}
		metrics.SetGauge("tl_sessions_total", nil, float64(total))
	}

	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	fmt.Fprintf(w, "# HELP tl_build_info Build of the running tmux-api, value always 1.\n")
	fmt.Fprintf(w, "# HELP tl_uptime_seconds Seconds since this process started.\n")
	fmt.Fprintf(w, "# HELP tl_sessions Live tmux sessions per OS user.\n")
	fmt.Fprintf(w, "# HELP tl_sessions_total Live tmux sessions across every mapped user.\n")
	metrics.WriteTo(w)
}
