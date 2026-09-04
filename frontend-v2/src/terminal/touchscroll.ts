/**
 * Touch scroll: one finger's drag turned into discrete line wheels
 * (frontend/term.html:6056-6171, and the one-finger recognizer at :6478-6556,
 * whose FIRST line is the coarse-pointer gate the owes list below opens with).
 *
 * WHAT THIS IS FOR. It is the only way to scroll a terminal with a finger. A
 * one-finger drag inside the screen becomes a run of synthetic wheel events
 * with `deltaMode` LINE, one row each, dispatched on the xterm root. That is
 * what makes tmux enter copy-mode, and what lets a mouse-tracking application
 * such as Claude Code scroll its own view instead. Measured on a real phone
 * 2026-08-16: an 18-touchmove drag produced 15 one-line wheels, tmux copy-mode
 * scrolled 14 lines, and vim with `mouse=a` scrolled itself from line 1 to line
 * 46.
 *
 * A continuous pixel delta does not work here, which is why the original emits
 * line units (:6059-6072). xterm 6's `consumeWheelEvent` damps pixel deltas
 * under 50px to 0.3x AND, in mouse-tracking mode, forwards at most ONE report
 * to the application per DOM wheel event, magnitude discarded. Measured there:
 * ten pixel wheels of dy=-5 reached the app as 0 events, and dy=-60 as only 10.
 * A LINE wheel of deltaY +-1 is undamped and one row exact, and k dispatches in
 * a frame yield k reports, which beats the one-per-event cap by construction.
 *
 * Sign, as the page verified it (:6074-6075): the finger moving DOWN the screen
 * feeds negative px and emits deltaY -1, which scrolls UP into scrollback and
 * copy-mode. Content follows the finger, as it does everywhere else on a phone.
 *
 * THE CLASSIFICATION IS THE RED LINE. Which touch is a scroll, which is a tap
 * that raises the soft keyboard, and which belongs to a multi-finger gesture is
 * decided by four lines of term.html, and the page marks all four as the part
 * momentum was not allowed to touch in the banner over the whole scroller
 * (:6070-6071, "Only EMISSION/MOMENTUM changed; tap-vs-swipe CLASSIFICATION is
 * byte-identical"). The narrower note inside the touchstart handler (:6492-6495)
 * says the same of the three lines under it and stops there, so it does not
 * cover the fourth, which is the deferred focus gate at :6527 in the touchend
 * handler. They are ported here in the same order, with the same comparisons:
 *   1. a touchstart with anything but exactly one touch disarms the drag
 *      (:6498), which is what keeps two-finger and three-finger shapes out of
 *      this module's way by construction. In the native port the module that
 *      owns two fingers is font.ts, the pinch to font size; the two-finger
 *      toolbar tap and the three-finger session swipe are dropped along with
 *      term.html's shared multi-touch registry (:6404-6467).
 *   2. `lastY` advances on every move, before the threshold is tested (:6506),
 *      so the travel spent proving a swipe is never scrolled.
 *   3. the swipe test is `> SWIPE_THRESHOLD_PX` from where the finger LANDED,
 *      not along the path, and it is sticky once true (:6507).
 *   4. the focus call waits for the lift and only happens if the gesture never
 *      became a swipe (:6527), so a swipe cannot summon the keyboard over the
 *      scrollback it just revealed.
 *
 * One thing is deliberately NOT gated: the `tl-gestures` master kill. The page
 * consults `gesturesEnabled()` for the desktop smooth wheel (:6204) and for the
 * multi-touch registry (:6425), and never anywhere in this path, because a
 * finger has no other way to scroll. Do not add one.
 *
 * Everything here is pure: touch facts and a reading of the world go in, wheels
 * come out. No DOM, no timers, no rAF, no prefs lookup, which is what lets the
 * thresholds be tested at all. term.html's version cannot be: it lives in three
 * passive listeners closing over eight mutable page variables (:6084-6088 and
 * :6489).
 *
 * WHAT THE COMPONENT STILL OWES. The module decides and the component performs,
 * so anything missing from this list is behaviour nobody performs.
 *
 * FIRST THE GATE, because it decides whether any of the rest is wired at all.
 * term.html's whole recognizer, the three listeners included, sits inside
 * `if (isCoarsePointer)` at :6478, and `isCoarsePointer` is
 * `matchMedia('(pointer: coarse)').matches` read ONCE at :6350. So attach
 * nothing where that query is false. This repo has the query already, as
 * `isCoarsePointer()` in src/mobile/pointer.ts, and TerminalNative.tsx already
 * reads it once at mount (`const coarsePointer = isCoarsePointer()`) for
 * the reason term.html reads it once: a 2-in-1 that flips to its trackpad
 * mid-session must not lose the listeners the finger is using. Read it once and
 * gate the ATTACH on it. Do not put it in `TouchScrollWorld`, which would turn
 * it into a per-event read term.html never does.
 *
 * The hardware the gate protects is a touchscreen laptop or a 2-in-1, and what
 * happens there is worth spelling out, because a wiring that skips the gate
 * ships a bug on machines people own. Where the query answers false, term.html
 * attaches no touch listener and a finger gets whatever the browser does
 * natively; wire these three anyway and that same finger also feeds one LINE
 * wheel per row to the pty, which is what puts tmux into copy-mode. Nor can
 * these listeners replace the native scroll, only add to it, on any machine:
 * they are passive, so no `preventDefault` is available to them. The page is
 * deliberate about leaving touch-capable desktops alone (:6399-6400,
 * "touch-capable desktops keep native 2-finger scrolling latency-free").
 *
 * Which way such a machine answers is not something to predict from here.
 * `pointer` describes only the PRIMARY pointing device (Media Queries 4), and
 * which device that is comes down to the UA and the mode it is in: this repo
 * carries a reproduced case of the query answering coarse with a mouse in use
 * (pointer.ts's note on `FINE_QUERY`, reported 2026-09-01) and a sibling port
 * reasoning from it answering fine (wheel.ts's note on the pointer type).
 * Mirroring the gate is right under either answer, and attaching regardless is
 * right under neither, so the gate is the whole instruction. Those two siblings
 * are cited by name rather than by line because a line number in another file
 * drifts the moment that file is edited, and a citation a reader cannot follow
 * is the defect this comment exists to avoid.
 *
 * The listeners: `touchstart`, `touchmove` and `touchend` on the terminal host
 * element, all three `{ passive: true }`, each feeding `reduce`. Passive is not
 * a detail. A standing non-passive touch listener taxes the latency of every
 * scroll on the page (term.html:6382-6388 measured this), and nothing here ever
 * asks for `preventDefault`. The pinch recognizer DOES need to preventDefault a
 * two-finger `touchmove` on Chromium (font.ts), so that listener is the one to
 * attach lazily, as the page attaches its own (:6415-6416); this module's three
 * stay standing and passive. Add `touchcancel` as well, which term.html does
 * not (see below). Several terminals are mounted at once, since the lobby keeps
 * every visited session mounted and CSS-hides the rest, so keep one state per
 * terminal and put the listeners on that terminal's own host.
 *
 * Per action:
 *   wheel  `term.element.dispatchEvent(new WheelEvent('wheel', action.wheel))`,
 *          in order, on the xterm ROOT (:6107). The action carries the whole
 *          event init, so there is nothing to assemble: `deltaMode: 1` is
 *          DOM_DELTA_LINE, `clientX` is 0 and `clientY` is the finger's last y,
 *          which is what the SGR report the pty receives is built from.
 *   focus  term.html's `tapFocus()` (:5815): `term.focus()`, or the compose
 *          field when the mobile input bar is visible and `input.tapFocus` is
 *          'field' (reassigned at :7459-7460). Both halves are wired now, as
 *          TerminalNative's `tapFocus`: the field takes the tap wherever it is
 *          mounted, which is a coarse pointer under a posture that engages it,
 *          and xterm takes it otherwise. dragselect.ts's `focus` action is the
 *          same call, and the two have to stay the same call.
 *
 * The coast, which is the one thing this module cannot do for itself. While a
 * reduction comes back with `coasting` true, one `requestAnimationFrame` must
 * be pending, and its callback feeds `{ type: "frame", now }` with the
 * timestamp rAF hands it. When `coasting` goes false, cancel any pending frame.
 * The `now` of a frame and the `th` of a touch event have to come from the SAME
 * clock, because the coast measures one against the other: `performance.now()`
 * is that clock, and rAF timestamps share its time base.
 *
 * Four things must send `{ type: "interrupt" }`, which is
 * `cancelScrollMomentum` in the page: a REAL wheel, tested with `isTrusted`
 * (:6281), since our own synthetic wheels are untrusted and would otherwise
 * cancel the coast they are part of; every byte bound for the pty, at the shared
 * `sendInput` choke point that already sees the keyboard, the mirror, the soft
 * keys and paste (:8269) and again at `term.onData` (:8341); a soft key, which
 * bypasses onData with pre-baked bytes (:6823); and a reattach or session
 * switch (:10294).
 *
 * AND ONE THING MUST NOT, which is the same exclusion as the `isTrusted` test
 * arriving by the other route. With mouse reporting on, a wheel this module
 * asked for comes back as pty-bound input INSIDE the dispatch: xterm's
 * `bindMouse` consults the custom wheel handler, gets true for the untrusted
 * synthetic, and `coreMouseService.triggerMouseEvent` routes the report through
 * `_coreService.triggerDataEvent`, because only DEFAULT encoding takes
 * `triggerBinaryEvent` and DECSET 1006 selects SGR. So `term.onData` fires
 * SYNCHRONOUSLY inside `dispatchEvent`, and the two interrupt sites downstream
 * of it are the coast cancelling itself. Measured against the installed
 * @xterm/xterm 6.0.0: one untrusted `deltaMode: 1` wheel after
 * `\x1b[?1000h\x1b[?1006h` yields `onData ["\x1b[<64;…M"]` and no `onBinary`.
 *
 * term.html does not need the exclusion, and the reason is why it belongs in
 * the component rather than here. Its `cancelScrollMomentum` clears
 * `momentumRAF` alone (:6129-6130); the coast's velocity, distance and anchor
 * are `let`s inside `startScrollMomentum` that it never touches, and `step`
 * re-arms `momentumRAF` on the line after `feedScroll` (:6167), so re-entered
 * from inside `step` the cancel is a NO-OP. This port moved that motion state
 * into `TouchScrollState.coast`, where `interrupt` destroys it. A pure reducer
 * cannot see the re-entrancy that tells the two cases apart; the component can,
 * which is what `TerminalNative`'s `emittingWheel` and `cancelCoast` are. So
 * `interrupt` here stays what the page's cancel is, and the component owes it
 * the same filtering it already owes on `isTrusted`.
 *
 * What the component must read for `TouchScrollWorld`. Every field FRESH at the
 * moment of the event, because that is when term.html reads it, and then WHERE
 * the page reads each, because two of the five it reads at the lift alone and a
 * blanket sentence would have a wiring measure a box on every touchmove for
 * nothing:
 *   cellHeightPx    `.xterm-screen`'s box height / `term.rows`, falling back to
 *                   16 when there is no screen element or no rows (:6094-6097).
 *                   Read on every feed (:6119) and again at the lift (:6150,
 *                   :6551), so a touchmove, a frame and the lift all need it
 *                   real.
 *   screenHeightPx  `.xterm-screen`'s box height, falling back to
 *                   `(term.rows || 24) * 16` (:6098-6101). Read at the LIFT
 *                   only (:6156, the coast cap), which is the one place this
 *                   module consults it as well. A touchmove or a frame may pass
 *                   anything; measuring the box there buys nothing and costs a
 *                   forced layout on the touchmove path.
 *   scrollSpeed     the `gestures.scrollSpeedV2` pref (:6090), read on every
 *                   feed (:6119). `Prefs["gestures"].scrollSpeedV2` in the
 *                   SPA's own type, default 1, in the same `tl:prefs:v1`
 *                   document term.html reads. Read it FRESH rather than off the
 *                   prefs store's signal: `store/prefs.ts`'s
 *                   `readPersistedPrefs()` exists for this read and its header
 *                   says why a signal is the wrong source for it.
 *   momentum        the `gestures.scrollMomentum` pref (:6093), default true,
 *                   same document and the same fresh read. Read at the LIFT
 *                   only (:6543), which is why turning momentum off does not
 *                   stop a coast already in flight.
 *   mounted         `!!term.element` (:6106, :6508, :6161). Read on a touchmove
 *                   and on a frame.
 *
 * Both box reads name `.xterm-screen`, and term.html can afford a bare
 * `document.querySelector` for it (:6095, :6099) because it is one terminal per
 * document. Here several are mounted at once, so each instance must measure the
 * `.xterm-screen` inside ITS OWN host. A document query would hand every
 * terminal the first match in the DOM, and a hidden one measures 0 inside
 * `display: none` (`.tl-hidden`, app.css:1121-1123): `cellHeightPx` 0 makes
 * `rowPx` 0, and the visible terminal's finger would bank its px and emit not
 * one wheel.
 *
 * WHERE THIS IS NOT term.html LINE FOR LINE. Three differences, all deliberate.
 *
 * `touchcancel` is handled, and term.html registers no touchcancel on the
 * terminal element at all. What the page does on a cancelled touch is nothing:
 * the drag stays armed with a stale `startY` until the next touchstart resets
 * it. That is invisible today, because no further move can arrive for a
 * cancelled touch, no touchend follows it to reach the focus call, and the next
 * touchstart clears the same fields anyway. Handling it here folds the cancel
 * into exactly what that next touchstart would have done, so the module never
 * sits holding half a gesture, and a cancel cannot be followed by a coast.
 *
 * The coast is a `frame` event rather than an rAF closure, and its velocity,
 * distance and anchor live in `Coast` instead of in local `let`s (:6154-6157).
 * The arithmetic is unchanged, including which parts are frozen at the lift:
 * the stop speed comes from the cell height read once at kickoff (:6150, :6155)
 * and the cap from the screen height read there too (:6156), while the row size
 * is re-read on every feed (:6119). A font change mid-coast therefore changes
 * how many wheels the remaining pixels are worth, and not where the coast ends.
 *
 * `emitLineWheel`'s own `!term.element` guard (:6106) is not duplicated inside
 * `feed`. Both of `feed`'s callers test `mounted` first: a drag gives up on the
 * whole move (:6508) and a coast stops (:6161), so the guard cannot be reached
 * from either. The two tests that do the work are ported where the page has
 * them.
 *
 * OUT OF SCOPE, on purpose. The pinch to font size is font.ts, not here. The
 * two-finger toolbar tap and the three-finger session swipe are not ported at
 * all, and the design drops them with the registry they shared (361 lines).
 * What a selection does with a wheel belongs to selection.ts.
 *
 * The desktop smooth-wheel interceptor (:6172-6277) is its own port, wheel.ts,
 * and it is NOT independent of this one. Four things are shared in term.html,
 * and the first is a coupling a wiring can break by accident:
 *   - `emitLineWheel` (:6105-6113), called from both the touch feed (:6127) and
 *     the desktop pacer's `pumpWheel` (:6222). It takes its `clientY` from
 *     `scrollLastEmitY` (:6087, read at :6111), which is the field this module
 *     owns as `emitY`, and which ONLY the touch path ever writes (:6522). So a
 *     desktop wheel carries the last y a finger reached, or 100 where no finger
 *     ever did. wheel.ts says the same from its side, under `emit` in its own
 *     owes list, and keeps it deliberately: the mouse report's cell is derived
 *     from the coordinate, so giving the desktop path the wheel's own clientY
 *     instead would change which tmux pane a trackpad report lands in. Wire ONE
 *     emit primitive, reading this state's `emitY`, and neither port is the
 *     place to decide otherwise alone.
 *   - `SCROLL_MAX_EVENTS_PER_FEED` (:6082), one constant behind the touch feed's
 *     cap (:6123-6124) and both of the desktop path's (:6218-6219, :6254). Both
 *     ports now take it from `emit.ts` and re-export it, so the page's one
 *     constant is one constant here too.
 *   - `xtermCellH()` (:6094), read by the touch path at :6119, :6150 and :6551
 *     and by the desktop path at :6214, :6239 and :6254. Its one remaining
 *     caller, :6290, is the selection wheel-clear, which is selection.ts.
 *   - `xtermScreenH()` (:6098), whose only two callers are the coast cap
 *     (:6156) and a DOM_DELTA_PAGE wheel (:6240).
 * What is NOT shared: `feedScroll`, `scrollAccumPx`, the sample buffer, the
 * momentum engine, and the speed pref, which the desktop path reads from
 * `gestures.wheelSpeed` through its own `wheelSpeedMult` (:6206-6208). And the
 * one crossing that runs the other way is not in the interceptor at all: the
 * trusted-wheel cancel of a coast lives in a `wheel` listener on the terminal
 * HOST element (:6278-6281, `document.getElementById('terminal')`, not
 * `document`), and reaches this module as `interrupt`.
 */

