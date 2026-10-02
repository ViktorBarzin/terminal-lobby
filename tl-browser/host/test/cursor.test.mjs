import assert from "node:assert/strict";
import { test } from "node:test";
import { CursorBoard, cursorInPage } from "../lib/cursor.mjs";

/**
 * A stand-in for a frame's window: listeners, a binding, a clock, and the
 * frame element chain the script walks up.
 * @param {{ frameElement?: object | null, parent?: object, top?: object }} [shape]
 */
function fakeWindow(shape = {}) {
  /** @type {Map<string, (e: object) => void>} */
  const listeners = new Map();
  /** @type {object[]} */
  const calls = [];
  /** @type {{ at: number, fn: () => void }[]} */
  const timers = [];
  const clock = { t: 0 };
  /** @type {Record<string, unknown>} */
  const win = {
    addEventListener: (/** @type {string} */ type, /** @type {(e: object) => void} */ fn, opts) => {
      assert.deepEqual(opts, { capture: true, passive: true }, "listens in the capture phase, passively");
      listeners.set(type, fn);
    },
    setTimeout: (/** @type {() => void} */ fn, /** @type {number} */ ms) => {
      timers.push({ at: clock.t + ms, fn });
      return timers.length;
    },
    performance: { now: () => clock.t },
    __cursor: (/** @type {object} */ p) => calls.push(p),
    ...shape,
  };
  if (!("top" in shape)) win.top = win;
  if (!("parent" in shape)) win.parent = win;
  /**
   * A click's detail is its click count: 1 or more from a pointer, 0 when
   * the keyboard activated the control.
   * @param {string} type
   * @param {number} x
   * @param {number} y
   * @param {boolean} [trusted]
   * @param {number} [detail]
   */
  const fire = (type, x, y, trusted = true, detail = type === "click" ? 1 : 0) =>
    listeners.get(type)?.({ isTrusted: trusted, clientX: x, clientY: y, detail });
  /**
   * A real click: press, release, click, all at one spot.
   * @param {number} x
   * @param {number} y
   */
  const tap = (x, y) => {
    fire("pointerdown", x, y);
    fire("pointerup", x, y);
    fire("click", x, y);
  };
  /** @param {number} ms */
  const advance = (ms) => {
    clock.t += ms;
    for (const timer of timers.splice(0).sort((a, b) => a.at - b.at)) {
      if (timer.at <= clock.t) timer.fn();
      else timers.push(timer);
    }
  };
  return { win, calls, fire, tap, advance, listeners };
}

const OPTS = { binding: "__cursor", intervalMs: 33 };

test("the page reports moves, presses, releases and clicks where they land", () => {
  const { win, calls, fire, listeners } = fakeWindow();
  cursorInPage(OPTS, win);
  assert.deepEqual([...listeners.keys()].sort(), ["click", "pointerdown", "pointermove", "pointerup"]);
  fire("pointermove", 10, 20);
  fire("pointerdown", 10, 20);
  fire("pointerup", 10, 20);
  fire("click", 10, 20);
  assert.deepEqual(calls, [
    { kind: "move", x: 10, y: 20 },
    { kind: "down", x: 10, y: 20 },
    { kind: "up", x: 10, y: 20 },
    { kind: "click", x: 10, y: 20 },
  ]);
});

test("moves are throttled, and the last one in a burst still arrives", () => {
  const { win, calls, fire, advance } = fakeWindow();
  cursorInPage(OPTS, win);
  fire("pointermove", 1, 1);
  advance(5);
  fire("pointermove", 2, 2);
  advance(5);
  fire("pointermove", 3, 3);
  assert.deepEqual(calls, [{ kind: "move", x: 1, y: 1 }], "the first goes at once");
  advance(40);
  assert.deepEqual(calls.at(-1), { kind: "move", x: 3, y: 3 }, "the latest goes at the end of the window");
  assert.equal(calls.length, 2, "the ones in between are skipped");
});

