/**
 * A card let go over a tile lands in ONE system, not in both.
 *
 * The two drags end on the same release. `dnd/tiles.ts` applies the split from
 * its own pointer handling, and `dnd/sidebar.ts`'s `onDragend` fires for the
 * same gesture with `parent` set to whichever card list the pointer last
 * crossed on the way out to the workspace — so a card carried down through
 * another project's list and then dropped on a tile edge was split into the
 * tile AND reassigned to that project, by a gesture that asked for the first
 * only.
 *
 * Why this is its own file rather than more cases in `test/dnd.tiles.test.ts`:
 * everything there holds one module still and drives it, and its five green
 * assertions about `tileDropClaimed` stayed green for as long as nothing in
 * `src/` called it. A seam is only covered by a test that drives both sides.
 *
 * What is real here, and what is not. The drag library is the real one on real
 * lists, driven by a real long press and a real sequence of pointer events;
 * both modules are the real ones, and the claim travels between them exactly as
 * it does in the app. The two stores at the far ends are doubles, because
 * `SessionListDeps.move` and `TileDropDeps.apply` are the documented boundary
 * and the whole question here is which of the two gets called — so `move` is
 * implemented against its contract (a session moved relative to a neighbour)
 * rather than merely recorded, and the rows follow it, which is what makes
 * "the sidebar order did not change" an assertion about what a person sees.
 *
 * jsdom lays nothing out, so the rows' rects and `elementFromPoint` are
 * supplied. `test/dnd.drag.test.tsx` supplies the same two for the same reason,
 * and the numbers here are its numbers: rows 40px tall starting at y=100.
 */
import { createEffect, createRoot } from "solid-js";
import { describe, expect, it, onTestFinished } from "vitest";
import type { DropAnchor } from "../src/components/lobby.logic";
import { attachSessionList, GROUP_ATTR, liveOrder } from "../src/dnd/sidebar";
import { attachTileDrop } from "../src/dnd/tiles";
import {
  leaf,
  leafKeys,
  type Rect,
  type SessionKey,
  type TreeNode,
} from "../src/store/workspace-tree";

/** The card lists are 300px wide and the workspace is to the right of them.
 *  Which side of this line the pointer is on is the whole of what
 *  `elementFromPoint` needs to know to tell a row from a tile. */
const CANVAS_LEFT = 400;

const ROW_H = 40;
const FIRST_ROW_Y = 100;

/** The row the library clones to follow a finger. It is a `.tl-card` too, and
 *  it carries this id, which is how it is told apart from a real one. */
const CLONE_ID = "dnd-dragged-node-clone";

/** The only tile on screen, on a canvas 800px wide: a drop on its left third
 *  splits it, and half of 800 clears the 240px floor comfortably. */
const TILE: readonly Rect[] = [{ key: "deploy", x: 0, y: 0, width: 800, height: 900 }];

/** The same tile at 300px, where half is 150px and the split is refused. */
const NARROW_TILE: readonly Rect[] = [{ key: "deploy", x: 0, y: 0, width: 300, height: 900 }];

/** What `store.move` was asked for, which is the sidebar's whole output. */
interface Move {
  name: string;
  group: string;
  anchor?: DropAnchor;
}

interface At {
  x: number;
  y: number;
}

function rect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 300,
    width: 300,
    x: 0,
    y: top,
    toJSON() {},
  } as DOMRect;
}

/** The rows a list is showing, ignoring the clone that follows the finger. */
function shownIn(body: HTMLElement): string[] {
  return Array.from(body.querySelectorAll<HTMLElement>(".tl-card"))
    .filter((c) => c.id !== CLONE_ID)
    .map((c) => c.dataset.name ?? "");
}

/**
 * Card lists and a workspace canvas, registered the way the app registers them,
 * with the two store calls recorded and the layout one also applied.
 */