// The per-frame cap, from the one home the two scrollers share. A VALUE import,
// where `emit.ts` imports only TYPES from here, so the runtime graph is
// one-directional and there is no cycle to reason about.
import { SCROLL_MAX_EVENTS_PER_FEED } from "./emit";

/**
 * How far a finger must travel from where it landed before the gesture is a
 * scroll rather than a tap (term.html:6490).
 *
 * Both mistakes cost something, which is why the page defers the focus call to
 * the lift and gates it on this (:6486-6487): a scroll read as a tap raises the
 * soft keyboard over the scrollback it just revealed, and a tap read as a
 * scroll is a keyboard that will not come up. The comparison is strictly
 * greater, so exactly six pixels is still a tap.
 */
export const SWIPE_THRESHOLD_PX = 6;

/** Exponential decay of the coast velocity, tuned to UIScrollView's normal (term.html:6076). */
export const MOMENTUM_TAU_MS = 325;

/** The coast ends below this speed, in rows per second (term.html:6077). */
export const MOMENTUM_STOP_ROWS_PER_S = 0.5;

/** Hard cap on how far one coast may travel, in screenfuls of finger px (term.html:6078). */
export const MOMENTUM_MAX_COAST_SCREENS = 4;

/** A release slower than this, in rows per second, does not coast at all (term.html:6079). */
export const MOMENTUM_MIN_START_ROWS_PER_S = 3;

