/**
 * The pure half of the public-link visitor page
 * (docs/plans/2026-10-06-public-links-design.md, ADR-0041).
 *
 * A link is `/s/#<token>`. The token rides in the fragment so no request line
 * and no access log ever holds it; the page reads it, moves it into
 * sessionStorage, takes it off the address bar, and trades it at
 * `/s/api/link/redeem` for a view cookie. Everything after that is a read of
 * the conversation through the link's routes.
 */

/** 16 random bytes, base64url without padding (tmux-api linkTokenRe). */
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const LINK_ID_RE = /^[0-9a-f]{16}$/;

export const TOKEN_KEY = "tl:link-token";
export const REDEEM_URL = "/s/api/link/redeem";

/** How often a live conversation is re-read. */
export const POLL_MS = 3000;

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

/** What a redeem says about the link. */
export interface Redeemed {
  /** The link's id, which the read routes take as `l`. Not a secret. */
  link: string;
  title: string;
  expiresAt: number;
  /** Unix seconds the session ended, 0 while it runs. */
  endedAt: number;
}

/**
 * What a redeem answer means. `gone` is every 404: tmux-api answers the same
 * for a token that never existed, one that expired and one revoked, and the
 * page has nothing more useful to say than that. `retry` is everything else
 * that is not an answer, which the page tries again.
 */
export type RedeemOutcome = { kind: "ok"; value: Redeemed } | { kind: "gone" } | { kind: "retry" };

export function readRedeem(status: number, body: unknown): RedeemOutcome {
  if (status === 404) return { kind: "gone" };
  if (status !== 200 || typeof body !== "object" || body === null) return { kind: "retry" };
  const b = body as Record<string, unknown>;
  if (typeof b.link !== "string" || !LINK_ID_RE.test(b.link)) return { kind: "retry" };
  return {
    kind: "ok",
    value: {
      link: b.link,
      title: typeof b.title === "string" ? b.title : "",
      expiresAt: typeof b.expiresAt === "number" ? b.expiresAt : 0,
      endedAt: typeof b.endedAt === "number" ? b.endedAt : 0,
    },
  };
}

/** The routes a link's conversation is read through. `l` is the link id;
 *  the view key rides in a cookie the redeem set, never in the URL. */
export function transcriptRoutes(link: string) {
  const q = "l=" + encodeURIComponent(link);
  return {
    transcript: (after: number) =>
      `/s/api/link/transcript?${q}` + (after > 0 ? `&after=${after}` : ""),
    result: (toolId: string) => `/s/api/link/result?${q}&tool=${encodeURIComponent(toolId)}`,
    toolImage: (toolId: string, n: number) =>
      `/s/api/link/image?${q}&tool=${encodeURIComponent(toolId)}&n=${n}`,
    promptImage: (record: string, n: number) =>
      `/s/api/link/image?${q}&record=${encodeURIComponent(record)}&n=${n}`,
    picture: (path: string) => `/s/api/link/picture?${q}&p=${encodeURIComponent(path)}`,
  };
}

/**
 * Fold one transcript answer into what the page holds. A first read (or one
 * after the server lost track, which `after` past its last event shows)
 * replaces everything; a later read appends only events newer than the last
 * one held, so a repeated answer can never draw an event twice.
 */
export function mergeEvents<E extends { id: number }>(held: E[], fresh: E[], after: number): E[] {
  if (after <= 0) return fresh;
  const last = held.length > 0 ? held[held.length - 1]!.id : 0;
  const newer = fresh.filter((e) => e.id > last);
  return newer.length > 0 ? [...held, ...newer] : held;
}
