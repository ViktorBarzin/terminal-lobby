import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  NO_FIT_OWED,
  hasBox,
  isFitOwed,
  reduce,
  fitTarget,
  gridCramped,
  letterboxFrame,
  targetKey,
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

/**
 * WHICH SIZE, once the guard above has said a size may be taken at all.
 *
 * The design's "Watching tiles" paragraph in one function: a tile attached
 * read-only renders the session at whatever size its drivers gave it, centred,
 * with dead space where the tile does not match. Everything else fills its host.
 *
 * WHAT IT IS WORTH, measured on 2026-09-12. A session pinned 50x14 was made the
 * right-hand tile of a two-tile workspace and set to Watch only. The tile was
 * 670x601, its terminal fitted to 82x33, and tmux — which never letterboxes for
 * a client bigger than the window — drew the 50x14 window into the TOP-LEFT
 * corner, put a window border beside it and filled the rest with its own dots.
 * The eye in the header was right, the declined Grid claim was right, and the
 * picture was a bordered box in a corner of a field of dots.
 */
describe("what size a terminal takes", () => {
  const grid = { cols: 50, rows: 14 };

  it("fills the host for a tile that is driving", () => {
    expect(fitTarget(false, grid)).toEqual({ kind: "host" });
  });

  /**
   * The one that matters, and the one that was missing. Nothing in the slot
   * layer read `watching` for anything but the eye in the tile header.
   */
  it("draws the session's own grid for a tile that is watching", () => {
    expect(fitTarget(true, grid)).toEqual({ kind: "grid", cols: 50, rows: 14 });
  });

  /**
   * A driving tile OWNS the grid and claims it from its own box. Taking the
   * session's current size here would freeze the window wherever the last
   * device to speak left it — which is the bug `claimGrid` exists to fix.
   */
  it("ignores a known grid while driving, however big", () => {
    expect(fitTarget(false, { cols: 231, rows: 62 })).toEqual({ kind: "host" });
  });

  /**
   * tmux-api omits both fields when it cannot read a size, and a server that
   * predates them sends neither. The old picture — tmux's own fill — is worse
   * to look at and correct in every other way, so it is what a watcher without
   * a number falls back to.
   */
  it("falls back to the host when the grid is unknown", () => {
    expect(fitTarget(true, null)).toEqual({ kind: "host" });
    expect(fitTarget(true, undefined)).toEqual({ kind: "host" });
  });

  /**
   * `term.resize` throws below 1x1, and a terminal is whole cells or it is
   * nothing. A size that is not a size must not reach it.
   */
  it.each([
    ["no columns", { cols: 0, rows: 24 }],
    ["no rows", { cols: 80, rows: 0 }],
    ["a negative width", { cols: -80, rows: 24 }],
    ["half a column", { cols: 80.5, rows: 24 }],
    ["a width that is not a number", { cols: Number.NaN, rows: 24 }],
  ])("refuses %s and fills the host", (_why, bad) => {
    expect(fitTarget(true, bad)).toEqual({ kind: "host" });
  });

  /**
   * The component compares keys rather than objects: the grid arrives from a
   * reactive read that rebuilds it on every poll, so two equal sizes have to
   * compare equal or a watcher would re-resize its terminal every few seconds.
   */
  it("keys a target by the size it means", () => {
    expect(targetKey(fitTarget(true, grid))).toBe("50x14");
    expect(targetKey(fitTarget(true, { cols: 50, rows: 14 }))).toBe("50x14");
    expect(targetKey(fitTarget(true, { cols: 82, rows: 33 }))).toBe("82x33");
    expect(targetKey(fitTarget(false, grid))).toBe("host");
  });
});

/**
 * THE FRAME AROUND A WATCHED SESSION.
 *
 * Viktor, 2026-09-16: a session driven from a smaller screen should not be
 * scaled up, and the dead space around it should say so. These are the rules
 * for when there is a rectangle to draw at all — the drawing itself is two
 * pseudo-elements in app.css, positioned from the numbers this returns.
 */