/**
 * Beyond this gap between the newest sample and the lift, the finger was being
 * held still and there is no flick to continue (term.html:6080).
 *
 * It cannot be read off the samples instead. Browsers dedupe
 * identical-coordinate touchmoves, so a held finger produces no samples at all
 * and the buffer still ends at the last MOVING one (measured: a
 * decelerate-then-hold gesture coasted 4 rows).
 */
export const GAP_STILL_MS = 180;

/**
 * How the release velocity is attenuated across the 0 to GAP_STILL_MS band
 * (term.html:6081).
 *
 * Smooth rather than binary, so delivery latency trims a fast flick instead of
 * killing it. WKWebView coalescing routinely puts more than 80ms between the
 * last touchmove and the touchend, which is what an earlier binary 80ms cutoff
 * mistook for a stationary finger.
 */
export const GAP_ATTEN_TAU_MS = 400;

/**
 * Burst cap: one feed cannot spray hundreds of events (term.html:6082).
 *
 * ONE constant in the page and one here, in `emit.ts`, which is where the two
 * scrollers' shared middle lives. Both ports declared their own copy while
 * neither could see the other; this re-export ends that without moving the name
 * out of either module's public API, which both suites read.
 */
export { SCROLL_MAX_EVENTS_PER_FEED };

/** The window the release velocity is measured over (term.html:6083). */
export const VEL_WINDOW_MS = 100;

