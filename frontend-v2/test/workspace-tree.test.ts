/**
 * The split tree of a Workspace, checked as arithmetic.
 *
 * The module under test knows nothing about the DOM, about Solid or about
 * corvu, which is what makes it worth testing this hard: every gesture a person
 * can make to an arrangement of tiles resolves to one of six pure functions,
 * and none of them needs a browser to be wrong in.
 *
 * Two halves. Worked examples first, with the numbers written out, because an
 * arrangement is easier to argue about as a shape than as a description. Then a
 * generator that plays random sequences of splits, moves, replaces, removes and
 * resizes against the invariants, which is where the cases nobody thought of
 * live — normalisation running two rules at once, a resize landing on a split
 * that a remove had just merged, a fraction drifting off 1 after forty
 * operations.
 *
 * The one thing these tests CANNOT see is the reason the module exists: a live
 * terminal is never moved in the DOM, so the tree positions slots rather than
 * holding them. That is a property of the render layer and of `keepalive`, and
 * ADR-0027 names the browser check that settles it — build a four-tile
 * workspace on the real deployment, move a tile, and confirm its scrollback and
 * its socket survived.
 */
import { describe, expect, it } from "vitest";
import { keyOf } from "../src/store/keepalive";
import {
  MIN_TILE_PX,
  autoArrange,
  canSplit,
  fitsIn,
  hasLeaf,
  leaf,
  leafKeys,
  moveWithin,
  nodeAt,
  normalize,
  parseTreeNode,
  pathToLeaf,
  removeAt,
  replaceAt,
  resize,
  sessionOf,
  setFractions,
  split,
  splitAt,
  toRects,
  type Edge,
  type NodePath,
  type Rect,
  type Size,
  type Split,
  type TreeNode,
} from "../src/store/workspace-tree";

// ---------------------------------------------------------------------------
// Reading a tree out loud
// ---------------------------------------------------------------------------

/**
 * A tree as one line: `R(0.5:a 0.25:b 0.25:c)` is a row holding three tiles,
 * the first taking half the width.
 *
 * Fractions are rounded to three places on the way out, which is what lets an
 * expectation be written as the number a person would say. `1/3` is 0.333 here
 * and the float behind it is not, and no test in this file cares about the
 * difference — the tiling checks below measure pixels instead.
 */
function render(node: TreeNode | null): string {
  if (!node) return "(none)";
  if (node.kind === "leaf") return node.key;
  const parts = node.children.map(
    (child, i) => `${Math.round((node.fractions[i] ?? 0) * 1000) / 1000}:${render(child)}`,
  );
  return `${node.dir === "row" ? "R" : "C"}(${parts.join(" ")})`;
}

/** Unwrap a tree that the signature says may be null but the case says is not. */
function must(node: TreeNode | null): TreeNode {
  if (!node) throw new Error("expected a tree, got no workspace at all");
  return node;
}

function rectFor(rects: readonly Rect[], key: string): Rect {
  const hit = rects.find((r) => r.key === key);
  if (!hit) throw new Error(`no rect for ${key}`);
  return hit;
}

const WIDE: Size = { width: 1600, height: 900 };

/** The separator keepalive joins owner and name with, built rather than typed:
 *  a raw NUL byte in a source file makes git call it binary. */
const NUL = String.fromCharCode(0);

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe("the shape of a split", () => {
  it("shares the space evenly when nobody has said otherwise", () => {
    expect(render(split("row", [leaf("a"), leaf("b"), leaf("c")]))).toBe(
      "R(0.333:a 0.333:b 0.333:c)",
    );
  });

  it("scales supplied sizes to sum to one, so a caller may pass any ratio", () => {
    expect(render(split("row", [leaf("a"), leaf("b")], [3, 1]))).toBe("R(0.75:a 0.25:b)");
  });

  it("repairs a fractions array of the wrong length rather than trusting it", () => {
    // It can only arrive from a hand-built node or a stored document written to
    // an older shape, and guessing which child each number meant would move
    // tiles nobody dragged.
    expect(render(split("row", [leaf("a"), leaf("b")], [1]))).toBe("R(0.5:a 0.5:b)");
  });

  it("falls back to an even share when the sizes sum to nothing", () => {
    expect(render(split("column", [leaf("a"), leaf("b")], [0, -4]))).toBe("C(0.5:a 0.5:b)");
  });

  it("treats a key as opaque, so keepalive's owner-and-name shape needs no parsing", () => {
    // The real `keyOf` rather than a stand-in for its output: the tree stores
    // whatever keepalive mints and never parses it, and this is the one case
    // that would notice if the two halves ever disagreed about the shape. Two
    // people owning a session of the same name are two terminals, so they are
    // two tiles and not one.
    const mine = keyOf({ name: "deploy-the-thing" });
    const theirs = keyOf({ name: "deploy-the-thing", owner: "emo" });
    expect(mine).not.toBe(theirs);
    const both = splitAt(leaf(mine), mine, "right", theirs);
    expect(leafKeys(both)).toEqual([mine, theirs]);
    expect(hasLeaf(both, theirs)).toBe(true);
  });
});

