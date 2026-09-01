/**
 * Coarse-pointer detection — the single gate for every mobile-only affordance
 * (the soft-key toolbar, the mobile compose bar, the keyboard-offset plumbing).
 * Mirrors the vanilla frontend's `isCoarsePointer` (a `(pointer: coarse)`
 * matchMedia), exposed both as a one-shot boolean and as a Solid signal that
 * tracks live changes (a 2-in-1 device flipping between touch and trackpad, or a
 * desktop devtools device-emulation toggle).
 */

import { createSignal, onCleanup, type Accessor } from "solid-js";

const COARSE_QUERY = "(pointer: coarse)";

/**
 * Is there a pointing device here that can do a precise drag?
 *
 * ANY-pointer, deliberately, not `pointer`. `(pointer: coarse)` describes only
 * the PRIMARY input, so a touchscreen laptop, a 2-in-1 or a Chromebook reports
 * coarse even while the person is using a mouse. Gating native drag-and-drop on
 * `!coarse` left those machines with nothing: HTML5 drag was never armed, and
 * the touch path ignores `pointerType === "mouse"`, so neither ran and dragging
 * a session did nothing at all (reported 2026-09-01, reproduced with a
 * desktop-sized window that also advertises a touchscreen).
 *
 * `(any-pointer: fine)` asks the question that actually matters — is a mouse,
 * trackpad or stylus available — and a phone still answers no, so it keeps the
 * touch path.
 */
const FINE_QUERY = "(any-pointer: fine)";

/**
 * The PHONE query — one view at a time (the vanilla two-view flip).
 *
 * Deliberately narrower than `(pointer: coarse)` and narrower than a width
 * alone, because both of those regress a real case that works today:
 *  - width alone would flip a fine-pointer desktop window someone SHRANK on
 *    purpose to watch a session beside the list; a mouse is fine with the
 *    stacked layout, and hiding half of it there is a downgrade.
 *  - coarse alone would flip a tablet, measured healthy at 768x1024 (a 260px
 *    list with every card visible AND a terminal filling 87% of the height).
 * The max-height clause catches a phone in LANDSCAPE (844x390), which is too
 * wide for the width clause but has even less room for two panes.
 *
 * Ergonomics (40px targets, 16px inputs, touch-visible row actions) are NOT
 * gated on this — a finger is a finger at 768px, so those live under the plain
 * coarse query and the tablet gets them too.
 */
export const FLIP_QUERY =
  "(pointer: coarse) and ((max-width: 720px) or (max-height: 480px))";

/** SSR-safe one-shot media-query read. */
function matches(query: string): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

/** A media query as a Solid signal, cleaning its listener up with the owner. */
function watchQuery(query: string): Accessor<boolean> {
  const [on, setOn] = createSignal(matches(query));
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    try {
      const mq = window.matchMedia(query);
      const onChange = (e: MediaQueryListEvent) => setOn(e.matches);
      // addEventListener is the modern API; older Safari only has addListener.
      if (typeof mq.addEventListener === "function") {
        mq.addEventListener("change", onChange);
        onCleanup(() => mq.removeEventListener("change", onChange));
      } else if (typeof mq.addListener === "function") {
        mq.addListener(onChange);
        onCleanup(() => mq.removeListener(onChange));
      }
    } catch {
      /* no listener support — stays at the boot value */
    }
  }
  return on;
}

/** One-shot: is the primary pointer coarse (touch) right now? SSR-safe (false). */
export function isCoarsePointer(): boolean {
  return matches(COARSE_QUERY);
}

/** One-shot: is this a phone-shaped viewport (see FLIP_QUERY)? */
export function isMobileFlip(): boolean {
  return matches(FLIP_QUERY);
}

/**
 * Reactive phone-layout accessor. Rotating a phone crosses this query, so it
 * must be live rather than read once at boot.
 */
export function createMobileFlip(): Accessor<boolean> {
  return watchQuery(FLIP_QUERY);
}

/**
 * Reactive coarse-pointer accessor that re-fires when the media query flips.
 * Registers its listener on the current owner and cleans up on dispose.
 */
/**
 * True when a fine pointer exists. Defaults to TRUE where matchMedia is absent:
 * a machine that cannot answer is far more likely to be a desktop, and the cost
 * of being wrong is a draggable attribute nothing uses, rather than a drag that
 * silently does nothing.
 */
export function hasFinePointer(): boolean {
  return typeof matchMedia !== "function" || matchMedia(FINE_QUERY).matches;
}

export function createCoarsePointer(): Accessor<boolean> {
  return watchQuery(COARSE_QUERY);
}
