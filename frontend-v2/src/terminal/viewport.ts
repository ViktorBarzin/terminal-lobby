/**
 * How much of the native terminal's box a soft keyboard is covering, and
 * therefore what height the host should have (frontend/term.html:8394-8420
 * `keyboardReserve`, :8427-8469 `syncViewport`, its boot seed at :8490, and the
 * inbound `tl-kb` arm at :9407-9422).
 *
 * TWO FILES ARE NAMED viewport.ts AND THEY OWN DIFFERENT THINGS.
 *   `src/mobile/viewport.ts` is the SHELL's. It installs the listeners (window
 *     resize, orientationchange, visualViewport resize and scroll), publishes
 *     `--kb-offset`, `--sk-h` and `--app-vh`, toggles `body.tl-kb-up`, undoes a
 *     scroll the platform imposed, and forwards the height it measured to
 *     whatever terminal is mounted. It measures once, for the whole app.
 *   THIS file is the TERMINAL's, and it decides exactly one number: how many
 *     pixels to take off the host's box. It reads nothing, writes nothing, and
 *     holds no clock.
 *
 * WIRED, as of the mirror pass: `TerminalNative`'s `feedViewport` performs it,
 * fed `observed` from the mount seed and from its ResizeObserver and
 * `forwarded` from the `__tlKeyboardOffset` bridge, and writes
 * `hostHeightStyle` where that bridge used to do the arithmetic inline. The
 * bridge's `!host` guard stayed, since there is nothing to write to and nothing
 * to fit; its own `Number.isFinite(px)` check went, because `ignored` is what
 * this module answers for the same input and the two agreed.
 *
 * WHAT WAS ALREADY DONE BEFORE THIS MODULE, so a reader can see how little is
 * left of `syncViewport` to port. Pass 1 wired the receiving half, and the CSS
 * carries most of the rest:
 *   - `--kb-offset` is the shell's, published from its own visualViewport
 *     reading (mobile/viewport.ts:246). The shell IS the top window, so
 *     term.html's "the lobby forwards the real height" has no analogue pointing
 *     the other way and `max(own, forwarded)` collapses to `own` for that
 *     property. Nothing here writes it.
 *   - term.html's `tbH` term, the soft-key toolbar coming out of the terminal,
 *     is `--sk-h` inside `.tl-views` margin-bottom (app.css:2432-2448,
 *     published at mobile/viewport.ts:267). The container the host fills is
 *     already toolbar-free and safe-area-free.
 *   - term.html's `cbH` term IS NOT THIS MODULE'S, and it is not absent either.
 *     An earlier version of this line said nothing sits over the terminal's
 *     box, which was true until the compose mirror mounted its bar over it: the
 *     mirror pass added the bar as a second term on the same style write
 *     (TerminalNative's `barReservePx`, term.html:8461 and :8467), off the
 *     bar's live `offsetHeight` and 0 for the ghost render, behind the same two
 *     gates as the reserve this module decides. So a reader wiring a new caller
 *     owes that term as well as `shrinkPx`. The TEXT view's composer is a
 *     different surface again, inside a sibling `.tl-view`
 *     (SessionView.tsx:922-956), and never over the terminal.
 *   - both of the page's gates are already in that bridge, as
 *     `window.visualViewport && coarsePointer`.
 *   - the fit that has to follow a height change is TerminalNative's, debounced
 *     (`refit("fit-wanted")`), and the host's own ResizeObserver asks for one
 *     on any box change anyway (its `new ResizeObserver`). So no action here
 *     PERFORMS a fit; the owes list below says which of the three answers must
 *     not be followed by one, because the page's own answers differ on exactly
 *     that.
 *
 * SO WHAT IS LEFT IS TWO THINGS.
 *
 * 1. THE TERMINAL NEVER READS THE VIEWPORT FOR ITSELF, AND THE SHELL FORWARDS
 *    ON CHANGE ONLY. `installViewportSync` is installed once at the SHELL and
 *    stays installed for the whole app, the list screen and an open session
 *    alike (App.tsx:181-196, which records that the install moved there BECAUSE
 *    a per-session one did not run until a session was opened). What is missing
 *    is not the install, it is the message: `onKeyboard` fires only when the
 *    height the shell measured DIFFERS from the last one it sent
 *    (mobile/viewport.ts:259-262). A terminal that mounts later is never told,
 *    because nothing changed: a session opened while the keyboard is already
 *    up, a switch back to the terminal view, `?native=1` on a tab that started
 *    on the list. Its host keeps the stylesheet's `height: 100%` and the bottom
 *    rows, the prompt among them, sit behind the keyboard until the keyboard
 *    next moves.
 *
 *    THE SHIPPED PAGE HAS THE SAME HOLE, and an earlier draft of this header
 *    claimed the opposite. term.html does seed, by calling `syncViewport()` at
 *    boot (:8490) off a live read, and STANDALONE that seed reserves the
 *    keyboard, because the page's own visualViewport shrank. FRAMED, which is
 *    the only configuration the lobby ships, it reserves nothing: the frame's
 *    own reading is 0 (:8402-8404) and `framedKb` starts at 0 (:8425), so
 *    `keyboardReserve` answers `offset` 0 and `shrink` 0 and the boot height is
 *    the no-keyboard one. Nor is there a second seed. `keyboardToFrame`
 *    (TerminalView.tsx:420-424) is reachable only through `__tlKeyboardOffset`
 *    (bound at :469), whose single caller is App.tsx:195, which the shell
 *    invokes only when `kb !== lastKb` (mobile/viewport.ts:259-262), and the
 *    iframe's own `onLoad` (TerminalView.tsx:500) seeds the Alt state and
 *    nothing else. So on an iPad with the keyboard already up the prompt sits
 *    behind it until the keyboard next moves, in the shipped page as much as in
 *    the native path.
 *
 *    `observed` is the viewport asked from here, and a mount asks it. It closes
 *    a hole both paths have, rather than reproducing something the page does.
 *
 * 2. ONCE THE TERMINAL DOES READ FOR ITSELF IT HOLDS TWO READINGS OF ONE
 *    KEYBOARD, and term.html's arithmetic cannot express that. Its `shrink` is
 *    the forwarded height ALONE (:8419), which is safe there because the two
 *    readings are never both non-zero in that page: framed, an iframe's own
 *    visualViewport does not move when the keyboard opens (:8402-8404) so its
 *    reading is 0; standalone, nothing forwards (:8423-8424) so the forwarded
 *    one is 0. Natively there is no iframe, the terminal sits in the top window,
 *    and the shell measures that same window, so both readings are the SAME
 *    keyboard and both are non-zero. Subtracting both leaves a 60px terminal on
 *    an iPhone. What comes off the host is `max(own, forwarded)`, which is
 *    term.html's own `offset` and its own reason: "The two readings describe the
 *    SAME keyboard, so `offset` is the larger of them, never the sum"
 *    (:8413-8414).
 *
 *    AND A FORWARDED HEIGHT DOES NOT OUTLIVE ITS MESSAGE, which is where
 *    term.html's `framedKb` (:8425) is deliberately left behind. Natively the
 *    two readings are not two sources, they are one measurement taken twice:
 *    the shell computes `keyboardOffset(window.innerHeight, vv.height,
 *    vv.offsetTop)` (mobile/viewport.ts:27-33, :242-244) on the same window
 *    this terminal reads, character for character the `own` below. So a
 *    remembered forwarded number can never legitimately exceed a fresh `own`
 *    reading, and any excess is age: taking `max(own, remembered)` would pin
 *    the reserve at the STALE maximum, where a live reading of 0 cannot give
 *    the rows back. Nor would that be a one-frame lag. `__tlKeyboardOffset` is
 *    a global claimed via `ownWhile` (TerminalNative's `__tlKeyboardOffset`)
 *    and every visited
 *    session stays mounted, so a terminal that hands the bridge over never
 *    receives the close, and one missed zero-forward would hold it short for
 *    the rest of the mount.
 *
 *    term.html needs that memory for a reason with no native analogue: its own
 *    reading is blind for the whole life of a framed page, so the forwarded
 *    number is the only one it will ever have. Here the only blindness is "no
 *    `visualViewport` at all", and gate 1 decides nothing on it for every event,
 *    since the API cannot appear mid-session. The same goes for the pointer
 *    gate: `coarsePointer` is read once per mount (TerminalNative's own
 *    `const coarsePointer`), so a
 *    refusal there is permanent too, and a number remembered behind either gate
 *    could never be spent.
 *
 *    So `px` is used on the event that carries it, alongside that event's own
 *    facts, and `observed` reserves `own`. The contract on `px` is that it is
 *    `keyboardOffset`, the same formula as `own`, and NOT the other number
 *    mobile/viewport.ts computes: `coveredAtBottom` (:57-63) counts a shrunken
 *    LAYOUT viewport as coverage, so forwarding that instead would take the
 *    Android emulator's measured 312px off a container that had already shrunk
 *    itself.
 *
 * WHY THE ANSWER IS A SHRINK AND NOT A PIXEL HEIGHT. term.html writes an
 * absolute `vv.height - shrink - tbH - cbH` because its `terminalEl` fills a
 * whole iframe: the frame's layout viewport IS the terminal's box. Here the
 * host sits inside a `.tl-view`, `position: absolute; inset: 0` within
 * `.tl-views.tl-kb-inline` (app.css:1110-1120), which has the toolbar and the
 * safe area out of its bottom already and deliberately leaves the keyboard IN
 * (app.css:2437-2448), so what the caller needs is how much of THAT box the
 * keyboard covers.
 *
 * An absolute `vv.height` written onto the host would miss that box by
 * `--sk-h + --safe-b + the session bar - offsetTop`. Four terms, not the two an
 * earlier draft of this header named and called exact. `.tl-views` is the flex
 * remainder BELOW `.tl-session-bar` (SessionView.tsx:659 and :921,
 * sidebar.css:804-818), so the bar's height is out of the box as well, and
 * `vv.height` has already taken the pan off itself. Three of the four are the
 * container chain. The fourth, `offsetTop`, is where this module and the page's
 * formula genuinely disagree, which the divergence block below settles against
 * two measured edges.
 *
 * WHERE THE SHRINK AND term.html'S HEIGHT DIVERGE, and why the divergence is
 * the right way round here.
 *
 * When `offsetTop` is 0 the two land on the same pixel: framed, `vv.height` is
 * the frame's whole layout height and `shrink` is the forwarded number;
 * standalone, nothing forwards, so `shrink` is 0 and `vv.height` is
 * `layout - own`. Both come out at `layout - max(own, fwd)`, because the other
 * reading is 0 in each.
 *
 * When the visual viewport is PANNED, which iOS does to bring a focused field
 * into view, they differ by exactly `offsetTop`. `vv.height` is
 * `layout - own - offsetTop` by the definition of `own` below, so term.html's
 * height off a layout-anchored box implies a shrink of `own + offsetTop`, where
 * this module reserves `own`. At 812/436/100 that is 376 against 276.
 *
 * `own` is the number that composes with THIS app's layout, and the check is
 * two edges meeting:
 *   the container's bottom edge is `layout - --sk-h - --safe-b`
 *     (app.css:2446-2448), and `#root` is `height: var(--app-vh)`, which is
 *     `window.innerHeight` (app.css:30-34, mobile/viewport.ts:276), so the box
 *     is layout-anchored;
 *   the toolbar is fixed at `bottom: calc(var(--kb-offset) + var(--safe-b))`
 *     (app.css:2300), so its top edge is
 *     `layout - --kb-offset - --safe-b - --sk-h`;
 *   `--kb-offset` is the shell's `keyboardOffset(...)` (mobile/viewport.ts:244),
 *     which carries `offsetTop` exactly as `own` does.
 * So a shrink of `own` puts the host's bottom edge on the toolbar's top edge
 * whatever the pan, and `own + offsetTop` would leave an `offsetTop`-tall gap
 * above the toolbar. The panned-viewport block in the tests measures both edges
 * rather than leaving that in prose.
 *
 * ONE CONSEQUENCE OF THE SEED THAT NOTHING UNDER test/ CAN SETTLE. Writing a
 * shrink moves the host's bottom edge up, and natively that box is the tap
 * target's own ancestor, where term.html shrank its `#terminal` inside an
 * iframe that stayed put. That is the shape of the bug app.css:2437-2445
 * records against the CONTAINER version: a tap below ~54% of the screen blurred
 * the field and flashed the keyboard shut (measured 390x844, dated 2026-08-17
 * at term.html:8406-8411). Shrinking the HOST is what the shipped page already
 * does through this bridge, in its gate and its height write, so the seed adds a
 * moment when that happens rather than a new mechanism. It still wants the
 * Android emulator or a real phone to confirm, and no unit test here can.
 *
 * WHAT THE COMPONENT STILL OWES, per action. The module decides and the
 * component acts, so a side effect missing from this list is one nobody
 * performs:
 *   host-height: write `hostHeightStyle(shrinkPx)` to `host.style.height`,
 *                then fit.
 *   nothing:     write no height, then fit anyway. The reserve has not moved,
 *                so the string already on the host is the right one, but the
 *                box may have changed WIDTH.
 *   ignored:     nothing at all, the fit included. The one answer that must not
 *                be followed by a fit.
 *
 * THE FIT IS ON THAT LIST BECAUSE THE THREE ANSWERS DISAGREE ABOUT IT, and the
 * disagreement is term.html's own. What is unconditional in the page is the fit
 * relative to `syncViewport`'s two GATES: the four viewport listeners call
 * `refit()` with no gate at all (:8482-8486), so a `syncViewport` that returned
 * at :8428 or skipped the height write at :8441 is still followed by a fit. The
 * `tl-kb` arm is the exception, and it is the arm `forwarded` models: its
 * `refit()` (:9421) sits INSIDE
 * `if (e.source === window.parent && Number.isFinite(e.data.px))` (:9418), so a
 * junk message asks for no fit. Pass 1 does the same, returning at
 * the bridge's own `Number.isFinite` guard before both the height write and the
 * refit that follows it. An
 * earlier draft of this list read that arm as unconditional and told the
 * component to fit on every trigger whatever the action, which would have
 * emitted a tmux resize the page does not.
 *
 * `nothing` STILL DOES NOT MEAN "DO NOTHING". A container that changed WIDTH
 * with the reserve unmoved has a new column count, and that is the only thing
 * TerminalNative's ResizeObserver exists for, so a wiring that skipped
 * the fit on `nothing` would silence every non-keyboard resize: a view switch,
 * a window resize, the sidebar, an orientation change with the keyboard down.
 * The fit is debounced in the component because the keyboard animates over
 * ~250ms and fires a burst, and each fit emits a tmux resize
 * (term.html:8390-8393).
 *
 * WHAT THE DEDUPE COSTS, since answering `nothing` on an unmoved reserve is the
 * one place this module is quieter than the page. term.html rewrites the same
 * height string on every call (:8466), which self-heals: a write that did not
 * land is repaired by the next event. Skipping the write gives that up, so
 * `appliedShrink` is a claim about ONE element's inline style, and a component
 * that mounts a new host starts again from NO_KEYBOARD_RESERVE rather than
 * carrying the old number over. What it buys is the style write and nothing
 * else, and on iOS's fractional readings it buys almost nothing, since two
 * readings a fraction of a pixel apart are two distinct reserves. It earns its
 * keep on the settled bursts, a visualViewport `scroll` that moves nothing
 * among them.
 *
 * The component also owes the FACTS, gathered at the moment it asks rather than
 * cached when the trigger fired: `window.innerHeight`,
 * `window.visualViewport?.height ?? null`,
 * `window.visualViewport?.offsetTop ?? 0` and its once-per-mount
 * `coarsePointer`. A geometry cached when a resize fired can be stale by the
 * time the decision runs, which is the same rule fit.ts states for its box.
 *
 * THE `?? 0` ON `offsetTop` IS LOAD-BEARING and an earlier draft of this list
 * left it off. `Number.isFinite(undefined)` is false, so `measurable` would be
 * false and `own` would be 0 on EVERY event, and the seed this module exists
 * for would reserve nothing. Under `strict: true` the expression without it
 * does not compile, since `window.visualViewport` is `VisualViewport | null`
 * and `?.offsetTop` is therefore `number | undefined` against an `offsetTop:
 * number` field. That compile error is the only reason the omission is a
 * nuisance rather than a shipped bug, so it is worth writing down that the
 * fallback is 0 and not `undefined`.
 */

