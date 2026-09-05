import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  GHOST_MS,
  GHOST_PX,
  NO_GESTURE,
  REPLACE_PX,
  STALL_MS,
  reduce,
  type DragSelectAction,
  type DragSelectEvent,
  type DragSelectReduction,
  type DragSelectState,
  type DragSelectWorld,
  type MouseTracking,
  type MoveEvent,
  type PressEvent,
  type ScreenBox,
} from "../src/terminal/dragselect";

/**
 * Plain-drag selection, as frontend/term.html:5921-6055 paid for it.
 *
 * THE FAILURE BEHIND ALL OF IT. tmux, and Claude Code inside it, keep the
 * terminal in mouse-report mode. xterm then reports a plain left drag to the
 * pty instead of selecting. `term.onBinary` is what turns mouse reporting on at
 * all, so wiring it costs mouse text selection in every pane that tracks the
 * mouse. term.html buys it back by swallowing the plain left press
 * at document capture and re-dispatching a clone carrying the force modifier.
 * Each test below is one rule that trade needs.
 */

/** 800x400 at the origin: with 20 rows a row is 20px, so the status row starts at y=380. */
const SCREEN: ScreenBox = { left: 0, top: 0, width: 800, height: 400 };
const ROWS = 20;
const COLS = 80;

/** Everything the component reads at the moment of an event. Overridden per test. */
const world = (over: Partial<DragSelectWorld> = {}): DragSelectWorld => ({
  now: 10_000,
  isMac: false,
  insideScreen: true,
  hasSelection: false,
  screen: SCREEN,
  rows: ROWS,
  cols: COLS,
  mouseTracking: "any",
  ...over,
});

/** A trusted, plain, left-button press well clear of the status row. */
const press = (over: Partial<PressEvent> = {}): PressEvent => ({
  isTrusted: true,
  button: 0,
  detail: 1,
  clientX: 100,
  clientY: 100,
  screenX: 340,
  screenY: 560,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...over,
});

const down = (over: Partial<PressEvent> = {}): DragSelectEvent => ({
  type: "press",
  press: press(over),
});

/** Motion with the button still held, which is what a drag looks like. */
const moved = (over: Partial<MoveEvent> = {}): DragSelectEvent => ({
  type: "motion",
  motion: { isTrusted: true, buttons: 1, clientX: 100, clientY: 100, ...over },
});

const lifted = (over: Partial<{ clientX: number; clientY: number }> = {}): DragSelectEvent => ({
  type: "release",
  release: { clientX: 100, clientY: 100, ...over },
});

const kinds = (r: DragSelectReduction): string[] => r.actions.map((a) => a.kind);

const find = <K extends DragSelectAction["kind"]>(
  r: DragSelectReduction,
  kind: K,
): Extract<DragSelectAction, { kind: K }> => {
  const hit = r.actions.find((a) => a.kind === kind);
  expect(hit, `a ${kind} action`).toBeTruthy();
  return hit as Extract<DragSelectAction, { kind: K }>;
};

/** State with a live clone drag, as a dispatched clone leaves it. */
const dragging = (clientX: number, clientY: number, at: number): DragSelectState => ({
  drag: { clientX, clientY, at },
  lastRelease: null,
  pending: null,
});

