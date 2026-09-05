/**
 * Deploy self-update — PURE logic (inventory Cat.10 "Deploy & Self-Update
 * Healing"). No DOM, no timers, no signals: just the testable kernel. The
 * timers/listeners/signals that drive it live in ./healer.ts.
 *
 * Why this exists: a deploy restarts ttyd, which only DROPS the terminal's
 * WebSocket — the page silently reconnects and keeps running its OLD JavaScript
 * forever (Cache-Control never helps because the tab never re-fetches itself).
 * The lobby is the ONLY deploy channel: there is no server build header, so a
 * running tab re-fetches its own served bytes and asks "is this still MY build?"
 *
 * IDENTITY, NOT BYTES (ADR-0007). The old kernel compared a djb2 hash of the
 * whole served body, and the git SHA is stamped inside that body — so "a new
 * build is being served" really meant "someone committed something", including
 * backend-only commits that never touched the frontend. 55% of the commits in
 * the month before ADR-0007 left `frontend/index.html` byte-identical, and every
 * one of them would have notified. The comparison is now `TL_ASSET`: a
 * fingerprint of the frontend artifact's own content, stamped at deploy.
 * Identical frontend → identical id → no update, by construction rather than by
 * policy. It is also immune to anything else that varies per response (an edge
 * injecting a per-request script, a nonce), which whole-body hashing was not.
 */

/**
 * The marker substring the served HTML must contain. `fetchSelf` validates it so
 * an auth interstitial (which lacks it) is never read as an identity — that
 * would blind the detector. Kept as a literal here AND emitted verbatim by the
 * boot console line (`logBuildId`), so the built single-file `index.html`
 * carries the substring and a self-fetch can recognise its own page.
 */
export const BUILD_SUBSTRING = "terminal-lobby build:";

/** The attribute pair `parseAssetId` reads. A meta tag in `<head>` survives
 *  Vite's minifier untouched, so ONE parse shape works for both frontends. */
export const ASSET_SUBSTRING = 'name="tl-asset"';

/** AUTO-reload storm window: at most one automatic reload per this interval per
 *  top document. The anti-loop backstop, not a policy knob. */
export const STORM_WINDOW_MS = 120_000;

/**
 * How long away counts as "the next open" (Viktor, 2026-08-04): any app switch
 * of 5s or more. Short enough that a pending update lands the first time the
 * user comes back, long enough that a momentary notification-centre pull is not
 * a resume edge.
 */
export const RESUME_AWAY_MS = 5_000;

/** Reload attempts at ONE target id before the healer goes quiet about it. A
 *  reload that never lands must degrade to silence, never to a loop. */
export const MAX_UPDATE_ATTEMPTS = 3;

