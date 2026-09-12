/**
 * Where the Tiles of a Workspace sit, as arithmetic.
 *
 * A Workspace is several sessions on screen at once, arranged as a tmux-shaped
 * tree of rows and columns (CONTEXT.md "Workspace"). This module is the whole
 * of that arrangement and nothing else: data in, data out. It does not import
 * Solid, it never touches the DOM, and it has not heard of `@corvu/resizable`.
 *
 * THAT ISOLATION IS THE POINT, and ADR-0027 asks for it in as many words:
 * "Worth writing the tree-to-rects function so it does not know corvu exists,
 * which keeps that exit cheap." Corvu is at 0.2.5, last published 2025-05-04,
 * and is used off-label here — a skeleton of empty panels stacked above the
 * terminals, because every split-pane library on the web wants to own the panes
 * themselves. If it stops being maintained, its replacement re-implements a
 * divider drag and calls `resize()`. Every line below survives untouched.
 *
 * WHY THIS IS ARITHMETIC AND NOT A LAYOUT COMPONENT. A live terminal is never
 * moved in the DOM. `store/keepalive.ts` keeps every visited session mounted,
 * `App.tsx` renders that list append-only and never reorders it, and moving the
 * node a session hangs off disposes `TerminalNative` — which drops the xterm,
 * the ttyd socket and the tmux attach, a 779 ms rebuild for a warm open
 * (ADR-0026), or the 1,797 ms cover keepalive was built to remove. So the tree
 * POSITIONS slots that never move: `toRects` turns it into one rectangle per
 * session and the slot layer reads those rectangles off it. Splitting, moving,
 * closing and resizing change rectangles. None of them changes DOM order.
 *
 * THE TREE IS N-ARY ON PURPOSE. Three tiles across are ONE row of three rather
 * than nested pairs, so a divider moves exactly its two neighbours and nothing
 * else on screen twitches. `normalize` is what keeps it that way after every
 * mutation: a split with one child collapses into that child, and a split whose
 * direction matches its parent's merges into the parent, carrying its fractions
 * scaled by the slot it occupied. Closing tiles therefore never leaves a spine
 * of useless nesting behind.
 *
 * WHAT THIS MODULE DOES NOT DECIDE. Which sessions belong to a workspace lives
 * server-side in tmux-api; only the shape lives here, and only per device
 * (ADR-0027 §2). Nor does it enforce the minimum tile: `splitAt` will happily
 * build a tree too small for the window, because a window dragged narrow does
 * exactly that and the tree has to survive it. `canSplit` is the guard a drop
 * target asks before it calls, and `fitsIn` is the question the render layer
 * asks before falling back to the focused tile alone.
 */

/**
 * A session's identity, exactly as `store/keepalive.ts` mints it — `keyOf`
 * returns `owner\0name`, because two people can own a session of the same name
 * and they are different terminals.
 *
 * The tree stores it whole and compares it whole; `sessionOf` is the one place
 * that takes it apart, for the consumers that need the two halves separately —
 * a tile header looking a title up by name, and the tmux-api document, which
 * holds members as name and owner rather than as a joined key.
 *
 * keepalive is not imported for it. The shape is two fields and a separator,
 * and reaching for the module that owns a 24-hour mount list to get at it would
 * put that list behind a pure function. `sessionOf` is tested against the real
 * `keyOf` instead, which is what actually keeps the two from drifting.
 */
export type SessionKey = string;

/** A session key taken apart: what `keepalive.keyOf` composes one from. */
export interface SessionParts {
  name: string;
  /** Absent, never empty, for a session of the viewer's own. */
  owner?: string;
}

/**
 * How a split lays its children out. `row` puts them side by side, divided by
 * vertical dividers; `column` stacks them, divided by horizontal ones. Same
 * sense as CSS `flex-direction`, so the word describes the children rather than
 * the divider between them.
 */
export type Direction = "row" | "column";

/** Which side of a tile a dropped session lands on. */
export type Edge = "left" | "right" | "top" | "bottom";

/** One tile: one rectangle showing one session. */
export interface Leaf {
  readonly kind: "leaf";
  readonly key: SessionKey;
}

/**
 * A row or a column of two or more children.
 *
 * `fractions` has one entry per child and sums to 1. They are the tree's own
 * stored sizes AND the array corvu's controlled `sizes` prop is fed, so there
 * is no second source of truth and no measurement round-trip: a drag updates
 * them, `toRects` recomputes, the slots move. Nothing waits a frame on a
 * ResizeObserver.
 */
