/**
 * Which session the installed app should reopen on.
 *
 * A killed PWA cold-launches at start_url `/`, and iOS does not reliably
 * restore the `#session` hash it was last showing, so the app booted with
 * nothing selected, which is the new-session composer. Viktor, 2026-10-01:
 * "every time I open it I go to the composer view instead".
 *
 * So the device remembers the session on screen, and a launch that arrives
 * with no session in its URL reattaches it. The marker is device-LOCAL, not a
 * roamed pref: a phone's last session must not follow you to the desktop. It is
 * cleared when you leave a session for the composer, so a deliberate "new
 * session" is what the next launch shows.
 *
 * Reopening waits for the first session list, because attaching to a name is
 * what creates a session: reopening one that was killed elsewhere would bring
 * it back as an empty shell.
 */
import { NAME_RE } from "../types/lobby";

export const LAST_SESSION_KEY = "tl:last-session:v1";

type Reader = Pick<Storage, "getItem">;
type Writer = Pick<Storage, "setItem" | "removeItem">;

const local = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

export function readLastSession(storage: Reader | null = local()): string | null {
  try {
    const v = storage?.getItem(LAST_SESSION_KEY) ?? null;
    return v !== null && NAME_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Remember `name`, or forget with null. Best effort: storage may be blocked. */
export function writeLastSession(name: string | null, storage: Writer | null = local()): void {
  try {
    if (name === null) storage?.removeItem(LAST_SESSION_KEY);
    else storage?.setItem(LAST_SESSION_KEY, name);
  } catch {
    /* private mode or blocked site data: the app still opens, on the composer */
  }
}

/** Running as the installed app rather than a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true || nav.standalone === true
  );
}

export interface ReopenInput {
  /** The marker read at boot, before anything could overwrite it. */
  remembered: string | null;
  /** The launch URL already named a session (hash or `?session=`). */
  urlSelected: boolean;
  standalone: boolean;
  /** Acting as another user (`?as=`): their sessions, not this device's. */
  lens: boolean;
  /** The caller's own live session names, from the first successful list. */
  live: readonly string[];
}

/** Is this launch one that should reopen, before the session list is known? */
export function wantsReopen(i: Omit<ReopenInput, "live">): boolean {
  return !i.urlSelected && i.standalone && !i.lens && i.remembered !== null;
}

export function pickReopen(i: ReopenInput): string | null {
  if (!wantsReopen(i) || i.remembered === null) return null;
  return i.live.includes(i.remembered) ? i.remembered : null;
}
