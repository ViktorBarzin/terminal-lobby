/**
 * The fit guard. Whether xterm may be re-fitted to its host right now, and
 * what to do when it may not (frontend/term.html:5579-5613, replay at :9441).
 *
 * WHY A FIT NEEDS A GUARD AT ALL. The lobby keeps every session you visit
 * mounted and CSS-hides the ones you are not looking at (`store/keepalive.ts`,
 * `.tl-hidden { display: none !important }` in app.css:1121). That is
 * deliberate, so switching back is free and a background session keeps its
 * attention signal. A `display: none` host has a 0x0 box, so fitting xterm
 * against it computes a ~13x7 grid, xterm emits that as a resize, and ttyd's
 * tmux client drags the REAL window down to 13 columns, squeezing every other
 * client attached to that session. The hidden view damages the visible one.
 *
 * So a fit only means something once the host has a box. Until then the fit is
 * skipped and remembered as OWED, and the debt is settled by the next fit that
 * does have a box: the ResizeObserver notification a host fires when it
 * regains one, or the view coming back on screen, whichever arrives first.
 *
 * The debt is ONE flag, as it is in the page: ten skipped fits behind a hidden
 * session owe one fit, because only the last geometry was ever going to be
 * right.
 *
 * Everything here is pure: a box measurement in, a verdict out. The component
 * owns the element, the measurement, the addon and the debounce.
 *
 * WHAT THE COMPONENT STILL OWES, per action. The module decides and the
 * component acts, so a side effect missing from this list is one nobody
 * performs:
 *   fit:      call `fitAddon.fit()`, then tell the pty (`attach.resize()`).
 *             In term.html the pty is told by xterm's own `onResize`
 *             (term.html:8372-8377), which fires only when the grid actually
 *             changed; TerminalNative pairs its own `attach.resize()` with the
 *             fit, inside its `safeFit`, which is a spare frame rather than a
 *             wrong one. That is named by function and not by line, because the
 *             two line numbers this comment used to carry (:113-115, :151-153)
 *             went stale inside this one pass and now point at unrelated
 *             functions. Its boot fit runs before `attach()`, so it sends
 *             nothing: the boot size goes out with the handshake instead. A fit
 *             that THROWS does not hand the debt back, because the page clears
 *             `owed` before it calls `doFit()` and no caller there hands it
 *             back either. Its five `safeFit()` callers differ only in how
 *             loudly they drop it: :8479 and :9188 log and move on, :8491
 *             swallows it in an empty catch, and :5614 and :5664 do not catch
 *             at all, so a throw in those two aborts the rest of the boot
 *             script. The next resize or view switch is what settles a fit that
 *             failed.
 *   skip:     do NOT fit, and do NOT send a resize either. A skipped fit leaves
 *             `term.cols/rows` at the last good geometry, so a resize sent
 *             anyway would carry a real number rather than nonsense. The page
 *             sends none regardless, and that is the airtight reason: the only
 *             thing that tells the pty a size after boot is `term.onResize`
 *             (term.html:8372-8377), which cannot fire when no fit ran. Not the
 *             tmux argument this comment used to make: keepalive.ts:17-18
 *             states that same rule, tmux sizing a window to its LATEST active
 *             client, and draws the opposite conclusion from it, that a hidden
 *             client holding an older size does NOT shrink the pane the visible
 *             one is using. Worth a log line; the debt now stands.
 *   nothing:  the guard was asked and had nothing to answer. Silent.
 *
 * THREE MORE THINGS ONLY THIS COMMENT CARRIES:
 *   - MEASURE AT THE MOMENT OF THE FIT, never earlier. `clientWidth` and
 *     `clientHeight` of the host div, which is what term.html:5610 reads.
 *     A box cached when the trigger fired can be stale by the time the fit
 *     runs, and a stale non-zero box is exactly the zero-size fit this module
 *     exists to refuse.
 *   - DEBOUNCE THE TRIGGER, NOT THE FIT, AND ONLY WHERE THE PAGE DEBOUNCES IT.
 *     term.html has five `safeFit()` call sites and ONE of them is debounced:
 *     `refit()` (term.html:8472-8481) coalesces a burst into a single fit 120ms
 *     later, and every trigger that can arrive in a burst routes through it,
 *     among them the `resize` and `orientationchange` listeners and both
 *     `visualViewport` listeners (:8482-8486), the toolbar and compose-bar
 *     height changes (:7047, :7163, :7382, :7530), and the lobby's `tl-kb`,
 *     `tl-refit` and `tl-view` messages (:9421, :9428, :9441). Coalescing is
 *     what stops the "glitchy resize" on mobile: the soft keyboard animates
 *     over ~250ms and a rotate fires a burst, and every fit emits a tmux
 *     resize. That debounce belongs BEFORE this module: measure and reduce
 *     inside the debounced callback, so the box is read once and acted on at
 *     once.
 *     The other four fit IMMEDIATELY, so a debounce in front of one of those is
 *     a divergence rather than a port: the boot fit (:5614), the fonts
 *     `loadingdone` fit while `!booted` (:5664), the boot-end seed fit (:8491),
 *     and `applyTermPrefs` (:9188), which `applyFontSize` reaches (:9219-9226),
 *     so every pinch step and every A-/A+ tap fits at once. The pref path is
 *     not debounced because it is MASKED instead: `maskFitBurst` (:9159-9170)
 *     dims the container to .35 and restores it 180ms after the LAST fit of the
 *     burst, so the burst is hidden rather than thinned.
 *   - A COALESCED BURST REDUCES AS `fit-wanted` IF ANY OF ITS TRIGGERS WAS ONE.
 *     Only `fit-wanted` records a debt against a zero box. A `shown` at 0x0
 *     reduces to `nothing`, records nothing, and the fit it swallowed is never
 *     replayed. So a caller holding ONE pending event slot must let a
 *     `fit-wanted` outrank a `shown` that is already waiting, and must not let
 *     a later `shown` overwrite one.
 */

