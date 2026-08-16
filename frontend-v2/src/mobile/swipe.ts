/**
 * Horizontal swipe between sessions, for the phone layout where switching
 * otherwise means a round trip: back to the list, find the session, tap it.
 *
 * The gesture has to coexist with everything else that scrolls horizontally in
 * a session — a wide diff, a code block, the terminal itself — so it only
 * claims a drag that is clearly sideways, clearly long enough, and did not
 * start inside something that scrolls sideways itself.
 */

/** Minimum horizontal travel before a drag counts as a swipe. */
export const SWIPE_MIN_PX = 64;

/** How much more horizontal than vertical the drag must be. */
export const SWIPE_RATIO = 1.8;

/** Longer than this and it is a considered drag, not a flick. */
export const SWIPE_MAX_MS = 700;

export interface SwipeSample {
  dx: number;
  dy: number;
  ms: number;
}

/** Which way a completed drag swiped, if it swiped at all. PURE. */
export function swipeDirection(s: SwipeSample): "prev" | "next" | null {
  if (s.ms > SWIPE_MAX_MS) return null;
  const ax = Math.abs(s.dx);
  const ay = Math.abs(s.dy);
  if (ax < SWIPE_MIN_PX) return null;
  if (ax < ay * SWIPE_RATIO) return null;
  // Dragging leftward moves forward through the list, as a carousel does.
  return s.dx < 0 ? "next" : "prev";
}

/** True when the element or an ancestor can scroll sideways itself. */
function insideHorizontalScroller(target: EventTarget | null, root: HTMLElement): boolean {
  let el = target instanceof HTMLElement ? target : null;
  while (el && el !== root) {
    if (el.scrollWidth > el.clientWidth + 4) {
      const overflow = getComputedStyle(el).overflowX;
      if (overflow === "auto" || overflow === "scroll") return true;
    }
    el = el.parentElement;
  }
  return false;
}

export interface SwipeOptions {
  onSwipe: (direction: "prev" | "next") => void;
  /** Ignore gestures while this returns false (e.g. on a desktop). */
  enabled?: () => boolean;
}

/**
 * Watch `root` for a session-switching swipe. Returns a cleanup.
 *
 * Pointer events rather than touch events so a stylus works too; the terminal
 * iframe swallows its own pointers, which is correct — a swipe over the pty is
 * for the pty.
 */
export function installSwipe(root: HTMLElement, opts: SwipeOptions): () => void {
  let startX = 0;
  let startY = 0;
  let startAt = 0;
  let tracking = false;

  const down = (e: PointerEvent) => {
    if (e.pointerType === "mouse") return;
    if (opts.enabled && !opts.enabled()) return;
    if (insideHorizontalScroller(e.target, root)) return;
    tracking = true;
    startX = e.clientX;
    startY = e.clientY;
    startAt = Date.now();
  };

  const up = (e: PointerEvent) => {
    if (!tracking) return;
    tracking = false;
    const dir = swipeDirection({
      dx: e.clientX - startX,
      dy: e.clientY - startY,
      ms: Date.now() - startAt,
    });
    if (dir) opts.onSwipe(dir);
  };

  const cancel = () => {
    tracking = false;
  };

  root.addEventListener("pointerdown", down, { passive: true });
  root.addEventListener("pointerup", up, { passive: true });
  root.addEventListener("pointercancel", cancel, { passive: true });
  return () => {
    root.removeEventListener("pointerdown", down);
    root.removeEventListener("pointerup", up);
    root.removeEventListener("pointercancel", cancel);
  };
}