async function mount(opts: {
  lists: readonly { group: string; names: readonly string[] }[];
  tree: TreeNode | null;
  rects: readonly Rect[];
  dragged: SessionKey | null;
}) {
  const sidebar = document.createElement("div");
  document.body.appendChild(sidebar);
  const canvas = document.createElement("div");
  document.body.appendChild(canvas);
  // The canvas is told where it is, since jsdom will not say. Only its top-left
  // corner is read: the rects are pixels from it and the events carry client
  // coordinates, so its box is what translates between them.
  canvas.getBoundingClientRect = () =>
    ({
      left: CANVAS_LEFT,
      top: 0,
      x: CANVAS_LEFT,
      y: 0,
      right: CANVAS_LEFT,
      bottom: 0,
      width: 0,
      height: 0,
    }) as DOMRect;

  const model = new Map<string, readonly string[]>();
  const bodies = new Map<string, HTMLElement>();
  const byName = new Map<string, HTMLElement>();
  for (const list of opts.lists) {
    model.set(list.group, list.names);
    const body = document.createElement("div");
    body.className = "tl-group-body";
    body.setAttribute(GROUP_ATTR, list.group);
    for (const name of list.names) {
      const card = document.createElement("div");
      card.className = "tl-card";
      card.dataset.name = name;
      body.appendChild(card);
      byName.set(name, card);
    }
    sidebar.appendChild(body);
    bodies.set(list.group, body);
  }

  // Measured live rather than assigned once, because the rows move while a drag
  // is in the air: a seat fixed at the start would keep answering with the
  // arrangement the drag began in, and a row carried past its neighbour could
  // never be brought back.
  const cards = (): HTMLElement[] =>
    Array.from(sidebar.querySelectorAll<HTMLElement>(".tl-card")).filter((c) => c.id !== CLONE_ID);
  const seat = (el: HTMLElement): number => Math.max(0, cards().indexOf(el));
  for (const card of byName.values()) {
    card.getBoundingClientRect = () => rect(FIRST_ROW_Y + seat(card) * ROW_H, ROW_H);
  }
  for (const body of bodies.values()) {
    body.getBoundingClientRect = () => {
      const own = shownIn(body);
      const first = own[0] ? seat(byName.get(own[0]) ?? body) : 0;
      return rect(FIRST_ROW_Y + first * ROW_H, Math.max(own.length, 1) * ROW_H);
    };
  }
  document.elementFromPoint = (x: number, y: number): Element | null => {
    if (x >= CANVAS_LEFT) return canvas;
    return (
      cards().find((c) => {
        const r = c.getBoundingClientRect();
        return y >= r.top && y < r.bottom;
      }) ?? null
    );
  };

  const moves: Move[] = [];
  const applied: (TreeNode | null)[] = [];
  let dragged = opts.dragged;
  let holds = 0;
  let releases = 0;
  const hold = (): (() => void) => {
    holds += 1;
    return () => {
      releases += 1;
    };
  };

  /**
   * `store.move`, as much of it as this file needs: the session leaves whatever
   * list it was in and lands next to the neighbour the anchor names. Written
   * out rather than recorded because the rows are rendered from it — a double
   * that accepted the call and changed nothing would make "the sidebar order is
   * unchanged" true whatever the code under test did.
   */
  const move = async (name: string, group: string, anchor?: DropAnchor): Promise<void> => {
    moves.push({ name, group, anchor });
    for (const [g, names] of model) {
      const without = names.filter((n) => n !== name);
      model.set(g, without);
    }
    const into = [...(model.get(group) ?? [])];
    const beside = anchor ? into.indexOf(anchor.name) : -1;
    const at = beside < 0 ? into.length : anchor?.side === "below" ? beside + 1 : beside;
    into.splice(at, 0, name);
    model.set(group, into);
  };

  const dispose = createRoot((d) => {
    for (const list of opts.lists) {
      attachSessionList(bodies.get(list.group)!, {
        group: () => list.group,
        names: () => [...(model.get(list.group) ?? [])],
        move,
        hold,
      });
    }
    attachTileDrop(canvas, {
      dragged: () => dragged,
      rects: () => opts.rects,
      tree: () => opts.tree,
      apply: (next) => {
        applied.push(next);
      },
      hold,
    });
    // The app's `<For>`, in a dozen lines. `ProjectGroup` renders each list
    // from `liveOrder(group) ?? the model`, so the rows follow the order the
    // library is reporting while a drag is in the air and fall back to the
    // model once it is cleared — which is what puts a card the tiles took back
    // in the list it came from. Without this the DOM and the library's values
    // drift apart, and the library says so on stderr ("the number of draggable
    // items does not match the number of values"): a harness the library is
    // warning about is not evidence of anything.
    createEffect(() => {
      for (const list of opts.lists) {
        const body = bodies.get(list.group)!;
        const want = liveOrder(list.group) ?? model.get(list.group) ?? [];
        const have = shownIn(body);
        if (have.length === want.length && have.every((n, i) => n === want[i])) continue;
        for (const name of want) {
          const card = byName.get(name);
          if (card) body.appendChild(card);
        }
      }
    });
    return d;
  });
  onTestFinished(() => {
    dispose();
    sidebar.remove();
    canvas.remove();
  });

  // A list registers with the library on the next microtask (`register` in
  // dnd/sidebar.ts says why), so nothing is sortable until one has passed.
  await Promise.resolve();

  return {
    cards,
    moves,
    applied,
    shown: (group: string): string[] => shownIn(bodies.get(group)!),
    setDragged: (key: SessionKey | null) => {
      dragged = key;
    },
    holds: () => holds,
    releases: () => releases,
  };
}