/** How many samples the ring buffer keeps (term.html:6521). */
export const VEL_SAMPLES_MAX = 24;

/**
 * The most decay one frame may apply (term.html:6159). A tab that was
 * throttled or backgrounded comes back with a huge gap since the last frame,
 * and without the clamp that single step would swallow the whole coast.
 */
export const COAST_FRAME_CAP_MS = 64;

/**
 * The x every synthetic wheel carries (term.html:6111). The pty's SGR wheel
 * report takes its column from this, so it is part of what the application
 * receives, not a placeholder.
 *
 * KEPT HERE rather than shared with `emit.ts`'s private copy of the same 0,
 * where the per-frame cap above went the other way, and the difference is what
 * each guards against. The cap is arithmetic: two copies can disagree and each
 * one still looks right, so one home is the only guard. This 0 is a FIELD of an
 * emitted event, and both copies are already pinned against the page's own
 * `clientX: 0, clientY: scrollLastEmitY` text by their own suites, which
 * compare the built wheel to a literal. That catches a drift a shared constant
 * would not: a single export only proves the two files agree with each other.
 */
export const WHEEL_CLIENT_X = 0;

/**
 * One discrete synthetic wheel, as the `WheelEvent` init the component
 * dispatches (term.html:6107-6112). Handed over whole so there is nothing left
 * to assemble: a pixel-mode delta or a magnitude other than one row would be
 * damped or capped by xterm before the pty ever saw it.
 */
