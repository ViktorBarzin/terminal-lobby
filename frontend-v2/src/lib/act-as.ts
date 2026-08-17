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