/** The world as of one trigger, read fresh. Nothing here is remembered by the module. */
export interface ViewportFacts {
  /**
   * `window.innerHeight`. The LAYOUT viewport, which iOS Safari does NOT shrink
   * when the soft keyboard rises. That is the whole reason this module exists.
   */
  readonly layoutHeight: number;
  /**
   * `window.visualViewport.height`, or `null` when the browser has no
   * `visualViewport` at all. `null` is term.html's `if (!window.visualViewport)
   * return` (:8428): nothing is decided, rather than decided from a fallback
   * the page never uses.
   */
  readonly visualHeight: number | null;
  /** `window.visualViewport.offsetTop`. Read with `visualHeight`, and meaningless without it. */
  readonly offsetTop: number;
  /**
   * `matchMedia("(pointer: coarse)").matches`. A fact per event rather than a
   * live query because both pages read it once for their lifetime
   * (term.html:6350, and TerminalNative's `const coarsePointer`), so a
   * pointer type that changes
   * mid-session moves nothing in either.
   */
  readonly coarsePointer: boolean;
}

/** The two readings of one keyboard, and what comes off the host because of them. */
export interface KeyboardReserve {
  /** What the terminal's own visualViewport says is covered. term.html's `own`. */
  readonly own: number;
  /** What the shell forwarded on this event. term.html's `fwd`. */
  readonly forwarded: number;
  /** The larger of the two, never the sum. term.html's `offset`. */
  readonly offset: number;
}