test("a press is never held back: a waiting move goes first, then the press", () => {
  const { win, calls, fire, advance } = fakeWindow();
  cursorInPage(OPTS, win);
  fire("pointermove", 1, 1);
  advance(5);
  fire("pointermove", 50, 60);
  fire("pointerdown", 50, 60);
  assert.deepEqual(calls, [
    { kind: "move", x: 1, y: 1 },
    { kind: "move", x: 50, y: 60 },
    { kind: "down", x: 50, y: 60 },
  ]);
  advance(100);
  assert.equal(calls.length, 3, "the flushed move is not sent again");
});

test("events a script made up do not move the cursor", () => {
  const { win, calls, fire } = fakeWindow();
  cursorInPage(OPTS, win);
  fire("click", 5, 5, false);
  assert.deepEqual(calls, []);
});

test("a click the keyboard made (Enter or Space on a focused control) is not reported", () => {
  const { win, calls, fire } = fakeWindow();
  cursorInPage(OPTS, win);
  // Chrome's keyboard-activated click is trusted, at clientX/clientY 0.
  fire("click", 0, 0, true, 0);
  // Even with a press and release just before, detail 0 is the keyboard.
  fire("pointerdown", 0, 0);
  fire("pointerup", 0, 0);
  fire("click", 0, 0, true, 0);
  assert.deepEqual(
    calls.filter((c) => c.kind === "click"),
    [],
  );
});

test("a click no press and release preceded at that spot is not reported", () => {
  const { win, calls, fire, tap } = fakeWindow();
  cursorInPage(OPTS, win);
  fire("click", 40, 40);
  assert.deepEqual(calls, [], "no press at all");
  fire("pointerdown", 10, 10);
  fire("pointerup", 10, 10);
  fire("click", 300, 200);
  assert.deepEqual(
    calls.filter((c) => c.kind === "click"),
    [],
    "a press and release elsewhere",
  );
  calls.length = 0;
  tap(10, 10);
  // A label forwards a second trusted click to its control: one press, one ring.
  fire("click", 10, 10);
  assert.deepEqual(
    calls.filter((c) => c.kind === "click"),
    [{ kind: "click", x: 10, y: 10 }],
  );
});

test("a drag that ends in a click rings where it was released", () => {
  const { win, calls, fire } = fakeWindow();
  cursorInPage(OPTS, win);
  fire("pointerdown", 10, 10);
  fire("pointerup", 60, 10);
  fire("click", 60, 10);
  assert.deepEqual(calls.at(-1), { kind: "click", x: 60, y: 10 });
});

test("a same-origin iframe adds its frame's offsets, walking up to the top", () => {
  const top = fakeWindow().win;
  const middle = fakeWindow({
    top,
    parent: top,
    frameElement: { getBoundingClientRect: () => ({ left: 100, top: 200 }), clientLeft: 2, clientTop: 3 },
  }).win;
  const inner = fakeWindow({
    top,
    parent: middle,
    frameElement: { getBoundingClientRect: () => ({ left: 10, top: 20 }), clientLeft: 1, clientTop: 1 },
  });
  cursorInPage(OPTS, inner.win);
  inner.tap(5, 5);
  assert.deepEqual(inner.calls, [
    { kind: "down", x: 118, y: 229 },
    { kind: "up", x: 118, y: 229 },
    { kind: "click", x: 118, y: 229 },
  ]);
});

test("a cross-origin iframe is skipped: its position in the page cannot be read", () => {
  const top = fakeWindow().win;
  // A cross-origin frame's frameElement is null.
  const frame = fakeWindow({ top, parent: top, frameElement: null });
  cursorInPage(OPTS, frame.win);
  frame.tap(5, 5);
  assert.deepEqual(frame.calls, []);
  // A same-origin frame inside a cross-origin one: reading the parent throws.
  const blocked = {
    get frameElement() {
      throw new Error("SecurityError");
    },
  };
  const nested = fakeWindow({
    top,
    parent: blocked,
    frameElement: { getBoundingClientRect: () => ({ left: 0, top: 0 }), clientLeft: 0, clientTop: 0 },
  });
  cursorInPage(OPTS, nested.win);
  nested.tap(5, 5);
  assert.deepEqual(nested.calls, []);
});

test("a page that removed or broke the binding is not broken by the script", () => {
  const { win, fire } = fakeWindow();
  cursorInPage(OPTS, win);
  win.__cursor = () => {
    throw new Error("nope");
  };
  assert.doesNotThrow(() => fire("click", 1, 1));
  delete win.__cursor;
  assert.doesNotThrow(() => fire("click", 1, 1));
});