describe("which presses are reclaimed at all", () => {
  /**
   * The first row is the recursion guard and the reason this is a table: the
   * clone the module asks for is an untrusted mousedown on the same node, so a
   * module that intercepted its own clone would clone forever. Every other row
   * is a gesture that has to keep reaching the app or xterm unchanged.
   */
  const PASSES = [
    { press: "our own clone, or any untrusted press", over: { isTrusted: false }, w: {} },
    { press: "the middle button", over: { button: 1 }, w: {} },
    { press: "the right button", over: { button: 2 }, w: {} },
    { press: "Shift, which xterm already force-selects on", over: { shiftKey: true }, w: {} },
    { press: "Alt", over: { altKey: true }, w: {} },
    { press: "Ctrl", over: { ctrlKey: true }, w: {} },
    { press: "Cmd or Meta", over: { metaKey: true }, w: {} },
    { press: "a press outside .xterm-screen", over: {}, w: { insideScreen: false } },
    { press: "a press with no .xterm-screen to measure", over: {}, w: { screen: null } },
  ] as const;

  it.each(PASSES)("lets $press through untouched", ({ over, w }) => {
    const r = reduce(NO_GESTURE, down(over), world(w));
    expect(r.actions).toEqual([]);
    // Identity, so a component can compare and skip its own work.
    expect(r.state).toBe(NO_GESTURE);
  });

  it("reclaims a plain trusted left press over the screen", () => {
    expect(kinds(reduce(NO_GESTURE, down(), world()))).toEqual([
      "swallow-press",
      "force-selection",
      "focus",
    ]);
  });

  /**
   * term.html swallows at :5966-5967 before it decides anything else, so xterm
   * never sees the real press. Losing that leaks twice over: the real press
   * reaches the pty as a mouse report, and the clone reports a second one.
   */
  it("swallows the real press before anything else happens", () => {
    expect(kinds(reduce(NO_GESTURE, down(), world()))[0]).toBe("swallow-press");
  });

  /** The clone is xterm's input, so every field it selects from has to survive. */
  it("builds the clone from the press it swallowed", () => {
    const r = reduce(NO_GESTURE, down({ clientX: 210, clientY: 55 }), world());
    expect(find(r, "force-selection").clone).toMatchObject({
      detail: 1,
      clientX: 210,
      clientY: 55,
      screenX: 340,
      screenY: 560,
      button: 0,
      buttons: 1,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
  });

  /**
   * detail is what makes a double-click select a word and a triple-click a
   * line: xterm reads it off the event it processes, which is the clone.
   */
  it("carries the click count so a double-click still selects a word", () => {
    expect(find(reduce(NO_GESTURE, down({ detail: 2 }), world()), "force-selection").clone.detail)
      .toBe(2);
  });

  it("takes the focus xterm's own click would have taken", () => {
    expect(kinds(reduce(NO_GESTURE, down(), world()))).toContain("focus");
  });
});

describe("the force modifier", () => {
  /**
   * The modifier is the entire mechanism, and the platform split is which key
   * xterm answers to (term.html:5950). Its own
   * `SelectionService.shouldForceSelection` is
   * `isMac ? e.altKey && macOptionClickForcesSelection : e.shiftKey`, so a clone
   * without the right one is just another reported click.
   */
  const MODIFIER = [
    { platform: "a Mac forces selection with Option", isMac: true, alt: true, shift: false },
    { platform: "everywhere else it is Shift", isMac: false, alt: false, shift: true },
  ] as const;

  it.each(MODIFIER)("$platform", ({ isMac, alt, shift }) => {
    const { clone } = find(reduce(NO_GESTURE, down(), world({ isMac })), "force-selection");
    expect(clone.altKey).toBe(alt);
    expect(clone.shiftKey).toBe(shift);
  });

  /**
   * Exactly one of the two, never both, and the wrong one fails differently on
   * each platform: a Mac clone carrying Shift forces no selection at all, while
   * off a Mac an Alt clone matches xterm's `shouldColumnSelect` and drags out a
   * column block instead of lines.
   */
  it.each(MODIFIER)("sets one modifier and not the other, given $platform", ({ isMac }) => {
    const { clone } = find(reduce(NO_GESTURE, down(), world({ isMac })), "force-selection");
    expect(clone.altKey !== clone.shiftKey).toBe(true);
  });
});

describe("the tmux status row", () => {
  /**
   * The bottom row carries tmux's window tabs, so a click there has to reach
   * the app. term.html's test is `term.rows > 1 && e.clientY - rect.top >=
   * rect.height * (term.rows - 1) / term.rows` (:5964-5965): the last row of
   * the grid, measured off the box rather than off a cell height.
   */
  const GEOMETRY = [
    { at: "one pixel above the last row", clientY: 379, rows: ROWS, screen: SCREEN, status: false },
    { at: "the first pixel of the last row", clientY: 380, rows: ROWS, screen: SCREEN, status: true },
    { at: "the last pixel of the screen", clientY: 399, rows: ROWS, screen: SCREEN, status: true },
    { at: "the middle of the screen", clientY: 200, rows: ROWS, screen: SCREEN, status: false },
    // A one-row terminal has no status line to protect, and treating its only
    // row as one would make the whole screen unselectable.
    { at: "the only row of a one-row terminal", clientY: 399, rows: 1, screen: SCREEN, status: false },
    { at: "the last row of a two-row terminal", clientY: 201, rows: 2, screen: SCREEN, status: true },
    // The box is not always at the top of the window: the lobby's chrome sits
    // above it, so the threshold rides on rect.top.
    {
      at: "an offset box, above its last row",
      clientY: 429,
      rows: ROWS,
      screen: { left: 0, top: 50, width: 800, height: 400 },
      status: false,
    },
    {
      at: "an offset box, inside its last row",
      clientY: 430,
      rows: ROWS,
      screen: { left: 0, top: 50, width: 800, height: 400 },
      status: true,
    },
  ] as const;

  it.each(GEOMETRY)("a press at $at is on the status row: $status", ({ clientY, rows, screen, status }) => {
    const r = reduce(NO_GESTURE, down({ clientY }), world({ rows, screen }));
    // A status-row press waits to see whether it travels, so it asks for
    // nothing beyond the swallow. Anything else force-selects at once.
    expect(kinds(r)).toEqual(
      status ? ["swallow-press"] : ["swallow-press", "force-selection", "focus"],
    );
  });

  /**
   * term.html does not call tapFocus on this branch (:5968-6003 returns without
   * it): the click is about to be replayed to the app, and tmux moves the focus
   * itself.
   */
  it("holds a status-row press back without focusing or cloning", () => {
    expect(kinds(reduce(NO_GESTURE, down({ clientY: 390 }), world()))).toEqual(["swallow-press"]);
  });

  /**
   * The point of the exception: press and release on a tmux window tab still
   * switches windows. term.html replays it as raw SGR bytes rather than a DOM
   * re-dispatch, so there is nothing re-entrant to reason about (:5984-5995).
   */
  it("replays the click to the app when it releases without travelling", () => {
    const held = reduce(NO_GESTURE, down({ clientX: 100, clientY: 390 }), world());
    const r = reduce(held.state, lifted({ clientX: 100, clientY: 390 }), world());
    // Press then release, in that order, both SGR button 0.
    expect(find(r, "replay-status-click").sends).toEqual(["\x1b[<0;11;20M", "\x1b[<0;11;20m"]);
  });

  /**
   * The column and row are 1-based cell coordinates, which is what SGR carries.
   * At 800px over 80 columns a cell is 10px, so x=0 is column 1 and x=795 is
   * column 80; the clamp is what stops a press on the last sub-pixel reporting
   * column 81.
   */
  const CELLS = [
    { clientX: 0, clientY: 380, cell: "1;20" },
    { clientX: 5, clientY: 399, cell: "1;20" },
    { clientX: 10, clientY: 380, cell: "2;20" },
    { clientX: 795, clientY: 390, cell: "80;20" },
    { clientX: 800, clientY: 390, cell: "80;20" },
  ] as const;

  it.each(CELLS)("reports a press at ($clientX,$clientY) as cell $cell", ({ clientX, clientY, cell }) => {
    const held = reduce(NO_GESTURE, down({ clientX, clientY }), world());
    const r = reduce(held.state, lifted({ clientX, clientY }), world());
    expect(find(r, "replay-status-click").sends).toEqual([`\x1b[<0;${cell}M`, `\x1b[<0;${cell}m`]);
  });

  /**
   * The bytes are measured from the press, not the release. A trackpad release
   * drifts a pixel or two, and a status click that reported the drift would
   * land on the neighbouring window tab.
   */
  it("reports the press position even when the release drifted", () => {
    const held = reduce(NO_GESTURE, down({ clientX: 5, clientY: 390 }), world());
    const r = reduce(held.state, lifted({ clientX: 795, clientY: 390 }), world());
    expect(find(r, "replay-status-click").sends[0]).toBe("\x1b[<0;1;20M");
  });

  /**
   * term.html captures `rect` inside the mousedown (:5963) and the release
   * reads that capture (:5991-5993). A fit or a rotate between the two moves
   * the live box, and re-measuring then would place the click by the new
   * geometry against the old press coordinates.
   */
  it("measures against the box as it was at the press", () => {
    const held = reduce(NO_GESTURE, down({ clientX: 5, clientY: 390 }), world());
    const shifted = world({ screen: { left: 400, top: 0, width: 800, height: 400 } });
    const r = reduce(held.state, lifted({ clientX: 5, clientY: 390 }), shifted);
    expect(find(r, "replay-status-click").sends[0]).toBe("\x1b[<0;1;20M");
  });

  /**
   * Only a mouse-tracking app can read the bytes. Sent to a shell they arrive
   * as typed garbage on the prompt, and term.html gates on exactly that
   * (:5989). A status line click needs tmux mouse mode anyway.
   */
  const TRACKING = [
    { mode: "none" as MouseTracking, replays: false },
    { mode: "x10" as MouseTracking, replays: true },
    { mode: "vt200" as MouseTracking, replays: true },
    { mode: "drag" as MouseTracking, replays: true },
    { mode: "any" as MouseTracking, replays: true },
  ];

  it.each(TRACKING)("with mouse tracking $mode, replays the click: $replays", ({ mode, replays }) => {
    const w = world({ mouseTracking: mode });
    const held = reduce(NO_GESTURE, down({ clientY: 390 }), w);
    expect(kinds(reduce(held.state, lifted(), w))).toEqual(replays ? ["replay-status-click"] : []);
  });

  /**
   * The other half of the disambiguation: the Claude input box sits at the
   * bottom, so a drag selecting the last lines of output starts in the status
   * row. Travel makes it a selection (:5975-5981).
   */
  it("becomes a selection drag once the press travels", () => {
    const held = reduce(NO_GESTURE, down({ clientX: 100, clientY: 390 }), world());
    const r = reduce(held.state, moved({ clientX: 100 + REPLACE_PX, clientY: 390 }), world());
    expect(kinds(r)).toEqual(["force-selection"]);
    // The clone starts where the finger pressed, not where it had reached, so
    // the selection covers the whole travel.
    expect(find(r, "force-selection").clone.clientX).toBe(100);
  });

  it("replays nothing once the press has become a drag", () => {
    const held = reduce(NO_GESTURE, down({ clientX: 100, clientY: 390 }), world());
    const dragged = reduce(held.state, moved({ clientX: 200, clientY: 390 }), world());
    expect(kinds(reduce(dragged.state, lifted({ clientX: 200 }), world()))).toEqual([]);
  });

  /**
   * `if (term.hasSelection()) clearSelectionBecause(...)` (:5979): the reason is
   * only recorded when there is a highlight to clear, which keeps a
   * replacing-drag reason out of the trail when nothing was replaced.
   */
  it("clears a standing selection when the status-row press becomes a drag", () => {
    const w = world({ hasSelection: true });
    const held = reduce(NO_GESTURE, down({ clientX: 100, clientY: 390 }), w);
    const r = reduce(held.state, moved({ clientX: 120, clientY: 390 }), w);
    expect(find(r, "clear-selection").reason).toBe("replacing drag (bottom row)");
  });

  it("clears nothing when there was no selection to replace", () => {
    const held = reduce(NO_GESTURE, down({ clientX: 100, clientY: 390 }), world());
    expect(kinds(reduce(held.state, moved({ clientX: 120, clientY: 390 }), world()))).toEqual([
      "force-selection",
    ]);
  });
});

describe("a press while a selection is already up", () => {
  const w = world({ hasSelection: true });

  /**
   * SELECTION LIFECYCLE (term.html:5829-5838): a selection clears only on
   * scroll, Escape or a replacing drag, never on a plain click. macOS trackpads
   * emit spurious trusted mousedown/up pairs after a drag lift, so any
   * click-clears rule eventually eats a fresh selection. The press is held back
   * until it proves itself.
   */
  it("holds the press back instead of replacing the selection", () => {
    expect(kinds(reduce(NO_GESTURE, down(), w))).toEqual(["swallow-press", "focus"]);
  });

  /**
   * tapFocus IS called here (:6035). The real press was swallowed, so nothing
   * else is going to focus the terminal.
   */
  it("still takes the focus the swallowed press would have taken", () => {
    expect(kinds(reduce(NO_GESTURE, down(), w))).toContain("focus");
  });

  it("keeps the selection when the press releases without travelling", () => {
    const held = reduce(NO_GESTURE, down(), w);
    const r = reduce(held.state, lifted(), w);
    expect(r.actions).toEqual([]);
    expect(r.state.pending).toBeNull();
  });

  /**
   * REPLACE_PX is deliberately larger than trackpad jitter (term.html:5842-5844):
   * macOS tap-drag continuations and micro-slips move a few pixels, an
   * intentional replacing drag travels. Either axis on its own counts, because
   * the test is per-axis rather than euclidean.
   */
  const TRAVEL = [
    { travel: "no movement at all", dx: 0, dy: 0, replaces: false },
    { travel: "one pixel of jitter", dx: 1, dy: 0, replaces: false },
    { travel: "a pixel under the threshold on both axes", dx: 9, dy: 9, replaces: false },
    { travel: "the threshold horizontally", dx: 10, dy: 0, replaces: true },
    { travel: "the threshold vertically", dx: 0, dy: 10, replaces: true },
    { travel: "the threshold backwards", dx: -10, dy: 0, replaces: true },
    { travel: "well past it", dx: 200, dy: 150, replaces: true },
  ] as const;

  it.each(TRAVEL)("$travel replaces the selection: $replaces", ({ dx, dy, replaces }) => {
    const held = reduce(NO_GESTURE, down(), w);
    const r = reduce(held.state, moved({ clientX: 100 + dx, clientY: 100 + dy }), w);
    expect(kinds(r)).toEqual(replaces ? ["clear-selection", "force-selection"] : []);
  });

  /** The table above is written against the shipped numbers, so state them once. */
  it("uses a 10px threshold, which is what the travel table assumes", () => {
    expect(REPLACE_PX).toBe(10);
  });

  /**
   * The reason string is what term.html's seldebug toast and its `sel-cleared`
   * telemetry carry, so a selection dying unexpectedly can be traced to the
   * gesture that did it. Absolute values, and the px suffix rides the second
   * number (:6023-6025).
   */
  it("names the travel that replaced the selection", () => {
    const held = reduce(NO_GESTURE, down(), w);
    const r = reduce(held.state, moved({ clientX: 100 - 40, clientY: 100 + 7 }), w);
    expect(find(r, "clear-selection").reason).toBe("replacing drag (40,7px)");
  });

  /**
   * The order is load-bearing, not tidiness. xterm's `handleMouseDown` routes
   * `this._enabled && e.shiftKey` to `_handleIncrementalClick`, and `_enabled`
   * is true in a pane that is NOT reporting the mouse, so a Shift clone landing
   * on a live selection EXTENDS it. Clearing first is what makes the clone start
   * a new range there.
   */
  it("clears before it re-selects, never the other way round", () => {
    const held = reduce(NO_GESTURE, down(), w);
    expect(kinds(reduce(held.state, moved({ clientX: 300 }), w))).toEqual([
      "clear-selection",
      "force-selection",
    ]);
  });

  it("starts the replacing selection at the press, not at the travel", () => {
    const held = reduce(NO_GESTURE, down({ clientX: 100, clientY: 100 }), w);
    const r = reduce(held.state, moved({ clientX: 300, clientY: 220 }), w);
    expect(find(r, "force-selection").clone).toMatchObject({ clientX: 100, clientY: 100 });
  });

  /**
   * A double or triple click is unambiguous new-selection intent, so it is not
   * held back (:6010-6014). It clears first, because xterm would otherwise
   * extend the range that is already up.
   */
  it("lets a double-click through at once, clearing as it goes", () => {
    const r = reduce(NO_GESTURE, down({ detail: 2 }), w);
    expect(kinds(r)).toEqual(["swallow-press", "clear-selection", "force-selection", "focus"]);
    expect(find(r, "clear-selection").reason).toBe("double-click replace");
  });

  /**
   * The clear rides `detail > 1` alone (:6011), not on there being a selection,
   * and that asymmetry is where selection.ts's stash rule comes from: the
   * dismissal fires with nothing highlighted, `clearSelectionBecause` returns at
   * its own guard (:5893), and a pending copy stays alive. Deciding it here
   * instead would move that guard and turn the next Ctrl+C back into SIGINT.
   */
  it("still asks for the clear on a double-click with no selection up", () => {
    expect(kinds(reduce(NO_GESTURE, down({ detail: 2 }), world()))).toEqual([
      "swallow-press",
      "clear-selection",
      "force-selection",
      "focus",
    ]);
  });
});

describe("the trackpad ghost-click guard", () => {
  /** A hijacked drag that released at (100,100) at t=10000, which is what arms the window. */
  const afterLift: DragSelectState = {
    drag: null,
    lastRelease: { at: 10_000, clientX: 100, clientY: 100 },
    pending: null,
  };

  /**
   * macOS trackpads emit spurious trusted mousedown/up pairs after a drag lift,
   * sometimes deferred until the finger next touches to MOVE the pointer
   * (term.html:5832-5835). Inside the window they are ignored and the selection
   * survives; outside it they are a real click.
   */
  const GHOSTS = [
    { click: "the same pixel, immediately", dx: 0, dy: 0, age: 0, ghost: true },
    { click: "the last millisecond of the window", dx: 0, dy: 0, age: GHOST_MS - 1, ghost: true },
    { click: "one millisecond past the window", dx: 0, dy: 0, age: GHOST_MS, ghost: false },
    { click: "the edge of the box", dx: GHOST_PX, dy: GHOST_PX, age: 100, ghost: true },
    { click: "a pixel outside the box across", dx: GHOST_PX + 1, dy: 0, age: 100, ghost: false },
    { click: "a pixel outside the box down", dx: 0, dy: GHOST_PX + 1, age: 100, ghost: false },
    { click: "a real click somewhere else", dx: 300, dy: 200, age: 100, ghost: false },
  ] as const;

  it.each(GHOSTS)("$click is a ghost: $ghost", ({ dx, dy, age, ghost }) => {
    const w = world({ hasSelection: true, now: 10_000 + age });
    const r = reduce(afterLift, down({ clientX: 100 + dx, clientY: 100 + dy }), w);
    // A ghost asks for nothing beyond the swallow, and above all is not held
    // back: a held-back ghost's own travel would replace the selection.
    expect(kinds(r)).toEqual(ghost ? ["swallow-press"] : ["swallow-press", "focus"]);
    expect(r.state.pending === null).toBe(ghost);
  });

  /**
   * `ghost && term.hasSelection()` (:6009). With nothing selected there is
   * nothing to protect, and swallowing the press without cloning would cost the
   * user a click.
   */
  it("is only a ghost while a selection is up", () => {
    expect(kinds(reduce(afterLift, down(), world({ now: 10_100 })))).toContain("force-selection");
  });

  /**
   * The swallow happens at :5966, before the ghost test at :6005, so a ghost
   * press is still kept off xterm. Letting it through would report a click to
   * the pty that the user never made.
   */
  it("still swallows the ghost press", () => {
    expect(kinds(reduce(afterLift, down(), world({ hasSelection: true, now: 10_100 })))).toEqual([
      "swallow-press",
    ]);
  });

  /**
   * `lastHijackUp` has exactly two writers in term.html: the clone's own mouseup
   * listener (:5955) and finalizeCloneDrag (:5929). An ordinary release we never
   * hijacked must not arm the window, or the next real press inside it is
   * ignored.
   */
  it("is not armed by a release with no clone drag behind it", () => {
    const r = reduce(NO_GESTURE, lifted(), world());
    expect(r.state.lastRelease).toBeNull();
    expect(r.state).toBe(NO_GESTURE);
  });

  it("is armed by the release of a clone drag, at the release point", () => {
    const r = reduce(dragging(100, 100, 9_000), lifted({ clientX: 140, clientY: 90 }), world());
    expect(r.state.lastRelease).toEqual({ at: 10_000, clientX: 140, clientY: 90 });
    expect(r.state.drag).toBeNull();
  });
});

describe("a gesture whose mouseup never arrives", () => {
  /**
   * Two real ways it happens (term.html:5904-5918): the button is released
   * outside the document, past the window edge; or macOS three-finger-drag keeps
   * the button down after the fingers lift, so the next pointer move silently
   * continues the drag. Either way xterm stays in drag state and every later
   * move re-extends the "selection".
   */
  it("finalizes at the last dragged point when the button came up unseen", () => {
    const r = reduce(dragging(150, 120, 9_900), moved({ buttons: 0, clientX: 400, clientY: 300 }), world());
    const fin = find(r, "finalize-drag");
    expect(fin.cause).toBe("lost-mouseup");
    // The last point the drag actually reached, NOT where the pointer is now:
    // travel after the release was never part of the selection.
    expect(fin.at).toEqual({ clientX: 150, clientY: 120 });
    expect(r.state.drag).toBeNull();
  });

  it("tracks the drag while the button is genuinely still down", () => {
    const r = reduce(dragging(150, 120, 9_900), moved({ clientX: 260, clientY: 180 }), world());
    expect(r.actions).toEqual([]);
    expect(r.state.drag).toEqual({ clientX: 260, clientY: 180, at: 10_000 });
  });

  /**
   * Only the left-button bit is read (`m.buttons & 1`, :5934), so a drag whose
   * left button was released while the right one is still down heals too.
   */
  it("reads only the left-button bit", () => {
    const r = reduce(dragging(150, 120, 9_900), moved({ buttons: 2, clientX: 400 }), world());
    expect(find(r, "finalize-drag").cause).toBe("lost-mouseup");
  });

  /**
   * Case (b), and what the stall buys: a lift pause then travel is drag-lock
   * resuming, not deliberate selection growth, so the selection closes at the
   * stationary point.
   */
  const STALLS = [
    { platform: "a Mac, resuming after the full stall", isMac: true, still: STALL_MS, heals: true },
    { platform: "a Mac, resuming a millisecond early", isMac: true, still: STALL_MS - 1, heals: false },
    { platform: "a Mac, still moving", isMac: true, still: 16, heals: false },
    // term.html gates case (b) on isMacLike (:5938): three-finger-drag is a
    // macOS trackpad feature, and a Windows mouse resting mid-drag is just a
    // hand holding still.
    { platform: "anywhere else, long past the stall", isMac: false, still: STALL_MS * 4, heals: false },
  ] as const;

  it.each(STALLS)("$platform finalizes: $heals", ({ isMac, still, heals }) => {
    const r = reduce(
      dragging(150, 120, 10_000 - still),
      moved({ clientX: 400, clientY: 300 }),
      world({ isMac }),
    );
    expect(kinds(r)).toEqual(heals ? ["finalize-drag"] : []);
    if (heals) {
      expect(find(r, "finalize-drag").cause).toBe("drag-lock-resume");
      expect(find(r, "finalize-drag").at).toEqual({ clientX: 150, clientY: 120 });
    }
  });

  /** The healing listener tests isTrusted (:5932): our own synthetic events are not motion. */
  it("ignores untrusted motion", () => {
    const state = dragging(150, 120, 9_000);
    const r = reduce(state, moved({ isTrusted: false, buttons: 0, clientX: 400 }), world());
    expect(r.actions).toEqual([]);
    expect(r.state).toBe(state);
  });

  /**
   * finalizeCloneDrag sets lastHijackUp from the point it finalized at (:5929),
   * so the ghost window opens where the selection ended rather than where the
   * pointer had wandered to.
   */
  it("arms the ghost window from the point it finalized at", () => {
    const r = reduce(dragging(150, 120, 9_900), moved({ buttons: 0, clientX: 400 }), world());
    expect(r.state.lastRelease).toEqual({ at: 10_000, clientX: 150, clientY: 120 });
  });

  it("does nothing on motion with no clone drag live", () => {
    const r = reduce(NO_GESTURE, moved({ buttons: 0, clientX: 400 }), world());
    expect(r.actions).toEqual([]);
    expect(r.state).toBe(NO_GESTURE);
  });

  /**
   * The pending slot's own answer to a missing mouseup, and the one place this
   * port is not term.html line for line: term.html would leave the old pair of
   * closures armed and add a second, so a later motion could resolve the stale
   * gesture and select from a press the user has forgotten about. One slot
   * means the fresh press wins.
   */
  it("replaces a press left pending by a missing mouseup", () => {
    const w = world({ hasSelection: true });
    const stale = reduce(NO_GESTURE, down({ clientX: 100, clientY: 100 }), w);
    const again = reduce(stale.state, down({ clientX: 500, clientY: 300 }), w);
    expect(again.state.pending?.press.clientX).toBe(500);
    // And the travel that resolves it is measured from the new press: 20px from
    // (500,300) commits, while the same point is 400px from the stale one.
    const r = reduce(again.state, moved({ clientX: 520, clientY: 300 }), w);
    expect(find(r, "clear-selection").reason).toBe("replacing drag (20,0px)");
    expect(find(r, "force-selection").clone.clientX).toBe(500);
  });

  /**
   * The healing and the motion swallow are two independent document-capture
   * listeners in term.html, healing registered first (:5931 against :6048), and
   * neither stops the other. So a lost-mouseup motion over a live selection both
   * heals the drag and is swallowed: the swallow's own `cloneDrag` test (:6050)
   * reads the null the healing just wrote.
   */
  it("heals and swallows the same motion when a selection survives the drag", () => {
    const r = reduce(
      dragging(150, 120, 9_900),
      moved({ buttons: 0, clientX: 400 }),
      world({ hasSelection: true }),
    );
    expect(kinds(r)).toEqual(["finalize-drag", "swallow-motion"]);
  });
});

describe("the mode-1003 motion swallow", () => {
  /**
   * Panes in mouse mode 1003 get EVERY pointer motion reported, the TUI
   * hover-repaints, and that output clears xterm's selection. Field telemetry
   * put every clear on the FIRST post-release pointer move
   * (term.html:6037-6047). So while a selection exists and no button is down,
   * motion over the screen is swallowed at document capture: xterm never sees
   * it, nothing is reported, nothing repaints, the highlight lives.
   */
  it("swallows idle motion over a live selection", () => {
    expect(kinds(reduce(NO_GESTURE, moved({ buttons: 0 }), world({ hasSelection: true })))).toEqual(
      ["swallow-motion"],
    );
  });

  const NOT_SWALLOWED = [
    // Nothing to protect, and swallowing motion with no selection would break
    // hover in every TUI on screen.
    { because: "there is no selection", motion: { buttons: 0 }, w: { hasSelection: false } },
    // A held left button is a drag in progress, and xterm needs those moves to
    // grow the selection it is making.
    { because: "the left button is down", motion: { buttons: 1 }, w: { hasSelection: true } },
    {
      because: "the pointer is off the screen",
      motion: { buttons: 0 },
      w: { hasSelection: true, insideScreen: false },
    },
    {
      because: "the motion is untrusted",
      motion: { isTrusted: false, buttons: 0 },
      w: { hasSelection: true },
    },
  ] as const;

  it.each(NOT_SWALLOWED)("lets motion through when $because", ({ motion, w }) => {
    expect(kinds(reduce(NO_GESTURE, moved(motion), world(w)))).not.toContain("swallow-motion");
  });

  /**
   * `cloneDrag` is the swallow's last guard (:6050). Swallowing during a drag we
   * started ourselves would freeze the selection at its first cell.
   */
  it("lets motion through while our own clone drag is live", () => {
    const r = reduce(dragging(100, 100, 9_990), moved({ buttons: 1 }), world({ hasSelection: true }));
    expect(kinds(r)).not.toContain("swallow-motion");
  });

  /**
   * Registration order decides this one. term.html's swallow listener is
   * registered at load (:6048); a pending gesture's move listener is added
   * inside the mousedown, so it comes later on the same node and phase and the
   * swallow's stopImmediatePropagation stops it running at all. The path is
   * reachable: a held-back press whose mouseup went missing leaves buttons at 0
   * with the selection still up, so its travel never resolves.
   */
  it("suppresses a pending press's travel check when it swallows", () => {
    const w = world({ hasSelection: true });
    const held = reduce(NO_GESTURE, down(), w);
    const r = reduce(held.state, moved({ buttons: 0, clientX: 400, clientY: 300 }), w);
    expect(kinds(r)).toEqual(["swallow-motion"]);
    expect(r.state.pending).not.toBeNull();
  });
});

describe("what the component is told to do", () => {
  const source = readFileSync(resolve(__dirname, "../src/terminal/dragselect.ts"), "utf8");
  const owes = (): string => {
    const start = source.indexOf("WHAT THE COMPONENT STILL OWES");
    const end = source.indexOf("WHAT THE COMPONENT MUST READ", start);
    expect(start, "the owes list").toBeGreaterThan(-1);
    expect(end, "the end of the owes list").toBeGreaterThan(start);
    return source.slice(start, end);
  };

  /**
   * A pure module decides and the component performs, so this comment is the
   * only carrier for the DOM work, and a different agent wires it. An action
   * missing from that list is one nobody performs.
   */
  it.each([
    "swallow-press",
    "swallow-motion",
    "force-selection",
    "finalize-drag",
    "clear-selection",
    "focus",
    "replay-status-click",
  ])("describes what to do with %s", (kind) => {
    expect(owes()).toContain(kind);
  });

  /**
   * The four easiest to wire wrongly: a passive capture listener cannot
   * preventDefault, the finalize needs the target the clone went to, and the
   * status replay has to take the input path so the read-only guard still
   * applies.
   */
  it.each(["capture", "preventDefault", "sendInput", "target"])(
    "names %s among the wiring it depends on",
    (needle) => {
      expect(owes()).toContain(needle);
    },
  );
});

describe("parity with term.html", () => {
  const TERM_HTML = resolve(__dirname, "../..", "frontend/term.html");
  const html = (): string => readFileSync(TERM_HTML, "utf8");

  /**
   * Four numbers, tuned against real trackpads, living in two places until
   * term.html retires. A port that quietly halved one hands back the failure it
   * was tuned to stop.
   */
  it("uses the thresholds term.html ships", () => {
    const src = html();
    const m = /const GHOST_MS = (\d+), GHOST_PX = (\d+), REPLACE_PX = (\d+);/.exec(src);
    expect(m, "the threshold line in term.html").toBeTruthy();
    expect(Number(m?.[1])).toBe(GHOST_MS);
    expect(Number(m?.[2])).toBe(GHOST_PX);
    expect(Number(m?.[3])).toBe(REPLACE_PX);
    const stall = /const STALL_MS = (\d+);/.exec(src);
    expect(stall, "STALL_MS in term.html").toBeTruthy();
    expect(Number(stall?.[1])).toBe(STALL_MS);
  });

  /**
   * The clear reasons are copied strings, not paraphrases: they reach the
   * `sel-cleared` telemetry and the seldebug toast, so a rewording breaks the
   * only trail a vanished selection leaves.
   */
  it("keeps the clear reasons term.html records", () => {
    const src = html();
    expect(src).toContain("'double-click replace'");
    expect(src).toContain("'replacing drag (bottom row)'");
    const w = world({ hasSelection: true });
    expect(find(reduce(NO_GESTURE, down({ detail: 2 }), w), "clear-selection").reason).toBe(
      "double-click replace",
    );
    const held = reduce(NO_GESTURE, down({ clientY: 390 }), w);
    expect(
      find(reduce(held.state, moved({ clientX: 300, clientY: 390 }), w), "clear-selection").reason,
    ).toBe("replacing drag (bottom row)");
  });

  /**
   * The interceptor's own guards, quoted out of the page. If term.html ever
   * loses the isTrusted test, the clone recursion it prevents is worth knowing
   * about before this port is blamed for it.
   */
  it("still intercepts the same presses term.html does", () => {
    const src = html();
    expect(src).toContain("if (!e.isTrusted || e.button !== 0) return;");
    expect(src).toContain("if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;");
    expect(src).toContain("e.stopImmediatePropagation();");
  });

  /** The SGR replay, byte for byte, as :5994-5995 writes it. */
  it("sends the status click in the SGR form term.html sends", () => {
    expect(html()).toContain("sendInput('\\x1b[<0;' + col + ';' + row + 'M');");
    const held = reduce(NO_GESTURE, down({ clientX: 0, clientY: 399 }), world());
    expect(find(reduce(held.state, lifted(), world()), "replay-status-click").sends).toEqual([
      "\x1b[<0;1;20M",
      "\x1b[<0;1;20m",
    ]);
  });

  /**
   * The clone's force modifier depends on two options pass 1 added. A terminal
   * without `macOptionClickForcesSelection` turns every Mac clone back into a
   * reported click, since xterm's own predicate reads it.
   */
  it("depends on the options the native terminal now passes", () => {
    const native = readFileSync(resolve(__dirname, "../src/components/TerminalNative.tsx"), "utf8");
    expect(native).toContain("macOptionClickForcesSelection: true");
    expect(native).toContain("altClickMovesCursor: false");
  });
});
