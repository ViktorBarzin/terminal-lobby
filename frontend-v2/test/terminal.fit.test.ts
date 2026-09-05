import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  NO_FIT_OWED,
  hasBox,
  isFitOwed,
  reduce,
  type FitAction,
  type FitEvent,
  type FitState,
  type HostBox,
} from "../src/terminal/fit";

/**
 * The fit guard's rules, as term.html:5579-5613 paid for them.
 *
 * THE FAILURE BEHIND ALL OF IT. The lobby keeps every visited session mounted
 * and CSS-hides the ones you are not looking at (src/store/keepalive.ts, and
 * `.tl-hidden { display: none !important }` in app.css), so a hidden host div
 * has a 0x0 box. Fitting xterm against that computes a ~13x7 grid, xterm emits
 * it as a resize, and ttyd's tmux client drags the REAL window down to 13
 * columns, squeezing every other client attached to that session. So a
 * zero-size fit is skipped and OWED, and the debt is settled the next time
 * there is a box to fit into (term.html replays at :9441).
 */

const BIG: HostBox = { width: 800, height: 600 };

/** The debt term.html's `owed` flag carries: one fit was skipped, none has landed since. */
const OWED: FitState = { owed: true };

const fitWanted = (box: HostBox | null): FitEvent => ({ type: "fit-wanted", box });
const shown = (box: HostBox | null): FitEvent => ({ type: "shown", box });

/** Every box the page's `!(box.width > 0) || !(box.height > 0)` refuses. */
const NO_BOX: ReadonlyArray<readonly [string, HostBox | null]> = [
  ["a hidden host, measured 0x0", { width: 0, height: 0 }],
  ["zero width", { width: 0, height: 600 }],
  ["zero height", { width: 800, height: 0 }],
  ["a negative width", { width: -1, height: 600 }],
  ["a negative height", { width: 800, height: -1 }],
  ["NaN width", { width: Number.NaN, height: 600 }],
  ["NaN height", { width: 800, height: Number.NaN }],
  ["no element to measure at all", null],
];

describe("a fit with a box behind it", () => {
  /**
   * The ordinary case, and the one that must stay cheap: the terminal is on
   * screen, something reflowed, so fit and tell the pty.
   */
  it("passes a normal fit straight through", () => {
    const r = reduce(NO_FIT_OWED, fitWanted(BIG));
    expect(r.action).toBe("fit");
    expect(isFitOwed(r.state)).toBe(false);
    expect(r.why).toBe("the host box is 800x600");
  });

  /**
   * A sub-pixel box still fits: the page's test is `> 0`, not `>= 1`, and a
   * flex child mid-animation legitimately measures 799.5 wide.
   */
  it("fits a fractional box, as the page's `> 0` test does", () => {
    expect(reduce(NO_FIT_OWED, fitWanted({ width: 799.5, height: 0.5 })).action).toBe("fit");
  });

  /**
   * The SPA's own backstop, and the reason the debt does not have to be
   * cleared by the visibility signal: a host that regains a box fires the
   * ResizeObserver, which arrives here as an ordinary `fit-wanted`. That fit
   * settles the debt like any other.
   */
  it("clears a standing debt when any fit lands", () => {
    const r = reduce(OWED, fitWanted(BIG));
    expect(r.action).toBe("fit");
    expect(isFitOwed(r.state)).toBe(false);
  });

  /**
   * `FitReduction.state`'s identity promise, on the path that runs most often.
   * A fit with nothing owed moves no debt, so the state comes back as the SAME
   * object and a caller can compare by identity. Returning a fresh
   * `{ owed: false }` there would allocate on every resize notification, and
   * measured with that change in place, only this test and the one below it
   * caught it; the file's other 41 tests all still passed.
   */
  it("hands the state object straight back when a fit moves no debt", () => {
    expect(reduce(NO_FIT_OWED, fitWanted(BIG)).state).toBe(NO_FIT_OWED);
  });

  /** And when a fit DOES clear a debt, the cleared state is the shared constant. */
  it("clears a debt onto NO_FIT_OWED rather than a fresh object", () => {
    expect(reduce(OWED, fitWanted(BIG)).state).toBe(NO_FIT_OWED);
  });
});