test("the board turns a report into a cursor message for the tab", () => {
  const board = new CursorBoard();
  assert.deepEqual(board.report("t1", { kind: "click", x: 640.25, y: 400 }), {
    t: "cursor",
    tab: "t1",
    x: 640.25,
    y: 400,
    kind: "click",
  });
});

test("the board refuses a report that is not a cursor position", () => {
  const board = new CursorBoard();
  for (const bad of [
    null,
    "click",
    { kind: "drag", x: 1, y: 1 },
    { kind: "move", x: "1", y: 1 },
    { kind: "move", x: 1 },
    { kind: "move", x: Number.NaN, y: 1 },
    { kind: "move", x: 1e9, y: 1 },
  ])
    assert.equal(board.report("t1", bad), null, JSON.stringify(bad));
  assert.equal(board.last("t1"), null);
});

test("a newly watching viewer is given the last position, as a move", () => {
  const board = new CursorBoard();
  board.report("t1", { kind: "move", x: 1, y: 2 });
  board.report("t1", { kind: "click", x: 30, y: 40 });
  // Replayed as a move, so joining does not show a click that already happened.
  assert.deepEqual(board.last("t1"), { t: "cursor", tab: "t1", x: 30, y: 40, kind: "move" });
  assert.equal(board.last("t2"), null);
});

test("a closed tab's cursor is forgotten", () => {
  const board = new CursorBoard();
  board.report("t1", { kind: "move", x: 1, y: 2 });
  board.report("t2", { kind: "move", x: 3, y: 4 });
  board.prune(new Set(["t2"]));
  assert.equal(board.last("t1"), null);
  assert.notEqual(board.last("t2"), null);
});

test("a page flooding moves is cut down; the move pacing never holds a press", () => {
  let now = 0;
  const board = new CursorBoard({ now: () => now });
  assert.notEqual(board.report("t1", { kind: "move", x: 1, y: 1 }), null);
  now += 1;
  assert.equal(board.report("t1", { kind: "move", x: 2, y: 2 }), null);
  assert.deepEqual(board.last("t1")?.x, 2, "the dropped move still counts as the last position");
  assert.notEqual(board.report("t1", { kind: "down", x: 2, y: 2 }), null);
  now += 50;
  assert.notEqual(board.report("t1", { kind: "move", x: 3, y: 3 }), null);
});

test("a page flooding presses and clicks is cut to a burst, then about 20 a second, per tab", () => {
  let now = 0;
  const board = new CursorBoard({ now: () => now });
  const kinds = /** @type {const} */ (["down", "up", "click"]);
  let passed = 0;
  for (let i = 0; i < 1000; i++)
    if (board.report("t1", { kind: kinds[i % 3], x: i % 50, y: 1 })) passed++;
  assert.ok(passed >= 6, `a real double click (6 messages) fits the burst, got ${passed}`);
  assert.ok(passed <= 12, `a loop of 1000 is cut to a small burst, got ${passed}`);

  // Another tab has its own allowance.
  assert.notEqual(board.report("t2", { kind: "click", x: 1, y: 1 }), null);

  // A second later, about 20 more go through, however many are tried.
  now += 1000;
  passed = 0;
  for (let i = 0; i < 1000; i++) if (board.report("t1", { kind: "click", x: 1, y: 1 })) passed++;
  assert.ok(passed >= 10 && passed <= 22, `about a second's worth after a second, got ${passed}`);

  // The flood does not starve moves, which have their own pacing.
  now += 20;
  assert.notEqual(board.report("t1", { kind: "move", x: 9, y: 9 }), null);
});

test("a closed tab's click allowance is forgotten with it", () => {
  const board = new CursorBoard({ now: () => 0 });
  for (let i = 0; i < 100; i++) board.report("t1", { kind: "click", x: 1, y: 1 });
  assert.equal(board.report("t1", { kind: "click", x: 1, y: 1 }), null, "spent");
  board.prune(new Set());
  assert.notEqual(board.report("t1", { kind: "click", x: 1, y: 1 }), null, "a fresh tab with the same id starts full");
});
