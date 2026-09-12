/**
 * What a drop onto the tiles means, checked as geometry.
 *
 * `@formkit/drag-and-drop` has no positional API at all — a parent's whole
 * state is `Array<T>` through `getValues`/`setValues`, and every operation it
 * knows resolves to an index in some parent's array. "Drop on the left third of
 * this tile to split it" is not expressible in that vocabulary, so the library
 * contributes the pointer, the long press and the touch path, and the module
 * under test contributes the arithmetic. That division is settled in the design
 * and in ADR-0027; what is left to check is the arithmetic.
 *
 * Three halves, and the first two need no browser:
 *
 *   - the HIT TEST, which turns a pointer and a list of tile rects into what
 *     the drop means. Every edge, the middle, outside everything, the seam
 *     between two tiles, the corner where two edges compete, the boundary
 *     exactly on a third, and the split a 240px floor refuses;
 *   - the PREVIEW BOX, which is the only feedback a person gets. Tiles cannot
 *     move under the cursor — moving the node a session hangs off disposes
 *     `TerminalNative` and takes the xterm, the ttyd socket and the tmux attach
 *     with it, a 779 ms rebuild (ADR-0026) — so the translucent shadow has to
 *     be exactly where the tile will land. That is a property, and it is
 *     checked as one: the preview equals the rect the dropped session gets from
 *     `toRects` after the drop is applied;
 *   - the WIRING, in jsdom, where a drag is a sequence of real events against a
 *     real element and what is asserted is the single write at the end of it.
 *
 * Two couplings are pinned here rather than left to drift. The refusal matches
 * `canSplit` at every tile and every edge of a real tree, because the hit test
 * reads the floor off a rect and `canSplit` reads it off the tree, and they are
 * the same number for the same reason. And the preview matches `toRects`,
 * because `splitAt` halves the tile it splits and a preview that assumed
 * anything else would lie by exactly the fraction it got wrong.
 */
import { createRoot } from "solid-js";
import { describe, expect, it, onTestFinished } from "vitest";
import { DRAG_START_EVENT } from "../src/dnd/sidebar";
import {
  applyDrop,
  attachTileDrop,
  beginTileDrag,
  type DropTarget,
  EDGE_BAND,
  hitTest,
  type Point,
  previewBox,
  type TileDropDeps,
  tileDropClaimed,
  tileDropTarget,
} from "../src/dnd/tiles";
import {
  type Box,
  canSplit,
  type Edge,
  leaf,
  leafKeys,
  MIN_TILE_PX,
  type Rect,
  type SessionKey,
  type Size,
  split,
  toRects,
  type TreeNode,
} from "../src/store/workspace-tree";

const EDGES: readonly Edge[] = ["left", "right", "top", "bottom"];

/**
 * One tile, 1200x900, so a third of each axis is a whole number of pixels: 400
 * across and 300 down. The boundary cases below are then written as the numbers
 * a person would say rather than as floats that happen to land the right side
 * of a comparison.
 */
const ONE: readonly Rect[] = [{ key: "a", x: 0, y: 0, width: 1200, height: 900 }];

/** A tile too narrow to halve: 400px across, so a vertical split would leave
 *  two of 200 and the 240px floor refuses it. Tall enough to halve downwards. */
const NARROW: readonly Rect[] = [{ key: "a", x: 0, y: 0, width: 400, height: 900 }];

function at(x: number, y: number): Point {
  return { x, y };
}

/** A point well inside one edge's band: a tenth of the way in, with the other
 *  axis at the middle, so the intended edge is the nearest one by a distance
 *  no float can argue with. */
function pointOn(rect: Rect, edge: Edge): Point {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  switch (edge) {
    case "left":
      return at(rect.x + rect.width * 0.1, cy);
    case "right":
      return at(rect.x + rect.width * 0.9, cy);
    case "top":
      return at(cx, rect.y + rect.height * 0.1);
    case "bottom":
      return at(cx, rect.y + rect.height * 0.9);
  }
}

function rectFor(rects: readonly Rect[], key: SessionKey): Rect {
  const hit = rects.find((r) => r.key === key);
  if (!hit) throw new Error(`no rect for ${key}`);
  return hit;
}

