/**
 * The one answer to "can this device remember anything".
 *
 * Four modules had grown their own copy of the same two lines, and a copy is
 * where a divergence hides: a browser that throws on the `localStorage` getter
 * (Safari with cookies blocked, a partitioned third-party frame, a sandboxed
 * iframe) has to be caught, not tested for, because reading the property is
 * itself the thing that throws.
 */

/** What this app actually asks of a Storage. Narrower than `Storage`, so a test
 *  can hand in a three-method fake without standing up a whole Web Storage. */
export type MinStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** `localStorage`, or null where it is absent or blocked. Callers treat null as
 *  "this page life is all the memory there is" and degrade rather than fail. */
export function localStorageOrNull(): MinStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * `sessionStorage`, or null where it is absent or blocked. The per-TAB store:
 * what it holds survives a reload (including the one deploy/healer.ts performs
 * when a new build lands) and dies with the tab, which is the lifetime a
 * per-tab undo stack wants (store/undo.ts).
 *
 * Caught rather than tested for, same as above and for the same reason: in a
 * sandboxed iframe, reading the property is itself what throws.
 *
 * No `ssGet`/`ssSet` pair beside `lsGet`/`lsSet` below. Both callers of per-tab
 * storage take their Storage as an injected option instead, so their tests can
 * hand in a Map-backed fake with no DOM at all, and a key-at-a-time pair here
 * would have nobody to call it. A second unused copy of those four lines is the
 * divergence this file exists to prevent.
 */
export function sessionStorageOrNull(): MinStorage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Read one string, or null where the key is unset, the store is absent or the
 * store refuses. Deliberately without a default parameter: the fallback differs
 * per caller (a font size, a theme name, an empty Set), and a default here would
 * quietly turn "nothing stored" and "storage blocked" into the same answer for
 * callers that want to tell them apart.
 */
export function lsGet(key: string): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

/**
 * Write one string, or remove the key when `val` is null. A refused write costs
 * the preference for this page life and nothing else, so it is swallowed rather
 * than raised: no caller in this app has anything useful to do about a private
 * window or a full quota.
 */
export function lsSet(key: string, val: string | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (val === null) localStorage.removeItem(key);
    else localStorage.setItem(key, val);
  } catch {
    /* private mode / quota / blocked store */
  }
}
