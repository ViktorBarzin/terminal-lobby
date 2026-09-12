import Resizable from "@corvu/resizable";
import { type Component, createEffect, createMemo, type JSX, untrack } from "solid-js";
import {
  fitsIn,
  leaf,
  leafKeys,
  MIN_TILE_PX,
  nodeAt,
  type NodePath,
  type Rect,
  type SessionKey,
  type Size,
  type TreeNode,
  toRects,
} from "../store/workspace-tree";
import "../tiles.css";

/**
 * The dividers of a Workspace, and nothing else on screen.
 *
 * THIS COMPONENT RENDERS NO SESSIONS. It draws a skeleton of empty, transparent
 * panels over the live terminals and hands the caller one rectangle per tile
 * through {@link WorkspaceCanvasProps.onRects}. The terminals stay where they
 * have always been: `store/keepalive.ts` keeps every visited session mounted,
 * `App.tsx` renders that list with a `<For>` that only ever appends, and the
 * slot layer positions each slot from the rect that arrives here. Moving the
 * node a session hangs off disposes `TerminalNative` — the xterm, the ttyd
 * socket and the tmux attach all go, a 779 ms rebuild for a warm open
 * (ADR-0026) — so nothing in this file may own, wrap or contain a session.
 * ADR-0027 makes that binding; the two-layer split is how a resize library gets
 * used at all under it.
 *
 * WHY A SKELETON. Every split-pane library on the web wants the panes as its
 * own children and reparents one whenever the structure changes: `@corvu/
 * resizable`, `solid-resizable-panels`, `allotment`, `react-resizable-panels`,
 * `dockview`. So corvu is given a tree with no terminals in it. It may reparent
 * its own nodes as freely as it likes, because there is nothing in them to
 * lose. What we take from it is the part that is genuinely fiddly: touch
 * dragging, the min and max clamps, keyboard resizing, and the intersecting
 * drag that moves both axes at a junction where two dividers meet.
 *
 * ```
 *   handle drag ──▶ corvu ──onSizesChange──▶ onFractions(path, fractions)
 *                                                      │
 *                                              caller stores it in the tree
 *                                                      │
 *                                            tree ──▶ sizes ──▶ onRects
 * ```
 *
 * THE TREE'S FRACTIONS ARE CORVU'S CONTROLLED `sizes`. Nothing is stored here
 * — not the sizes, not a measured box, not a copy of the tree. A drag leaves as
 * `onFractions`, the caller writes it to the tree, the new fractions arrive
 * back as a prop and the rects follow in the same tick. There is no
 * `ResizeObserver` round-trip and no frame of lag, which is the design's
 * "skeleton drives the slot layer" in one sentence. Corvu's prop documentation
 * calls those numbers percentages; they are fractions summing to 1, measured
 * against its 0.2.5 source, and `Split.fractions` is the same array.
 *
 * The caller's half is one line, and it must be a FUNCTIONAL update rather than
 * a write over a captured tree:
 *
 * ```tsx
 * onFractions={(path, fractions) =>
 *   setTree((t) => setFractions(t, path, fractions, container()))}
 * ```
 *
 * A drag at a junction moves two axes at once, so two roots report in the same
 * frame and the second write must see the first one's tree.
 *
 * WHAT THE CALLER OWES US. `container` is the box the rects are computed in, so
 * it has to be the box the canvas is positioned in — `tiles.css` pins the
 * canvas to `.tl-shell-body` minus the dock, the same geometry `.tl-offstage`
 * uses, and a `container` measured against anything else puts every divider a
 * few pixels off its tile. The rects are also the VISIBLE SET: a mounted slot
 * whose key is not among them is not on screen, which is how the too-small
 * fallback below reaches the slot layer without a second channel.
 */
export interface WorkspaceCanvasProps {
  /** The arrangement to draw. A workspace of one is a bare leaf and has no dividers. */
  tree: TreeNode;
  /** The box the tree is laid out in, in CSS pixels. */
  container: Size;
  /**
   * The tile taking the keystrokes. Used for one thing here: it is the tile
   * shown alone when the container is too small for the whole tree.
   */
  focused: SessionKey | null;
  /**
   * One rect per visible tile, in the tree's reading order, whenever the
   * arrangement or the container changes. The slot layer looks each one up by
   * key and positions the slot it already has.
   */
  onRects: (rects: Rect[]) => void;
  /**
   * A divider moved: `path` names the split (`[]` is the root) and `fractions`
   * is its complete new row of sizes, one per child, summing to 1. Fires only
   * for a real change — see {@link sameFractions}.
   */
  onFractions: (path: NodePath, fractions: number[]) => void;
}

/** corvu's minimum panel size, in the `${number}px` form its `Size` type takes. */
const MIN_PANEL_SIZE = `${MIN_TILE_PX}px` as const;

/**
 * Close enough to be the same row of sizes.
 *
 * corvu rounds every size it computes to 6 decimal places (`fixToPrecision`),
 * so an array that made the round trip through it comes back a few times 1e-7
 * away from the one we sent. At 1600px wide that is 0.0016 px of difference, and
 * treating it as a change would rewrite the tree on every render forever.
 */
function sameFractions(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((f, i) => Math.abs(f - (b[i] ?? 0)) <= 1e-6);
}

/**
 * The tree's STRUCTURE, with the sizes and the session keys left out.
 *
 * This is what the skeleton is rebuilt on, and leaving those two out is the
 * point of it. A divider drag changes fractions forty times a second and must
 * not rebuild anything: corvu's handle manager holds the dragged element and
 * its window listeners, so removing that element mid-drag would end the drag on
 * its first frame. The keys are out because the skeleton holds no session
 * content, so swapping which session sits in which tile changes nothing it
 * draws.
 */
