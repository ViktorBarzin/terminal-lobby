/**
 * Public links, the parts that are rules rather than markup
 * (docs/plans/2026-10-06-public-links-design.md). The Share dialog, the
 * Settings page and the session bar all read these, so the three cannot
 * disagree about who may share, what the lifetimes are called, or how a time
 * left is said.
 */
import type { LinkTTL, LinkView, Session } from "../types/lobby";

/** Every lifetime, in the order the form offers them. */
export const LINK_TTLS: readonly LinkTTL[] = ["1h", "24h", "7d", "never"];

/** What the form calls each lifetime. */
export const TTL_LABELS: Record<LinkTTL, string> = {
  "1h": "1 hour",
  "24h": "24 hours",
  "7d": "7 days",
  never: "Until revoked",
};

/**
 * Whether the ⋯ menu offers Share… for a session.
 *
 * Only for your OWN session running Claude (decision 1, ADR-0041): a session
 * shared with you carries `access`, and one owned by somebody else names them
 * in `owner`. Never in a tab acting as another user, whose links would be
 * bearer URLs to their conversations; the server answers 403 there too, so
 * offering it would only ever fail.
 */
export function canShare(
  session: Pick<Session, "owner" | "access" | "tool">,
  me: string,
  actAs: string,
): boolean {
  if (actAs) return false;
  if (session.access) return false;
  // A link shares the conversation, so a session with no Claude in it has
  // nothing to share (ADR-0041); the server refuses it too.
  if (session.tool !== "claude") return false;
  return !session.owner || session.owner === me;
}

/** The session bar's "2 viewing", empty while nobody is. */
export function viewersLabel(n: number | undefined): string {
  return n && n > 0 ? `${n} viewing` : "";
}

/** The URL a link opens: the token rides in the fragment, which browsers never
 *  send to a server (decision 9). */
export function linkUrl(origin: string, token: string): string {
  return `${origin}/s/#${token}`;
}

/**
 * How long a link has left, in words: "expires in 23 h", "until revoked".
 *
 * Under an hour it counts minutes, rounded up so a link with seconds left does
 * not read "0 min". Under two days it counts hours, so a 24h link reads as
 * hours for its whole life; past that, days.
 */
export function expiryLabel(expiresAt: number, nowMs: number): string {
  if (!expiresAt) return "until revoked";
  const secs = expiresAt - Math.floor(nowMs / 1000);
  if (secs <= 0) return "expired";
  if (secs < 3600) return `expires in ${Math.max(1, Math.ceil(secs / 60))} min`;
  const hours = Math.round(secs / 3600);
  if (hours < 48) return `expires in ${hours} h`;
  return `expires in ${Math.round(hours / 24)} d`;
}

/**
 * The links that belong to one session. By tmux's session id first, which is
 * what a link is bound to and what survives a rename; by name when the session
 * list predates the id field.
 */
export function linksForSession(
  links: readonly LinkView[],
  session: Pick<Session, "name" | "id">,
): LinkView[] {
  return links.filter((l) =>
    session.id ? l.sessionId === session.id : l.session === session.name,
  );
}