export interface ViewportState {
  /**
   * The shrink currently on the host, in pixels. 0 means the host carries the
   * stylesheet's `height: 100%`, which is also where a freshly mounted terminal
   * starts: no inline height and no keyboard are the same rendered box.
   *
   * The whole state, deliberately. term.html also keeps `framedKb` (:8425); the
   * header's item 2 carries why remembering a forwarded height natively pins
   * the reserve at the stale maximum instead of tracking the keyboard.
   */
  readonly appliedShrink: number;
}

/** A host with no inline height and no keyboard. Where a freshly mounted terminal starts. */
export const NO_KEYBOARD_RESERVE: ViewportState = { appliedShrink: 0 };

export type ViewportEvent =
  /**
   * Read the viewport and decide again. The mount seed, a window resize, an
   * orientationchange, a visualViewport resize or scroll: term.html funnels all
   * of them into one `syncViewport()` call, and they are one question here for
   * the same reason.
   */
  | { type: "observed"; facts: ViewportFacts }
  /**
   * The shell measured the keyboard and told us (`__tlKeyboardOffset`, the
   * `tl-kb` message). Carries facts as well, because term.html recomputes from
   * a LIVE read rather than from the forwarded number alone (:9419-9420), and
   * because natively the live read is the better half of the pair: `px` is
   * spent on this event and not remembered past it.
   *
   * `px` must be the shell's `keyboardOffset` (mobile/viewport.ts:27-33), which
   * is the same formula as `own`, and not its `coveredAtBottom` (:57-63).
   */
  | { type: "forwarded"; px: number; facts: ViewportFacts };

