/**
 * Runtime config. Two backends sit behind the same-origin ingress in production:
 *
 *   - session-events — the normalized event stream + prompt/cancel control
 *     channel, served at the ROOT paths /events, /prompt, /cancel (see
 *     session-events/main.go). Its web-mediated PERMISSION broker was removed
 *     in 575d4f5 — see permissionUrl() below.
 *   - tmux-api — the lobby data API (sessions, layout, whoami, projects …),
 *     reached under the /api/sessions/* prefix (the PROD ingress is
 *     `PathPrefix /api/sessions/` → tmux-api, stripping the whole prefix so
 *     tmux-api sees /whoami, /sessions, /layout, … at its root; this matches the
 *     vanilla frontend/index.html verbatim). The vite dev proxy reproduces both
 *     mappings for local dev (vite.config.ts).
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

/**
 * `?as=<osUser>` — the admin act-as switch (docs/plans/2026-08-16-admin-act-as-
 * user-design.md). Present, a tab acts as that user throughout: sessions,
 * layout, projects, prefs, files and gallery all belong to them.
 *
 * A query parameter rather than a header because two of the surfaces it must
 * reach are not fetch() calls — file previews and gallery thumbnails are
 * <img src> — and a parameter is the only form all of them can carry. On the
 * URL rather than in memory so it survives a reload and stays visible in the
 * address bar; per tab, so one tab can be someone else while another stays you.
 *
 * The server decides whether it is allowed; this is only how the ask travels.
 * Push subscriptions deliberately do NOT carry it — pwa/push.ts spells its
 * paths out verbatim rather than going through apiUrl, which is what keeps
 * this browser from being enrolled as one of the target's devices.
 */
const ACT_AS_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,31}$/;

/** Pure half of the reader, so it is testable without touching the location. */
export function readActAsFrom(search: string): string {
  try {
    const v = new URLSearchParams(search).get("as") ?? "";
    // Matches the server's own charset (authuser.userRe), including its refusal
    // of a leading dash. The server re-checks regardless; dropping it here just
    // keeps a hand-edited URL from putting junk on every request.
    return ACT_AS_RE.test(v) ? v : "";
  } catch {
    return "";
  }
}

function readActAs(): string {
  if (typeof window === "undefined") return "";
  return readActAsFrom(window.location.search);
}

export const ACT_AS = readActAs();

/** Append the act-as target to a backend URL. Inert when not switched. */
export function appendActAs(url: string, actAs: string): string {
  if (!actAs) return url;
  return url + (url.includes("?") ? "&" : "?") + "as=" + encodeURIComponent(actAs);
}

/** Config-bound `appendActAs`, applied by every builder below. */
function withActAs(url: string): string {
  return appendActAs(url, ACT_AS);
}

/**
 * The tmux-api prefix. Every lobby data call built with `apiUrl` lives under it.
 * The PROD ingress routes `PathPrefix /api/sessions/` → tmux-api and STRIPS the
 * whole prefix, so tmux-api serves /whoami, /sessions, /layout, /prefs, … at its
 * root — exactly what the vanilla frontend/index.html calls. Web Push rides the
 * same /api/sessions/ prefix but is spelled out verbatim in pwa/push.ts (NOT via
 * apiUrl), so it is unaffected by this constant.
 */
export const TMUX_API_PREFIX = "/api/sessions";

/** SSE endpoint for a session's normalized event stream (session-events). */
export function eventsUrl(session: string, lastEventId: number): string {
  const u = `${API_BASE}/events/${encodeURIComponent(session)}`;
  // The Go SSE handler reads Last-Event-ID (header) first, then ?lastEventId=.
  // EventSource's native header only survives within one instance; because we
  // recreate the source on every manual reconnect, we carry the cursor in the
  // query so a resumed connection replays only events with id > lastEventId.
  return withActAs(lastEventId > 0 ? `${u}?lastEventId=${lastEventId}` : u);
}