/**
 * The same box, to within a millionth of a pixel.
 *
 * `toRects` pins a split's last edge to the container's extent, because a
 * cumulative sum of fractions does not always land on it — ratios of 6:4:2
 * across 1600px end at 1599.9999999999998. The preview adds half a width to an
 * origin instead, so the two arrive at the same boundary by different routes
 * and disagree in the last bit or two. A millionth of a pixel is four orders of
 * magnitude below anything a screen can show.
 */
function expectSameBox(actual: Box | null, expected: Box): void {
  if (!actual) throw new Error("expected a preview box, got none");
  expect(actual.x).toBeCloseTo(expected.x, 6);
  expect(actual.y).toBeCloseTo(expected.y, 6);
  expect(actual.width).toBeCloseTo(expected.width, 6);
  expect(actual.height).toBeCloseTo(expected.height, 6);
}

// ---------------------------------------------------------------------------
// The hit test
// ---------------------------------------------------------------------------

describe("hitTest — what the pointer is asking for", () => {
  it("splits on the edge the pointer is nearest to", () => {
    expect(hitTest(at(100, 450), ONE)).toEqual({ kind: "split", key: "a", edge: "left" });
    expect(hitTest(at(1100, 450), ONE)).toEqual({ kind: "split", key: "a", edge: "right" });
    expect(hitTest(at(600, 100), ONE)).toEqual({ kind: "split", key: "a", edge: "top" });
    expect(hitTest(at(600, 800), ONE)).toEqual({ kind: "split", key: "a", edge: "bottom" });
  });

  it("replaces what is in the tile when the pointer is in the middle", () => {
    expect(hitTest(at(600, 450), ONE)).toEqual({ kind: "replace", key: "a" });
  });

  it("removes from the workspace when the pointer is outside every tile", () => {
    // All four ways out, and the case where there are no tiles at all. A drag
    // from the sidebar reads this as "not a drop into the workspace" and a tile
    // drag reads it as "take this tile out" — the same geometry, and `applyDrop`
    // is what tells them apart, without a branch.
    expect(hitTest(at(-1, 450), ONE)).toEqual({ kind: "remove" });
    expect(hitTest(at(1201, 450), ONE)).toEqual({ kind: "remove" });
    expect(hitTest(at(600, -1), ONE)).toEqual({ kind: "remove" });
    expect(hitTest(at(600, 901), ONE)).toEqual({ kind: "remove" });
    expect(hitTest(at(600, 450), [])).toEqual({ kind: "remove" });
  });

  it("counts the tile's own outer edge as inside it", () => {
    // Closed bounds, so the last column of pixels down the right-hand side of
    // the rightmost tile still aims at that tile. Half-open bounds would make
    // the far edge of the workspace mean "remove", which is the one place a
    // person is most likely to aim a split at.
    expect(hitTest(at(0, 450), ONE)).toEqual({ kind: "split", key: "a", edge: "left" });
    expect(hitTest(at(1200, 450), ONE)).toEqual({ kind: "split", key: "a", edge: "right" });
    expect(hitTest(at(600, 0), ONE)).toEqual({ kind: "split", key: "a", edge: "top" });
    expect(hitTest(at(600, 900), ONE)).toEqual({ kind: "split", key: "a", edge: "bottom" });
  });

  it("treats the third as half-open: a pixel inside splits, the boundary does not", () => {
    const rect = rectFor(ONE, "a");
    const across = rect.width * EDGE_BAND;
    const down = rect.height * EDGE_BAND;
    // The fixture is sized so both are whole pixels, 400 and 300.
    expect([across, down]).toEqual([400, 300]);
    expect(hitTest(at(across - 1, 450), ONE)).toEqual({ kind: "split", key: "a", edge: "left" });
    expect(hitTest(at(across, 450), ONE)).toEqual({ kind: "replace", key: "a" });
    expect(hitTest(at(600, down - 1), ONE)).toEqual({ kind: "split", key: "a", edge: "top" });
    expect(hitTest(at(600, down), ONE)).toEqual({ kind: "replace", key: "a" });
  });

  it("measures each edge against its own axis, so a corner goes to the nearer one", () => {
    // (100, 100) is a twelfth of the way across and a ninth of the way down, so
    // the left edge is nearer in the only terms that matter for a tile of this
    // shape. (100, 60) is the same horizontally and closer to the top.
    expect(hitTest(at(100, 100), ONE)).toEqual({ kind: "split", key: "a", edge: "left" });
    expect(hitTest(at(100, 60), ONE)).toEqual({ kind: "split", key: "a", edge: "top" });
  });

  it("breaks an exact diagonal tie the same way every time", () => {
    // 1200x900, so x/1200 === y/900 on the line y = 0.75x. A tie is only
    // reachable on that line, and which way it goes matters less than that it
    // goes the same way twice: horizontal first, then the earlier edge.
    expect(hitTest(at(100, 75), ONE)).toEqual({ kind: "split", key: "a", edge: "left" });
    expect(hitTest(at(1100, 75), ONE)).toEqual({ kind: "split", key: "a", edge: "right" });
  });

  it("aims at the earlier tile when the pointer is exactly on a seam", () => {
    const two: Rect[] = [
      { key: "a", x: 0, y: 0, width: 600, height: 900 },
      { key: "b", x: 600, y: 0, width: 600, height: 900 },
    ];
    // The rects tile the container exactly and share the boundary number, so a
    // pointer at 600 is inside both. Reading order decides, which makes the
    // answer the left-hand tile rather than a coin toss.
    expect(hitTest(at(600, 450), two)).toEqual({ kind: "split", key: "a", edge: "right" });
  });

  it("refuses a split that would take a tile below the 240px floor", () => {
    expect(hitTest(at(20, 450), NARROW)).toEqual({ kind: "invalid", key: "a", edge: "left" });
    expect(hitTest(at(380, 450), NARROW)).toEqual({ kind: "invalid", key: "a", edge: "right" });
    // The floor applies to the axis the divider crosses and to nothing else, so
    // a tile too narrow to halve sideways still halves downwards.
    expect(hitTest(at(200, 50), NARROW)).toEqual({ kind: "split", key: "a", edge: "top" });
  });

  it("allows a split that lands exactly on the floor and refuses the pixel below it", () => {
    const exact: Rect[] = [{ key: "a", x: 0, y: 0, width: MIN_TILE_PX * 2, height: 900 }];
    const under: Rect[] = [{ key: "a", x: 0, y: 0, width: MIN_TILE_PX * 2 - 1, height: 900 }];
    expect(hitTest(at(10, 450), exact).kind).toBe("split");
    expect(hitTest(at(10, 450), under).kind).toBe("invalid");
  });

  it("never refuses a replace, which shrinks nothing", () => {
    const tiny: Rect[] = [{ key: "a", x: 0, y: 0, width: 40, height: 40 }];
    expect(hitTest(at(20, 20), tiny)).toEqual({ kind: "replace", key: "a" });
  });

  it("reads a tile of no extent as a replace rather than dividing by its width", () => {
    // `parseTreeNode` refuses a stored fraction of zero, so nothing in the app
    // mints one. A rect measured mid-animation can still be flat, and a hit
    // test that returned NaN there would put an undrawable preview on screen.
    const flat: Rect[] = [{ key: "a", x: 0, y: 0, width: 0, height: 900 }];
    expect(hitTest(at(0, 450), flat)).toEqual({ kind: "replace", key: "a" });
  });

  /**
   * The hit test reads the 240px floor off a RECT and `canSplit` reads it off
   * the TREE. Both are the same arithmetic — `toRects` and `canSplit`'s own
   * `boxOfPath` walk the same cumulative edges — but they are two expressions
   * of it, and the drop preview showing as valid while the drop is refused is
   * the failure that would follow them drifting apart.
   */
  it("agrees with canSplit at every tile and every edge of a real tree", () => {
    const tree = split("row", [leaf("a"), split("column", [leaf("b"), leaf("c")])], [0.7, 0.3]);
    const container: Size = { width: 1000, height: 700 };
    const rects = toRects(tree, container);
    const seen = new Set<string>();
    for (const rect of rects) {
      for (const edge of EDGES) {
        const hit = hitTest(pointOn(rect, edge), rects);
        expect(hit.kind === "split" || hit.kind === "invalid").toBe(true);
        expect(hit.kind === "split").toBe(canSplit(tree, rect.key, edge, container));
        seen.add(hit.kind);
      }
    }
    // The tree is chosen so both answers appear: a 700px column halves either
    // way, and a 300px one halves neither sideways nor, at 350px tall, down.
    expect([...seen].sort()).toEqual(["invalid", "split"]);
  });
});