export type ViewportAction =
  /**
   * Give the host this much less than its container. 0 hands the box back to
   * the stylesheet; `hostHeightStyle` turns the number into the value to write.
   * Fit after it.
   */
  | { kind: "host-height"; shrinkPx: number }
  /**
   * The reserve did not move, or a gate refused. Write no height, and fit
   * anyway: term.html's four viewport listeners refit outside both of
   * `syncViewport`'s gates (:8482-8486), and the box may have changed width.
   */
  | { kind: "nothing" }
  /**
   * The event was not ours to act on. Write no height and do NOT fit, which is
   * the whole reason this is a third answer rather than a second `nothing`:
   * term.html keeps the `tl-kb` arm's `refit()` inside the same finite gate as
   * everything else it does (:9418, :9421), and pass 1 returns before its own
   * (the bridge's `Number.isFinite` guard, ahead of its trailing refit). Two
   * answers could not tell the component
   * which `nothing` it was looking at.
   */
  | { kind: "ignored" };

export interface ViewportReduction {
  /** Identical to the state passed in when nothing moved, so a caller can compare by identity. */
  readonly state: ViewportState;
  readonly action: ViewportAction;
  /**
   * The reason, for the log line. Unlike fit.ts, a `nothing` here can carry
   * one: which of the two gates refused is the interesting half of the answer
   * when a phone reports no reservation at all.
   */
  readonly why: string;
}

