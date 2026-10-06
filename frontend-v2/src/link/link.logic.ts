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
  | { kind: "ended" }
  | { kind: "retry" };

export function readRedeem(status: number, body: unknown): RedeemOutcome {
  if (status === 404) return { kind: "ended" };
  if (status !== 200 || typeof body !== "object" || body === null) return { kind: "retry" };
  const b = body as Record<string, unknown>;
  const mode = b.mode === "rw" ? "rw" : b.mode === "ro" ? "ro" : null;
  if (typeof b.ticket !== "string" || !TICKET_RE.test(b.ticket) || mode === null) {
    return { kind: "retry" };
  }
  return {
    kind: "ok",
    value: {
      ticket: b.ticket,
      mode,
      title: typeof b.title === "string" ? b.title : "",
      expiresAt: typeof b.expiresAt === "number" ? b.expiresAt : 0,
    },
  };
}

/** The badge: what this visitor can do. */
export function badgeFor(mode: LinkMode): string {
  return mode === "rw" ? "Driving" : "Watching";
}