// ---------------------------------------------------------------------------
// The preview
// ---------------------------------------------------------------------------

describe("previewBox — the shadow that stands in for the tile", () => {
  const rect = rectFor(ONE, "a");

  it("shows the half of the tile the new one will take", () => {
    expectSameBox(previewBox({ kind: "split", key: "a", edge: "left" }, ONE), {
      x: 0,
      y: 0,
      width: 600,
      height: 900,
    });
    expectSameBox(previewBox({ kind: "split", key: "a", edge: "right" }, ONE), {
      x: 600,
      y: 0,
      width: 600,
      height: 900,
    });
    expectSameBox(previewBox({ kind: "split", key: "a", edge: "top" }, ONE), {
      x: 0,
      y: 0,
      width: 1200,
      height: 450,
    });
    expectSameBox(previewBox({ kind: "split", key: "a", edge: "bottom" }, ONE), {
      x: 0,
      y: 450,
      width: 1200,
      height: 450,
    });
  });

  it("shows the whole tile for a replace, because that is what gets taken over", () => {
    expectSameBox(previewBox({ kind: "replace", key: "a" }, ONE), {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
  });

  it("shows the refused half for an invalid split, so the shadow says which one", () => {
    // The caller paints this one as refused rather than hiding it. A drop that
    // simply does nothing reads as a broken drag; a shadow in the shape of the
    // tile you asked for, marked invalid, says what was asked and why not.
    expectSameBox(previewBox({ kind: "invalid", key: "a", edge: "right" }, NARROW), {
      x: 200,
      y: 0,
      width: 200,
      height: 900,
    });
  });

  it("shows nothing for a removal and nothing for a tile that is not there", () => {
    expect(previewBox({ kind: "remove" }, ONE)).toBeNull();
    expect(previewBox({ kind: "replace", key: "gone" }, ONE)).toBeNull();
    expect(previewBox({ kind: "split", key: "gone", edge: "left" }, ONE)).toBeNull();
  });

  /**
   * The one that matters. Tiles do not move during a drag, so the shadow is the
   * whole of the feedback, and a shadow that is not exactly where the tile
   * lands is a promise the drop then breaks. `splitAt` builds the new pair with
   * no fractions, which is an even share, and this is what pins the preview to
   * that fact rather than to an assumption about it.
   */
  it("lands the tile exactly where the shadow was, on every edge of every tile", () => {
    const tree = split("row", [leaf("a"), split("column", [leaf("b"), leaf("c")])], [0.6, 0.4]);
    const container: Size = { width: 1600, height: 900 };
    const rects = toRects(tree, container);
    for (const rect of rects) {
      for (const edge of EDGES) {
        const target: DropTarget = { kind: "split", key: rect.key, edge };
        const shadow = previewBox(target, rects);
        const after = applyDrop(tree, "n", target);
        if (!after) throw new Error("a split cannot empty a workspace");
        expectSameBox(shadow, rectFor(toRects(after, container), "n"));
      }
    }
  });

  it("lands a replaced tile exactly where the shadow was", () => {
    const tree = split("row", [leaf("a"), leaf("b")], [0.6, 0.4]);
    const container: Size = { width: 1600, height: 900 };
    const rects = toRects(tree, container);
    const target: DropTarget = { kind: "replace", key: "b" };
    const after = applyDrop(tree, "n", target);
    if (!after) throw new Error("a replace cannot empty a workspace");
    expectSameBox(previewBox(target, rects), rectFor(toRects(after, container), "n"));
  });
});

// ---------------------------------------------------------------------------
// Applying it
// ---------------------------------------------------------------------------

describe("applyDrop — the one write a finished drag asks for", () => {
  const two = split("row", [leaf("a"), leaf("b")]);

  it("splits the tile under the pointer and gives the new tile half of it", () => {
    const after = applyDrop(two, "n", { kind: "split", key: "b", edge: "right" });
    expect(leafKeys(after ?? leaf("?"))).toEqual(["a", "b", "n"]);
  });

  it("replaces what a tile was showing, in place", () => {
    const after = applyDrop(two, "n", { kind: "replace", key: "a" });
    expect(leafKeys(after ?? leaf("?"))).toEqual(["n", "b"]);
  });

  it("moves a tile that is already on screen rather than duplicating its session", () => {
    // keepalive mounts exactly one live view per session, so a second tile of
    // one session has no terminal to put in it, and the two would contend for
    // that session's Grid continuously. The tree layer refuses it; this is the
    // check that the drop layer cannot route around the refusal.
    const three = split("row", [leaf("a"), leaf("b"), leaf("c")]);
    const after = applyDrop(three, "a", { kind: "split", key: "c", edge: "bottom" });
    const keys = leafKeys(after ?? leaf("?"));
    expect(keys.sort()).toEqual(["a", "b", "c"]);
    expect(new Set(keys).size).toBe(3);
  });

  it("takes a member out when the pointer left the tiles", () => {
    const after = applyDrop(two, "a", { kind: "remove" });
    expect(leafKeys(after ?? leaf("?"))).toEqual(["b"]);
  });

  it("ends the workspace when the last tile is dragged out", () => {
    expect(applyDrop(leaf("a"), "a", { kind: "remove" })).toBeNull();
  });

  it("changes nothing when a session that was never here is dropped outside", () => {
    // The whole of the sidebar's "dropped somewhere that is not the workspace"
    // case, and it needs no branch: removing a session that has no tile is the
    // tree unchanged, by reference, so the caller writes nothing.
    expect(applyDrop(two, "n", { kind: "remove" })).toBe(two);
  });

  it("changes nothing for a refused split, so the drop is declined rather than fudged", () => {
    expect(applyDrop(two, "n", { kind: "invalid", key: "a", edge: "left" })).toBe(two);
  });

  it("changes nothing when a tile is dropped back on its own edge", () => {
    expect(applyDrop(two, "a", { kind: "split", key: "a", edge: "left" })).toBe(two);
    expect(applyDrop(two, "a", { kind: "replace", key: "a" })).toBe(two);
  });
});

// ---------------------------------------------------------------------------
// The wiring
// ---------------------------------------------------------------------------

/** One mounted canvas with fake deps, and the gestures that drive it. */
function mount(opts: {
  tree: TreeNode | null;
  rects: readonly Rect[];
  dragged: SessionKey | null;
  origin?: { left: number; top: number };
}) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const left = opts.origin?.left ?? 0;
  const top = opts.origin?.top ?? 0;
  // jsdom lays nothing out, so the canvas is told where it is. Everything above
  // that is the real thing: real events on the real document, and the real
  // listener set the module installs.
  el.getBoundingClientRect = () =>
    ({ left, top, x: left, y: top, right: left, bottom: top, width: 0, height: 0 }) as DOMRect;

  const applied: (TreeNode | null)[] = [];
  let holds = 0;
  let releases = 0;
  let dragged = opts.dragged;
  const deps: TileDropDeps = {
    dragged: () => dragged,
    rects: () => opts.rects,
    tree: () => opts.tree,
    apply: (next) => {
      applied.push(next);
    },
    hold: () => {
      holds += 1;
      return () => {
        releases += 1;
      };
    },
  };
  const dispose = createRoot((d) => {
    attachTileDrop(el, deps);
    return d;
  });
  onTestFinished(() => {
    dispose();
    el.remove();
  });
  return {
    applied,
    holds: () => holds,
    releases: () => releases,
    setDragged: (key: SessionKey | null) => {
      dragged = key;
    },
  };
}

function startSidebarDrag(): void {
  document.dispatchEvent(new CustomEvent(DRAG_START_EVENT));
}

function pointer(type: string, x: number, y: number): void {
  document.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true }));
}