function shapeOf(node: TreeNode): string {
  if (node.kind === "leaf") return ".";
  return `${node.dir === "row" ? "r" : "c"}(${node.children.map(shapeOf).join(",")})`;
}

/** What the recursive skeleton needs from the component that owns the tree. */
interface SkeletonContext {
  /** The live fractions of the split at this path, as corvu's controlled `sizes`. */
  sizesAt: (path: NodePath) => number[];
  /** corvu reporting a row of sizes for the split at this path. */
  onSizes: (path: NodePath, sizes: number[]) => void;
}

/**
 * One corvu root per split, recursively, holding nothing.
 *
 * A plain function rather than a component on purpose: it is called once from a
 * memo that re-runs only when {@link shapeOf} changes, and it reads the tree
 * ONLY for structure. Sizes come back through `ctx.sizesAt`, which reads the
 * live tree, so a fraction change updates `sizes` without touching a single DOM
 * node. Written as a component with a `node` prop, the `.map()` over its
 * children would track that prop and rebuild the whole skeleton on every frame
 * of a drag.
 */
function skeletonFor(node: TreeNode, path: NodePath, ctx: SkeletonContext): JSX.Element {
  if (node.kind === "leaf") return null;
  const sizes = createMemo(() => ctx.sizesAt(path), [] as number[], { equals: sameFractions });
  const last = node.children.length - 1;
  const label = node.dir === "row" ? "Resize tiles left and right" : "Resize tiles up and down";
  return (
    <Resizable
      class="tl-tiles-split"
      // `row` puts children side by side, which corvu calls horizontal; it sets
      // the matching `flex-direction` on this element itself.
      orientation={node.dir === "row" ? "horizontal" : "vertical"}
      sizes={sizes()}
      onSizesChange={(next) => ctx.onSizes(path, next)}
      // Inline, not in tiles.css: a skeleton that took pointer events would be
      // an invisible sheet over every live terminal, so it must not depend on a
      // stylesheet having loaded.
      style={{ "pointer-events": "none" }}
    >
      {node.children.map((child, i) => [
        <Resizable.Panel
          class="tl-tiles-panel"
          // The floor is the library's to enforce, not ours: corvu resolves
          // this against its own measured root and clamps the drag there, which
          // is where a clamp has to live to feel right under a finger.
          minSize={MIN_PANEL_SIZE}
          style={{ "pointer-events": "none" }}
        >
          {skeletonFor(child, [...path, i], ctx)}
        </Resizable.Panel>,
        i < last ? (
          <Resizable.Handle
            class="tl-tiles-handle"
            type="button"
            aria-label={label}
            style={{ "pointer-events": "auto" }}
          />
        ) : null,
      ])}
    </Resizable>
  );
}

export const WorkspaceCanvas: Component<WorkspaceCanvasProps> = (props) => {
  /**
   * The tree actually drawn: the whole arrangement, or the focused tile alone
   * when the window is too small to give every tile the 240px floor.
   *
   * The arrangement is not lost and not rewritten — a window dragged narrow and
   * back shows the same tiles it did before, because nothing was stored on the
   * way through. A workspace whose focused tile has gone (a kill, a rename)
   * falls back to the first tile in reading order, which is deterministic.
   */
  const shown = createMemo<TreeNode>(() => {
    const tree = props.tree;
    if (fitsIn(tree, props.container)) return tree;
    const keys = leafKeys(tree);
    const focused = props.focused;
    const key = focused !== null && keys.includes(focused) ? focused : keys[0];
    return key === undefined ? tree : leaf(key);
  });

  // The whole interface to the slot layer. `untrack` around the call so a
  // caller that reads a signal in its handler does not subscribe this effect to
  // it and re-emit on changes that moved no tile.
  createEffect(() => {
    const rects = toRects(shown(), props.container);
    untrack(() => props.onRects(rects));
  });

  const ctx: SkeletonContext = {
    sizesAt: (path) => {
      const node = nodeAt(shown(), path);
      return node?.kind === "split" ? [...node.fractions] : [];
    },
    onSizes: (path, next) => {
      const node = nodeAt(untrack(shown), path);
      if (node?.kind !== "split") return;
      // THE ECHO, SWALLOWED. A controlled corvu root reports the sizes it was
      // just handed: once per panel as each registers, and again from its own
      // effect on every render. Passed on, each echo writes a new tree object,
      // which re-renders this canvas, which echoes again — a loop that never
      // settles because every write produces a new object. Only a row that
      // differs from the tree's own is a drag.
      if (sameFractions(node.fractions, next)) return;
      props.onFractions(path, [...next]);
    },
  };

  /**
   * The skeleton, rebuilt when a tile is added, removed or re-nested and at no
   * other time.
   *
   * Two memos rather than one. `shape` recomputes on every tree change and
   * PROPAGATES only when the string differs, which is what makes the second one
   * deaf to a resize; the `untrack` inside it is the other half, because
   * reading the tree for its structure must not subscribe to its fractions.
   * Solid disposes a memo's previous computations when it re-runs, so the old
   * skeleton's corvu roots unregister their handles on the way out.
   */
  const shape = createMemo(() => shapeOf(shown()));
  const skeleton = createMemo<JSX.Element>(() => {
    shape();
    return untrack(() => skeletonFor(shown(), [], ctx));
  });

  return (
    <div class="tl-tiles" style={{ "pointer-events": "none" }}>
      {skeleton()}
    </div>
  );
};
