/**
 * The pure half of the public-link visitor page
 * (docs/plans/2026-10-06-public-links-design.md).
 *
 * A link is `/s/#<token>`. The token rides in the fragment so no request line
 * and no access log ever holds it; the page reads it, moves it into
 * sessionStorage, takes it off the address bar, and trades it at
 * `/s/api/link/redeem` for a single-use ticket each time it connects.
 */

/** 16 random bytes, base64url without padding (tmux-api linkTokenRe). */
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
/** 24 random bytes, base64url without padding (tmux-api ticketRe). */
const TICKET_RE = /^[A-Za-z0-9_-]{32}$/;

export const TOKEN_KEY = "tl:link-token";
export const REDEEM_URL = "/s/api/link/redeem";

export type LinkMode = "ro" | "rw";

/** The token from a location hash, or "" when there is none worth sending. */
export function tokenFromHash(hash: string): string {
  const t = hash.startsWith("#") ? hash.slice(1) : hash;
  return TOKEN_RE.test(t) ? t : "";
}

/**
 * Where the token comes from on this load: the fragment the visitor opened, or
 * the copy this tab kept after taking the fragment off the address bar, so a
 * reload still works without the token sitting in history.
 */
export function pickToken(hash: string, stored: string | null): string {
  return tokenFromHash(hash) || (stored && TOKEN_RE.test(stored) ? stored : "");
}

/**
 * Which link server a mode attaches through. ttyd-link-ro takes no input at
 * all and serves /s; ttyd-link-rw serves /s/rw. tmux-api refuses a ticket on
 * the wrong one, so this is not a choice the page gets to make freely.
 */
export function baseFor(mode: LinkMode): string {
  return mode === "rw" ? "/s/rw" : "/s";
}

/** ttyd's positional args for one attempt: the ticket, and nothing else. */
export function argsFor(ticket: string): string {
  return "arg=" + encodeURIComponent(ticket);
}

export interface Redeemed {
  ticket: string;
  mode: LinkMode;
  title: string;
  expiresAt: number;
  /** The session's window, which a watcher is drawn at. 0 when unknown. */
  cols: number;
  rows: number;
}

/**
 * What a redeem answer means. `ended` is every 404: tmux-api answers the same
 * for a token that never existed, one that expired, one revoked, and one whose
 * session has gone, and the page has nothing more useful to say than that.
 * `retry` is everything else that is not a ticket, which the reconnect ladder
 * should keep trying.
 */
export type RedeemOutcome =
  | { kind: "ok"; value: Redeemed }
  | { kind: "transcript"; value: EndedLink }
  | { kind: "ended" }
  | { kind: "retry" };

/** A link whose session has ended: it shows the conversation read-only. */
export interface EndedLink {
  /** The link's id, which the transcript routes take as `l`. Not a secret. */
  link: string;
  title: string;
  expiresAt: number;
}

const LINK_ID_RE = /^[0-9a-f]{16}$/;

export function readRedeem(status: number, body: unknown, peek = false): RedeemOutcome {
  if (status === 404) return { kind: "ended" };
  if (status !== 200 || typeof body !== "object" || body === null) return { kind: "retry" };
  const b = body as Record<string, unknown>;
  if (b.mode === "transcript") {
    if (typeof b.link !== "string" || !LINK_ID_RE.test(b.link)) return { kind: "retry" };
    return {
      kind: "transcript",
      value: {
        link: b.link,
        title: typeof b.title === "string" ? b.title : "",
        expiresAt: typeof b.expiresAt === "number" ? b.expiresAt : 0,
      },
    };
  }
  const mode = b.mode === "rw" ? "rw" : b.mode === "ro" ? "ro" : null;
  const ticket = typeof b.ticket === "string" ? b.ticket : "";
  // A peek carries no ticket by design; a redeem without a well-formed one is
  // not an answer worth acting on.
  if (mode === null || (!peek && !TICKET_RE.test(ticket))) return { kind: "retry" };
  const dim = (v: unknown): number =>
    typeof v === "number" && Number.isInteger(v) && v > 0 && v < 2000 ? v : 0;
  return {
    kind: "ok",
    value: {
      ticket,
      mode,
      title: typeof b.title === "string" ? b.title : "",
      expiresAt: typeof b.expiresAt === "number" ? b.expiresAt : 0,
      cols: dim(b.cols),
      rows: dim(b.rows),
    },
  };
}

/**
 * The font size that fits a watcher's whole window across the screen.
 *
 * A read-only visitor never sizes the session's window (tmux ignores a
 * read-only client's size), so the page draws at the window's own size, the
 * way the lobby draws a watching view, and scales the font instead: on a
 * phone that means a small font rather than a window cut off at the right
 * edge. `cellRatio` is one cell's width over the font size, measured from the
 * real face. Clamped to 6..14px: below 6 nothing is legible, and above 14 the
 * page would only be bigger than the lobby's own default.
 */
export function fontToFit(width: number, cols: number, cellRatio: number): number {
  if (cols <= 0 || width <= 0 || cellRatio <= 0) return 14;
  const px = Math.floor((width / cols / cellRatio) * 10) / 10;
  return Math.max(6, Math.min(14, px));
}

/** The badge: what this visitor can do. */
export function badgeFor(mode: LinkMode): string {
  return mode === "rw" ? "Driving" : "Watching";
}

/** The routes an ended link's transcript is read through. `l` is the link id;
 *  the view key rides in a cookie the redeem set, never in the URL. */
export function transcriptRoutes(link: string) {
  const q = "l=" + encodeURIComponent(link);
  return {
    transcript: `/s/api/link/transcript?${q}`,
    result: (toolId: string) => `/s/api/link/result?${q}&tool=${encodeURIComponent(toolId)}`,
    toolImage: (toolId: string, n: number) =>
      `/s/api/link/image?${q}&tool=${encodeURIComponent(toolId)}&n=${n}`,
    promptImage: (record: string, n: number) =>
      `/s/api/link/image?${q}&record=${encodeURIComponent(record)}&n=${n}`,
    picture: (path: string) => `/s/api/link/picture?${q}&p=${encodeURIComponent(path)}`,
  };
}