/** One turn of the microtask queue plus a macrotask, which is long enough for
 *  the write's `finally` to have released the poll hold. */
function settle(): Promise<void> {
  return new Promise((done) => setTimeout(done, 0));
}

describe("attachTileDrop — a drag in the air, and the single write at the end", () => {
  it("shows the preview the pointer is over and claims the drop for the tiles", () => {
    mount({ tree: leaf("a"), rects: ONE, dragged: "n" });
    expect(tileDropTarget()).toBeNull();

    startSidebarDrag();
    pointer("pointermove", 100, 450);
    expect(tileDropTarget()).toEqual({ kind: "split", key: "a", edge: "left" });
    // What `dnd/sidebar.ts` asks before it writes a card order: the drop is the
    // workspace's, so the sidebar must not also treat it as a reorder.
    expect(tileDropClaimed()).toBe(true);

    pointer("pointermove", 600, 450);
    expect(tileDropTarget()).toEqual({ kind: "replace", key: "a" });
    expect(tileDropClaimed()).toBe(true);

    pointer("pointermove", 2000, 450);
    expect(tileDropTarget()).toEqual({ kind: "remove" });
    // Outside the tiles is the sidebar's own business again.
    expect(tileDropClaimed()).toBe(false);
  });

  it("writes the arrangement once when the pointer comes up, and clears the preview", async () => {
    const h = mount({ tree: leaf("a"), rects: ONE, dragged: "n" });
    startSidebarDrag();
    expect(h.holds()).toBe(1);
    pointer("pointermove", 100, 450);
    pointer("pointerup", 100, 450);
    // The library reaches a cancelled drag's end twice; the second must not
    // write again (dnd/sidebar.ts carries the same latch for the same reason).
    pointer("pointerup", 100, 450);

    expect(h.applied).toHaveLength(1);
    expect(leafKeys(h.applied[0] ?? leaf("?"))).toEqual(["n", "a"]);
    await settle();
    expect(tileDropTarget()).toBeNull();
    expect(h.releases()).toBe(1);
  });

  it("translates the pointer into the container's own coordinates", async () => {
    // The rects come out of `toRects` as pixels from the container's top-left
    // corner; the events carry client coordinates. A canvas 200px in from the
    // left and 100px down means a client (300, 550) is the container's
    // (100, 450), which is the left third of the only tile.
    const h = mount({
      tree: leaf("a"),
      rects: ONE,
      dragged: "n",
      origin: { left: 200, top: 100 },
    });
    startSidebarDrag();
    pointer("pointermove", 300, 550);
    expect(tileDropTarget()).toEqual({ kind: "split", key: "a", edge: "left" });
    pointer("pointerup", 300, 550);
    expect(leafKeys(h.applied[0] ?? leaf("?"))).toEqual(["n", "a"]);
    await settle();
  });

  it("follows a native drag through dragover and dragend, which carry no pointer events", () => {
    // A mouse gets the library's native path, where the browser suppresses
    // pointer events for the length of the drag and reports the position on
    // `dragover` instead. Same tracker, different event names.
    const h = mount({ tree: leaf("a"), rects: ONE, dragged: "n" });
    startSidebarDrag();
    document.dispatchEvent(
      new MouseEvent("dragover", { clientX: 1100, clientY: 450, bubbles: true }),
    );
    expect(tileDropTarget()).toEqual({ kind: "split", key: "a", edge: "right" });
    document.dispatchEvent(new MouseEvent("dragend", { bubbles: true }));
    expect(leafKeys(h.applied[0] ?? leaf("?"))).toEqual(["a", "n"]);
  });

  it("writes nothing when the drag carries no session, and retires the last claim", async () => {
    // A project header is dragged through the same sidebar machinery and raises
    // the same start event. It is not a session, so there is nothing to drop —
    // and the claim left by the session drag before it has to go, or the
    // sidebar would read it in its own `onDragend` and decline to reorder a
    // card that never went near a tile.
    const h = mount({ tree: leaf("a"), rects: ONE, dragged: "n" });
    startSidebarDrag();
    pointer("pointermove", 100, 450);
    pointer("pointerup", 100, 450);
    expect(tileDropClaimed()).toBe(true);
    await settle();

    h.setDragged(null);
    startSidebarDrag();
    pointer("pointermove", 100, 450);
    expect(tileDropTarget()).toBeNull();
    expect(tileDropClaimed()).toBe(false);
    pointer("pointerup", 100, 450);
    expect(h.applied).toHaveLength(1);
    expect(h.holds()).toBe(1);
  });

  it("writes nothing when a drag ends having asked for nothing", async () => {
    const h = mount({ tree: leaf("a"), rects: ONE, dragged: "n" });
    startSidebarDrag();
    pointer("pointermove", 2000, 450);
    pointer("pointerup", 2000, 450);
    expect(h.applied).toHaveLength(0);
    await settle();
    // The poll is still released: it was held for the length of the drag, not
    // for the length of the write.
    expect(h.releases()).toBe(1);
  });

  it("abandons the drop when the platform takes the gesture away", async () => {
    // `pointercancel` is an incoming call, a system gesture, or the browser
    // starting a native drag of its own. None of them is a person letting go
    // over a tile, and a native drag start raises it on the way past — so
    // committing here would land a tile the moment a mouse drag began.
    const h = mount({ tree: leaf("a"), rects: ONE, dragged: "n" });
    startSidebarDrag();
    pointer("pointermove", 100, 450);
    pointer("pointercancel", 100, 450);
    expect(h.applied).toHaveLength(0);
    expect(tileDropTarget()).toBeNull();
    await settle();
    expect(h.releases()).toBe(1);
  });

  it("abandons the drop on Escape", async () => {
    const h = mount({ tree: leaf("a"), rects: ONE, dragged: "n" });
    startSidebarDrag();
    pointer("pointermove", 100, 450);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(h.applied).toHaveLength(0);
    expect(tileDropTarget()).toBeNull();
    await settle();
    expect(h.releases()).toBe(1);
  });

  it("stops listening between drags, so a pointer over a terminal costs nothing", async () => {
    mount({ tree: leaf("a"), rects: ONE, dragged: "n" });
    pointer("pointermove", 100, 450);
    expect(tileDropTarget()).toBeNull();

    startSidebarDrag();
    pointer("pointermove", 100, 450);
    pointer("pointerup", 100, 450);
    await settle();
    pointer("pointermove", 1100, 450);
    expect(tileDropTarget()).toBeNull();
  });
});

