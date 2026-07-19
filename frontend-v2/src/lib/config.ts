/**
 * Runtime config. The session-events service is a sibling of tmux-api on the
 * devvm; in production the SPA is same-origin behind the ingress, so the default
 * base is "" (relative). Override via `?api=` for local dev against a remote box.
 */
function readApiBase(): string {
  if (typeof window === "undefined") return "";
  try {
    const q = new URLSearchParams(window.location.search).get("api");
    if (q) return q.replace(/\/$/, "");
  } catch {
    /* no URL / no search */
  }
  return "";
}

export const API_BASE = readApiBase();

/** SSE endpoint for a session's normalized event stream (session-events). */
export function eventsUrl(session: string, lastEventId: number): string {
  const u = `${API_BASE}/events/${encodeURIComponent(session)}`;
  // The Go SSE handler reads Last-Event-ID (header) first, then ?lastEventId=.
  // EventSource's native header only survives within one instance; because we
  // recreate the source on every manual reconnect, we carry the cursor in the
  // query so a resumed connection replays only events with id > lastEventId.
  return lastEventId > 0 ? `${u}?lastEventId=${lastEventId}` : u;
}

/** POST target for resolving a permission request by its reqId. */
export function permissionUrl(reqId: string): string {
  return `${API_BASE}/permission/${encodeURIComponent(reqId)}`;
}

/** Provisional prompt-inject endpoint (pillar #1 control channel, not yet
 * finalized in the backend — see blockers). Send writes into the tmux pty. */
export function inputUrl(session: string): string {
  return `${API_BASE}/input/${encodeURIComponent(session)}`;
}

/** ttyd fallback URL for the terminal view (stubbed for the foundation). */
export function ttydUrl(session: string): string {
  return `${API_BASE}/terminal/${encodeURIComponent(session)}`;
}

export const BUILD_ID: string =
  typeof __TL_BUILD__ !== "undefined" ? __TL_BUILD__ : "dev";
