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
 * The user this tab is a LENS on, or "" when it is an ordinary tab.
 *
 * ONE ANSWER FOR THE WHOLE TAB, and two things read it. It decides that a
 * session opens WATCHING here rather than by the automatic driven/not-driven
 * rule — you came to look at someone else's account, so watching is the state
 * to arrive in, on every session including one a third party shared with the
 * target read-write. And it namespaces the stored Watch choice, so *take
 * control* on bob's `code` is remembered against bob's `code` and never against
 * your own session of that name (store/watchmode.ts).
 *
 * A DEFAULT, NOT A LOCK (2026-08-21). The control still works: taking control
 * re-attaches read-write and the pty controls come back with it, because
 * helping with what you are looking at should not mean leaving the lobby for
 * `sudo -u <user> tmux attach`. The server's ceiling is unchanged — it already
 * answered `rw` for an act-as attach that did not ask to watch — and the
 * compensating control is the audit line, which names the mode each attach
 * resolved to and says `DRIVING (read-write)` in words.
 *
 * Read from the SERVER's answer, not from `?as=` alone — acting as YOURSELF is
 * not a switch, and only the server can tell the two apart (`realUser` is
 * present only when the identity actually changed). Until that answer arrives
 * this assumes the switch took: the first attach happens early, and a lens that
 * comes up watching costs a click, while one that comes up driving is what the
 * watching default exists to prevent.
 */
export function lensTarget(
  whoami: Whoami | null | undefined,
  actAs: string,
): string {
  if (!actAs) return "";
  if (!whoami) return actAs;
  return whoami.realUser ? actAs : "";
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
 * under bob, where the attach path then created it.
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
