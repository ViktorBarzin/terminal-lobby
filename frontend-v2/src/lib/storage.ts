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
