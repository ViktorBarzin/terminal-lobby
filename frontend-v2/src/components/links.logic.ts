/**
 * Public links, the parts that are rules rather than markup
 * (docs/plans/2026-10-06-public-links-design.md). The Share dialog, the
 * Settings page and the session bar all read these, so the three cannot
 * disagree about who may share, which lifetimes a mode allows, or how a time
 * left is said.
 */
import type {
  LinkMode,
  LinkTTL,
  LinkView,
  LinkVisitor,
  Session,
  VisitorCount,
} from "../types/lobby";

/** Every lifetime, in the order the form offers them. */
export const LINK_TTLS: readonly LinkTTL[] = ["1h", "24h", "7d", "never"];

/** What the form calls each lifetime. */
export const TTL_LABELS: Record<LinkTTL, string> = {
  "1h": "1 hour",
  "24h": "24 hours",
  "7d": "7 days",
  never: "Until revoked",
};

/** What the form calls each mode. The list and the bar say Watch and Drive. */
export const MODE_CHOICES: Record<LinkMode, string> = {
  ro: "Watch only",
  rw: "Can type",
};

/** The badge a link wears in a list. */
export function modeBadge(mode: LinkMode): string {
  return mode === "rw" ? "Drive" : "Watch";
}

/**
 * Whether a lifetime is on offer for a mode. A read-write link is a shell as
 * you for whoever holds the URL, so the server caps it at 24h (decision 3) and
 * answers 400 to anything longer. The form disables what would be refused
 * rather than letting the server say so.
 */
export function ttlAllowed(mode: LinkMode, ttl: LinkTTL): boolean {
  return mode === "ro" || ttl === "1h" || ttl === "24h";
}

/**
 * The lifetime to keep when the mode changes under it. Switching to "Can type"
 * with "7 days" chosen drops to the longest lifetime that mode allows, rather
 * than leaving a disabled option selected.
 */
export function clampTtl(mode: LinkMode, ttl: LinkTTL): LinkTTL {
  return ttlAllowed(mode, ttl) ? ttl : "24h";
}

/**
 * Whether the ⋯ menu offers Share… for a session.
 *
 * Only for your OWN session (decision 1): a session shared with you carries
 * `access`, and one owned by somebody else names them in `owner`. Never in a
 * tab acting as another user, whose links would be bearer URLs to their shell;
 * the server answers 403 there too, so offering it would only ever fail.
 */
export function canShare(
  session: Pick<Session, "owner" | "access">,
  me: string,
  actAs: string,
): boolean {
  if (actAs) return false;
  if (session.access) return false;
  return !session.owner || session.owner === me;
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

/** One visitor, as a list names them: "guest 1 (driving)". */
export function visitorLabel(v: LinkVisitor): string {
  return v.mode === "rw" ? `guest ${v.guest} (driving)` : `guest ${v.guest}`;
}

/** A link's visitors counted the way the session list counts them. */
export function countVisitors(visitors: readonly LinkVisitor[]): VisitorCount {
  return {
    total: visitors.length,
    driving: visitors.filter((v) => v.mode === "rw").length,
  };
}

/** Settings' one-line count for a link: "2 visitors (1 driving)". Empty when
 *  nobody is attached. */
export function visitorCountLabel(v: VisitorCount): string {
  if (v.total <= 0) return "";
  const n = v.total === 1 ? "1 visitor" : `${v.total} visitors`;
  return v.driving > 0 ? `${n} (${v.driving} driving)` : n;
}

/** The session bar's reading: "2 via link" and, when anyone drives, the
 *  bracketed count. Empty when nobody is attached through a link. */
export function visitorSummary(v: VisitorCount | undefined): {
  text: string;
  driving: string;
} {
  if (!v || v.total <= 0) return { text: "", driving: "" };
  return { text: `${v.total} via link`, driving: v.driving > 0 ? `(${v.driving} driving)` : "" };
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
