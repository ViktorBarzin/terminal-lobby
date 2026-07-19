/**
 * Runtime config. Two backends sit behind the same-origin ingress in production:
 *
 *   - session-events — the normalized event stream + prompt/cancel/permission
 *     control channel, served at the ROOT paths /events, /prompt, /cancel,
 *     /permission (see session-events/main.go).
 *   - tmux-api — the lobby data API (sessions, layout, whoami, projects …),
 *     reached under the /api/* prefix (the ingress strips /api → tmux-api root;
 *     see the runtime-topology diagram in the feature inventory). The vite dev
 *     proxy reproduces both mappings for local dev (vite.config.ts).
 *
 * `?api=<base>` overrides the origin for BOTH surfaces so a laptop can point at a
 * remote devvm; default is "" (same-origin).
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

/** The tmux-api prefix. Lobby data calls live under this (ingress strips it). */
export const TMUX_API_PREFIX = "/api";

/** SSE endpoint for a session's normalized event stream (session-events). */
export function eventsUrl(session: string, lastEventId: number): string {
  const u = `${API_BASE}/events/${encodeURIComponent(session)}`;
  // The Go SSE handler reads Last-Event-ID (header) first, then ?lastEventId=.
  // EventSource's native header only survives within one instance; because we
  // recreate the source on every manual reconnect, we carry the cursor in the
  // query so a resumed connection replays only events with id > lastEventId.
  return lastEventId > 0 ? `${u}?lastEventId=${lastEventId}` : u;
}

/** POST target for resolving a permission request by its reqId (session-events). */
export function permissionUrl(reqId: string): string {
  return `${API_BASE}/permission/${encodeURIComponent(reqId)}`;
}

/** POST target to inject a prompt into the session's Claude (session-events).
 *  Body: {text}. 204 on success, 409 if a turn is already running. */
export function promptUrl(session: string): string {
  return `${API_BASE}/prompt/${encodeURIComponent(session)}`;
}

/** POST target to cancel/interrupt the running turn (session-events). No body. */
export function cancelUrl(session: string): string {
  return `${API_BASE}/cancel/${encodeURIComponent(session)}`;
}

/** Build a tmux-api URL under the /api prefix (e.g. apiUrl("/sessions")). */
export function apiUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE}${TMUX_API_PREFIX}${p}`;
}

/** The tmux-api prefs endpoint (roamed settings). Whole-doc GET/PUT. */
export const PREFS_PATH = "/prefs";

/**
 * Origin the terminal iframe attaches against — the patched ttyd `-I` page that
 * serves `/`, `/ws`, `/token` (deploy-options doc). It MUST stay same-origin as
 * the lobby: the ttyd page is the iframe, and the lobby↔iframe postMessage bus
 * rejects any `e.origin !== location.origin`. Default "" = same-origin root, the
 * exact base the vanilla app uses (`/?arg=`). `?terminal=<base>` overrides it so
 * a canary build of this SPA can point at a second ttyd unit during cutover.
 */
function readTerminalBase(): string {
  if (typeof window === "undefined") return "";
  try {
    const q = new URLSearchParams(window.location.search).get("terminal");
    if (q) return q.replace(/\/$/, "");
  } catch {
    /* no URL / no search */
  }
  return "";
}

export const TERMINAL_BASE = readTerminalBase();

export const BUILD_ID: string =
  typeof __TL_BUILD__ !== "undefined" ? __TL_BUILD__ : "dev";