/**
 * The host element's box, in CSS pixels, as the component measured it just now.
 * `null` when there was nothing to measure, because the ref is not attached
 * yet. That is term.html's `!box` arm.
 */
export interface HostBox {
  width: number;
  height: number;
}

export interface FitState {
  /**
   * A fit was asked for, refused for want of a box, and has not landed since.
   * term.html's `owed`, and read there through `fitGuard.owed()` at the one
   * place that replays it.
   */
  readonly owed: boolean;
}

/** Nothing skipped, nothing outstanding. Where a freshly mounted terminal starts. */
export const NO_FIT_OWED: FitState = { owed: false };

export type FitEvent =
  /**
   * Something asked for a fit: the fit after `term.open()`, a ResizeObserver
   * notification, the `__tlRefitTerminal` bridge, a font or pref change that
   * moves the cell size. All of them are the same question, which is why
   * term.html funnels them through one `safeFit`.
   */
  | { type: "fit-wanted"; box: HostBox | null }
  /**
   * The view came back on screen: the terminal section or the session slot lost
   * its `.tl-hidden`. term.html learns this from the lobby's `tl-view` message
   * (:9435-9442) rather than from a resize, because a framed document's own
   * resize event on a `display: none` frame lifting is not something to rely
   * on. Native has the ResizeObserver as well, so this is the earlier of two
   * chances rather than the only one.
   */
  | { type: "shown"; box: HostBox | null };

// There is deliberately no `hidden` event. The box is the whole test, so a
// view going away needs nothing from here: the same transition takes the host
// to 0x0, and the fit that answers it is refused on its own measurement. The
// debt then waits, which is what a hidden session should cost.

export type FitAction =
  /** Fit now. The box behind this decision is real. */
  | "fit"
  /** A fit was wanted and could not run. The debt stands. */
  | "skip"
  /** The guard had nothing to answer. */
  | "nothing";

export interface FitReduction {
  /** Identical to the state passed in when the debt did not move, so a caller can compare by identity. */
  readonly state: FitState;
  readonly action: FitAction;
  /** The reason, for the log line. Empty for `nothing`. */
  readonly why: string;
}

/**
 * Is there a box worth fitting into?
 *
 * `> 0` and not `!== 0`, which is term.html's `!(box.width > 0)` verbatim: NaN
 * and a negative are refused too. A zero is what a hidden host reports, and a
 * NaN is what an unlaid-out one can report. Both compute a grid from nothing.
 */
export function hasBox(box: HostBox | null): boolean {
  return !!box && box.width > 0 && box.height > 0;
}

/** Whether a fit is outstanding. term.html's `fitGuard.owed()`. */
export function isFitOwed(state: FitState): boolean {
  return state.owed;
}

/** The whole guard. Nothing here reads an element, a clock or the addon. */
export function reduce(state: FitState, event: FitEvent): FitReduction {
  if (!hasBox(event.box)) {
    // A fit that was ASKED for and could not run is owed. A view merely coming
    // on screen asked for nothing, so it records no debt of its own. Whatever
    // was owed before still is, because the replay it was meant to trigger has
    // not happened. That keeps the debt monotone: only a landed fit clears it.
    const owed = event.type === "fit-wanted" || state.owed;
    return {
      state: owed === state.owed ? state : { owed },
      action: owed ? "skip" : "nothing",
      why: owed ? describeBox(event.box) : "",
    };
  }

  // `if (!e.data.hidden && fitGuard.owed()) refit()` (term.html:9441). The debt
  // is half of that condition: a view switch with nothing outstanding must not
  // emit a tmux resize for a geometry that was already correct.
  if (event.type === "shown" && !state.owed) {
    return { state, action: "nothing", why: "" };
  }

  return {
    state: state.owed ? NO_FIT_OWED : state,
    action: "fit",
    why:
      event.type === "shown"
        ? "replaying the fit owed since the view was hidden"
        : describeBox(event.box),
  };
}

function describeBox(box: HostBox | null): string {
  return box ? `the host box is ${box.width}x${box.height}` : "the host has no box yet";
}