export interface LineWheel {
  /** One row, in the direction of travel. Negative is up, into scrollback. */
  readonly deltaY: 1 | -1;
  /** `WheelEvent.DOM_DELTA_LINE`. The whole point. */
  readonly deltaMode: 1;
  readonly bubbles: true;
  readonly cancelable: true;
  readonly clientX: 0;
  /** The finger's last y, carried from the drag into the coast. */
  readonly clientY: number;
}

/**
 * One reading of the finger, kept for the release velocity (term.html:6520).
 *
 * Two clocks per sample, and the lift compares against both. `t` is the event's
 * own creation stamp, which is true finger timing and survives coalesced or
 * late delivery on real iOS; `th` is the clock read while handling it, which
 * stays sane for synthetic events whose creation stamps batch unreliably
 * (:6509-6519).
 */
export interface VelocitySample {
  readonly y: number;
  /** `TouchEvent.timeStamp`. */
  readonly t: number;
  /** `performance.now()` when the event was handled. */
  readonly th: number;
}

/**
 * A coast in flight: the flick the finger left behind, still emitting.
 *
 * term.html's five locals inside `startScrollMomentum` (:6154-6157), which is
 * where their lifetimes come from. `stopVelPxPerMs` and `capPx` are measured
 * once, at the lift; `velPxPerMs` and `coastedPx` move every frame.
 */
export interface Coast {
  /** px/ms, in the sign `feed` takes: the negated release velocity (:6154). */
  readonly velPxPerMs: number;
  /** How far this coast has travelled, unsigned, against `capPx` (:6157, :6165). */
  readonly coastedPx: number;
  /** Below this speed the coast is over. Frozen at the lift (:6155). */
  readonly stopVelPxPerMs: number;
  /** Four screens of finger travel. Frozen at the lift (:6156). */
  readonly capPx: number;
  /** The timestamp the next frame measures its dt from (:6157, :6159). */
  readonly at: number;
}

/**
 * Everything the recognizer remembers. term.html's `startY`, `lastY` and
 * `moved` (:6489) plus the five module-level scroll variables (:6084-6088),
 * as plain data so a test can write one by hand.
 */
export interface TouchScrollState {
  /**
   * Where the one finger landed, and where it was last seen. Both null means no
   * armed drag: either nothing is touching, or a second finger disarmed it.
   *
   * They are set and cleared together, never one without the other.
   */
  readonly startY: number | null;
  readonly lastY: number | null;
  /**
   * The gesture has passed the swipe threshold, and stays passed
   * (term.html:6507).
   *
   * A drag disarmed by a second finger keeps whatever this was, exactly as the
   * page leaves it: :6498 returns before the `moved = false` on :6500, and the
   * only reader left is the focus test, which the null `startY` has already
   * settled.
   */
  readonly moved: boolean;
  /**
   * Signed finger px not yet spent on a wheel (term.html:6085). Shared between
   * the drag and the coast, which is what makes the hand-off seamless: the
   * remainder from the last touchmove is the first thing the coast spends.
   */
  readonly accumPx: number;
  /** The velocity ring buffer, oldest first, at most VEL_SAMPLES_MAX long. */
  readonly samples: readonly VelocitySample[];
  /**
   * The clientY every synthetic wheel carries (term.html:6087). It survives a
   * touchstart's reset, exactly as the page's module-level variable does, and
   * starts at 100 as the page starts it.
   *
   * A drag sets it in the same step that marks the gesture as feeding, and the
   * coast requires a gesture that fed, so every wheel these transitions produce
   * carries a y some finger actually reached.
   *
   * NOT private to this module, and the only field here that is not. In
   * term.html one `scrollLastEmitY` feeds the one `emitLineWheel` (:6111) that
   * both the touch feed (:6127) and the desktop wheel pacer (:6222) call, so
   * the desktop port's wheels carry THIS value: the last y a finger reached, or
   * 100 on a machine where none ever did. The touch path is still its only
   * writer (:6522). The OUT OF SCOPE note in the header has the consequence for
   * a wiring that shares one emit primitive between the two ports.
   */
  readonly emitY: number;
  /**
   * This gesture has fed the scroller at least once, which is the page's
   * `scrollEmittedGesture` (term.html:6088, :6523) and the gate on coasting.
   *
   * It says the move passed the gates, NOT that a wheel went out: a single 8px
   * move on 16px rows feeds the accumulator, emits nothing, and still leaves a
   * flick worth continuing.
   */
  readonly emitted: boolean;
  /** The coast, or null when nothing is coasting (term.html:6084). */
  readonly coast: Coast | null;
}

