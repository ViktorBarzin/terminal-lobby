/**
 * Favicon state badge (inventory Cat.9, high-risk). Ported from the vanilla
 * frontend: the lobby OWNS the browser tab (the terminal is an iframe inside
 * it), so it badges `link[rel=icon]` with a canvas-rendered dot to signal state
 * at a glance from another tab.
 *
 * Two badge KINDS (Viktor: "yellow signals something is wrong — I'd prefer a
 * green tick for done"):
 *   - 'awaiting' — an amber dot (--state-awaiting): Claude genuinely wants input.
 *   - 'done'     — a green circle with a white tick (--state-done): a turn
 *                  finished, or a bell rang with nothing awaiting (good news, so
 *                  it does not wear the warning color).
 *
 * The 'done' badge is driven by the SAME `isUnseen` predicate as the tab title's
 * `(N✓)` count (store/visits.ts), so the two badge and clear together. They used
 * to disagree: the title badged every finished session while the favicon only
 * ever went green on a bell, so a session that finished quietly badged the title
 * and left the icon plain.
 *
 * `faviconKind` is PURE and unit-tested for its precedence (awaiting OUTRANKS
 * done). The render + swap are DOM/canvas and run only in a real browser.
 */

export type FaviconKind = "" | "awaiting" | "done";

/** The only session fields the badge needs. */
export type BadgeSession = { name: string; state?: string };

/** The base tab icon; swapped for a badged data: URL, restored to this on clear. */
export const FAVICON_HREF = "/icon-192.png";

/**
 * The badge to show: any session awaiting input OUTRANKS the finished/bell
 * signal — amber only when action is actually wanted, otherwise the green tick
 * if a bell latched OR a finished session is still unseen, else no badge.
 *
 * `isUnseen` defaults to "every done session is unseen" — the same default as
 * title.ts, so an un-injected caller badges consistently in both places.
 */
export function faviconKind(
  sessions: readonly BadgeSession[],
  attentionBell: boolean,
  isUnseen: (s: BadgeSession) => boolean = (s) => s.state === "done",
): FaviconKind {
  if (sessions.some((s) => s.state === "awaiting")) return "awaiting";
  if (attentionBell || sessions.some(isUnseen)) return "done";
  return "";
}

/**
 * Render the base icon onto a 64px canvas with a state-colored badge top-right
 * and hand back a PNG data: URL. Colors come from the live theme's --state-*
 * tokens (read off <body>), so the badge tracks the current palette. If the base
 * icon fails to load (asset route not live), a theme-colored tile stands in so
 * the dot still shows. Best-effort: never throws into the caller.
 */
export function renderBadgedFavicon(
  kind: Exclude<FaviconKind, "">,
  done: (dataUrl: string) => void,
): void {
  if (typeof document === "undefined") return;
  const size = 64,
    r = 13,
    cx = size - r - 3,
    cy = r + 3;
  const css = getComputedStyle(document.body);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const drawBadge = (): void => {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    if (kind === "done") {
      ctx.fillStyle = css.getPropertyValue("--state-done").trim() || "#56d364";
      ctx.fill();
      // white tick, stroke scaled to the 13px badge radius
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 3.4;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.45, cy + r * 0.05);
      ctx.lineTo(cx - r * 0.1, cy + r * 0.42);
      ctx.lineTo(cx + r * 0.5, cy - r * 0.35);
      ctx.stroke();
    } else {
      ctx.fillStyle =
        css.getPropertyValue("--state-awaiting").trim() || "#8b5cf6";
      ctx.fill();
    }
    done(canvas.toDataURL("image/png"));
  };
  const img = new Image();
  img.onload = () => {
    ctx.drawImage(img, 0, 0, size, size);
    drawBadge();
  };
  img.onerror = () => {
    ctx.fillStyle = css.getPropertyValue("--bg-page").trim() || "#0d1117";
    ctx.fillRect(0, 0, size, size);
    drawBadge();
  };
  img.src = FAVICON_HREF;
}

/**
 * Owns the `link[rel=icon]` element and swaps its href to a badged data: URL for
 * the current kind, restoring the plain icon on "". Renders each kind once and
 * caches it (the same amber dot is reused every time). `apply` is idempotent —
 * a no-op when the kind is unchanged — so it is safe to call from a poll.
 */
export interface FaviconBadger {
  apply(kind: FaviconKind): void;
}

export function createFaviconBadger(
  link: HTMLLinkElement | null = typeof document !== "undefined"
    ? document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    : null,
): FaviconBadger {
  let current: FaviconKind = "";
  const cache: Partial<Record<Exclude<FaviconKind, "">, string>> = {};
  const pending: Partial<Record<Exclude<FaviconKind, "">, boolean>> = {};

  function apply(kind: FaviconKind): void {
    if (!link) return;
    if (kind === current) return;
    current = kind;
    if (!kind) {
      link.href = FAVICON_HREF;
      return;
    }
    const cached = cache[kind];
    if (cached) {
      link.href = cached;
      return;
    }
    if (pending[kind]) return; // applied when the in-flight render lands
    pending[kind] = true;
    renderBadgedFavicon(kind, (url) => {
      pending[kind] = false;
      cache[kind] = url;
      if (current === kind) link.href = url;
    });
  }

  return { apply };
}