export interface Split {
  readonly kind: "split";
  readonly dir: Direction;
  readonly children: readonly TreeNode[];
  readonly fractions: readonly number[];
}

export type TreeNode = Leaf | Split;

/**
 * A node's address: the child index to take at each level, root first. `[]` is
 * the root itself. Paths are what `resize` and `setFractions` name a split by,
 * because a split has no key of its own to be named by.
 */
export type NodePath = readonly number[];

/** The box a tree is laid out inside, in CSS pixels. */
export interface Size {
  width: number;
  height: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One tile's box, in pixels from the container's top-left corner. */
export interface Rect extends Box {
  key: SessionKey;
}

/**
 * The smallest tile a split may produce, in CSS pixels — roughly 30 columns at
 * the default font.
 *
 * This is a proposal from the design, not a measurement, and the design says so
 * under its open questions: it should be set from what a Claude Code TUI
 * actually needs to stay usable, checked against the real thing. Enforced in
 * two places, neither of them inside a mutation: `canSplit` refuses the split
 * and the drop preview shows as invalid, and `resize` clamps the divider rather
 * than letting it past.
 */
export const MIN_TILE_PX = 240;

/** Float slack for fraction sums and pixel comparisons. Doubles as the floor a
 *  fraction may not go below: a tile of exactly zero extent shows nothing, can
 *  never be dragged back, and does not survive a write to storage and a read. */
const EPSILON = 1e-9;

/**
 * The separator `keepalive.keyOf` joins owner and name with, built rather than
 * typed. A raw NUL byte in a source file makes git treat the file as binary and
 * most editors mangle it on save, so the one place this codebase needs the
 * character spells it out instead.
 */
const KEY_SEPARATOR = String.fromCharCode(0);

/**
 * A session key taken back apart — the inverse of `keepalive.keyOf`, which
 * composes `${owner ?? ""}<NUL>${name}` and has never had one.
 *
 * Split at the FIRST separator: an OS user name cannot contain one, so
 * everything before it is the owner and everything after it is the name,
 * whatever the name contains. An empty owner means the session is the viewer's
 * own, and the field is left off rather than handed back as `""` — a tile
 * header testing `parts.owner` for the foreign-session marker should get
 * undefined there rather than a string that is only falsy by luck.
 *
 * A key with no separator at all reads as a bare name with no owner. Nothing in
 * the app mints one, and a hand-edited document or an older shape can, so the
 * forgiving reading costs nothing and keeps one malformed key from being an
 * exception in the middle of a render.
 */
export function sessionOf(key: SessionKey): SessionParts {
  const at = key.indexOf(KEY_SEPARATOR);
  if (at < 0) return { name: key };
  const owner = key.slice(0, at);
  const name = key.slice(at + 1);
  return owner ? { name, owner } : { name };
}

// ---------------------------------------------------------------------------
// Fractions
// ---------------------------------------------------------------------------

function evenFractions(n: number): number[] {
  return n > 0 ? new Array<number>(n).fill(1 / n) : [];
}

/**
 * Scale a list of sizes to sum to exactly 1, treating anything negative or not
 * finite as 0. A list that sums to nothing at all falls back to an even share,
 * which is the only answer that keeps every child on screen.
 */
function renormalize(fracs: readonly number[]): number[] {
  const clean = fracs.map((f) => (Number.isFinite(f) && f > 0 ? f : 0));
  const total = clean.reduce((a, b) => a + b, 0);
  if (total <= 0) return evenFractions(clean.length);
  return clean.map((f) => f / total);
}

/**
 * The fractions to use for a split with `n` children. An array of the wrong
 * length is repaired to an even share rather than trusted: it can only arrive
 * from a hand-built node or a `tl:workspaces:v1` document written to an older
 * shape, and guessing which child each number belonged to would be worse than
 * spreading them evenly.
 */
function fractionsFor(fracs: readonly number[] | undefined, n: number): number[] {
  if (!fracs || fracs.length !== n) return evenFractions(n);
  return renormalize(fracs);
}

/**
 * Raise every entry below `min` up to it, taking the deficit from the entries
 * with slack, in proportion to how much slack each has.
 *
 * It terminates in at most `n` passes: an entry pinned to `min` is neither
 * above it (so it is never reduced again) nor below it (so it is never raised
 * again), and each pass pins at least one. It cannot overdraw either — with
 * `min * n < 1` the total slack is `1 - n * min`, which is strictly larger than
 * any deficit the same list can produce.
 *
 * A split too small to give every child the floor has no valid answer at all,
 * so it gets an even share and the window-too-small fallback handles the rest.
 */
function clampFractions(fracs: readonly number[], rawMin: number): number[] {
  const n = fracs.length;
  if (n === 0) return [];
  const min = Math.max(rawMin, EPSILON);
  if (min * n >= 1 - EPSILON) return evenFractions(n);
  const out = [...fracs];
  for (let pass = 0; pass < n; pass++) {
    const under: number[] = [];
    let deficit = 0;
    let slack = 0;
    out.forEach((f, i) => {
      if (f < min - EPSILON) {
        under.push(i);
        deficit += min - f;
      } else if (f > min) {
        slack += f - min;
      }
    });
    if (under.length === 0) break;
    if (slack <= 0) return evenFractions(n);
    out.forEach((f, i) => {
      if (f > min) out[i] = f - (deficit * (f - min)) / slack;
    });
    for (const i of under) out[i] = min;
  }
  return renormalize(out);
}

// ---------------------------------------------------------------------------
// Building and reading a tree
// ---------------------------------------------------------------------------

/** One tile. */
export function leaf(key: SessionKey): Leaf {
  return { kind: "leaf", key };
}

/**
 * A row or column of children, evenly sized unless told otherwise. A raw
 * constructor: it does not normalize, so a caller can build the nesting
 * `normalize` is supposed to flatten and watch it happen.
 */
export function split(
  dir: Direction,
  children: readonly TreeNode[],
  fractions?: readonly number[],
): Split {
  return {
    kind: "split",
    dir,
    children: [...children],
    fractions: fractionsFor(fractions, children.length),
  };
}

/** Every tile in the tree, in reading order: left to right, top to bottom. */
export function leafKeys(node: TreeNode): SessionKey[] {
  if (node.kind === "leaf") return [node.key];
  const out: SessionKey[] = [];
  for (const child of node.children) out.push(...leafKeys(child));
  return out;
}

/**
 * Is this session already on screen? The question a drag from the sidebar asks
 * to tell a split (a session arriving) from a move (one already here), which is
 * the difference between adding a tile and relocating one.
 */
export function hasLeaf(node: TreeNode, key: SessionKey): boolean {
  if (node.kind === "leaf") return node.key === key;
  return node.children.some((child) => hasLeaf(child, key));
}

/** Where a session's tile sits, or null when it has none. */
export function pathToLeaf(node: TreeNode, key: SessionKey): NodePath | null {
  if (node.kind === "leaf") return node.key === key ? [] : null;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (!child) continue;
    const below = pathToLeaf(child, key);
    if (below) return [i, ...below];
  }
  return null;
}