/** `<meta name="tl-asset" content="...">`, in either attribute order. */
const ASSET_META_RE =
  /<meta[^>]*\sname=["']tl-asset["'][^>]*>|<meta[^>]*\scontent=["'][^"']*["'][^>]*\sname=["']tl-asset["'][^>]*>/i;
const CONTENT_ATTR_RE = /\scontent=["']([^"']*)["']/i;

/**
 * The served page's update IDENTITY, or null when it carries none. Null is the
 * safe answer for every unknown — an unstamped page (a mis-stamped deploy: the
 * literal `__TL_ASSET__` placeholder) and a markerless interstitial must both
 * read as "no information", never as "a different build".
 */
export function parseAssetId(text: string): string | null {
  const tag = text.match(ASSET_META_RE);
  if (!tag) return null;
  const content = tag[0].match(CONTENT_ATTR_RE);
  const id = content?.[1]?.trim();
  if (!id || id.includes("__TL_")) return null;
  return id;
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

/** The stamp endpoint's shape: the same 12-hex fingerprint the meta tag carries,
 *  and nothing else. Anything longer, shorter or non-hex is "no information". */
const STAMP_RE = /^[0-9a-f]{12}$/;

/**
 * Read the build stamp from the dedicated endpoint. Returns the id, or null for
 * every unusable answer — a 404 (an origin that predates the endpoint), an auth
 * interstitial, a placeholder, anything that is not exactly a fingerprint.
 *
 * This replaces reading the id out of a full copy of the page. Measured on the
 * old path: 1,430,075-1,430,242 B per poll every 5s, and on iOS Safari 1,279
 * full bodies against 2 revalidations in 24h — 1.83 GB/day from one phone, or
 * 5.7x the entire downlink of a 400kbps link, permanently. The stamp is ~12
 * bytes, so the cheapness no longer depends on a 304 arriving.
 */
export async function fetchStamp(
  fetchImpl: typeof fetch,
  url: string,
  cacheMode: RequestCache,
): Promise<{ id: string | null; missing: boolean }> {
  const r = await fetchImpl(url, { cache: cacheMode, credentials: "same-origin" });
  if (r.status === 404) return { id: null, missing: true };
  if (!r.ok) return { id: null, missing: false };
  const text = (await r.text()).trim();
  return { id: STAMP_RE.test(text) ? text : null, missing: false };
}

/**
 * AUTO-reload storm throttle — pure decision. Returns whether an automatic
 * reload is allowed right now (the caller records `now` as the new
 * `lastReloadAt` when this returns true).
 *
 * The timestamp lives in sessionStorage, which can THROW (a sandboxed or
 * partitioned context). That used to remove the cap silently: the read was
 * swallowed, `lastReloadAt` stayed 0, and the gate opened on every call. When
 * storage is unavailable the document's own uptime stands in — it must have been
 * alive a full window before it may auto-reload, which caps an un-storable
 * document at one reload per window using nothing but in-document state.
 */
export function stormOK(
  now: number,
  lastReloadAt: number | null,
  windowMs: number = STORM_WINDOW_MS,
  opts: { storageAvailable?: boolean; uptimeMs?: number } = {},
): boolean {
  if (opts.storageAvailable === false) return (opts.uptimeMs ?? 0) >= windowMs;
  return now - (lastReloadAt ?? 0) >= windowMs;
}

/**
 * The zero-touch update policy, expressed as a pure plan (ADR-0007). The user
 * never taps anything: an update applies itself at a boundary that happens
 * anyway — the next open.
 *
 * `"reload"`  — apply now; the caller records the storm timestamp and the
 *               confirmation record first.
 * `"defer"`   — a real update is waiting for a safe moment (the page is hidden,
 *               or someone is looking at an attached terminal). Nothing is
 *               shown; the next resume edge or the next tick applies it.
 * `"none"`    — nothing to do: same build, unreadable response, or storm-gated.
 * `"give-up"` — reloads at this target keep failing to land; go quiet rather
 *               than thrash.
 */
export type UpdatePlan = "reload" | "defer" | "none" | "give-up";

export interface UpdateState {
  /** this document's own `TL_ASSET`; null = we don't know, so never act. */
  runningAsset: string | null;
  /** the id parsed out of the served bytes; null = no information. */
  servedAsset: string | null;
  /** is a terminal attached (a session is selected and mounted)? */
  attached: boolean;
  /** is the document visible AND focused right now? */
  visible: boolean;
  /** is this evaluation a resume edge — back after >= RESUME_AWAY_MS away, or a
   *  bfcache restore? This is what "the next open" means. */
  justResumed: boolean;
  /** reloads already attempted at THIS target id without landing. */
  attempts: number;
  now: number;
  lastReloadAt: number | null;
  stormWindowMs?: number;
  maxAttempts?: number;
  storageAvailable?: boolean;
  uptimeMs?: number;
}

export function planUpdate(s: UpdateState): UpdatePlan {
  // No information is not a new build: an unreadable page (auth wall, 5xx,
  // offline) and a document that does not know its own identity both mean stop.
  if (!s.servedAsset || !s.runningAsset) return "none";
  if (s.servedAsset === s.runningAsset) return "none";
  // A target that will not land must never keep trying — checked before every
  // other branch so no combination of state can resurrect the loop.
  if (s.attempts >= (s.maxAttempts ?? MAX_UPDATE_ATTEMPTS)) return "give-up";
  // Never navigate a hidden document: a backgrounded reload cannot be confirmed,
  // and on a phone it spends a full download and a tmux reattach on a page
  // nobody is looking at. It waits for the open instead.
  if (!s.visible) return "defer";
  // Never yank a page out from under someone using a terminal. It lands at the
  // next open (Viktor, 2026-08-04: no idle-timeout reload while visible+focused).
  if (s.attached && !s.justResumed) return "defer";
  if (
    !stormOK(s.now, s.lastReloadAt, s.stormWindowMs, {
      storageAvailable: s.storageAvailable,
      uptimeMs: s.uptimeMs,
    })
  ) {
    return "none";
  }
  return "reload";
}

/** The boot log line, `"terminal-lobby build: <id>"`. Emitting `BUILD_SUBSTRING`
 *  is what plants the marker literal in the shipped bundle. */
export function buildLogLine(id: string): string {
  return BUILD_SUBSTRING + " " + id;
}