/**
 * The two readings and their winner (term.html:8416-8420). Two things differ
 * from the page's three lines, and both are below: `shrink` is not on the
 * result, and the own reading gets a finite check.
 *
 * `shrink` is deliberately NOT on the result. In the page it is the forwarded
 * height alone, which only works because the two readings are never both
 * non-zero there; natively they are, and the header carries the derivation.
 * What a native host needs is `offset`.
 *
 * `Math.max(0, forwarded || 0)` is the page's expression, and its `|| 0` is
 * what neutralises a NaN. The own reading gets a finite check the page does not
 * have: its inputs are `window.innerHeight` and two visualViewport reads, which
 * cannot be NaN, while a pure function can be called with anything. All three
 * inputs are checked, `offsetTop` included, since it poisons the subtraction the
 * same way.
 *
 * WHAT THE CHECK BUYS IS NOT SAFETY, and an earlier draft of this comment said
 * it "fails in the safe direction". It does not. Answering `own` 0 where the
 * host already carries a reserve moves the reserve to 0, `hostHeightStyle`
 * writes "", and the rows go back under the keyboard, which is the harm the
 * module exists to prevent. An unchecked NaN would not put an invalid `calc()`
 * on the host either: `hostHeightStyle(NaN)` is "" too, because `NaN > 0` is
 * false. What the check buys is two other things. A junk own reading cannot
 * poison a GOOD forwarded height, where `Math.max(NaN, fwd)` is NaN. And NaN
 * cannot reach `appliedShrink`, where `NaN === NaN` is false, so the dedupe
 * would answer `host-height` on every later event however settled the keyboard
 * was and the state would stop being a claim about the host at all. Facts that
 * are actually finite stay the caller's job, and the owes list says how
 * `strict: true` holds it to that.
 */
