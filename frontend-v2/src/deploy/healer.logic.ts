/**
 * Deploy self-heal — PURE logic (inventory Cat.10 "Deploy & Self-Update
 * Healing"). No DOM, no timers, no signals: just the testable kernel of the
 * content-hash stale-tab healer. The timers/listeners/signals that drive it live
 * in ./healer.ts.
 *
 * Why this exists: a deploy restarts ttyd, which only DROPS the terminal's
 * WebSocket — the page silently reconnects and keeps running its OLD JavaScript
 * forever (Cache-Control never helps because the tab never re-fetches itself).
 * The lobby is the ONLY deploy channel: there is no server build header, so a
 * running tab detects a deploy by re-fetching its own served bytes and comparing
 * a content hash. The build id (Vite `define`, a git SHA at deploy) is inlined
 * into the served HTML, so every deploy changes those bytes and flips the hash.
 */

/**
 * The marker substring the served HTML must contain. `fetchSelf` validates it so
 * an auth interstitial (which lacks it) NEVER becomes the comparison baseline —
 * that would blind the detector. Kept as a literal here AND emitted verbatim by
 * the boot console line (`logBuildId`), so the built single-file `index.html`
 * carries the substring and a self-fetch can recognise its own page.
 */
export const BUILD_SUBSTRING = "terminal-lobby build:";

/** AUTO-reload storm window: at most one AUTOMATIC reload per this interval per
 *  top document. An EXPLICIT "Update ready" tap is never routed through it. */
export const STORM_WINDOW_MS = 120_000;

/**
 * djb2 string hash → `"<len>:<hash>"`. The length prefix makes a collision
 * between two different-length pages impossible; within a deploy the page is
 * byte-stable, so ANY change to the served bytes flips this value. Ported
 * verbatim from the vanilla frontend's `hashPage`.
 */
export function hashPage(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  }
  return text.length + ":" + h;
}

/**
 * Fetch our OWN served bytes and return them ONLY if the response is a real,
 * authenticated copy of the app: HTTP 200 AND it contains the build marker. Any
 * other outcome resolves `null` (an auth wall or error page must never become
 * the baseline). `fetch` + `url` are injected so this is unit-testable and so a
 * canary deploy can retarget the origin without touching call sites. Rejections
 * propagate to the caller (the healer catches them and retries next tick).
 */
export async function fetchSelf(
  fetchImpl: typeof fetch,
  url: string,
  cacheMode: RequestCache,
): Promise<string | null> {
  const r = await fetchImpl(url, { cache: cacheMode, credentials: "same-origin" });
  if (!r.ok) return null;
  const text = await r.text();
  return text.includes(BUILD_SUBSTRING) ? text : null;
}

/**
 * AUTO-reload storm throttle — pure decision. Returns whether an automatic
 * reload is allowed right now (the caller records `now` as the new
 * `lastReloadAt` when this returns true). The served page is byte-stable within
 * a deploy, so a reload re-boots the page and re-arms the baseline to the NEW
 * bytes — detection then stops. This cap is the anti-loop backstop even in the
 * pathological per-request-varying case.
 */
export function stormOK(
  now: number,
  lastReloadAt: number | null,
  windowMs: number = STORM_WINDOW_MS,
): boolean {
  return now - (lastReloadAt ?? 0) >= windowMs;
}

/**
 * The `requestTopReload` policy, expressed as a pure plan (TOP-owned reload):
 *
 *   - no attached terminal OR a hidden tab → reload immediately (nothing on
 *     screen to interrupt), subject to the storm throttle;
 *   - an attached terminal on a visible tab → DEFER to a sticky "Update ready"
 *     pill (a new build must never yank the page out from under an active
 *     viewer), unless one is already up.
 *
 * `"reload"`     — do it now; the caller also records the storm timestamp.
 * `"throttled"`  — an immediate reload was wanted but the storm gate blocked it.
 * `"show-pill"`  — raise the sticky, tappable "Update ready" pill.
 * `"pill-pending"` — a pill is already up; nothing to do.
 */
export type ReloadPlan = "reload" | "throttled" | "show-pill" | "pill-pending";

export interface ReloadState {
  /** is a terminal attached (a session selected / iframe mounted)? */
  attached: boolean;
  /** is the tab hidden right now? */
  hidden: boolean;
  /** is the deferred "Update ready" pill already raised? */
  updatePending: boolean;
  now: number;
  lastReloadAt: number | null;
  stormWindowMs?: number;
}

export function planReload(s: ReloadState): ReloadPlan {
  const immediate = !s.attached || s.hidden;
  if (immediate) {
    return stormOK(s.now, s.lastReloadAt, s.stormWindowMs) ? "reload" : "throttled";
  }
  return s.updatePending ? "pill-pending" : "show-pill";
}

/**
 * The lobby message-bus bridge predicate: is this postMessage the terminal
 * iframe's build-stale signal? The origin + source are validated by the caller
 * (TerminalView); this only classifies the payload. Completes the TOP-owned
 * reload contract — the embedded terminal never reloads itself, it posts
 * `{type:'tl-build-stale'}` UP and the lobby owns the single reload.
 */
export function isBuildStale(data: unknown): boolean {
  return (
    !!data &&
    typeof data === "object" &&
    (data as { type?: unknown }).type === "tl-build-stale"
  );
}

/** The boot log line, `"terminal-lobby build: <id>"`. Emitting `BUILD_SUBSTRING`
 *  is what plants the marker literal in the shipped bundle. */
export function buildLogLine(id: string): string {
  return BUILD_SUBSTRING + " " + id;
}