describe("beginTileDrag — taking a tile out of the workspace", () => {
  const two = split("row", [leaf("a"), leaf("b")]);
  const twoRects: readonly Rect[] = [
    { key: "a", x: 0, y: 0, width: 600, height: 900 },
    { key: "b", x: 600, y: 0, width: 600, height: 900 },
  ];

  it("removes the tile when it is dropped outside the split area", async () => {
    const h = mount({ tree: two, rects: twoRects, dragged: null });
    beginTileDrag("a");
    pointer("pointermove", 2000, 450);
    expect(tileDropTarget()).toEqual({ kind: "remove" });
    pointer("pointerup", 2000, 450);
    expect(leafKeys(h.applied[0] ?? leaf("?"))).toEqual(["b"]);
    await settle();
    expect(h.releases()).toBe(1);
  });

  it("ends the workspace when the last tile is dragged out", () => {
    const h = mount({ tree: leaf("a"), rects: ONE, dragged: null });
    beginTileDrag("a");
    pointer("pointermove", 2000, 450);
    pointer("pointerup", 2000, 450);
    // Null is the caller's signal that there is no workspace left and it is
    // looking at a single session again.
    expect(h.applied).toEqual([null]);
  });

  it("moves a tile onto another tile's edge without asking the sidebar", () => {
    const h = mount({ tree: two, rects: twoRects, dragged: null });
    beginTileDrag("a");
    pointer("pointermove", 620, 450);
    expect(tileDropTarget()).toEqual({ kind: "split", key: "b", edge: "left" });
    pointer("pointerup", 620, 450);
    expect(leafKeys(h.applied[0] ?? leaf("?"))).toEqual(["a", "b"]);
    // Still two tiles: a move, never a copy.
    expect(h.applied[0]?.kind).toBe("split");
  });

  it("declines to start while a sidebar drag is already in the air", () => {
    const h = mount({ tree: two, rects: twoRects, dragged: "n" });
    startSidebarDrag();
    pointer("pointermove", 100, 450);
    beginTileDrag("b");
    pointer("pointerup", 100, 450);
    // The sidebar's session landed, not the tile the second gesture named.
    expect(leafKeys(h.applied[0] ?? leaf("?"))).toEqual(["n", "a", "b"]);
    expect(h.holds()).toBe(1);
  });
});
