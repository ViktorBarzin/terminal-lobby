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
export function createCoarsePointer(): Accessor<boolean> {
  return watchQuery(COARSE_QUERY);
}

/**
 * Is this a phone or a tablet, as the DRAG LIBRARY understands the question?
 *
 * Deliberately the same test @formkit/drag-and-drop makes internally
 * (`isMobilePlatform`), because the two answers have to agree. The library
 * ignores mouse pointermove unless it thinks it is on a mobile platform, so a
 * machine we call mobile and it does not would be left with a mouse that
 * cannot drag at all. It is not exported, so it is mirrored here — if it ever
 * changes upstream, this is the line that has to follow it.
 *
 * What it decides for us is `nativeDrag` (dnd/sidebar.ts). A desktop needs it
 * ON, because a mouse has no other path. A phone needs it OFF, because the
 * PLATFORM starts a native drag of its own from a long press on a `draggable`
 * element, and that drag then delivers no `dragover` at all — measured on the
 * Android emulator, the event stream was `pointerdown` → `dragstart` →
 * `pointercancel`, the row was marked as picked up, and nothing moved for the
 * rest of the gesture.
 *
 * A media query cannot answer this. `(any-pointer: fine)` reads TRUE on the
 * emulator, which has a host mouse attached, and would have left the phone on
 * the broken path.
 */
export function isMobilePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (uaData) return uaData.mobile === true;
  const ua = navigator.userAgent;
  const isPad = /iPad/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
  return /android|iphone|ipod/i.test(ua) || isPad;
}