describe("letterboxFrame", () => {
  const grid = fitTarget(true, { cols: 60, rows: 19 });
  const host: HostBox = { width: 1340, height: 809 };

  /** The measured case: 60x19 drew 432x304 inside a 1340x809 view. */
  it("frames a session smaller than the view, and names its grid", () => {
    expect(letterboxFrame(grid, { width: 432, height: 304 }, host)).toEqual({
      width: 432,
      height: 304,
      label: "60 × 19",
    });
  });

  /** A driving terminal fills its host, so there is no Grid target and no
   *  dead space to explain. */
  it("draws nothing for a terminal that fills its host", () => {
    expect(
      letterboxFrame(fitTarget(false, { cols: 60, rows: 19 }), { width: 432, height: 304 }, host),
    ).toBeNull();
    expect(letterboxFrame(grid, host, host)).toBeNull();
  });

  /**
   * `safe center` start-aligns an overflowing session, so the frame would be
   * drawn where the session is not — and the clipped edges already say the
   * session is bigger than this screen.
   */
  it.each([
    ["wider", { width: 1642, height: 500 }],
    ["taller", { width: 400, height: 900 }],
    ["both", { width: 1642, height: 900 }],
  ])("draws nothing for a session %s than the view", (_why, term) => {
    expect(letterboxFrame(grid, term, host)).toBeNull();
  });

  /** Nothing has been laid out yet, or the host is one of keepalive's hidden
   *  ones. Neither is a rectangle. */
  it("draws nothing without two real boxes", () => {
    expect(letterboxFrame(grid, null, host)).toBeNull();
    expect(letterboxFrame(grid, { width: 432, height: 304 }, null)).toBeNull();
    expect(letterboxFrame(grid, { width: 0, height: 0 }, host)).toBeNull();
  });
});

/**
 * WHEN A DRIVING VIEW HAS TO SAY ITS SIZE AGAIN.
 *
 * The screenshot Viktor sent on 2026-09-16 was a driving view sitting in a
 * 60-column window with tmux's dots around it: another device held the Grid,
 * and nothing about this view had changed, so nothing made it speak.
 */
describe("gridCramped", () => {
  const mine = { cols: 184, rows: 50 };

  it("sees a window another device shrank", () => {
    expect(gridCramped(mine, { cols: 60, rows: 19 })).toBe(true);
  });

  /**
   * The agreeing case, and the reason rows are a range: the server takes the
   * status lines off the rows this client claimed, so the window it reports
   * back is shorter than the terminal that asked for it.
   */
  it.each([
    ["no status bar", { cols: 184, rows: 50 }],
    ["one status line", { cols: 184, rows: 49 }],
    ["tmux's maximum five", { cols: 184, rows: 45 }],
  ])("accepts its own claim with %s", (_why, grid) => {
    expect(gridCramped(mine, grid)).toBe(false);
  });

  /** Six rows short is more than any status bar tmux will draw, so the rows
   *  belong to somebody else's client. */
  it("sees a window shorter than any status bar explains", () => {
    expect(gridCramped(mine, { cols: 184, rows: 44 })).toBe(true);
  });

  /** One column out is one column of Claude's output re-wrapped, so columns
   *  are compared exactly. */
  it("sees a single column of disagreement", () => {
    expect(gridCramped(mine, { cols: 183, rows: 49 })).toBe(true);
  });

  /**
   * THE CLAIM WAR THIS REFUSES TO START. A window bigger than this terminal
   * belongs to a larger client, and this one is cropped rather than dotted.
   * Two devices that both claimed back would take the window from each other
   * on every poll; with only the cramped side speaking, the larger client
   * wins once and it ends.
   */
  it.each([
    ["wider", { cols: 231, rows: 49 }],
    ["taller", { cols: 184, rows: 62 }],
    ["both", { cols: 231, rows: 62 }],
  ])("leaves a window %s than the terminal alone", (_why, grid) => {
    expect(gridCramped(mine, grid)).toBe(false);
  });

  /**
   * tmux-api omits both fields when it could not read a size, and a server
   * that predates them sends neither. Claiming against a number nobody
   * reported would be a POST behind a guess.
   */
  it.each([
    ["nothing polled yet", null],
    ["a server that says nothing", undefined],
    ["no columns", { cols: 0, rows: 19 }],
    ["half a row", { cols: 60, rows: 19.5 }],
    ["a size that is not a number", { cols: Number.NaN, rows: 19 }],
  ])("stays quiet for %s", (_why, grid) => {
    expect(gridCramped(mine, grid)).toBe(false);
  });
});