const point = (el: Element, type: string, at: At): boolean =>
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: at.x,
      clientY: at.y,
      pointerType: "touch",
    }),
  );

/** The hold is 450ms; wait past it with real time, since fake timers and the
 *  library's own timeouts do not mix well enough to be worth it. */
const held = (): Promise<unknown> => new Promise((r) => setTimeout(r, 600));
const settled = (): Promise<unknown> => new Promise((r) => setTimeout(r, 60));

/**
 * Press, hold past the long press, move through each point in turn, and let go
 * at the last one.
 *
 * The touch path is the one driven here, as in `test/dnd.drag.test.tsx`: a
 * mouse reorders through native drag events, which jsdom raises but never
 * produces from a pointer. Only the press is aimed at the card; everything
 * after it goes to whatever is under the pointer, because that is where a
 * browser sends it — and it is load-bearing twice over. A card carried into
 * another list is moved there as it goes, so the element the press started on
 * is somewhere else by the end; and a release over the workspace is a release
 * on an element that is not a card at all, which is the whole difference this
 * file is about.
 */
async function drag(card: HTMLElement, from: At, through: readonly At[]): Promise<void> {
  point(card, "pointerdown", from);
  await held();
  const under = (at: At): Element => document.elementFromPoint(at.x, at.y) ?? document.body;
  for (const at of through) {
    point(under(at), "pointermove", at);
    await settled();
  }
  const last = through[through.length - 1] ?? from;
  point(under(last), "pointerup", last);
  await settled();
}

describe("a drag that ends over the tiles", () => {
  it("splits the tile and writes no card order at all", async () => {
    const h = await mount({
      lists: [
        { group: "alpha", names: ["a1"] },
        { group: "bravo", names: ["b1"] },
      ],
      tree: leaf("deploy"),
      rects: TILE,
      dragged: "a1",
    });

    // Down through bravo's list on the way out, which is what makes this worth
    // driving rather than asserting: the library transfers the card into that
    // list as the pointer passes, so the sidebar's `onDragend` fires with bravo
    // as its parent and a1 among bravo's values. Then out onto the left third
    // of the only tile, and let go.
    await drag(h.cards()[0]!, { x: 150, y: 120 }, [
      { x: 150, y: 125 },
      { x: 150, y: 165 },
      { x: 450, y: 450 },
    ]);

    expect(h.moves).toEqual([]);
    expect(h.shown("alpha")).toEqual(["a1"]);
    expect(h.shown("bravo")).toEqual(["b1"]);
    expect(h.applied.map((t) => leafKeys(t ?? leaf("?")))).toEqual([["a1", "deploy"]]);
    // Both modules hold the poll for the length of their drag. The suppressed
    // path is a second way out of `onDragend`, and one that forgot to release
    // would leave the sidebar frozen until the tab was reloaded.
    expect(h.releases()).toBe(h.holds());
  });

  it("leaves the sidebar alone even when the split is refused", async () => {
    // Half of a 300px tile is 150px, under the 240px floor, so the drop is
    // declined and the arrangement does not change. The card was still aimed at
    // the workspace, and reordering the sidebar because the split was too small
    // would be a second surprise on top of the first.
    const h = await mount({
      lists: [{ group: "alpha", names: ["a1", "b1"] }],
      tree: leaf("deploy"),
      rects: NARROW_TILE,
      dragged: "a1",
    });

    await drag(h.cards()[0]!, { x: 150, y: 120 }, [
      { x: 150, y: 125 },
      { x: 150, y: 165 },
      { x: 410, y: 450 },
    ]);

    expect(h.moves).toEqual([]);
    expect(h.applied).toEqual([]);
    expect(h.shown("alpha")).toEqual(["a1", "b1"]);
  });
});

