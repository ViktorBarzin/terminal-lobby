/**
 * Keep the focused text field visible while the soft keyboard is up.
 *
 * THE PROBLEM. The lobby's list screen scrolls inside `.tl-sidebar-scroll`,
 * and three of its boxes are created at the moment they are focused: a
 * project's "new session" input (appended at the END of that group), a card's
 * rename box, and the "+ Project" box. On a phone the soft keyboard then takes
 * the bottom third of the screen. Measured at 390x844 with a project whose
 * sessions run past the fold: the input landed at y=543-583 while an iPhone
 * keyboard covers everything below y=508 — 75px under it, so the field being
 * typed into was off screen.
 *
 * The browser's own "scroll the focused element into view" cannot fix that on
 * its own. It runs once, at focus time, against the geometry BEFORE the
 * keyboard has opened, and it aims for the scroll container's box — which on
 * iOS Safari still extends under the keyboard, because iOS shrinks only the
 * visual viewport and the layout is unchanged. iOS's fallback of panning the
 * whole document is undone deliberately by viewport.ts's `unpin()` (the shell
 * is a fixed-height, non-scrolling surface; a document offset there is the
 * platform moving the app off screen, which is a worse bug).
 *
 * SO TWO THINGS HAVE TO BE TRUE, and this module is the second:
 *   1. the scroll container's box must END above the keyboard — the phone
 *      layout reserves `--kb-offset` on `.tl-sidebar` (sidebar.css);
 *   2. the field must be re-revealed AFTER the geometry settles, which is what
 *      happens here. The keyboard animates over ~250ms and fires a burst of
 *      viewport events throughout, and the reveal that matters is the last one.
 *
 * `block: "nearest"` throughout: the field is brought just inside the
 * scrollport and no further, so a list the reader had positioned deliberately
 * moves by the minimum.
 */

/** Fields worth revealing. A checkbox or a button takes focus without ever
 *  raising a keyboard, and scrolling the list under one would be noise. */
function isTypable(el: Element | null): el is HTMLElement {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  if (!(el instanceof HTMLInputElement)) return false;
  return !["checkbox", "radio", "button", "submit", "reset", "range", "file"].includes(
    el.type,
  );
}

export interface FocusRevealOptions {
  /** Test seam: the viewport whose changes re-trigger a reveal. */
  visualViewport?: VisualViewport | null;
  /** How long after the last viewport event to take the settled reading (ms).
   *  Matches viewport.ts's own settle window — the same animation. */
  settleMs?: number;
}

/**
 * Reveal the focused field on focus, on every viewport change while it holds
 * focus, and once more when those stop. Returns a cleanup.
 *
 * Idempotent by construction: `scrollIntoView({block:"nearest"})` on an element
 * already inside the scrollport scrolls nothing, so the burst of events during
 * the keyboard animation costs a no-op each.
 */
export function installFocusReveal(opts: FocusRevealOptions = {}): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }
  const vv = opts.visualViewport !== undefined ? opts.visualViewport : window.visualViewport;
  const settleMs = opts.settleMs ?? 350;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  const reveal = (): void => {
    const el = document.activeElement;
    if (!isTypable(el)) return;
    // A field can be unmounted between the event and this call (committing a
    // rename removes the box); scrollIntoView on a detached node does nothing,
    // but isConnected says so without relying on that.
    if (!el.isConnected) return;
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  const onViewportChange = (): void => {
    reveal();
    // ...and again once the events STOP. The keyboard is still animating while
    // they fire, so the reading taken mid-flight is of a geometry that no
    // longer holds by the time the reader looks.
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = undefined;
      reveal();
    }, settleMs);
  };

  // On focus as well as on the viewport change: a field focused while the
  // keyboard is ALREADY up (tabbing from one box to the next) raises no
  // viewport event at all, so there would be nothing to react to.
  document.addEventListener("focusin", onViewportChange);
  window.addEventListener("resize", onViewportChange);
  vv?.addEventListener("resize", onViewportChange);
  vv?.addEventListener("scroll", onViewportChange);

  return () => {
    document.removeEventListener("focusin", onViewportChange);
    window.removeEventListener("resize", onViewportChange);
    vv?.removeEventListener("resize", onViewportChange);
    vv?.removeEventListener("scroll", onViewportChange);
    if (settleTimer) clearTimeout(settleTimer);
  };
}
