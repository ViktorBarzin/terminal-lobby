/**
 * Prompt requests the page left behind.
 *
 * Found in deployed review round 2 (2026-09-28): a send to a suspended session
 * is held 5-6 s while Claude wakes (store/wake-send.ts). A reload inside that
 * window cut the prompt's request off, the send read that as a refusal, and
 * the composer put the words back and saved them as the draft just before the
 * page went. The server had the prompt already: after the reload Claude had
 * answered it and the same words sat in the field with Send armed to send them
 * twice.
 *
 * A request that fails after the page began to go while it was in flight is
 * one whose outcome this page cannot know, and the server usually has it. The
 * page has begun to go at `beforeunload` or `pagehide`, whichever comes first:
 * Chromium rejects the request right after `beforeunload` and before
 * `pagehide` (measured on a local build, 2026-09-28: 3608 ms, 3619 ms and
 * 3645 ms), and iOS Safari fires no `beforeunload`. A leave the reader
 * cancels from a `beforeunload` prompt still counts, which at worst keeps the
 * words of a send that later fails out of the field. `trackPrompt` counts each such failure and `takeLeftBehind` hands one
 * to the field that would restore its words, which then leaves them out. A send
 * cut off before any prompt request went out, while the session was still
 * waking, counts nothing, so its words come back as before.
 */
let hides = 0;
let leftBehind = 0;

if (typeof window !== "undefined") {
  const going = (): void => {
    hides++;
  };
  window.addEventListener("beforeunload", going);
  window.addEventListener("pagehide", going);
}

/** Watch one prompt request: a failure after the page began to go while it
 *  was in flight counts as left behind. The promise is passed through. */
export function trackPrompt<T>(request: Promise<T>): Promise<T> {
  const at = hides;
  return request.catch((err: unknown) => {
    if (hides > at) leftBehind++;
    throw err;
  });
}

/** True, once, for each prompt request the page left behind. */
export function takeLeftBehind(): boolean {
  if (leftBehind === 0) return false;
  leftBehind--;
  return true;
}
