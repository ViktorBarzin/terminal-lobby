/**
 * Last-active-wins, the two pieces of it that are not wiring: the vocabulary a
 * claim carries, and the rate limit on the pointer's.
 *
 * The wiring itself is TerminalNative (which moment counts as touched) and
 * SessionView (whether this device may speak for the session at all).
 */

/**
 * WHAT MADE A DEVICE CLAIM THE WINDOW, one word per claim site in the browser.
 *
 * A CLOSED vocabulary, mirroring `gridClaimReasons` in tmux-api/grid_size.go,
 * because the value lands in a telemetry attribute (`session.grid_claimed`,
 * `tl.reason`): an open one there is a series any tab could invent. A word the
 * server does not know is recorded as "unknown" rather than dropped, so the
 * count of claims stays right while the two ends are mid-deploy.
 *
 *   focus         the tab or the terminal took focus
 *   input         a keystroke, a paste, or a pointer move over the terminal
 *   socket-open   a fresh ttyd connection attached
 *   take-control  a watching view switched to driving
 *   fit           the terminal re-fitted to its host and reported a new grid
 *   visible-set   a workspace's visible tiles changed and each re-claimed
 */
export type GridClaimReason =
  | "focus"
  | "input"
  | "socket-open"
  | "take-control"
  | "fit"
  | "visible-set";

/**
 * The rate limit on a grid claim, which is the one piece of last-active-wins
 * that is arithmetic rather than wiring.
 *
 * A device takes the session's tmux window whenever it is touched, and one of
 * the three things that counts as touched is the pointer moving over the
 * terminal. `pointermove` fires at roughly 100 Hz on a desktop mouse — the
 * figure TerminalNative's own drag code measured — so a one-second sweep
 * across a tile is a hundred claims unless something stands in front of it.
 *
 * LEADING EDGE, and that is the whole design. The pointer claim exists so the
 * window comes back the instant you touch the device; a trailing throttle
 * would put a quarter second of lag on exactly the interaction it is there to
 * make feel immediate. So the first move of a sweep passes and the rest of the
 * window is dropped.
 *
 * Its own module, with an injected clock, because a throttle tested through
 * the component needs fake timers, a mounted terminal and a DOM event to say
 * something a six-line unit says better.
 */
export function leadingThrottle(everyMs: number, now: () => number = Date.now): () => boolean {
  // -Infinity rather than 0, so the first call passes whatever the clock's
  // origin is. `Date.now()` at page load is ~1.8e12, which happens to be far
  // past any window, but an injected clock starting at 0 is not.
  let last = -Infinity;
  return (): boolean => {
    const t = now();
    // Measured from the last call that PASSED, never from the last call made:
    // a continuous sweep is a dropped call every 10 ms, and restarting the
    // window on those would mean the pointer never claims again after its
    // first move.
    if (t - last < everyMs) return false;
    last = t;
    return true;
  };
}
