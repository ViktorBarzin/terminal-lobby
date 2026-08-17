/**
 * Mobile viewport / soft-keyboard plumbing, ported from the vanilla
 * frontend/index.html `syncViewport` + `refit` (~12365-12438).
 *
 * iOS Safari does NOT shrink the layout viewport when the soft keyboard rises —
 * only `window.visualViewport` reflects it — so a `height:100%` surface renders
 * its bottom rows (the prompt / compose bar) behind the keyboard. We publish the
 * covered height as the CSS custom property `--kb-offset` on <html>; fixed-bottom
 * accessories (the soft-key toolbar, the compose bar) sit at
 * `bottom: calc(var(--kb-offset) + env(safe-area-inset-bottom))` so they ride
 * just above the keyboard. On Chromium `interactive-widget=resizes-content`
 * (viewport meta) additionally shrinks the layout viewport, so `--kb-offset`
 * settles near 0 there and the two mechanisms compose.
 *
 * The keyboard animates over ~250ms and fires a burst of resize/scroll events,
 * so the actual `onRefit` (which may drive a terminal re-fit) is debounced while
 * the fast `--kb-offset` write is rAF-coalesced.
 */

/**
 * Pixels of the layout viewport currently covered at the bottom (the soft
 * keyboard). PURE + parameterized for unit testing.
 *   kb = max(0, innerHeight − visualViewport.height − visualViewport.offsetTop)
 */
export function keyboardOffset(
  innerHeight: number,
  vvHeight: number,
  vvOffsetTop: number,
): number {
  return Math.max(0, innerHeight - vvHeight - vvOffsetTop);
}

export interface ViewportSyncOptions {
  /** Debounced callback after the viewport settles (e.g. re-fit the terminal). */
  onRefit?: () => void;
  /** Debounce window for onRefit (ms). Default 120 (matches the vanilla fit). */
  refitDebounceMs?: number;
}

/**
 * Wire the viewport listeners and start publishing `--kb-offset`. Returns a
 * cleanup that removes every listener and cancels pending timers. No-op (returns
 * a no-op cleanup) when there is no DOM / no visualViewport.
 */
export function installViewportSync(opts: ViewportSyncOptions = {}): () => void {
  const noop = () => {};
  if (typeof window === "undefined" || typeof document === "undefined") {
    return noop;
  }
  const vv = window.visualViewport ?? null;
  const refitDebounceMs = opts.refitDebounceMs ?? 120;

  let rafScheduled = false;
  let rafHandle = 0;
  let fitTimer: ReturnType<typeof setTimeout> | undefined;

  const writeOffset = (): void => {
    const h = vv ? vv.height : window.innerHeight;
    const top = vv ? vv.offsetTop : 0;
    const kb = keyboardOffset(window.innerHeight, h, top);
    const root = document.documentElement.style;
    root.setProperty("--kb-offset", kb + "px");
    // Publish the live soft-key toolbar height so the surface above it can
    // reserve the exact space (a hidden toolbar reads 0 → the surface reclaims
    // it). Mirrors the vanilla syncViewport --sk-h write.
    const tb = document.getElementById("soft-keys");
    root.setProperty("--sk-h", (tb ? tb.offsetHeight : 0) + "px");
    // --app-vh: the shell's height once a phone shows ONE pane full-screen.
    // window.innerHeight, deliberately — NOT visualViewport.height and NOT a
    // CSS viewport unit:
    //  - vh/svh/dvh resolve to the LARGE viewport in an iOS standalone PWA, so
    //    the pane renders taller than the screen and its footer is clipped
    //    (the vanilla page measured 681px rendered against a 641px window);
    //  - visualViewport.height SHRINKS with the soft keyboard, which would
    //    resize the whole session list every time a rename box took focus.
    root.setProperty("--app-vh", window.innerHeight + "px");
  };

  const sync = (): void => {
    if (!rafScheduled) {
      rafScheduled = true;
      const run = () => {
        rafScheduled = false;
        writeOffset();
      };
      if (typeof requestAnimationFrame === "function") rafHandle = requestAnimationFrame(run);
      else run();
    }
    if (opts.onRefit) {
      if (fitTimer) clearTimeout(fitTimer);
      fitTimer = setTimeout(() => {
        fitTimer = undefined;
        opts.onRefit?.();
      }, refitDebounceMs);
    }
  };

  window.addEventListener("resize", sync);
  window.addEventListener("orientationchange", sync);
  if (vv) {
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
  }
  // Seed once so accessories are positioned before the first event fires.
  writeOffset();

  return () => {
    window.removeEventListener("resize", sync);
    window.removeEventListener("orientationchange", sync);
    if (vv) {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
    }
    if (fitTimer) clearTimeout(fitTimer);
    // Cancel the pending frame too. Without this a sync() scheduled just before
    // teardown still runs afterwards and writes --sk-h / --kb-offset for a
    // surface that no longer exists — measuring a soft-key row that is gone and
    // publishing 0px. It also made the test suite order-dependent: a stray
    // frame from one file's unmounted SessionView overwrote the value another
    // file's test had just asserted.
    if (rafHandle && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(rafHandle);
    }
    rafScheduled = false;
  };
}