export const NO_TOUCH_SCROLL: TouchScrollState = {
  startY: null,
  lastY: null,
  moved: false,
  accumPx: 0,
  samples: [],
  emitY: 100,
  emitted: false,
  coast: null,
};

export type TouchScrollEvent =
  /** A finger landed. `touches` is `e.touches.length`, `y` is `e.touches[0].clientY`. */
  | { readonly type: "touchstart"; readonly touches: number; readonly y: number }
  /** A finger moved. `t` is `e.timeStamp`, `th` is `performance.now()` at handling. */
  | {
      readonly type: "touchmove";
      readonly touches: number;
      readonly y: number;
      readonly t: number;
      readonly th: number;
    }
  /**
   * A finger lifted. term.html's handler reads no touch count here, so neither
   * does this: a two-finger lift is already disarmed by the second finger's
   * touchstart, and the first `touchend` of the pair finds `startY` null.
   */
  | { readonly type: "touchend"; readonly t: number; readonly th: number }
  /** The browser took the touch away (a system gesture, a scroll handover). */
  | { readonly type: "touchcancel" }
  /** A rAF tick while `coasting`. `now` is rAF's own timestamp. */
  | { readonly type: "frame"; readonly now: number }
  /** Something else claimed the terminal, and the coast is over. See the header for the four sites. */
  | { readonly type: "interrupt" };

/** What the component read from the DOM, xterm and the prefs for this event. */
export interface TouchScrollWorld {
  /** One row of the screen box, in CSS px. */
  readonly cellHeightPx: number;
  /** The whole screen box, in CSS px, for the coast cap. */
  readonly screenHeightPx: number;
  /** The `gestures.scrollSpeedV2` pref, wheels per finger row-height. */
  readonly scrollSpeed: number;
  /** The `gestures.scrollMomentum` pref. */
  readonly momentum: boolean;
  /** `!!term.element`: xterm is mounted and there is something to dispatch on. */
  readonly mounted: boolean;
}

export type TouchScrollAction =
  /** Dispatch this wheel on the xterm root. This is the whole mechanism. */
  | { readonly kind: "wheel"; readonly wheel: LineWheel }
  /** The tap was a tap: take the focus, which is what raises the soft keyboard. */
  | { readonly kind: "focus" };

export interface TouchScrollReduction {
  /**
   * The state after the event.
   *
   * Identity is preserved by the paths that decide nothing at all: a
   * `touchmove` no `touchstart` armed or a second finger took, a `frame` with
   * no coast, and an `interrupt` with no coast. `touchstart`, `touchend` and
   * `touchcancel` always hand back a FRESH object, because each of them clears
   * fields whether or not those fields already held the cleared value, and this
   * doc used to promise identity "whenever nothing moved" for them too. So
   * identity is a cheap "nothing was decided" on the first three and carries no
   * information on the other three; read `actions` and `coasting` for what
   * happened.
   */
  readonly state: TouchScrollState;
  /** In the order the component must perform them. Empty when there is nothing to do. */
  readonly actions: readonly TouchScrollAction[];
  /**
   * Whether a frame should be pending once this decision is applied. True for
   * exactly as long as a coast is in flight, so the component keeps one rAF
   * outstanding while it is true and cancels when it goes false.
   */
  readonly coasting: boolean;
}

const NOTHING: readonly TouchScrollAction[] = [];
const NO_SAMPLES: readonly VelocitySample[] = [];

/** The whole recognizer. Nothing here touches the DOM, a clock or a pref. */
export function reduce(
  state: TouchScrollState,
  event: TouchScrollEvent,
  world: TouchScrollWorld,
): TouchScrollReduction {
  switch (event.type) {
    case "touchstart":
      return onStart(state, event.touches, event.y);
    case "touchmove":
      return onMove(state, event, world);
    case "touchend":
      return onEnd(state, event, world);
    case "touchcancel":
      return onCancel(state);
    case "frame":
      return onFrame(state, event.now, world);
    case "interrupt":
      // term.html's `cancelScrollMomentum`, and only that: the accumulator's
      // remainder and the drag are left alone, and the next touchstart clears
      // them (:6129-6131).
      return done(state.coast === null ? state : { ...state, coast: null }, NOTHING);
    default: {
      const unhandled: never = event;
      void unhandled;
      return done(state, NOTHING);
    }
  }
}

/** `coasting` is not a separate decision: it is whether a coast survived this event. */
function done(
  state: TouchScrollState,
  actions: readonly TouchScrollAction[],
): TouchScrollReduction {
  return { state, actions, coasting: state.coast !== null };
}

/**
 * The four accepted values of `gestures.scrollSpeedV2`, and 1 for anything else
 * (term.html:6089-6092).
 *
 * The fallback is load-bearing rather than defensive: this key REPLACED a
 * `scrollSpeed` pref whose values were a deltaY multiplier with different
 * semantics, already serialized as 2 or 3 into roamed documents. A stale
 * document therefore reaches here with a number that means something else.
 */
