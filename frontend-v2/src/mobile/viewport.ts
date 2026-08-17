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

/**
 * How much the SHELL must still give up for the soft keyboard, measured rather
 * than assumed. PURE + parameterized for unit testing.
 *
 *   reserve = max(0, shellBottom − (visualViewport.offsetTop + height))
 *
 * `keyboardOffset` above answers "how far off the bottom must a fixed accessory
 * sit", which is right for the soft-key row and the terminal's own bar. This
 * answers a different question: how much of the SHELL the keyboard covers —
 * and the two are not the same number whenever something has already shortened
 * the shell.
 *
 * That "something" varies by platform: iOS Safari leaves the layout viewport
 * alone, Chromium shrinks it (interactive-widget=resizes-content, set in
 * index.html), and the iOS standalone PWA is its own case again. Subtracting a
 * modelled keyboard height from a shell that had already shrunk reserved it
 * TWICE and put the Text composer near the top of the screen with a dead gap
 * above the keyboard (reported 2026-08-17; reproduced at 390x844 with the
 * composer at 9% of the screen and 368px of nothing below it).
 *
 * Measuring where the shell actually ends removes the guess: a shell that
 * already clears the keyboard reserves nothing, whatever put it there.
 */
export function keyboardReserve(
  shellBottom: number,
  vvHeight: number,
  vvOffsetTop: number,
): number {
  return Math.max(0, shellBottom - (vvOffsetTop + vvHeight));
}

export interface ViewportSyncOptions {
  /** Debounced callback after the viewport settles (e.g. re-fit the terminal). */
  onRefit?: () => void;
  /** Debounce window for onRefit (ms). Default 120 (matches the vanilla fit). */
  refitDebounceMs?: number;
  /**
   * The covered height, whenever it CHANGES — for surfaces that cannot measure
   * it themselves.
   *
   * The terminal is an iframe, and an iframe's visualViewport does not move when
   * the keyboard opens: only the top window's does. So the frame cannot see the
   * keyboard, and it has to be told (TerminalView posts it as `tl-kb`).
   *
   * On CHANGE rather than on every event: the keyboard animates over ~250ms and
   * fires resize/scroll throughout, and each post makes the frame re-fit and
   * tmux resize.
   */
  onKeyboard?: (px: number) => void;
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
  // The last height published to onKeyboard. -1 rather than 0 so the seeding
  // write always reports once, telling the frame where it stands before the
  // first keyboard ever opens.
  let lastKb = -1;

  /**
   * Record the real geometry when the keyboard opens or closes.
   *
   * TEMPORARY, and deliberately so. Two attempts at the mobile keyboard layout
   * were reasoned from a model of the device rather than from the device, and
   * both were wrong — iOS Safari, Chromium and the iOS standalone PWA each
   * reserve the keyboard differently, and the repo's own iOS notes say to
   * measure on real hardware rather than conclude. This rides the flight
   * recorder (ADR-0008 diag.incident) so the numbers arrive without anyone
   * having to read them off a screen.
   *
   * Fires only on a CHANGE of the keyboard state, so a keyboard's ~250ms
   * animation contributes one record per edge rather than a burst. Remove once
   * the layout is settled.
   */
  const measureSafeAreaBottom = (): number => {
    try {
      const probe = document.createElement("div");
      probe.style.cssText =
        "position:fixed;left:0;bottom:0;width:0;visibility:hidden;pointer-events:none;" +
        "height:env(safe-area-inset-bottom)";
      document.body.appendChild(probe);
      const h = Math.round(probe.getBoundingClientRect().height);
      probe.remove();
      return h;
    } catch {
      return -1;
    }
  };

  let lastReported = -1;
  const reportGeometry = (kb: number): void => {
    if (kb === lastReported) return;
    lastReported = kb;
    try {
      const diag = (window as unknown as {
        __TL_DIAG__?: { incident?: (kind: string, attrs: Record<string, unknown>) => void };
      }).__TL_DIAG__;
      if (!diag?.incident) return;
      const box = (sel: string): number[] => {
        const el = document.querySelector(sel);
        if (!el) return [];
        const r = el.getBoundingClientRect();
        return [Math.round(r.top), Math.round(r.bottom)];
      };
      const cs = getComputedStyle(document.documentElement);
      const px = (n: string): string => cs.getPropertyValue(n).trim();
      diag.incident("viewport", {
        "tl.vp.inner_h": window.innerHeight,
        "tl.vp.screen_h": typeof screen !== "undefined" ? screen.height : 0,
        "tl.vp.vv_h": vv ? Math.round(vv.height) : -1,
        "tl.vp.vv_top": vv ? Math.round(vv.offsetTop) : -1,
        "tl.vp.vv_scale": vv ? vv.scale : -1,
        "tl.vp.root": box("#root").join(","),
        "tl.vp.views": box(".tl-views").join(","),
        "tl.vp.composer": box(".tl-composer").join(","),
        "tl.vp.softkeys": box("#soft-keys").join(","),
        "tl.vp.kb_offset": px("--kb-offset"),
        "tl.vp.kb_reserve": px("--kb-reserve"),
        "tl.vp.sk_h": px("--sk-h"),
        "tl.vp.app_vh": px("--app-vh"),
        // env(safe-area-inset-bottom) cannot be read from JS, so measure a
        // throwaway element sized by it. It matters here because the
        // reservation adds it on top of the keyboard, and whether iOS keeps
        // reporting an inset while the keyboard covers the home indicator is
        // exactly the sort of thing worth measuring rather than assuming.
        "tl.vp.safe_b": measureSafeAreaBottom(),
        "tl.vp.standalone":
          typeof matchMedia === "function" &&
          matchMedia("(display-mode: standalone)").matches,
        "tl.vp.kb_inline": !!document.querySelector(".tl-views.tl-kb-inline"),
      });
    } catch {
      /* a diagnostic must never be the thing that breaks the app */
    }
  };

  const writeOffset = (): void => {
    const h = vv ? vv.height : window.innerHeight;
    const top = vv ? vv.offsetTop : 0;
    const kb = keyboardOffset(window.innerHeight, h, top);
    const root = document.documentElement.style;
    root.setProperty("--kb-offset", kb + "px");
    // --kb-reserve: how much of the SHELL the keyboard covers, measured off the
    // shell's real box rather than derived from innerHeight. Distinct from
    // --kb-offset, which positions FIXED accessories — see keyboardReserve.
    // Falls back to --kb-offset's answer when there is no shell to measure
    // (a test, or a mount before the element exists), which is the historic
    // behaviour.
    const shell = document.getElementById("root");
    root.setProperty(
      "--kb-reserve",
      (shell ? keyboardReserve(shell.getBoundingClientRect().bottom, h, top) : kb) + "px",
    );
    if (kb !== lastKb) {
      lastKb = kb;
      opts.onKeyboard?.(kb);
    }
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
    reportGeometry(kb);
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
