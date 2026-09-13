import Resizable from "@corvu/resizable";
import {
  type Component,
  createComputed,
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  untrack,
} from "solid-js";
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

/**
 * The tree a canvas of this size draws: the whole arrangement, or the focused
 * tile alone when the box cannot give every tile the 240px floor.
 *
 * The arrangement is not lost and not rewritten — a window dragged narrow and
 * back shows the same tiles it did before, because nothing is stored on the way
 * through. A workspace whose focused tile has gone (a kill, a rename) falls
 * back to the first tile in reading order, which is deterministic.
 *
 * A plain function of its three inputs rather than a component-body closure, so
 * the signal that holds the answer can be seeded and refilled from the one
 * copy of the rule. See {@link WorkspaceCanvas}'s `drawn`.
 */
function treeToDraw(tree: TreeNode, container: Size, focused: SessionKey | null): TreeNode {
  if (fitsIn(tree, container)) return tree;
  const keys = leafKeys(tree);
  const key = focused !== null && keys.includes(focused) ? focused : keys[0];
  return key === undefined ? tree : leaf(key);
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
   * THE TREE THE SKELETON IS DRAWN FROM, as a SIGNAL rather than as a memo.
   *
   * A memo is what this was, and the kind is the whole of the bug. corvu reads
   * its controlled `sizes` prop from inside its own DISPOSAL: `Resizable.Panel`
   * unregisters in an `onCleanup`, `unregisterPanel` calls `setSizes`, and
   * `createControllableSignal`'s setter reads `props.value()` before it reports.
   * That read reaches {@link SkeletonContext.sizesAt}, which is how the tree is
   * reached from inside Solid's `cleanNode`.
   *
   * READING A STALE MEMO THERE RECOMPUTES IT. `untrack` does not change that —
   * it suppresses the subscription, not the recomputation — so a memo read from
   * a teardown drags `updateComputation` into the middle of a disposal, and the
   * disposal walk then finds the `owned` array it is iterating set to null:
   * `TypeError: Cannot read properties of null (reading '0')`, thrown out of
   * Solid's own `cleanNode`. Reading a SIGNAL cannot do any of that. It returns
   * what is in it.
   *
   * Measured in Chrome on 2026-09-12 against two real tmux sessions, closing
   * the second-to-last tile of a workspace. The write runs inside a `batch`, so
   * the teardown happens in the flush that batch ends with and the TypeError
   * unwound out of `writeWorkspace` before it reached `putWorkspaces` —
   * `landWorkspace`'s `.catch` then swallowed it in silence. The tiles came off
   * screen, tmux-api was never told the workspace had ended, and a reload
   * brought the closed tile back. The same unwind left Solid's update queue
   * half-drained, so corvu's own root and handle stayed in the page and drew a
   * divider down the middle of the one session left on screen. One read of one
   * memo, both faults.
   *
   * Before the fix this was ALSO reading `props.tree` there, which is the
   * accessor a `<Show when={workspaceTree()}>` hands out and which Solid makes
   * throw once its condition is false ("Attempting to access a stale value from
   * <Show>"). That error is the one a reader sees first and it is a symptom of
   * the same read: the memo recomputed during the disposal, and the prop it
   * recomputes from had already been revoked. Bisected on the same day — with
   * the throw caught and the value left stale, the TypeError remains; with the
   * memo turned into a signal, both go.
   *
   * `createComputed` rather than `createEffect` to keep it filled, because it
   * runs in the same flush as the change rather than after it. A frame of lag
   * here is a divider that trails the drag, and the design's "skeleton drives
   * the slot layer" means corvu is handed the tree's fractions in the tick they
   * change. It is also what makes the teardown safe: a computation Solid has
   * already disposed is skipped rather than re-run, so the one flush that ends
   * a workspace never calls this at all, and the signal keeps the last
   * arrangement for corvu to read on its way out.
   */
  const [drawn, setDrawn] = createSignal<TreeNode>(
    untrack(() => treeToDraw(props.tree, props.container, props.focused)),
  );
  createComputed(() => setDrawn(treeToDraw(props.tree, props.container, props.focused)));

  // The whole interface to the slot layer. `untrack` around the call so a
  // caller that reads a signal in its handler does not subscribe this effect to
  // it and re-emit on changes that moved no tile.
  createEffect(() => {
    const rects = toRects(drawn(), props.container);
    untrack(() => props.onRects(rects));
  });

  const ctx: SkeletonContext = {
    sizesAt: (path) => {
      const node = nodeAt(drawn(), path);
      return node?.kind === "split" ? [...node.fractions] : [];
    },
    onSizes: (path, next) => {
      // UNTRACKED, because corvu calls this from inside an effect of its own
      // (`createEffect(() => onSizesChange(sizes()))`, its root) as well as
      // from the untracked setter. A tracked read there would subscribe that
      // effect to the tree and have it re-report on every arrangement change.
      const node = nodeAt(untrack(drawn), path);
      if (node?.kind !== "split") return;
      // A ROW THAT IS NOT ONE SIZE PER CHILD IS NOT A DRAG, and this is the
      // half of the swallow a teardown needs.
      //
      // corvu keeps its own array of panel sizes and splices an entry out of it
      // as each `Resizable.Panel` unregisters, reporting the shorter row each
      // time. The fraction comparison below cannot swallow that: `sameFractions`
      // answers false for rows of different lengths, by design, because two
      // lengths really are two different arrangements. Measured on 2026-09-12,
      // a two-tile workspace coming off screen: without this line the canvas
      // calls `onFractions([], [0])` TWICE on its way out — a one-entry row, of
      // zero, for a split with two children. `onFractions` promises "its
      // complete new row of sizes, one per child, summing to 1", and that row
      // is none of those things.
      //
      // The shell drops both today, because `tiles()` is already null by then
      // and its handler returns. That is the shell defending itself against
      // this file, and it is the only thing standing between a teardown and a
      // tile written to zero width. Refusing here costs nothing: corvu's own
      // resize path writes a complete row (`setSizes(newSizes.map(
      // fixToPrecision))`, one entry per panel), so every row a real drag
      // produces passes, and the partial rows reported while panels register or
      // unregister are echoes either way.
      if (next.length !== node.children.length) return;
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
  const shape = createMemo(() => shapeOf(drawn()));
  const skeleton = createMemo<JSX.Element>(() => {
    shape();
    return untrack(() => skeletonFor(drawn(), [], ctx));
  });

  return (
    <div class="tl-tiles" style={{ "pointer-events": "none" }}>
      {skeleton()}
    </div>
  );
};