export function scrollSpeedMult(pref: number): number {
  return pref === 1 || pref === 1.5 || pref === 2 || pref === 3 ? pref : 1;
}

/**
 * The release velocity in px/ms, positive for a finger moving DOWN the screen
 * (term.html:6137-6147).
 *
 * A two-point secant from the oldest sample still inside VEL_WINDOW_MS to the
 * newest, so a slow approach cannot dilute the flick that ended it. The page's
 * comment calls this weighted; the arithmetic it ships, and this port, is the
 * secant.
 *
 * It does NOT settle a finger held still before the lift. A held finger
 * produces no samples at all, so the window goes on reading the last moving
 * ones and reports the speed they had. GAP_STILL_MS is what answers that, and
 * it is answered at the lift rather than here.
 */
export function releaseVelocity(samples: readonly VelocitySample[]): number {
  if (samples.length < 2) return 0;
  const newest = samples[samples.length - 1];
  if (!newest) return 0;
  let i = samples.length - 1;
  while (i > 0) {
    const before = samples[i - 1];
    if (!before || newest.t - before.t > VEL_WINDOW_MS) break;
    i--;
  }
  const oldest = samples[i];
  if (!oldest) return 0;
  const dt = newest.t - oldest.t;
  // Two samples stamped at the same instant carry no velocity. The length test
  // above and these two lookups are what keep the indexes typed.
  if (dt <= 0) return 0;
  return (newest.y - oldest.y) / dt;
}

function onStart(state: TouchScrollState, touches: number, y: number): TouchScrollReduction {
  // Before the touch count is looked at (:6496-6497), so a second finger is a
  // hard cancel for the coast and the flick velocity whatever else it is.
  const fresh = { ...state, coast: null, accumPx: 0, samples: NO_SAMPLES, emitted: false };
  // :6498. Anything but exactly one finger disarms the drag, which is what
  // makes multi-finger shapes safe by construction.
  if (touches !== 1) return done({ ...fresh, startY: null, lastY: null }, NOTHING);
  return done({ ...fresh, startY: y, lastY: y, moved: false }, NOTHING);
}

function onMove(
  state: TouchScrollState,
  event: { readonly touches: number; readonly y: number; readonly t: number; readonly th: number },
  world: TouchScrollWorld,
): TouchScrollReduction {
  // :6503. A second finger mid-drag stops the scroll rather than fighting it.
  if (event.touches !== 1) return done(state, NOTHING);
  const { startY, lastY } = state;
  if (startY === null || lastY === null) return done(state, NOTHING);

  const delta = lastY - event.y;
  // :6506 comes before :6507: `lastY` advances whether or not this move
  // scrolls, so the travel spent proving the swipe stays out of the
  // accumulator, and only the crossing move's own delta is fed.
  const walked = {
    ...state,
    lastY: event.y,
    moved: state.moved || Math.abs(startY - event.y) > SWIPE_THRESHOLD_PX,
  };
  // :6508. Three ways a move earns nothing: it has not proven itself a swipe
  // yet, it covered no ground at all (an identical coordinate the browser did
  // not dedupe), or there is no terminal to dispatch on. None of the three is
  // sampled either, so none of them can feed the release velocity.
  if (!walked.moved || delta === 0 || !world.mounted) return done(walked, NOTHING);

  // :6520-6524. `emitY` is set before the feed, so this move's wheels carry
  // this move's y.
  const sampled = [...state.samples, { y: event.y, t: event.t, th: event.th }];
  return feed(
    {
      ...walked,
      samples:
        sampled.length > VEL_SAMPLES_MAX ? sampled.slice(sampled.length - VEL_SAMPLES_MAX) : sampled,
      emitY: event.y,
      emitted: true,
    },
    delta,
    world,
  );
}

function onEnd(
  state: TouchScrollState,
  event: { readonly t: number; readonly th: number },
  world: TouchScrollWorld,
): TouchScrollReduction {
  // :6527. The deferred focus, and the whole reason it is deferred: a gesture
  // that never became a swipe was a tap. A null `startY` belongs to a
  // multi-finger sequence, which takes no focus at all.
  const actions: readonly TouchScrollAction[] =
    !state.moved && state.startY !== null ? [{ kind: "focus" }] : NOTHING;
  // :6528-6529 and :6554.
  const lifted = { ...state, startY: null, lastY: null, moved: false, emitted: false };
  // :6543. A gesture that never fed the scroller has no flick to continue.
  if (!state.emitted || !world.momentum) return done(lifted, actions);
  const coast = kickoff(state.samples, event, world);
  // A failed kickoff leaves a coast in flight alone, as the page does: the only
  // cancel on this path is the one inside `startScrollMomentum` (:6149), which
  // a failed gate never reaches. Nothing arrives here with a coast anyway, since
  // only a lift starts one and every touchstart and cancel clears it.
  return done(coast === null ? lifted : { ...lifted, coast }, actions);
}