/** The node at a path, or null when the path runs off the tree. */
export function nodeAt(node: TreeNode, path: NodePath): TreeNode | null {
  let cur: TreeNode = node;
  for (const i of path) {
    if (cur.kind !== "split") return null;
    const next = cur.children[i];
    if (!next) return null;
    cur = next;
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * The shape every mutation leaves behind. Two rules, applied bottom-up:
 *
 *   - a split with one child IS that child, so closing a tile does not leave a
 *     wrapper around the survivor;
 *   - a split whose direction matches its parent's merges into the parent, its
 *     fractions scaled by the slot it occupied, so splitting a tile divides
 *     that tile's space and leaves its siblings' sizes alone.
 *
 * Together they keep the n-ary promise: a row of three is one node with three
 * children, which is what makes a divider move exactly its two neighbours.
 *
 * Returns null only for a node holding no tiles at all — an empty split, which
 * a well-formed tree never contains and an untrusted document might. Callers
 * read that null as "there is no workspace here", the same answer removing the
 * last tile gives.
 */
export function normalize(node: TreeNode): TreeNode | null {
  if (node.kind === "leaf") return node;
  const kids: TreeNode[] = [];
  const fracs: number[] = [];
  const own = fractionsFor(node.fractions, node.children.length);
  node.children.forEach((child, i) => {
    const kept = normalize(child);
    if (!kept) return;
    const share = own[i] ?? 0;
    if (kept.kind === "split" && kept.dir === node.dir) {
      const inner = fractionsFor(kept.fractions, kept.children.length);
      kept.children.forEach((grand, j) => {
        kids.push(grand);
        fracs.push(share * (inner[j] ?? 0));
      });
      return;
    }
    kids.push(kept);
    fracs.push(share);
  });
  const [first] = kids;
  if (!first) return null;
  if (kids.length === 1) return first;
  return { kind: "split", dir: node.dir, children: kids, fractions: renormalize(fracs) };
}

/**
 * One node of an untrusted document, or null. Structure only; the duplicate
 * check and the normalisation belong to the whole tree and run in the caller.
 */
function parseNode(value: unknown): TreeNode | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind === "leaf") {
    const key = raw.key;
    return typeof key === "string" && key.length > 0 ? leaf(key) : null;
  }
  if (raw.kind !== "split") return null;

  const dir = raw.dir;
  if (dir !== "row" && dir !== "column") return null;

  const rawChildren = raw.children;
  const rawFractions = raw.fractions;
  if (!Array.isArray(rawChildren) || !Array.isArray(rawFractions)) return null;
  const childValues: unknown[] = rawChildren;
  const fractionValues: unknown[] = rawFractions;
  // Two children is the floor, not one: a split of one is a tile wearing a
  // wrapper, and `normalize` would silently unwrap it. Refusing says the
  // document was not written by this module, which is worth knowing.
  if (childValues.length < 2 || fractionValues.length !== childValues.length) return null;

  const fractions: number[] = [];
  for (const f of fractionValues) {
    if (typeof f !== "number" || !Number.isFinite(f) || f <= 0) return null;
    fractions.push(f);
  }
  const total = fractions.reduce((a, b) => a + b, 0);
  if (Math.abs(total - 1) > EPSILON) return null;

  const children: TreeNode[] = [];
  for (const child of childValues) {
    const parsed = parseNode(child);
    if (!parsed) return null;
    children.push(parsed);
  }
  return split(dir, children, fractions);
}

