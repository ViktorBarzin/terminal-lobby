import { diag } from "../telemetry/diag";

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
  /** Quiet period before the settle re-measure (ms). Default 350. */
  settleMs?: number;
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
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  // Long enough to outlast the keyboard's ~250ms animation and the burst of
  // events it fires, short enough that a settled layout is not visibly wrong
  // in the meantime.
  const settleMs = opts.settleMs ?? 350;
  // The last height published to onKeyboard. -1 rather than 0 so the seeding
  // write always reports once, telling the frame where it stands before the
  // first keyboard ever opens.
  let lastKb = -1;

  /**
   * Record the real geometry when the keyboard opens or closes.
   *
   * TEMPORARY. Attempts at the mobile keyboard layout that were reasoned from a
   * model of the device rather than from the device kept being wrong — iOS
   * Safari, Chromium and the iOS standalone PWA each account for the keyboard
   * differently, and this repo's own iOS notes say to measure on real hardware.
   * This rides the flight recorder (ADR-0008 diag.incident) so the numbers
   * arrive without anyone reading them off a screen.
   *
   * Through diag(), the module singleton — an EARLIER version reached for a
   * global named after the inlining placeholder, which does not exist at
   * runtime (the placeholder is a marker in the HTML; the core installs itself
   * as globalThis.tlDiag and the app binds an instance). It silently reported
   * nothing at all.
   *
   * Fires only on a CHANGE of the keyboard state, so the ~250ms animation
   * contributes one record per edge rather than a burst.
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

  // Gated on the whole geometry, not just kb. On a platform that shrinks the
  // LAYOUT viewport for the keyboard (Chromium via interactive-widget) kb stays
  // 0 across the whole open/close cycle, so a kb-only gate reported nothing at
  // all there — measured on the emulator.
  let lastSig = "";
  const reportGeometry = (kb: number): void => {
    const sig = [kb, window.innerHeight, vv ? Math.round(vv.height) : -1,
                 vv ? Math.round(vv.offsetTop) : -1].join("/");
    if (sig === lastSig) return;
    lastSig = sig;
    try {
      const box = (sel: string): string => {
        const el = document.querySelector(sel);
        if (!el) return "";
        const r = el.getBoundingClientRect();
        return Math.round(r.top) + "," + Math.round(r.bottom);
      };
      const cs = getComputedStyle(document.documentElement);
      const px = (n: string): string => cs.getPropertyValue(n).trim();
      const timeline = document.querySelector(".tl-timeline");
      diag().incident("viewport", {
        "tl.vp.inner_h": window.innerHeight,
        "tl.vp.screen_h": typeof screen !== "undefined" ? screen.height : 0,
        "tl.vp.vv_h": vv ? Math.round(vv.height) : -1,
        // The one that separates the two candidate causes: a non-zero offset
        // means iOS PANNED the visual viewport to bring the focused field into
        // view, which moves everything on screen. Zero means the layout moved
        // under a still viewport instead.
        "tl.vp.vv_top": vv ? Math.round(vv.offsetTop) : -1,
        "tl.vp.doc_scroll": Math.round(
          document.scrollingElement ? document.scrollingElement.scrollTop : -1,
        ),
        "tl.vp.root": box("#root"),
        "tl.vp.views": box(".tl-views"),
        "tl.vp.composer": box(".tl-composer"),
        "tl.vp.softkeys": box("#soft-keys"),
        // The transcript scroller: if this jumps while vv_top stays 0, the
        // movement is the list re-anchoring, not the page panning.
        "tl.vp.tl_scroll": timeline ? Math.round(timeline.scrollTop) : -1,
        "tl.vp.tl_h": timeline ? Math.round(timeline.clientHeight) : -1,
        "tl.vp.tl_scroll_h": timeline ? Math.round(timeline.scrollHeight) : -1,
        "tl.vp.kb_offset": px("--kb-offset"),
        "tl.vp.sk_h": px("--sk-h"),
        "tl.vp.app_vh": px("--app-vh"),
        "tl.vp.safe_b": measureSafeAreaBottom(),
        "tl.vp.standalone":
          typeof matchMedia === "function" &&
          matchMedia("(display-mode: standalone)").matches,
        "tl.vp.active": document.activeElement
          ? document.activeElement.className || document.activeElement.tagName
          : "",
      });
    } catch {
      /* a diagnostic must never be the thing that breaks the app */
    }
  };

  /**
   * Undo a scroll offset the PLATFORM imposed on the document.
   *
   * Measured on an iPhone-26 installed PWA: focusing the Text composer made
   * iOS collapse window.innerHeight to the visual viewport (812 -> 436) AND
   * scroll the document 376px to bring the field "into view". The shell tracks
   * innerHeight, so it collapsed with it, and the scroll carried it off the top
   * — the composer measured at -90,-25, above the screen — after which iOS
   * unwound both over FOURTEEN seconds. That crawl is the "everything scrolls"
   * report.
   *
   * The layout is invariant without that offset: across the same samples
   * `innerHeight + offsetTop` held constant at 812 and the visual viewport at
   * 436, so with the offset at zero the reservation puts the composer in the
   * same place in every frame of the animation.
   *
   * Safe to force: this page has no scrollable overflow of its own (html/body
   * are overflow:hidden and the shell is a fixed height), so any offset here is
   * the platform's, never a reader's scroll position.
   */
  const unpin = (): void => {
    const el = (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
    if (el && el.scrollTop !== 0) el.scrollTop = 0;
    if (el && el.scrollLeft !== 0) el.scrollLeft = 0;
  };

  const writeOffset = (): void => {
    unpin();
    const h = vv ? vv.height : window.innerHeight;
    const top = vv ? vv.offsetTop : 0;
    const kb = keyboardOffset(window.innerHeight, h, top);
    const root = document.documentElement.style;
    root.setProperty("--kb-offset", kb + "px");
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
    // Before the frame as well: the offset is what moves the app off screen,
    // and a rAF away is a visible jump.
    unpin();
    if (!rafScheduled) {
      rafScheduled = true;
      const run = () => {
        rafScheduled = false;
        writeOffset();
      };
      if (typeof requestAnimationFrame === "function") rafHandle = requestAnimationFrame(run);
      else run();
    }
    // Re-measure once the events STOP.
    //
    // The keyboard animates over ~250ms and fires resize/scroll throughout, so
    // the last event routinely arrives while the geometry is still moving — and
    // nothing fires afterwards to correct whatever was measured at that
    // instant, so the transient is what the layout keeps. Measured on the
    // in-cluster Android emulator with a real keyboard: a reservation stuck at
    // 311.76px (the pre-keyboard shell height minus the post-keyboard viewport)
    // and the Text composer sat at the top of the screen; one further event
    // settled it and the composer snapped back to the bottom.
    //
    // Separate from the onRefit debounce because it must run whether or not a
    // caller wants a refit, and it costs one style write.
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = undefined;
      writeOffset();
    }, settleMs);

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
  // The document scrolling at all is the platform doing it — undo it as it
  // happens rather than a frame later. Its own listener, not sync(), because
  // this must be cheap enough to run on every scroll tick.
  window.addEventListener("scroll", unpin, { passive: true });
  if (vv) {
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
  }
  // Seed once so accessories are positioned before the first event fires.
  writeOffset();

  return () => {
    window.removeEventListener("resize", sync);
    window.removeEventListener("orientationchange", sync);
    window.removeEventListener("scroll", unpin);
    if (vv) {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
    }
    if (fitTimer) clearTimeout(fitTimer);
    if (settleTimer) clearTimeout(settleTimer);
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