/**
 * POST target for resolving a permission request by its reqId (session-events).
 *
 * @deprecated DEAD ROUTE — session-events no longer serves it. 575d4f5 removed
 * the web-mediated PreToolUse permission broker: it answered "ask" for any
 * session nobody was watching in Text mode, and a PreToolUse "ask" OVERRIDES
 * the allowlist rather than deferring to it, so it forced a prompt on every
 * tool call in every session on the shared devvm. The prod ingress no longer
 * routes it either. Kept — with PermissionPanel.tsx — so a future re-enable
 * behind a per-session gate does not have to rebuild the client half; calling
 * it today gets a 404.
 */
export function permissionUrl(reqId: string): string {
  return `${API_BASE}/permission/${encodeURIComponent(reqId)}`;
}

/** POST target to inject a prompt into the session's Claude (session-events).
 *  Body: {text}. 204 on success, 409 if a turn is already running. */
export function promptUrl(session: string): string {
  return withActAs(`${API_BASE}/prompt/${encodeURIComponent(session)}`);
}

/** POST target to cancel/interrupt the running turn (session-events). No body. */
export function cancelUrl(session: string): string {
  return withActAs(`${API_BASE}/cancel/${encodeURIComponent(session)}`);
}

/**
 * POST target that types an answer into the session's pane (session-events).
 * Body: {keys:[…]}. The server allowlists the keys — this is how the text view
 * answers a blocking prompt (ADR-0010).
 */
export function keysUrl(session: string): string {
  return withActAs(`${API_BASE}/keys/${encodeURIComponent(session)}`);
}

/** GET target for the window of turns before event `before` (session-events). */
export function earlierUrl(session: string, before: number): string {
  return withActAs(
    `${API_BASE}/earlier/${encodeURIComponent(session)}?before=${before}`,
  );
}

/** GET target for one tool result in full, after the wire capped it. */
export function resultUrl(session: string, toolId: string): string {
  return withActAs(
    `${API_BASE}/result/${encodeURIComponent(session)}/${encodeURIComponent(toolId)}`,
  );
}

/** GET target for the slash commands this session can run beyond the built-ins
 *  (its user's skills + custom commands, the project's, enabled plugins'). */
export function commandsUrl(session: string): string {
  return withActAs(`${API_BASE}/commands/${encodeURIComponent(session)}`);
}

/** GET target for what the session's pane currently shows, plus its state. */
export function paneUrl(session: string): string {
  return withActAs(`${API_BASE}/pane/${encodeURIComponent(session)}`);
}

/** Build a tmux-api URL under the /api/sessions prefix (e.g. apiUrl("/sessions")
 *  → "/api/sessions/sessions"; apiUrl("/whoami") → "/api/sessions/whoami"). */
export function apiUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return withActAs(`${API_BASE}${TMUX_API_PREFIX}${p}`);
}

/**
 * The clipboard-upload service prefix. The ingress routes /clipboard/* to the
 * clipboard-upload service (stripping the prefix), so from the browser every
 * image call is /clipboard/... — POST /clipboard/upload (multipart `image` for
 * gallery pastes, `file` for ephemeral /tmp transfers), GET /clipboard/list?
 * session=, GET /clipboard/img/<session>/<name>. The vite dev proxy reproduces
 * the mapping (vite.config.ts). `?api=` overrides the origin like the others.
 */
export const CLIPBOARD_PREFIX = "/clipboard";

/** Build a clipboard-upload URL under the /clipboard prefix. */
export function clipboardUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return withActAs(`${API_BASE}${CLIPBOARD_PREFIX}${p}`);
}

/** GET target listing the caller's stored images for one session (newest-first). */
export function clipboardListUrl(session: string): string {
  return clipboardUrl(`/list?session=${encodeURIComponent(session)}`);
}

/** GET target serving one stored image back (gallery thumbnail / lightbox src). */
export function clipboardImgUrl(session: string, name: string): string {
  return clipboardUrl(
    `/img/${encodeURIComponent(session)}/${encodeURIComponent(name)}`,
  );
}