describe("sessionOf", () => {
  it("round-trips keepalive's key, with an owner and without one", () => {
    for (const parts of [{ name: "deploy-the-thing" }, { name: "auth", owner: "emo" }]) {
      expect(sessionOf(keyOf(parts))).toEqual(parts);
      expect(keyOf(sessionOf(keyOf(parts)))).toBe(keyOf(parts));
    }
  });

  it("leaves the owner off rather than handing back an empty string", () => {
    // `keyOf` writes `${owner ?? ""}` , so an unowned session's key starts with
    // the separator. A tile header asking `parts.owner` for a foreign-session
    // marker must get undefined there, not a string that is falsy by luck.
    const parts = sessionOf(keyOf({ name: "auth" }));
    expect(parts).toEqual({ name: "auth" });
    expect("owner" in parts).toBe(false);
  });

  it("reads a key with no separator in it as a bare name", () => {
    expect(sessionOf("auth")).toEqual({ name: "auth" });
  });

  it("splits at the first separator, so a name is never mistaken for an owner", () => {
    const odd = { name: `a${NUL}b`, owner: "emo" };
    expect(sessionOf(keyOf(odd))).toEqual(odd);
  });

  it("is what turns a tile back into the session its header renders", () => {
    const tree = splitAt(
      leaf(keyOf({ name: "auth" })),
      keyOf({ name: "auth" }),
      "right",
      keyOf({ name: "deploy", owner: "emo" }),
    );
    expect(leafKeys(tree).map(sessionOf)).toEqual([
      { name: "auth" },
      { name: "deploy", owner: "emo" },
    ]);
  });
});

describe("addressing a tile", () => {
  const tree = split("row", [leaf("a"), split("column", [leaf("b"), leaf("c")])]);

  it("names a tile by the child indices from the root down", () => {
    expect(pathToLeaf(tree, "a")).toEqual([0]);
    expect(pathToLeaf(tree, "c")).toEqual([1, 1]);
    expect(pathToLeaf(leaf("a"), "a")).toEqual([]);
    expect(pathToLeaf(tree, "z")).toBeNull();
  });

  it("walks a path back to its node, and stops at the edge of the tree", () => {
    expect(nodeAt(tree, [1, 0])).toEqual(leaf("b"));
    expect(nodeAt(tree, [])).toBe(tree);
    expect(nodeAt(tree, [5])).toBeNull();
    expect(nodeAt(tree, [0, 0])).toBeNull();
  });

  it("answers whether a session is already on screen, which is split-or-move", () => {
    expect(hasLeaf(tree, "b")).toBe(true);
    expect(hasLeaf(tree, "z")).toBe(false);
  });

  it("lists tiles in reading order, left to right and top to bottom", () => {
    expect(leafKeys(tree)).toEqual(["a", "b", "c"]);
  });
});