describe("a fit with nothing to fit into", () => {
  it.each(NO_BOX)("skips and owes a fit for %s", (_name, box) => {
    const r = reduce(NO_FIT_OWED, fitWanted(box));
    expect(r.action).toBe("skip");
    expect(isFitOwed(r.state)).toBe(true);
    expect(r.why).not.toBe("");
  });

  /**
   * `hasBox` is the page's `!box || !(box.width > 0) || !(box.height > 0)`,
   * inverted. NaN is the case a `=== 0` test would wave through: NaN > 0 is
   * false, so the page refuses it, and a fit against a NaN box is a grid
   * computed from nothing.
   */
  it.each(NO_BOX)("reads %s as no box", (_name, box) => {
    expect(hasBox(box)).toBe(false);
  });

  it("reads a real box as a box", () => {
    expect(hasBox(BIG)).toBe(true);
  });

  /**
   * The debt is a single flag, exactly as it is in the page. Ten skipped fits
   * behind a hidden session owe ONE fit, not ten, because only the last
   * geometry was ever going to be right.
   */
  it("collapses two skipped fits into one debt", () => {
    const first = reduce(NO_FIT_OWED, fitWanted({ width: 0, height: 0 }));
    const second = reduce(first.state, fitWanted(null));
    expect(second.action).toBe("skip");
    expect(isFitOwed(second.state)).toBe(true);

    const replay = reduce(second.state, shown(BIG));
    expect(replay.action).toBe("fit");
    expect(isFitOwed(replay.state)).toBe(false);
    // One replay, and nothing left owed to fire a second.
    expect(reduce(replay.state, shown(BIG)).action).toBe("nothing");
  });

  /**
   * Refusals hand back the state OBJECT, so a component can compare by
   * identity and skip the work behind a change. That is the same contract
   * held.ts's `offer` gives its refusals, and it holds for all three actions:
   * the `fit` arm is pinned by the two tests above.
   */
  it("hands back the same state object when the debt does not move", () => {
    expect(reduce(OWED, fitWanted(null)).state).toBe(OWED);
    expect(reduce(NO_FIT_OWED, shown(BIG)).state).toBe(NO_FIT_OWED);
  });
});

describe("coming back on screen", () => {
  /**
   * The replay (term.html:9441). Switching away from a session and back is
   * what makes this reachable: the boot fit or the observer's notification was
   * skipped while the view was hidden, and this is the first moment there is a
   * box to honour it with.
   */
  it("replays the owed fit and clears the debt", () => {
    const r = reduce(OWED, shown(BIG));
    expect(r.action).toBe("fit");
    expect(isFitOwed(r.state)).toBe(false);
    expect(r.why).toBe("replaying the fit owed since the view was hidden");
  });

  /**
   * `if (!e.data.hidden && fitGuard.owed()) refit()`. The debt is half of that
   * condition, so a view switch with no fit outstanding costs nothing. Without
   * the check, every switch would emit a tmux resize for a geometry that was
   * already correct.
   */
  it("does nothing when no fit is owed", () => {
    const r = reduce(NO_FIT_OWED, shown(BIG));
    expect(r.action).toBe("nothing");
    expect(isFitOwed(r.state)).toBe(false);
    expect(r.why).toBe("");
  });

  /**
   * The debt outlives a replay that could not be honoured. The visibility
   * signal is a Solid effect and the host's box is read in the same tick, so a
   * measurement taken before the class flip has landed can still come back
   * 0x0; term.html has the same gap and closes it the same way, because its
   * replay goes through `refit()` and only clears `owed` once a fit with a real
   * box has run.
   */
  it("keeps the debt when the box is still zero", () => {
    const r = reduce(OWED, shown({ width: 0, height: 0 }));
    expect(r.action).toBe("skip");
    expect(isFitOwed(r.state)).toBe(true);
    // The identity promise on this arm too: the debt did not move, so neither
    // did the object.
    expect(r.state).toBe(OWED);
  });

  /**
   * A `shown` event never invents a debt. Nothing asked for a fit, so a view
   * that comes on screen at 0x0, a slot shown while its parent is still hidden,
   * leaves the guard with nothing to replay later.
   */
  it.each(NO_BOX)("owes nothing new when shown with %s and no debt", (_name, box) => {
    const r = reduce(NO_FIT_OWED, shown(box));
    expect(r.action).toBe("nothing");
    expect(isFitOwed(r.state)).toBe(false);
  });
});