/**
 * A value read back off disk as a tree, or null for anything that is not one.
 *
 * This is the gate `store/workspaces.ts` injects as `parseTree`, and the reason
 * it cannot be `normalize`: that function's argument is already a `TreeNode`, so
 * it can canonicalise a tree the type system has already vouched for and can say
 * nothing at all about a value that came out of `localStorage`. Until this
 * existed the store's own test carried a second copy of the node shape, which is
 * the drift the injection was built to prevent.
 *
 * It never throws. A refusal costs one device's arrangement — the store drops
 * the entry and the workspace auto-arranges from its server-side member order,
 * which is exactly what a device that had never seen it would do. That is a
 * better failure than putting a malformed tree on screen, so the checks are
 * strict: a fraction must be finite and positive, the fractions must sum to 1
 * within the module's own float slack, a split must have at least two children
 * and one fraction each, and every child must parse.
 *
 * ONE CHECK IS HERE AND NOT IN THE LIST THE STORE ASKED FOR: a session may
 * appear at most once. keepalive mounts one live view per session, so a stored
 * document naming the same session twice describes a workspace where one tile
 * has no terminal in it, and the second tile's Grid claim would fight the
 * first's. A validator that passed that through would be putting the one
 * invariant this feature rests on back on screen.
 *
 * What comes back is normalized, so a document written by an older shape, or by
 * hand, is canonical before anything renders it.
 */
export function parseTreeNode(value: unknown): TreeNode | null {
  const parsed = parseNode(value);
  if (!parsed) return null;
  const keys = leafKeys(parsed);
  if (new Set(keys).size !== keys.length) return null;
  return normalize(parsed);
}

/**
 * Drop the node at `path` and hand its space to its siblings, in proportion to
 * what they already had — the share-out `renormalize` performs for free, and
 * the one a person expects when a tile closes and the others grow into it.
 *
 * Left denormalised on purpose: the caller runs `normalize` afterwards, which
 * is where a lone survivor gets unwrapped.
 */
function withoutPath(node: TreeNode, path: NodePath): TreeNode | null {
  if (path.length === 0) return null;
  if (node.kind !== "split") return node;
  const at = path[0] ?? -1;
  const target = node.children[at];
  if (!target) return node;
  const inner = withoutPath(target, path.slice(1));
  const kids: TreeNode[] = [];
  const fracs: number[] = [];
  const own = fractionsFor(node.fractions, node.children.length);
  node.children.forEach((child, i) => {
    const kept = i === at ? inner : child;
    if (!kept) return;
    kids.push(kept);
    fracs.push(own[i] ?? 0);
  });
  if (kids.length === 0) return null;
  return { kind: "split", dir: node.dir, children: kids, fractions: renormalize(fracs) };
}