/** The lift's decision: a coast to run, or null (term.html:6543-6552, :6148-6157). */
function kickoff(
  samples: readonly VelocitySample[],
  event: { readonly t: number; readonly th: number },
  world: TouchScrollWorld,
): Coast | null {
  const newest = samples[samples.length - 1];
  // :6545-6547. The gap from the newest sample to the lift, on whichever clock
  // reads it as shorter: the flick-favourable reading in both worlds, while a
  // genuine hold is long on both. No samples at all is an infinite gap.
  const gap = newest
    ? Math.max(0, Math.min(event.t - newest.t, event.th - newest.th))
    : Number.POSITIVE_INFINITY;
  let v0 = releaseVelocity(samples);
  // :6549-6550.
  if (gap > GAP_STILL_MS) v0 = 0;
  else v0 *= Math.exp(-gap / GAP_ATTEN_TAU_MS);
  // :6551. The gate is rows per second, not px/ms, so the same finger speed
  // coasts on a small font and not on a large one. It is the ATTENUATED
  // velocity that faces it.
  if (!((Math.abs(v0) * 1000) / world.cellHeightPx >= MOMENTUM_MIN_START_ROWS_PER_S)) return null;
  return {
    // :6154. A drag with the finger going down feeds negative px while its
    // release velocity is positive, so the coast continues the motion by
    // feeding the negated velocity.
    velPxPerMs: -v0,
    coastedPx: 0,
    // :6155-6156. Measured once, here, and not re-read per frame.
    stopVelPxPerMs: (MOMENTUM_STOP_ROWS_PER_S * world.cellHeightPx) / 1000,
    capPx: MOMENTUM_MAX_COAST_SCREENS * world.screenHeightPx,
    // :6157. `performance.now()` at the lift, which the component supplies as
    // the event's own handling stamp.
    at: event.th,
  };
}

/** One coast frame (term.html:6158-6168). */
function onFrame(
  state: TouchScrollState,
  now: number,
  world: TouchScrollWorld,
): TouchScrollReduction {
  const coast = state.coast;
  if (coast === null) return done(state, NOTHING);
  // :6159-6160. Decay first, on a dt that a throttled tab cannot inflate.
  const dt = Math.min(COAST_FRAME_CAP_MS, now - coast.at);
  const velPxPerMs = coast.velPxPerMs * Math.exp(-dt / MOMENTUM_TAU_MS);
  // :6161. The three ways a coast ends, in the page's order. All of them are
  // silent: the frame that stops emits nothing.
  if (
    Math.abs(velPxPerMs) < coast.stopVelPxPerMs ||
    coast.coastedPx >= coast.capPx ||
    !world.mounted
  ) {
    return done({ ...state, coast: null }, NOTHING);
  }
  // :6164-6166.
  const stepPx = velPxPerMs * dt;
  return feed(
    {
      ...state,
      coast: {
        ...coast,
        velPxPerMs,
        coastedPx: coast.coastedPx + Math.abs(stepPx),
        at: now,
      },
    },
    stepPx,
    world,
  );
}

/** A cancel ends the gesture. See the header for how term.html differs. */
function onCancel(state: TouchScrollState): TouchScrollReduction {
  return done(
    {
      ...state,
      startY: null,
      lastY: null,
      moved: false,
      accumPx: 0,
      samples: NO_SAMPLES,
      emitted: false,
      coast: null,
    },
    NOTHING,
  );
}

/**
 * The one emission path, shared by the live drag and the coast
 * (term.html:6117-6128).
 *
 * Signed finger px go in; every rowPx of accumulated travel comes back out as
 * one discrete line wheel, and the sub-row remainder stays for next time. rowPx
 * is `cellHeight / scrollSpeed`, so the pref reads as wheels per finger
 * row-height, and it is re-measured on every feed.
 */
function feed(
  state: TouchScrollState,
  deltaPx: number,
  world: TouchScrollWorld,
): TouchScrollReduction {
  const accumPx = state.accumPx + deltaPx;
  const rowPx = world.cellHeightPx / scrollSpeedMult(world.scrollSpeed);
  // :6120. An unmeasurable row keeps the px rather than spending them, so a
  // feed taken while the screen has no box is not travel thrown away.
  if (!(rowPx > 0)) return done({ ...state, accumPx }, NOTHING);
  // :6121-6122. Truncation toward zero, so the remainder keeps its sign.
  const whole = Math.trunc(accumPx / rowPx);
  if (whole === 0) return done({ ...state, accumPx }, NOTHING);
  // :6123-6124. The cap spends only what it emits: the px above it stay in the
  // accumulator for the next feed instead of being dropped.
  const k = Math.min(SCROLL_MAX_EVENTS_PER_FEED, Math.max(-SCROLL_MAX_EVENTS_PER_FEED, whole));
  const deltaY = k < 0 ? -1 : 1;
  const wheel: LineWheel = {
    deltaY,
    deltaMode: 1,
    bubbles: true,
    cancelable: true,
    clientX: WHEEL_CLIENT_X,
    clientY: state.emitY,
  };
  const actions: TouchScrollAction[] = [];
  for (let i = 0; i < Math.abs(k); i++) actions.push({ kind: "wheel", wheel });
  return done({ ...state, accumPx: accumPx - k * rowPx }, actions);
}
