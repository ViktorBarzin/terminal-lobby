/**
 * Switching identity is a NAVIGATION, not a state change.
 *
 * `?as=` is read once at module load by every URL builder in config.ts, and
 * half a dozen stores have already cached the caller's sessions, layout,
 * projects and prefs by the time Settings opens. Re-deriving all of that in
 * place would mean invalidating each of them in the right order; a full load
 * re-fetches everything under the new identity with no such choreography, and
 * leaves the tab's identity where it can be seen — in the address bar.
 */

import type { Whoami } from "../types/lobby";

/**
 * Whether this tab may only WATCH the sessions it opens: it is acting as
 * someone else, so it borrows their view and never their keyboard.
 *
 * ONE RULE FOR EVERY ATTACH in the tab, including a session a third party
 * shared with the target read-write: that grant is theirs, not yours, so "can I
 * type here" never depends on which row was clicked.
 *
 * Read from the SERVER's answer, not from `?as=` — acting as YOURSELF is not a
 * switch and must stay drivable, and only the server can tell the two apart
 * (`realUser` is present only when the identity actually changed). Until that
 * answer arrives the lock HOLDS: the first attach happens early, and coming up
 * watching costs a click, while coming up driving is what this exists to
 * prevent.
 *
 * Note what this is NOT: the ceiling is the server's, and it still answers `rw`
 * for an act-as attach that does not ask to watch. This is the tab declining
 * access it holds — an accident guard, not a privilege boundary. Taking control
 * means leaving the lens.
 */
export function watchLockedFor(
  whoami: Whoami | null | undefined,
  actAs: string,
): boolean {
  if (!actAs) return false;
  if (!whoami) return true;
  return !!whoami.realUser;
}

/**
 * The URL to navigate to in order to act as `target` ("" = back to yourself).
 *
 * Takes the current URL and returns the switched one, preserving other query
 * parameters (`?api=`, `?terminal=` — a canary or a remote devvm stays pointed
 * where it was) and dropping everything that names a session.
 *
 * BOTH the hash and `?session=` are dropped, because `readInitialSelection`
 * reads them as one thing: they refer to a session in the identity you are
 * LEAVING, and carrying one across asks the new lobby to open a session that is
 * very likely not there. On 2026-08-17 a surviving `?session=` did exactly that
 * — the switched page opened wizard's `Council-tax` one second after the switch,
 * under emo, where the attach path then created it.
 */
export function actAsUrl(currentUrl: string, target: string): string {
  const u = new URL(currentUrl, "http://localhost");
  if (target) {
    u.searchParams.set("as", target);
  } else {
    u.searchParams.delete("as");
  }
  u.searchParams.delete("session");
  u.hash = "";
  // Relative form, so this works the same against a real origin and a test one.
  return u.pathname + u.search;
}