/**
 * GET target serving one stored DOCUMENT back — the read-back route a text-view
 * attachment chip opens, and what the file preview reads a stored document
 * through. Separate from /img because the two answer differently: /img serves
 * only image bytes, while this one disables sniffing and forces a download for
 * anything a browser could execute as markup. Both resolve inside the caller's
 * own store directory.
 */
export function clipboardFileUrl(session: string, name: string): string {
  return clipboardUrl(
    `/file/${encodeURIComponent(session)}/${encodeURIComponent(name)}`,
  );
}

/**
 * The file-api service prefix (roadmap pillar #6). The ingress routes /files/*
 * to the file-api service WITHOUT stripping the prefix (the service's own routes
 * are /files/list, /files/read, /files/write — see file-api/main.go), so from
 * the browser every call is /files/... verbatim, mirroring session-events'
 * root-path mapping (NOT tmux-api's strip-the-prefix mapping). The vite dev
 * proxy reproduces it (vite.config.ts). `?api=` overrides the origin like the
 * others so a laptop can point at a remote devvm.
 */
export const FILE_API_PREFIX = "/files";

/** GET target reading one file's bytes (path is absolute, within the caller's
 *  home; the server enforces the boundary + a 10MB cap). Doubles as an <img>
 *  src for image previews. */
export function fileReadUrl(path: string): string {
  return withActAs(
    `${API_BASE}${FILE_API_PREFIX}/read?path=${encodeURIComponent(path)}`,
  );
}

/** GET target listing a directory's entries (dirs first). `all` includes
 *  dotfiles. */
export function fileListUrl(dir: string, all = false): string {
  const a = all ? "&all=1" : "";
  return withActAs(
    `${API_BASE}${FILE_API_PREFIX}/list?dir=${encodeURIComponent(dir)}${a}`,
  );
}

/** POST target writing one file (roadmap pillar #6 editor). Body: JSON
 *  {path, content}; the server confines the path to the caller's home, caps the
 *  content at 10MB, and replies 204. The /files prefix is verbatim (the ingress
 *  does not strip it), mirroring fileReadUrl / fileListUrl. */
export function fileWriteUrl(): string {
  return withActAs(`${API_BASE}${FILE_API_PREFIX}/write`);
}

/** The tmux-api prefs endpoint (roamed settings). Whole-doc GET/PUT. */
export const PREFS_PATH = "/prefs";

/**
 * The terminal page the iframe attaches against — the ttyd-served terminal-mode
 * document that mounts xterm on `?arg=` (frontend/term.html). It MUST stay
 * same-origin as the lobby: the term page is the iframe, and the lobby↔iframe
 * postMessage bus rejects any `e.origin !== location.origin`.
 *
 * Default is `/term.html` (NOT `/`): this SPA is served at `/`, so an iframe
 * pointed at `/?arg=` would recursively load the SPA instead of the terminal
 * page. term.html is a SEPARATE static asset (deploy ships it like sw.js) whose
 * `?arg=` terminal branch attaches ttyd/tmux and speaks the tl-* postMessage
 * bridge. `?terminal=<url>` overrides the whole page URL so a canary build can
 * point at a second term unit during cutover (e.g. `?terminal=/term2.html` or
 * `?terminal=https://canary.example/term.html`).
 */
const TERMINAL_BASE_DEFAULT = "/term.html";
function readTerminalBase(): string {
  if (typeof window === "undefined") return TERMINAL_BASE_DEFAULT;
  try {
    const q = new URLSearchParams(window.location.search).get("terminal");
    if (q) return q.replace(/\/$/, "");
  } catch {
    /* no URL / no search */
  }
  return TERMINAL_BASE_DEFAULT;
}

export const TERMINAL_BASE = readTerminalBase();

export const BUILD_ID: string =
  typeof __TL_BUILD__ !== "undefined" ? __TL_BUILD__ : "dev";
