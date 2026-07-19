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

/** One-shot: is the primary pointer coarse (touch) right now? SSR-safe (false). */
export function isCoarsePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  try {
    return window.matchMedia(COARSE_QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * Reactive coarse-pointer accessor that re-fires when the media query flips.
 * Registers its listener on the current owner and cleans up on dispose.
 */
export function createCoarsePointer(): Accessor<boolean> {
  const [coarse, setCoarse] = createSignal(isCoarsePointer());
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    try {
      const mq = window.matchMedia(COARSE_QUERY);
      const onChange = (e: MediaQueryListEvent) => setCoarse(e.matches);
      // addEventListener is the modern API; older Safari only has addListener.
      if (typeof mq.addEventListener === "function") {
        mq.addEventListener("change", onChange);
        onCleanup(() => mq.removeEventListener("change", onChange));
      } else if (typeof mq.addListener === "function") {
        mq.addListener(onChange);
        onCleanup(() => mq.removeListener(onChange));
      }
    } catch {
      /* no matchMedia listener support — stays at the boot value */
    }
  }
  return coarse;
}