describe("a drag that ends in the list", () => {
  it("still reorders, with a workspace on screen the whole time", async () => {
    const h = await mount({
      lists: [{ group: "alpha", names: ["a1", "b1"] }],
      tree: leaf("deploy"),
      rects: TILE,
      dragged: "a1",
    });

    await drag(h.cards()[0]!, { x: 150, y: 120 }, [
      { x: 150, y: 125 },
      { x: 150, y: 165 },
    ]);

    // Anchored under b1, the neighbour it came to rest past, which is what the
    // layout takes rather than an index.
    expect(h.moves).toEqual([
      { name: "a1", group: "alpha", anchor: { name: "b1", side: "below" } },
    ]);
    expect(h.shown("alpha")).toEqual(["b1", "a1"]);
    // The tiles saw the pointer outside every rect, which is a `remove` of a
    // session that has no tile: the same tree by reference, and nothing written.
    expect(h.applied).toEqual([]);
    expect(h.releases()).toBe(h.holds());
  });

  it("carries a card into another project, which a tile drop must not do for it", async () => {
    const h = await mount({
      lists: [
        { group: "alpha", names: ["a1"] },
        { group: "bravo", names: ["b1"] },
      ],
      tree: leaf("deploy"),
      rects: TILE,
      dragged: "a1",
    });

    // The same first two moves as the tile drop above, stopping where that one
    // carried on out to the workspace. This is the write the suppressed case
    // must not make, so it has to be shown happening when nobody suppresses it.
    await drag(h.cards()[0]!, { x: 150, y: 120 }, [
      { x: 150, y: 125 },
      { x: 150, y: 165 },
    ]);

    expect(h.moves).toEqual([
      { name: "a1", group: "bravo", anchor: { name: "b1", side: "above" } },
    ]);
    expect(h.shown("alpha")).toEqual([]);
    expect(h.shown("bravo")).toEqual(["a1", "b1"]);
    expect(h.applied).toEqual([]);
  });

  /**
   * The library ends a drag from a listener on the CARD and stops the event
   * there, so `dnd/tiles.ts` only ever hears a release that happened somewhere
   * else. An ordinary reorder is released on a card, and it used to leave that
   * module mid-drag for good: the poll hold never came back, `inFlight` stayed
   * true so no later drag could begin, and the abandoned listeners left the old
   * `dragKey` armed for the next release over a tile to apply.
   */
  it("hands the workspace its drag back, so the next drop is not the last one's", async () => {
    const h = await mount({
      lists: [{ group: "alpha", names: ["a1", "b1"] }],
      tree: leaf("deploy"),
      rects: TILE,
      dragged: "a1",
    });

    await drag(h.cards()[0]!, { x: 150, y: 120 }, [
      { x: 150, y: 125 },
      { x: 150, y: 165 },
    ]);
    expect(h.shown("alpha")).toEqual(["b1", "a1"]);

    // Now b1, which is the row at the top, out onto the tile's left third.
    h.setDragged("b1");
    await drag(h.cards()[0]!, { x: 150, y: 120 }, [
      { x: 150, y: 125 },
      { x: 450, y: 450 },
    ]);

    expect(h.applied.map((t) => leafKeys(t ?? leaf("?")))).toEqual([["b1", "deploy"]]);
    expect(h.moves).toHaveLength(1);
    expect(h.releases()).toBe(h.holds());
  });
});