describe("the journey a hidden session takes", () => {
  /**
   * Open a session while the Text view is showing, so the terminal mounts
   * inside a `display: none` section: the boot fit is skipped, the observer's
   * 0x0 notification is skipped, and switching to Terminal is what finally
   * settles the geometry. This is the sequence the whole module exists for.
   */
  it("boots hidden, owes one fit, and settles it on the switch", () => {
    let state = NO_FIT_OWED;
    const actions: FitAction[] = [];
    const step = (event: FitEvent): void => {
      const r = reduce(state, event);
      state = r.state;
      actions.push(r.action);
    };

    step(fitWanted({ width: 0, height: 0 })); // the fit after term.open()
    step(fitWanted({ width: 0, height: 0 })); // ResizeObserver, still hidden
    step(fitWanted(null)); // the refit bridge, host not measurable
    expect(isFitOwed(state)).toBe(true);

    step(shown(BIG)); // the view switch settles it
    step(fitWanted(BIG)); // the observer's real notification behind it
    step(shown(BIG)); // switch away and back, nothing owed

    expect(actions).toEqual(["skip", "skip", "skip", "fit", "fit", "nothing"]);
    expect(isFitOwed(state)).toBe(false);
  });
});

/**
 * A "parity with the page it came from" describe stood here until 2026-09-05,
 * with `frontend/term.html`. Its five cases quoted that page's own
 * `createFitGuard` block: the zero test spelled `!(box.width > 0)` rather than
 * `=== 0`, so NaN and a negative are refused too; a skip recording the debt and
 * a fit clearing it; the guard weighing no visibility of its own; the replay
 * site `if (!e.data.hidden && fitGuard.owed()) refit();`; and the fact that the
 * page's ONE `fitAddon.fit()` call sat inside the guard, so no caller could
 * reach around it. Every one of those properties is asserted above as this
 * module's own, over its action tables. What is gone is the second
 * implementation they were compared against.
 */
describe("the contract handed to the component", () => {
  const source = readFileSync(resolve(__dirname, "../src/terminal/fit.ts"), "utf8");
  const owes = (): string => {
    const start = source.indexOf("WHAT THE COMPONENT STILL OWES");
    const end = source.indexOf("*/", start);
    expect(start, "the owes list").toBeGreaterThan(-1);
    expect(end, "the end of the owes list").toBeGreaterThan(start);
    return source.slice(start, end);
  };

  /**
   * A pure module decides; the component performs. The `skip` action's other
   * half is that the pty is not told either, and nothing in the SPA enforces
   * it: TerminalNative pairs every `fit.fit()` with `a.resize()`, so a skip
   * that still called through would still send a size. term.html cannot make
   * that mistake, because the only thing that tells its pty a size after boot
   * is `term.onResize` (:8372-8377), which cannot fire when no fit ran. So the
   * rule lives in fit.ts's comment alone, which is why this test guards the
   * word.
   */
  it("names the resize the component must not send on a skip", () => {
    expect(owes()).toContain("resize");
  });

  /**
   * The module reads no clock, no DOM and no socket, which is what lets these
   * rules be tested without a browser. Comments are stripped first, so a
   * comment that NAMES one of these (the header names several) is not read as
   * a call to it.
   */
  it("touches nothing outside its arguments", () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/document\.|window\.|Date\.now|performance\.now|requestAnimation/);
  });
});