export function keyboardReserve(
  layoutHeight: number,
  visualHeight: number,
  offsetTop: number,
  forwarded: number,
): KeyboardReserve {
  const measurable =
    Number.isFinite(layoutHeight) && Number.isFinite(visualHeight) && Number.isFinite(offsetTop);
  const own = measurable ? Math.max(0, layoutHeight - visualHeight - offsetTop) : 0;
  const fwd = Math.max(0, forwarded || 0);
  return { own, forwarded: fwd, offset: Math.max(own, fwd) };
}

/**
 * The value to write to `host.style.height`.
 *
 * The one place that knows the host's height is RELATIVE: the container has the
 * toolbar and the safe area out of it already and the keyboard still in
 * (app.css:2446-2448), so the reserve is a shrink off it. Relative is also what
 * lets the box keep tracking `window.innerHeight` between writes, which matters
 * because the reduction above writes once per distinct reserve where the page
 * rewrote an absolute pixel height every call: the container chain resolves to
 * `#root { height: var(--app-vh) }` and `--app-vh` IS `window.innerHeight`
 * (app.css:30-34, mobile/viewport.ts:276).
 *
 * Empty at 0 so the box goes back to the stylesheet's `height: 100%` instead of
 * carrying an inline `calc(100% - 0px)`, which is what the bridge's height
 * write already does.
 *
 * A reserve taller than the container is not clamped, where term.html clamps
 * its pixel height with `Math.max(0, ...)` (:8467): CSS clamps a `calc()` that
 * resolves negative to 0 for `height`, so the rendered box is 0 either way and
 * what xterm's fit measures is that zero-height box.
 */