/** Swap in a subtree at a path, leaving fractions and siblings alone. */
function replaceNodeAt(node: TreeNode, path: NodePath, next: TreeNode): TreeNode {
  if (path.length === 0) return next;
  if (node.kind !== "split") return node;
  const at = path[0] ?? -1;
  const target = node.children[at];
  if (!target) return node;
  const rest = path.slice(1);
  return {
    kind: "split",
    dir: node.dir,
    children: node.children.map((child, i) =>
      i === at ? replaceNodeAt(target, rest, next) : child,
    ),
    fractions: [...node.fractions],
  };
}

/**
 * Put `newKey` beside `targetKey` on the given edge, halving the target's slot.
 *
 * The pair is always built as its own split and then normalized, which is what
 * makes the same-direction case come out right: splitting the right-hand tile
 * of a row again produces a row of three where the two new tiles share the
 * space the old tile had, rather than a row of two with a row inside it.
 */
function splitLeaf(
  tree: TreeNode,
  targetKey: SessionKey,
  edge: Edge,
  newKey: SessionKey,
): TreeNode {
  const path = pathToLeaf(tree, targetKey);
  if (!path) return tree;
  const dir: Direction = edge === "left" || edge === "right" ? "row" : "column";
  const newFirst = edge === "left" || edge === "top";
  const pair = split(
    dir,
    newFirst ? [leaf(newKey), leaf(targetKey)] : [leaf(targetKey), leaf(newKey)],
  );
  return normalize(replaceNodeAt(tree, path, pair)) ?? tree;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Drop a session onto one of a tile's four edges: that tile splits, and the new
 * tile takes half of it.
 *
 * A session already in the workspace is MOVED rather than copied, which is why
 * this hands off to `moveWithin` instead of refusing. keepalive mounts exactly
 * one live view per session, so a second tile of one session has no terminal to
 * show, and two tiles of one session would contend for its Grid continuously —
 * the contention the grid pinning exists to prevent. Nothing above this
 * function can produce a duplicate by getting the call wrong.
 *
 * An unknown target, or a session dropped on its own tile's edge, comes back
 * unchanged by reference, so a memo over the tree does not re-run.
 *
 * Does not enforce MIN_TILE_PX — `canSplit` is that question, asked by the drop
 * target before the drop is allowed to land.
 */
export function splitAt(
  tree: TreeNode,
  targetLeafKey: SessionKey,
  edge: Edge,
  newSessionKey: SessionKey,
): TreeNode {
  if (newSessionKey === targetLeafKey) return tree;
  if (hasLeaf(tree, newSessionKey)) return moveWithin(tree, newSessionKey, targetLeafKey, edge);
  return splitLeaf(tree, targetLeafKey, edge, newSessionKey);
}

/**
 * Drop a session onto a tile's middle: that tile now shows the dropped session,
 * at exactly the size and in exactly the place the old one had.
 *
 * If the dropped session already had a tile of its own, that tile closes and
 * its siblings take its space — the same invariant `splitAt` protects, since
 * one session may occupy at most one tile. The session that was displaced
 * leaves the workspace and keeps running in the sidebar, which is what removing
 * a tile always means.
 */
export function replaceAt(
  tree: TreeNode,
  targetLeafKey: SessionKey,
  newSessionKey: SessionKey,
): TreeNode {
  if (targetLeafKey === newSessionKey) return tree;
  const target = pathToLeaf(tree, targetLeafKey);
  if (!target) return tree;
  const elsewhere = pathToLeaf(tree, newSessionKey);
  const swapped = replaceNodeAt(tree, target, leaf(newSessionKey));
  if (!elsewhere) return swapped;
  // Addressed by PATH, not by key: after the swap two leaves carry the same
  // key and a key lookup would be a coin toss between them. The old path is
  // still valid because a replace changes a leaf's key and never the structure.
  const pruned = withoutPath(swapped, elsewhere);
  if (!pruned) return swapped;
  return normalize(pruned) ?? swapped;
}

/**
 * Close a tile. Its siblings share out the space in proportion to what they
 * already had, and any nesting the close made pointless disappears with it.
 *
 * Returns null when the tile that closed was the last one: there is no
 * workspace left and the caller is looking at a single session again, which is
 * the design's "removing down to one tile ends the workspace" one step further
 * along. A key with no tile gives the tree back by reference.
 *
 * The session itself keeps running and keeps its place in the sidebar. Whether
 * it also keeps its workspace MEMBERSHIP is a server-side question this module
 * cannot see: a kill keeps membership, a deliberate close does not (ADR-0027).
 */
export function removeAt(tree: TreeNode, leafKey: SessionKey): TreeNode | null {
  const path = pathToLeaf(tree, leafKey);
  if (!path) return tree;
  const pruned = withoutPath(tree, path);
  return pruned ? normalize(pruned) : null;
}

/**
 * Drag a tile that is already on screen onto another tile's edge: it leaves
 * where it was, its old siblings grow into the gap, and it lands beside the
 * target.
 *
 * Removing first and splitting second is what keeps the session in exactly one
 * tile at every step, including the case where the two tiles were each other's
 * only sibling — the parent collapses, the target becomes the root, and the
 * split rebuilds it on the new axis.
 *
 * A tile dropped on its own edge, or either key having no tile, leaves the tree
 * alone. A session arriving from the sidebar is `splitAt`, not this.
 */
export function moveWithin(
  tree: TreeNode,
  leafKey: SessionKey,
  targetLeafKey: SessionKey,
  edge: Edge,
): TreeNode {
  if (leafKey === targetLeafKey) return tree;
  if (!hasLeaf(tree, leafKey) || !hasLeaf(tree, targetLeafKey)) return tree;
  const without = removeAt(tree, leafKey);
  // Unreachable: the target is a second tile, so the tree cannot have emptied.
  if (!without) return tree;
  return splitLeaf(without, targetLeafKey, edge, leafKey);
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Where each child of a split starts and ends along its own axis, as `n + 1`
 * cumulative edges.
 *
 * Edges rather than per-child extents, because child `i` then runs from
 * `edges[i]` to `edges[i + 1]` and adjacent tiles share ONE number, so a
 * boundary is the same float from both sides by construction rather than by
 * luck. The last edge is pinned to the extent because the cumulative sum does
 * not always land on it: ratios of 6:4:2 across 1600px end at
 * 1599.9999999999998, which is 2.3e-13 px of nothing to look at but does make
 * `x + width === container.width` false, and that equality is worth having
 * exactly rather than approximately.
 */
function edgesFor(node: Split, extent: number): number[] {
  const fracs = fractionsFor(node.fractions, node.children.length);
  const edges: number[] = [0];
  let acc = 0;
  for (const f of fracs) {
    acc += f;
    edges.push(acc * extent);
  }
  edges[edges.length - 1] = extent;
  return edges;
}

function collectRects(node: TreeNode, box: Box, out: Rect[]): void {
  if (node.kind === "leaf") {
    out.push({ key: node.key, x: box.x, y: box.y, width: box.width, height: box.height });
    return;
  }
  const horizontal = node.dir === "row";
  const extent = horizontal ? box.width : box.height;
  const edges = edgesFor(node, extent);
  node.children.forEach((child, i) => {
    const from = edges[i] ?? 0;
    const to = edges[i + 1] ?? extent;
    collectRects(
      child,
      horizontal
        ? { x: box.x + from, y: box.y, width: to - from, height: box.height }
        : { x: box.x, y: box.y + from, width: box.width, height: to - from },
      out,
    );
  });
}

/**
 * One rectangle per tile, in pixels from the container's top-left corner, in
 * the tree's reading order.
 *
 * This is the whole interface between the tree and the screen. The slot layer
 * looks each rect up by key and positions the slot it already has; nothing is
 * created, destroyed, reordered or reparented by a change here, which is the
 * constraint ADR-0027 makes binding.
 *
 * The rects tile the container exactly: no gaps, no overlaps, and no room
 * reserved for dividers. A divider is drawn ON the boundary by the skeleton
 * above, so reserving space for one here would put a seam between every pair of
 * terminals and lose those pixels to nothing.
 */
export function toRects(tree: TreeNode, container: Size): Rect[] {
  const out: Rect[] = [];
  collectRects(
    tree,
    { x: 0, y: 0, width: Math.max(0, container.width), height: Math.max(0, container.height) },
    out,
  );
  return out;
}

/** The box a node occupies, walked down its path without laying out the rest. */
function boxOfPath(tree: TreeNode, path: NodePath, container: Size): Box | null {
  let node: TreeNode = tree;
  let box: Box = {
    x: 0,
    y: 0,
    width: Math.max(0, container.width),
    height: Math.max(0, container.height),
  };
  for (const i of path) {
    if (node.kind !== "split") return null;
    const child = node.children[i];
    if (!child) return null;
    const horizontal = node.dir === "row";
    const edges = edgesFor(node, horizontal ? box.width : box.height);
    const from = edges[i] ?? 0;
    const to = edges[i + 1] ?? from;
    box = horizontal
      ? { x: box.x + from, y: box.y, width: to - from, height: box.height }
      : { x: box.x, y: box.y + from, width: box.width, height: to - from };
    node = child;
  }
  return box;
}

/**
 * Would this split leave every resulting tile at or above MIN_TILE_PX? The
 * question a drop target asks before it lets a drop land, and what turns the
 * drop preview invalid when the answer is no.
 *
 * Only the axis the divider crosses is checked. A tile already shorter than the
 * floor because the window is short is not made shorter by a vertical divider,
 * and refusing there would make a small window refuse every drop rather than
 * the ones that would actually crush a terminal. The window-too-small case has
 * its own answer: show the focused tile alone, and restore the tree when the
 * window grows back.
 */
export function canSplit(
  tree: TreeNode,
  targetLeafKey: SessionKey,
  edge: Edge,
  container: Size,
): boolean {
  const path = pathToLeaf(tree, targetLeafKey);
  if (!path) return false;
  const box = boxOfPath(tree, path, container);
  if (!box) return false;
  const extent = edge === "left" || edge === "right" ? box.width : box.height;
  return extent / 2 >= MIN_TILE_PX - EPSILON;
}

/**
 * Is there room for this arrangement at this size? False is the signal to show
 * the focused tile alone until the window grows back, so a window dragged
 * narrow never costs anyone their arrangement.
 *
 * A single tile always fits. There is nothing to fall back TO, and a workspace
 * of one is just a session on screen.
 */
export function fitsIn(tree: TreeNode, container: Size): boolean {
  if (tree.kind === "leaf") return true;
  return toRects(tree, container).every(
    (r) => r.width >= MIN_TILE_PX - EPSILON && r.height >= MIN_TILE_PX - EPSILON,
  );
}

/**
 * The floor one child of this split may not go below, as a fraction of the
 * split's own extent.
 *
 * MIN_TILE_PX applies to TILES and this clamps CHILDREN — the same thing here,
 * and only because the tree is normalized. A child of a row is either a leaf or
 * a column, and every tile inside a column spans that column's full width, so
 * the child's width IS the width of every tile under it. A row inside a row
 * cannot exist; `normalize` merged it.
 *
 * No container means no pixels to measure against, and the floor falls back to
 * EPSILON rather than to zero. A tile of exactly zero extent is degenerate
 * whatever the screen is: it shows nothing, no divider drag can grow it back
 * because it has no edge to grab, and `parseTreeNode` refuses a stored fraction
 * that is not positive, so writing one would cost the arrangement on the next
 * page load.
 */
function minFractionFor(
  tree: TreeNode,
  path: NodePath,
  node: Split,
  container: Size | undefined,
): number {
  if (!container) return EPSILON;
  const box = boxOfPath(tree, path, container);
  if (!box) return EPSILON;
  const extent = node.dir === "row" ? box.width : box.height;
  if (extent <= 0) return EPSILON;
  return Math.max(MIN_TILE_PX / extent, EPSILON);
}

/**
 * Drag one divider. `dividerIndex` names the boundary between children `i` and
 * `i + 1`, and `delta` is how far it moves as a fraction of the split's own
 * extent, positive towards the far end.
 *
 * EXACTLY TWO CHILDREN MOVE, which is the whole reason the tree is n-ary: a row
 * of three is one node, so dragging the first divider grows the left tile into
 * the middle one and leaves the right one where it was. Nested pairs would have
 * shifted a tile nobody was dragging.
 *
 * Clamped, never refused. A divider dragged past the minimum stops at it,
 * because a handle that silently does nothing reads as broken. If the split is
 * already too small to give both neighbours the floor there is no valid place
 * to stop, so the divider holds still and the window-too-small fallback answers
 * that case instead.
 *
 * `container` is optional so the arithmetic can be exercised without one. Pass
 * the real measured box in the app, or the floor is not enforced.
 */
export function resize(
  tree: TreeNode,
  splitNodePath: NodePath,
  dividerIndex: number,
  delta: number,
  container?: Size,
): TreeNode {
  const node = nodeAt(tree, splitNodePath);
  if (!node || node.kind !== "split") return tree;
  if (!Number.isFinite(delta) || delta === 0) return tree;
  const count = node.children.length;
  if (!Number.isInteger(dividerIndex) || dividerIndex < 0 || dividerIndex > count - 2) return tree;
  const fracs = fractionsFor(node.fractions, count);
  const before = fracs[dividerIndex] ?? 0;
  const after = fracs[dividerIndex + 1] ?? 0;
  const min = minFractionFor(tree, splitNodePath, node, container);
  const lo = min - before;
  const hi = after - min;
  const moved = lo > hi ? 0 : Math.min(Math.max(delta, lo), hi);
  if (moved === 0) return tree;
  const next = [...fracs];
  next[dividerIndex] = before + moved;
  next[dividerIndex + 1] = after - moved;
  return replaceNodeAt(tree, splitNodePath, {
    kind: "split",
    dir: node.dir,
    children: node.children,
    fractions: renormalize(next),
  });
}

/**
 * Store a whole row of sizes at once — the shape corvu's `onSizesChange` hands
 * back, since a controlled `Resizable` reports its panels' sizes rather than
 * which divider moved.
 *
 * Unlike `resize` this may move children the drag did not touch, because
 * raising one off the floor has to take the space from somewhere. Corvu's own
 * min constraint should mean the clamp never fires; it is here so a document
 * stored before the floor changed, or written by a device with a different one,
 * still opens onto tiles you can read.
 *
 * A length that does not match the split's children is ignored outright. It can
 * only mean the caller is looking at a different tree from the one it is
 * writing to, and guessing which child each number meant would move tiles
 * nobody dragged.
 */
export function setFractions(
  tree: TreeNode,
  splitNodePath: NodePath,
  fractions: readonly number[],
  container?: Size,
): TreeNode {
  const node = nodeAt(tree, splitNodePath);
  if (!node || node.kind !== "split") return tree;
  if (fractions.length !== node.children.length) return tree;
  const min = minFractionFor(tree, splitNodePath, node, container);
  return replaceNodeAt(tree, splitNodePath, {
    kind: "split",
    dir: node.dir,
    children: node.children,
    fractions: clampFractions(renormalize(fractions), min),
  });
}

// ---------------------------------------------------------------------------
// The default arrangement
// ---------------------------------------------------------------------------

function stack(dir: Direction, nodes: readonly TreeNode[]): TreeNode {
  const [first] = nodes;
  if (nodes.length === 1 && first) return first;
  return split(dir, nodes);
}

/**
 * The arrangement a device that has never seen this workspace shows.
 *
 * Membership roams and geometry does not (ADR-0027 §2), so a fresh browser
 * knows which sessions belong together and nothing about how they were
 * arranged. It gets a grid, evenly, in the workspace's server-side member
 * order, and the first drag makes the arrangement its own. Deterministic on
 * purpose: the same workspace opens the same way on every fresh device.
 *
 * THE RULE, which also answers the design's open question about what to do past
 * four members. Columns first: `ceil(sqrt(n))` of them, filled one column at a
 * time, with the remainder going to the LATER columns. Every tile in the
 * workspace is then the same width, which is the dimension a terminal cares
 * about — columns are what wrap a line, and a tile 45 columns wide gives its
 * session a 45-column tmux window for every device attached to it.
 *
 *   1  one tile              5  one, then two of two
 *   2  side by side          6  three columns of two
 *   3  one, then two         7  two, two, three
 *   4  two and two, a 2x2    8  two, three, three
 *
 * Two members side by side is what the design means by "split vertically": the
 * word describes the divider between them, not the way they stack.
 *
 * Duplicate keys are dropped, the first occurrence winning, because one session
 * may occupy at most one tile and a server document is not this module's to
 * trust. No keys at all means no workspace, which is null.
 */
export function autoArrange(sessionKeys: readonly SessionKey[]): TreeNode | null {
  const keys = [...new Set(sessionKeys)];
  const [only] = keys;
  if (!only) return null;
  if (keys.length === 1) return leaf(only);
  const cols = Math.ceil(Math.sqrt(keys.length));
  const base = Math.floor(keys.length / cols);
  const extra = keys.length % cols;
  const columns: TreeNode[] = [];
  let at = 0;
  for (let c = 0; c < cols; c++) {
    const take = base + (c >= cols - extra ? 1 : 0);
    columns.push(stack("column", keys.slice(at, at + take).map(leaf)));
    at += take;
  }
  return stack("row", columns);
}