describe("normalize", () => {
  it("collapses a split with one child into that child", () => {
    expect(render(normalize(split("row", [leaf("a")])))).toBe("a");
  });

  it("merges a split into a parent of the same direction, scaled by the slot it held", () => {
    const nested = split("row", [leaf("a"), split("row", [leaf("b"), leaf("c")])], [0.6, 0.4]);
    expect(render(normalize(nested))).toBe("R(0.6:a 0.2:b 0.2:c)");
  });

  it("leaves a crossing direction nested, which is what makes a grid possible", () => {
    const grid = split("row", [leaf("a"), split("column", [leaf("b"), leaf("c")])]);
    expect(render(normalize(grid))).toBe("R(0.5:a 0.5:C(0.5:b 0.5:c))");
  });

  it("runs both rules together, however deep the pointless nesting goes", () => {
    const silly = split("row", [split("row", [split("column", [split("row", [leaf("a")])])])]);
    expect(render(normalize(silly))).toBe("a");
  });

  it("has no tree to return for a node holding no tiles at all", () => {
    expect(normalize(split("row", []))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reading a tree back off disk
// ---------------------------------------------------------------------------

describe("parseTreeNode", () => {
  // Raw literals, not constructor output. These are what a foreign build, a
  // half-finished write or a hand-edited localStorage leaves behind, and a
  // constructor would never make one — which is the whole reason the parser
  // cannot be `normalize`, whose argument is already a TreeNode.
  const tile = (key: string) => ({ kind: "leaf", key });
  const pair = [tile("a"), tile("b")];

  const refused: Array<[string, unknown]> = [
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["a string", "leaf"],
    ["an array, which is an object and is not a node", [tile("a")]],
    ["an object with no kind", { key: "a" }],
    ["a kind nothing writes", { kind: "tile", key: "a" }],
    ["a tile with no key", { kind: "leaf" }],
    ["a tile whose key is not a string", { kind: "leaf", key: 7 }],
    ["a tile whose key is empty", { kind: "leaf", key: "" }],
    ["a split with no direction", { kind: "split", children: pair, fractions: [0.5, 0.5] }],
    [
      "a direction nothing writes",
      { kind: "split", dir: "diagonal", children: pair, fractions: [0.5, 0.5] },
    ],
    ["children that are not an array", { kind: "split", dir: "row", children: {}, fractions: [] }],
    [
      "a split with one child, which is a tile wearing a wrapper",
      { kind: "split", dir: "row", children: [tile("a")], fractions: [1] },
    ],
    ["a split with no children", { kind: "split", dir: "row", children: [], fractions: [] }],
    [
      "fractions that are not an array",
      { kind: "split", dir: "row", children: pair, fractions: 1 },
    ],
    [
      "fewer fractions than children",
      { kind: "split", dir: "row", children: pair, fractions: [1] },
    ],
    [
      "a fraction that is not a number",
      { kind: "split", dir: "row", children: pair, fractions: ["0.5", 0.5] },
    ],
    [
      "a fraction that is not finite",
      { kind: "split", dir: "row", children: pair, fractions: [Number.POSITIVE_INFINITY, 0.5] },
    ],
    [
      "a fraction that is NaN",
      { kind: "split", dir: "row", children: pair, fractions: [Number.NaN, 0.5] },
    ],
    [
      "a fraction of zero, which is a tile with no pixels",
      { kind: "split", dir: "row", children: pair, fractions: [0, 1] },
    ],
    ["a negative fraction", { kind: "split", dir: "row", children: pair, fractions: [-0.5, 1.5] }],
    [
      "fractions that do not sum to one",
      { kind: "split", dir: "row", children: pair, fractions: [0.5, 0.4] },
    ],
    [
      "a child that is itself malformed",
      { kind: "split", dir: "row", children: [tile("a"), { kind: "leaf" }], fractions: [0.5, 0.5] },
    ],
    [
      "the same session in two tiles, which is the one thing a tree may never hold",
      { kind: "split", dir: "row", children: [tile("a"), tile("a")], fractions: [0.5, 0.5] },
    ],
    [
      "a duplicate buried in a nested split, where a shallow check would miss it",
      {
        kind: "split",
        dir: "row",
        children: [
          tile("a"),
          { kind: "split", dir: "column", children: [tile("b"), tile("a")], fractions: [0.5, 0.5] },
        ],
        fractions: [0.5, 0.5],
      },
    ],
  ];

  for (const [label, value] of refused) {
    it(`refuses ${label}`, () => {
      expect(parseTreeNode(value)).toBeNull();
    });
  }

  it("accepts a tile", () => {
    expect(parseTreeNode(tile("a"))).toEqual(leaf("a"));
  });

  it("accepts a split and hands back the same tree the constructors build", () => {
    const value = { kind: "split", dir: "row", children: pair, fractions: [0.5, 0.5] };
    expect(parseTreeNode(value)).toEqual(split("row", [leaf("a"), leaf("b")]));
  });

  it("allows the float slack a stored sum actually lands on", () => {
    // Thirds do not sum to 1 exactly in every arithmetic that produced them,
    // and a parser that demanded exactness would refuse a document it wrote.
    const value = {
      kind: "split",
      dir: "column",
      children: [tile("a"), tile("b"), tile("c")],
      fractions: [1 / 3, 1 / 3, 1 / 3 - 1e-12],
    };
    expect(render(parseTreeNode(value))).toBe("C(0.333:a 0.333:b 0.333:c)");
  });

  it("normalizes what it parses, so a stored oddity does not reach the screen", () => {
    const nested = {
      kind: "split",
      dir: "row",
      children: [
        tile("a"),
        { kind: "split", dir: "row", children: [tile("b"), tile("c")], fractions: [0.5, 0.5] },
      ],
      fractions: [0.6, 0.4],
    };
    expect(render(parseTreeNode(nested))).toBe("R(0.6:a 0.2:b 0.2:c)");
  });

  it("round-trips a tree through the JSON the device store writes", () => {
    const tree = splitAt(
      splitAt(leaf(keyOf({ name: "auth" })), keyOf({ name: "auth" }), "right", "b"),
      "b",
      "bottom",
      "c",
    );
    expect(parseTreeNode(JSON.parse(JSON.stringify(tree)))).toEqual(tree);
  });
});

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

describe("splitAt", () => {
  const one = leaf("a");

  it("puts the arriving session on the edge it was dropped on", () => {
    expect(render(splitAt(one, "a", "right", "b"))).toBe("R(0.5:a 0.5:b)");
    expect(render(splitAt(one, "a", "left", "b"))).toBe("R(0.5:b 0.5:a)");
    expect(render(splitAt(one, "a", "bottom", "b"))).toBe("C(0.5:a 0.5:b)");
    expect(render(splitAt(one, "a", "top", "b"))).toBe("C(0.5:b 0.5:a)");
  });

  it("makes a row of three rather than a row containing a row", () => {
    // The n-ary promise. The new pair takes the slot the split tile held, so
    // `a` keeps its half and `b` and `c` share the other one.
    const two = splitAt(one, "a", "right", "b");
    expect(render(splitAt(two, "b", "right", "c"))).toBe("R(0.5:a 0.25:b 0.25:c)");
  });

  it("nests when the split crosses the parent's direction", () => {
    const two = splitAt(one, "a", "right", "b");
    expect(render(splitAt(two, "b", "bottom", "c"))).toBe("R(0.5:a 0.5:C(0.5:b 0.5:c))");
  });

  it("moves a session that is already on screen instead of showing it twice", () => {
    // keepalive mounts one live view per session, so a second tile would have
    // no terminal in it, and two tiles of one session would contend for its
    // Grid continuously.
    const three = splitAt(splitAt(one, "a", "right", "b"), "b", "right", "c");
    const moved = splitAt(three, "a", "bottom", "c");
    expect(leafKeys(moved).slice().sort()).toEqual(["a", "b", "c"]);
    expect(render(moved)).toBe("R(0.667:C(0.5:a 0.5:c) 0.333:b)");
  });

  it("does nothing when a tile is dropped on its own edge", () => {
    const two = splitAt(one, "a", "right", "b");
    expect(splitAt(two, "a", "left", "a")).toBe(two);
  });

  it("does nothing when the target tile is not there", () => {
    expect(splitAt(one, "zz", "left", "b")).toBe(one);
  });

  it("does not enforce the minimum tile, which is canSplit's question to answer", () => {
    // A window dragged narrow takes an existing tree below the floor without
    // asking, so the tree has to survive being too small. Refusing here would
    // put the guard in the wrong layer.
    const tiny = splitAt(one, "a", "right", "b");
    expect(leafKeys(tiny)).toEqual(["a", "b"]);
    expect(canSplit(one, "a", "right", { width: 100, height: 100 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Replacing
// ---------------------------------------------------------------------------

describe("replaceAt", () => {
  it("swaps the session showing in a tile, keeping its size and its place", () => {
    const tree = split("row", [leaf("a"), leaf("b")], [0.7, 0.3]);
    expect(render(replaceAt(tree, "b", "c"))).toBe("R(0.7:a 0.3:c)");
  });

  it("closes the dropped session's old tile rather than showing it twice", () => {
    const tree = split("row", [leaf("a"), leaf("b"), leaf("c")], [0.5, 0.25, 0.25]);
    const after = replaceAt(tree, "a", "c");
    expect(leafKeys(after)).toEqual(["c", "b"]);
    expect(render(after)).toBe("R(0.667:c 0.333:b)");
  });

  it("does nothing when the tile already shows that session", () => {
    const tree = split("row", [leaf("a"), leaf("b")]);
    expect(replaceAt(tree, "a", "a")).toBe(tree);
  });

  it("does nothing for a tile that is not there", () => {
    const tree = split("row", [leaf("a"), leaf("b")]);
    expect(replaceAt(tree, "zz", "c")).toBe(tree);
  });
});

// ---------------------------------------------------------------------------
// Removing
// ---------------------------------------------------------------------------

describe("removeAt", () => {
  it("hands a closed tile's space to its siblings in proportion to what they had", () => {
    const row = split("row", [leaf("a"), leaf("b"), leaf("c")], [0.5, 0.25, 0.25]);
    expect(render(removeAt(row, "b"))).toBe("R(0.667:a 0.333:c)");
  });

  it("unwraps the survivor when a split drops to one child", () => {
    const tree = split("row", [leaf("a"), split("column", [leaf("b"), leaf("c")])]);
    expect(render(removeAt(tree, "c"))).toBe("R(0.5:a 0.5:b)");
  });

  it("leaves no useless nesting behind, however the close rearranges things", () => {
    // Closing `b` empties the column down to one child, that child is a row,
    // and the parent is a row: both normalisation rules fire on one removal.
    const tree = split("row", [
      leaf("a"),
      split("column", [leaf("b"), split("row", [leaf("c"), leaf("d")])]),
    ]);
    expect(render(removeAt(tree, "b"))).toBe("R(0.5:a 0.25:c 0.25:d)");
  });

  it("ends the workspace when the last tile closes", () => {
    expect(removeAt(leaf("a"), "a")).toBeNull();
  });

  it("leaves the tree alone, by reference, for a session with no tile", () => {
    const tree = split("row", [leaf("a"), leaf("b")]);
    expect(removeAt(tree, "zz")).toBe(tree);
  });
});

// ---------------------------------------------------------------------------
// Moving
// ---------------------------------------------------------------------------

describe("moveWithin", () => {
  it("moves a tile without ever duplicating the session", () => {
    const tree = split("row", [leaf("a"), leaf("b"), leaf("c")]);
    const moved = moveWithin(tree, "c", "a", "top");
    expect(leafKeys(moved).slice().sort()).toEqual(["a", "b", "c"]);
    expect(render(moved)).toBe("R(0.5:C(0.5:c 0.5:a) 0.5:b)");
  });

  it("flips a pair's axis when one half lands on the other's edge", () => {
    const pair = split("row", [leaf("a"), leaf("b")]);
    expect(render(moveWithin(pair, "b", "a", "bottom"))).toBe("C(0.5:a 0.5:b)");
  });

  it("leaves the tree alone when a tile is dropped on its own edge", () => {
    const tree = split("row", [leaf("a"), leaf("b")]);
    expect(moveWithin(tree, "a", "a", "left")).toBe(tree);
  });

  it("leaves the tree alone when either session has no tile", () => {
    const tree = split("row", [leaf("a"), leaf("b")]);
    expect(moveWithin(tree, "zz", "a", "left")).toBe(tree);
    expect(moveWithin(tree, "a", "zz", "left")).toBe(tree);
  });
});

// ---------------------------------------------------------------------------
// Resizing
// ---------------------------------------------------------------------------

describe("resize", () => {
  it("moves exactly the two neighbours of the divider, and nothing else", () => {
    // This is the whole reason the tree is n-ary. A row of four is one node, so
    // dragging the second divider grows `b` into `c` and leaves `a` and `d`
    // exactly where they were. Nested pairs would have shifted a tile nobody
    // was dragging.
    const row = split("row", [leaf("a"), leaf("b"), leaf("c"), leaf("d")]);
    const before = toRects(row, WIDE);
    const after = toRects(resize(row, [], 1, 0.05, WIDE), WIDE);
    const widened = after.filter((r) => Math.abs(r.width - rectFor(before, r.key).width) > 1e-9);
    expect(widened.map((r) => r.key)).toEqual(["b", "c"]);
    expect(rectFor(after, "a")).toEqual(rectFor(before, "a"));
    expect(rectFor(after, "d")).toEqual(rectFor(before, "d"));
  });

  it("takes its delta as a fraction of the split's own extent", () => {
    const row = split("row", [leaf("a"), leaf("b"), leaf("c")]);
    expect(render(resize(row, [], 0, 0.1, WIDE))).toBe("R(0.433:a 0.233:b 0.333:c)");
  });

  it("stops the divider at the 240px floor instead of refusing the drag", () => {
    // A handle that silently does nothing reads as broken, so it clamps.
    const row = split("row", [leaf("a"), leaf("b")]);
    expect(render(resize(row, [], 0, 0.9, { width: 1000, height: 800 }))).toBe("R(0.76:a 0.24:b)");
    expect(MIN_TILE_PX / 1000).toBe(0.24);
  });

  it("holds still when the split is already too small for two tiles", () => {
    // 400px cannot give two tiles 240 each. There is no valid place to stop, so
    // the divider does not move and the window-too-small fallback answers it.
    const row = split("row", [leaf("a"), leaf("b")]);
    expect(resize(row, [], 0, 0.2, { width: 400, height: 800 })).toBe(row);
  });

  it("has no floor at all without a container to measure against", () => {
    const row = split("row", [leaf("a"), leaf("b")]);
    expect(render(resize(row, [], 0, 0.45))).toBe("R(0.95:a 0.05:b)");
  });

  it("measures a nested split's floor against that split's own box", () => {
    // The column is half of a 1600px row, so the divider inside it moves
    // against the 900px height, not against anything the container knows.
    const tree = split("row", [leaf("a"), split("column", [leaf("b"), leaf("c")])]);
    expect(render(resize(tree, [1], 0, 0.9, WIDE))).toBe("R(0.5:a 0.5:C(0.733:b 0.267:c))");
  });

  it("ignores a path that is not a split and a divider that is not there", () => {
    const row = split("row", [leaf("a"), leaf("b")]);
    expect(resize(row, [0], 0, 0.1)).toBe(row);
    expect(resize(row, [9], 0, 0.1)).toBe(row);
    expect(resize(row, [], 1, 0.1)).toBe(row);
    expect(resize(row, [], -1, 0.1)).toBe(row);
    expect(resize(row, [], 0, 0)).toBe(row);
    expect(resize(row, [], 0, Number.NaN)).toBe(row);
  });
});

describe("setFractions", () => {
  it("stores the row of sizes corvu reports, scaled to sum to one", () => {
    const row = split("row", [leaf("a"), leaf("b"), leaf("c")]);
    expect(render(setFractions(row, [], [2, 1, 1]))).toBe("R(0.5:a 0.25:b 0.25:c)");
  });

  it("water-fills a panel under the floor from the ones with room to give", () => {
    const row = split("row", [leaf("a"), leaf("b")]);
    expect(render(setFractions(row, [], [0.95, 0.05], { width: 1000, height: 800 }))).toBe(
      "R(0.76:a 0.24:b)",
    );
  });

  it("spreads evenly when the split cannot give every child the floor", () => {
    const row = split("row", [leaf("a"), leaf("b")]);
    expect(render(setFractions(row, [], [0.9, 0.1], { width: 400, height: 800 }))).toBe(
      "R(0.5:a 0.5:b)",
    );
  });

  it("ignores an array that does not match the split's children", () => {
    const row = split("row", [leaf("a"), leaf("b")]);
    expect(setFractions(row, [], [1])).toBe(row);
    expect(setFractions(row, [0], [0.5, 0.5])).toBe(row);
  });
});

// ---------------------------------------------------------------------------
// The default arrangement
// ---------------------------------------------------------------------------

describe("autoArrange", () => {
  function keys(n: number): string[] {
    return Array.from({ length: n }, (_, i) => `a${i + 1}`);
  }

  const shapes: Array<[number, string]> = [
    [1, "a1"],
    [2, "R(0.5:a1 0.5:a2)"],
    [3, "R(0.5:a1 0.5:C(0.5:a2 0.5:a3))"],
    [4, "R(0.5:C(0.5:a1 0.5:a2) 0.5:C(0.5:a3 0.5:a4))"],
    [5, "R(0.333:a1 0.333:C(0.5:a2 0.5:a3) 0.333:C(0.5:a4 0.5:a5))"],
    [6, "R(0.333:C(0.5:a1 0.5:a2) 0.333:C(0.5:a3 0.5:a4) 0.333:C(0.5:a5 0.5:a6))"],
    [7, "R(0.333:C(0.5:a1 0.5:a2) 0.333:C(0.5:a3 0.5:a4) 0.333:C(0.333:a5 0.333:a6 0.333:a7))"],
    [
      8,
      "R(0.333:C(0.5:a1 0.5:a2) 0.333:C(0.333:a3 0.333:a4 0.333:a5) 0.333:C(0.333:a6 0.333:a7 0.333:a8))",
    ],
  ];

  for (const [n, shape] of shapes) {
    it(`arranges ${n} member${n === 1 ? "" : "s"} as ${shape}`, () => {
      expect(render(autoArrange(keys(n)))).toBe(shape);
    });
  }

  it("gives every tile the same width, which is the dimension a terminal cares about", () => {
    // A tile 45 columns wide gives its session a 45-column tmux window for
    // every device attached to it, so an arrangement that varies width by
    // column would hand one member a narrower session for no reason.
    for (let n = 2; n <= 12; n++) {
      const widths = new Set(
        toRects(must(autoArrange(keys(n))), WIDE).map((r) => Math.round(r.width * 1e6)),
      );
      expect(widths.size, `${n} members`).toBe(1);
    }
  });

  it("keeps the workspace's server-side member order", () => {
    expect(leafKeys(must(autoArrange(["z", "y", "x", "w"])))).toEqual(["z", "y", "x", "w"]);
  });

  it("drops a duplicate rather than showing one session twice", () => {
    expect(leafKeys(must(autoArrange(["a", "b", "a"])))).toEqual(["a", "b"]);
  });

  it("has no tree at all for no members", () => {
    expect(autoArrange([])).toBeNull();
  });

  it("is deterministic, so the same workspace opens the same way on any device", () => {
    expect(render(autoArrange(keys(6)))).toBe(render(autoArrange(keys(6))));
  });
});

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

describe("toRects", () => {
  it("puts a 2x2 at the four corners of the container", () => {
    expect(toRects(must(autoArrange(["a", "b", "c", "d"])), WIDE)).toEqual([
      { key: "a", x: 0, y: 0, width: 800, height: 450 },
      { key: "b", x: 0, y: 450, width: 800, height: 450 },
      { key: "c", x: 800, y: 0, width: 800, height: 450 },
      { key: "d", x: 800, y: 450, width: 800, height: 450 },
    ]);
  });

  it("ends the last tile exactly at the container edge, whatever the fractions", () => {
    // 6:4:2 across 1600px is the case that catches this: the cumulative sum of
    // those three fractions lands on 1599.9999999999998, so the last edge has
    // to be pinned to the extent rather than accumulated to it. Thirds would
    // have passed either way, which is how the pinning nearly went untested.
    const row = split("row", [leaf("a"), leaf("b"), leaf("c")], [6, 4, 2]);
    const rects = toRects(row, { width: 1600, height: 100 });
    const c = rectFor(rects, "c");
    expect(c.x + c.width).toBe(1600);
    expect(rectFor(rects, "b").x).toBe(rectFor(rects, "a").width);
    expect(rectFor(rects, "c").x).toBe(rectFor(rects, "b").x + rectFor(rects, "b").width);
  });

  it("reserves nothing for dividers, which are drawn on the boundary above", () => {
    const rects = toRects(split("row", [leaf("a"), leaf("b")]), { width: 1000, height: 100 });
    expect(rectFor(rects, "a").width + rectFor(rects, "b").width).toBe(1000);
  });

  it("survives a container of no size at all", () => {
    const rects = toRects(must(autoArrange(["a", "b", "c"])), { width: 0, height: 0 });
    expect(rects.map((r) => r.key)).toEqual(["a", "b", "c"]);
    expect(rects.every((r) => r.width === 0 && r.height === 0)).toBe(true);
  });
});

describe("canSplit", () => {
  it("allows a split that leaves both halves at exactly the floor", () => {
    expect(canSplit(leaf("a"), "a", "left", { width: 2 * MIN_TILE_PX, height: 900 })).toBe(true);
    expect(canSplit(leaf("a"), "a", "left", { width: 2 * MIN_TILE_PX - 1, height: 900 })).toBe(
      false,
    );
  });

  it("asks about the axis the divider crosses, not the other one", () => {
    // A tile already shorter than the floor because the window is short is not
    // made shorter by a vertical divider, and refusing there would make a small
    // window refuse every drop rather than the ones that crush a terminal.
    const short: Size = { width: 1600, height: 200 };
    expect(canSplit(leaf("a"), "a", "left", short)).toBe(true);
    expect(canSplit(leaf("a"), "a", "bottom", short)).toBe(false);
  });

  it("measures the target tile's own box, not the container's", () => {
    const two = split("row", [leaf("a"), leaf("b")]);
    expect(canSplit(two, "a", "left", { width: 1600, height: 900 })).toBe(true);
    expect(canSplit(two, "a", "left", { width: 900, height: 900 })).toBe(false);
    expect(canSplit(two, "a", "bottom", { width: 900, height: 900 })).toBe(true);
  });

  it("has nothing to split for a session with no tile", () => {
    expect(canSplit(leaf("a"), "zz", "left", WIDE)).toBe(false);
  });
});

describe("fitsIn", () => {
  it("always fits a single tile, because there is nothing to fall back to", () => {
    expect(fitsIn(leaf("a"), { width: 100, height: 100 })).toBe(true);
  });

  it("stops fitting the moment the window takes a tile under the floor", () => {
    const four = must(autoArrange(["a", "b", "c", "d"]));
    expect(fitsIn(four, { width: 960, height: 540 })).toBe(true);
    expect(fitsIn(four, { width: 960, height: 2 * MIN_TILE_PX - 2 })).toBe(false);
    expect(fitsIn(four, { width: 2 * MIN_TILE_PX - 2, height: 540 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Properties, over random sequences
// ---------------------------------------------------------------------------

/**
 * A seeded PRNG, so a failure names a seed and a step and replays exactly.
 * mulberry32: 32 bits of state, uniform enough for picking list indices and
 * small enough to read.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rnd: () => number, xs: readonly T[]): T {
  const x = xs[Math.floor(rnd() * xs.length)];
  if (x === undefined) throw new Error("picked from an empty list");
  return x;
}

const EDGES: readonly Edge[] = ["left", "right", "top", "bottom"];

/** Every split in the tree, by path, root first. */
function splitPaths(node: TreeNode, at: NodePath = []): NodePath[] {
  if (node.kind === "leaf") return [];
  const out: NodePath[] = [at];
  node.children.forEach((child, i) => out.push(...splitPaths(child, [...at, i])));
  return out;
}

function eachSplit(
  node: TreeNode,
  parentDir: "row" | "column" | null,
  visit: (node: Split, parentDir: "row" | "column" | null) => void,
): void {
  if (node.kind === "leaf") return;
  visit(node, parentDir);
  for (const child of node.children) eachSplit(child, node.dir, visit);
}

/**
 * The five things that must be true of any tree, however it was arrived at.
 * Everything a gesture can do to an arrangement is checked against these after
 * every single operation, which is where the interactions nobody enumerated
 * show up.
 */
function checkInvariants(tree: TreeNode, container: Size): void {
  const keys = leafKeys(tree);

  // 1. One session, at most one tile.
  expect(new Set(keys).size, "a session appears in two tiles").toBe(keys.length);

  eachSplit(tree, null, (node, parentDir) => {
    // 2. No split with fewer than two children: a lone child IS the split.
    expect(node.children.length >= 2, `a split has ${node.children.length} children`).toBe(true);
    // 3. No split shares its parent's direction, or a divider would move a tile
    //    nobody was dragging.
    expect(node.dir === parentDir, "a split shares its parent's direction").toBe(false);
    // 4. One fraction per child, none negative, summing to 1.
    expect(node.fractions.length, "fractions do not match children").toBe(node.children.length);
    expect(
      node.fractions.every((f) => Number.isFinite(f) && f >= 0),
      `a fraction is negative or not finite: ${node.fractions.join(", ")}`,
    ).toBe(true);
    const sum = node.fractions.reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1) < 1e-9, `fractions sum to ${sum}`).toBe(true);
  });

  // 5. The rects tile the container exactly: every one inside it, no two
  //    overlapping, and their areas adding up to the whole. Disjoint plus
  //    contained plus equal total area leaves no room for a gap.
  const rects = toRects(tree, container);
  expect(
    rects.map((r) => r.key),
    "a rect per tile, in reading order",
  ).toEqual(keys);
  let area = 0;
  for (const r of rects) {
    expect(
      r.x >= -1e-9 &&
        r.y >= -1e-9 &&
        r.x + r.width <= container.width + 1e-9 &&
        r.y + r.height <= container.height + 1e-9,
      `${r.key} falls outside the container`,
    ).toBe(true);
    expect(r.width >= -1e-9 && r.height >= -1e-9, `${r.key} has a negative side`).toBe(true);
    area += r.width * r.height;
  }
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      if (!a || !b) continue;
      const overlaps =
        a.x < b.x + b.width - 1e-9 &&
        b.x < a.x + a.width - 1e-9 &&
        a.y < b.y + b.height - 1e-9 &&
        b.y < a.y + a.height - 1e-9;
      expect(overlaps, `${a.key} overlaps ${b.key}`).toBe(false);
    }
  }
  const whole = container.width * container.height;
  expect(
    Math.abs(area - whole) < 1e-6 * Math.max(1, whole),
    `tiles cover ${area} of ${whole}`,
  ).toBe(true);

  // 6. Whatever a sequence of gestures can build survives the round trip the
  //    device store makes it take: JSON out to localStorage, `parseTreeNode`
  //    back in. A tree an operation can produce and the parser then refuses
  //    would lose someone their arrangement on their next page load, and the
  //    only way to find that class of bug is to take every tree through it.
  expect(
    render(parseTreeNode(JSON.parse(JSON.stringify(tree)))),
    "the parser refuses a tree these operations produced",
  ).toBe(render(tree));
}

/**
 * Play a random sequence of gestures against one tree, checking the invariants
 * after every one. `measure` is the box the tiling is checked in; `clampTo` is
 * what the resizes are told about, so a run can exercise the unclamped path by
 * leaving it out.
 */
function playSequence(seed: number, steps: number, measure: Size, clampTo?: Size): void {
  const rnd = mulberry32(seed);
  let tree: TreeNode = leaf("s0");
  let minted = 1;
  const log: string[] = ["start s0"];
  for (let step = 0; step < steps; step++) {
    const keys = leafKeys(tree);
    const roll = keys.length === 1 ? 0 : rnd();
    if (roll < 0.34) {
      const target = pick(rnd, keys);
      const edge = pick(rnd, EDGES);
      // A quarter of the drops are a session already on screen, which is a move
      // wearing a split's clothes and the case that can duplicate a tile.
      const arriving = keys.length > 1 && rnd() < 0.25 ? pick(rnd, keys) : `s${minted++}`;
      tree = splitAt(tree, target, edge, arriving);
      log.push(`split ${target} ${edge} <- ${arriving}`);
    } else if (roll < 0.5) {
      const from = pick(rnd, keys);
      const to = pick(rnd, keys);
      const edge = pick(rnd, EDGES);
      tree = moveWithin(tree, from, to, edge);
      log.push(`move ${from} -> ${to} ${edge}`);
    } else if (roll < 0.62) {
      const target = pick(rnd, keys);
      const arriving = rnd() < 0.5 ? pick(rnd, keys) : `s${minted++}`;
      tree = replaceAt(tree, target, arriving);
      log.push(`replace ${target} <- ${arriving}`);
    } else if (roll < 0.75) {
      const gone = pick(rnd, keys);
      const next = removeAt(tree, gone);
      log.push(`remove ${gone}`);
      if (next) {
        tree = next;
      } else {
        tree = leaf(`s${minted++}`);
        log.push("workspace ended, opening a fresh session");
      }
    } else if (roll < 0.9) {
      const path = pick(rnd, splitPaths(tree));
      const node = nodeAt(tree, path);
      if (node && node.kind === "split") {
        const divider = Math.floor(rnd() * (node.children.length - 1));
        const delta = (rnd() - 0.5) * 0.9;
        tree = resize(tree, path, divider, delta, clampTo);
        log.push(`resize [${path.join(",")}] divider ${divider} by ${delta.toFixed(3)}`);
      }
    } else {
      const path = pick(rnd, splitPaths(tree));
      const node = nodeAt(tree, path);
      if (node && node.kind === "split") {
        const sizes = node.children.map(() => rnd());
        tree = setFractions(tree, path, sizes, clampTo);
        log.push(`sizes [${path.join(",")}] <- ${sizes.map((s) => s.toFixed(3)).join(" ")}`);
      }
    }
    try {
      checkInvariants(tree, measure);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new Error(
        `seed ${seed}, step ${step}\n${log.join("\n")}\n\ntree: ${render(tree)}\n\n${why}`,
      );
    }
  }
}

describe("any sequence of gestures leaves a tree that still makes sense", () => {
  it("holds over 200 sequences of 40 operations in a 1600x900 window", () => {
    // The clamp container is passed, so this is the path the app runs: every
    // resize measures MIN_TILE_PX against the split's own box. The unclamped
    // arithmetic gets its own case below rather than sharing this one.
    for (let seed = 1; seed <= 200; seed++) playSequence(seed, 40, WIDE, WIDE);
  });

  it("holds in a window too small for the floor, where every clamp fires", () => {
    // 520x380 cannot give two tiles 240px on either axis, so resize refuses to
    // move and setFractions spreads evenly. The tree still has to tile.
    for (let seed = 1; seed <= 60; seed++) {
      playSequence(seed, 30, { width: 520, height: 380 }, { width: 520, height: 380 });
    }
  });

  it("holds with no container at all, where the only floor is a fraction that exists", () => {
    for (let seed = 1; seed <= 60; seed++) playSequence(seed, 30, WIDE);
  });

  it("never drives a fraction to zero, container or no container", () => {
    // A tile of zero extent has no edge to grab, so no drag can bring it back,
    // and `parseTreeNode` refuses it on the next page load. The clamp holds at
    // EPSILON even when there are no pixels to measure MIN_TILE_PX against.
    const row = split("row", [leaf("a"), leaf("b")]);
    const shoved = resize(row, [], 0, -5);
    expect(shoved.kind).toBe("split");
    if (shoved.kind === "split") {
      expect(shoved.fractions.every((f) => f > 0)).toBe(true);
    }
    expect(parseTreeNode(JSON.parse(JSON.stringify(shoved)))).not.toBeNull();
  });

  it("never leaves a tile below the floor after a resize that was given one", () => {
    // The clamp's own promise, checked over the same random sequences: with a
    // container passed to every resize, a tree that fitted before a drag still
    // fits after it.
    const box: Size = { width: 1920, height: 1080 };
    for (let seed = 1; seed <= 80; seed++) {
      const rnd = mulberry32(seed);
      let tree: TreeNode = must(
        autoArrange(Array.from({ length: 2 + Math.floor(rnd() * 3) }, (_, i) => `s${i}`)),
      );
      expect(fitsIn(tree, box), `seed ${seed}: the default arrangement does not fit`).toBe(true);
      for (let step = 0; step < 25; step++) {
        const path = pick(rnd, splitPaths(tree));
        const node = nodeAt(tree, path);
        if (!node || node.kind !== "split") continue;
        const divider = Math.floor(rnd() * (node.children.length - 1));
        tree = resize(tree, path, divider, (rnd() - 0.5) * 2, box);
        expect(fitsIn(tree, box), `seed ${seed}, step ${step}: ${render(tree)}`).toBe(true);
      }
    }
  });
});