export function hostHeightStyle(shrinkPx: number): string {
  return shrinkPx > 0 ? `calc(100% - ${shrinkPx}px)` : "";
}

/** The whole decision. Nothing here reads an element, a media query or a clock. */
export function reduce(state: ViewportState, event: ViewportEvent): ViewportReduction {
  // A NON-FINITE FORWARDED HEIGHT DISCARDS THE WHOLE MESSAGE, rather than being
  // ignored down to a recompute from the live facts. term.html gates the entire
  // `tl-kb` arm on `Number.isFinite(e.data.px)` (:9418), so a junk message
  // moves no `framedKb`, calls no `syncViewport` (no `--kb-offset` write and no
  // height write) and reaches no `refit()` either, since that call is inside the
  // same gate (:9421). TerminalNative used to return at its own
  // `Number.isFinite` guard, ahead of both the host write and the refit that
  // follows it, and now hands the message here instead. Falling through would
  // let a message both callers ignore write a height, off facts that have
  // nothing to do with the bad number. `ignored` and not `nothing`, because those two differ on the
  // fit and only the action can carry that. `keyboardReserve` still clamps a
  // NaN to 0 through its own `|| 0`, because that is the page's HELPER;
  // discarding here is the page's CALLER, and the two are different jobs.
  if (event.type === "forwarded" && !Number.isFinite(event.px)) {
    return {
      state,
      action: { kind: "ignored" },
      why: "a forwarded height that is not a number",
    };
  }

  const { facts } = event;

  // Gate 1: `if (!window.visualViewport) return;` (term.html:8428). Nothing is
  // measured and nothing is written.
  if (facts.visualHeight === null) {
    return { state, action: { kind: "nothing" }, why: "no visualViewport to read" };
  }

  // Gate 2: the height write lives inside `if (isCoarsePointer)`
  // (term.html:8441). A fine pointer has no soft keyboard to make room for, and
  // taking rows off a desktop terminal because the browser moved its visual
  // viewport is a regression rather than a reservation.
  if (!facts.coarsePointer) {
    return {
      state,
      action: { kind: "nothing" },
      why: "a fine pointer, so no soft keyboard",
    };
  }

  // The forwarded reading is this event's or none. Header item 2 carries why it
  // is not remembered: natively it is the same measurement as `own`, so a
  // remembered one can only be older. The `Math.max(0, ...)` is the page's own
  // caller-side clamp (:9419), which it applies as well as the helper's
  // (:8418), so both are here for the same reason they are both there.
  const reserve = keyboardReserve(
    facts.layoutHeight,
    facts.visualHeight,
    facts.offsetTop,
    event.type === "forwarded" ? Math.max(0, event.px) : 0,
  );

  if (reserve.offset === state.appliedShrink) {
    return { state, action: { kind: "nothing" }, why: "" };
  }

  return {
    state: { appliedShrink: reserve.offset },
    action: { kind: "host-height", shrinkPx: reserve.offset },
    why: describeReserve(reserve),
  };
}

function describeReserve(reserve: KeyboardReserve): string {
  if (reserve.offset === 0) return "the keyboard is gone, the host gets its box back";
  const source =
    reserve.own >= reserve.forwarded ? "measured here" : "forwarded by the shell";
  return `the keyboard covers ${reserve.offset}px of the host (${source})`;
}
