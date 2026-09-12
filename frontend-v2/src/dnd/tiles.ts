/**
 * Dropping a session into a Tile, and dragging one back out.
 *
 * `@formkit/drag-and-drop` is already the sidebar's drag (`dnd/sidebar.ts`) and
 * it is the right library for this too: it does multi-list transfer, nested
 * lists, drag handles and — the reason it was adopted — a touch path that is
 * not a second implementation. What it does NOT have is any positional API. A
 * parent's whole state is `Array<T>` through `getValues`/`setValues`, and every
 * operation it knows resolves to an index in some parent's array. "Drop on the
 * left third of this tile to split it sideways" cannot be said in that
 * vocabulary at all. So the library contributes the pointer, the long press and
 * the touch path, and this module contributes the geometry. The design settles
 * that split in as many words; there is no library call to go looking for.
 *
 * THE PREVIEW IS THE WHOLE OF THE FEEDBACK, which is why the arithmetic here is
 * worth getting exactly right. Tiles cannot slide around under the cursor
 * during a drag: moving the DOM node a session hangs off disposes
 * `TerminalNative`, and with it the xterm, the ttyd socket and the tmux attach
 * — a 779 ms rebuild for a warm open (ADR-0026), which is the cost
 * `store/keepalive.ts` exists to avoid. ADR-0027 makes the no-reparenting rule
 * binding. So nothing moves while you drag; a translucent shadow shows the
 * region the tile will occupy, and the tiles snap on release. A shadow that is
 * not exactly where the tile lands is a promise the drop then breaks, so
 * {@link previewBox} is pinned to `toRects` by test rather than by assumption.
 *
 * FOUR ANSWERS, AND THE SAME FOUR GESTURES THE DESIGN LISTS:
 *
 * ```
 *   ┌───────────────────────────┐
 *   │        ░░░ top ░░░        │   left/right/top/bottom third → split
 *   │  ░░░ ┌─────────────┐ ░░░  │   the middle                  → replace
 *   │ left │   replace   │ right│   anywhere outside            → remove
 *   │  ░░░ └─────────────┘ ░░░  │   a split under 240px         → invalid
 *   │       ░░░ bottom ░░░      │
 *   └───────────────────────────┘
 * ```
 *
 * `remove` needs no branch for where the drag came from. A session dragged out
 * of the sidebar and dropped outside the tiles was never in the workspace, and
 * `removeAt` hands back the same tree by reference for a key it cannot find —
 * so {@link applyDrop} writes nothing, and the sidebar's own drop handling
 * carries on as it always did. The same result on a tile drag takes that tile
 * out. One expression, two correct meanings.
 *
 * THE WIRING FOLLOWS `dnd/sidebar.ts` RATHER THAN INVENTING A SECOND SHAPE. A
 * live signal that exists only for the length of a drag (there, the list's
 * order; here, the drop target under the pointer), the store's poll hold taken
 * at the start and released once the write has landed, a re-entry latch so a
 * drag the platform cancels does not land twice, and exactly one write when the
 * pointer comes up.
 *
 * WHAT THIS MODULE OWES `dnd/sidebar.ts`, AND WHY IT IS A SEPARATE ACCESSOR.
 * Both drags end in the same instant, and the sidebar must not treat a drop
 * onto a tile as a card reorder. {@link tileDropClaimed} is that answer, and it
 * is deliberately NOT the preview signal: it is written on every pointer move,
 * so it is already correct by the time any end handler runs, and it does not
 * matter which of the two modules the browser calls first. The preview signal
 * is cleared at the end of a drag; the claim survives until the next one
 * begins, because it has to be readable during the end nobody controls the
 * order of.
 *
 * It reaches the sidebar as a reader `attachTileDrop` hands over and withdraws
 * with the canvas, rather than as an import the sidebar makes. That direction
 * is forced: this module imports {@link DRAG_START_EVENT} from there, so the
 * sidebar importing back would close a cycle that biome's `noImportCycles`
 * refuses. `setTileDropClaim` in `dnd/sidebar.ts` carries the same note.
 */

import { createSignal, onCleanup } from "solid-js";
import {
  type Box,
  type Edge,
  MIN_TILE_PX,
  type Rect,
  removeAt,
  replaceAt,
  type SessionKey,
  splitAt,
  type TreeNode,
} from "../store/workspace-tree";
import { DRAG_START_EVENT, setTileDropClaim } from "./sidebar";

/** A position in the container's own coordinates: pixels from its top-left
 *  corner, which is what `toRects` measures a tile's rect in. */
export interface Point {
  x: number;
  y: number;
}

/**
 * How much of a tile each edge claims, as a fraction of that tile's own width
 * or height. A third, per the design, measured per axis: the top band of a wide
 * short tile is a thinner strip of pixels than its left band, which is what
 * makes the middle a comfortable target on any tile shape.
 */
export const EDGE_BAND = 1 / 3;

/**
 * Float slack for the minimum-tile comparison, matching the value
 * `store/workspace-tree.ts` uses for the same comparison inside `canSplit`.
 * Both are deciding whether half of a measured extent clears 240px, and a tile
 * sized to exactly the floor by a divider drag must not flip to refused because
 * the arithmetic that produced it ended a billionth of a pixel low.
 */
const EPSILON = 1e-9;

/** Split the tile under the pointer; the dropped session takes half of it. */
export interface SplitDrop {
  readonly kind: "split";
  readonly key: SessionKey;
  readonly edge: Edge;
}

/** Show the dropped session in this tile, at the size and place it already has.
 *  Whatever was in it leaves the workspace and keeps running. */
export interface ReplaceDrop {
  readonly kind: "replace";
  readonly key: SessionKey;
}

/** The pointer is outside every tile: a tile drag means take it out, and a
 *  drag from the sidebar means this was never a drop into the workspace. */
export interface RemoveDrop {
  readonly kind: "remove";
}

/**
 * The split the pointer is asking for would leave a tile below
 * {@link MIN_TILE_PX}. Carries the tile and the edge anyway, so the preview can
 * be drawn in the shape that was refused and marked as refused — a drop that
 * silently does nothing reads as a broken drag.
 */
export interface InvalidDrop {
  readonly kind: "invalid";
  readonly key: SessionKey;
  readonly edge: Edge;
}

/** What a pointer position over the tiles means. */
export type DropTarget = SplitDrop | ReplaceDrop | RemoveDrop | InvalidDrop;

/** Shared, because it carries nothing: a removal is the same answer every time,
 *  so the preview's memo sees one reference rather than a new object per move. */
const REMOVE: RemoveDrop = { kind: "remove" };

/** Closed bounds on both sides. The rects `toRects` produces tile the container
 *  exactly and adjacent tiles share one boundary number, so a pointer on a seam
 *  is inside both and reading order decides; and the far edge of the workspace
 *  still aims at the tile it borders rather than meaning "remove", which is the
 *  one place a person is most likely to aim a split. */
function contains(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/**
 * Which edge the pointer is in the band of, or null for the middle.
 *
 * Each depth is measured as a fraction of the tile's extent along that axis, so
 * the four are comparable and the nearest wins. In a corner both a horizontal
 * and a vertical band contain the pointer, and the nearer one takes it, which
 * is the diagonal division a person expects from a corner.
 *
 * Ties go left, right, top, bottom. A tie needs the pointer to sit on the exact
 * diagonal of the relative-depth space, which a test can hit and a finger
 * essentially cannot; what matters is that the same point always answers the
 * same way, because a preview that flickers between two shapes under a still
 * pointer is worse than either shape.
 *
 * A tile of no extent has no bands. Nothing in the app mints one —
 * `parseTreeNode` refuses a stored fraction that is not positive — but a rect
 * measured mid-animation can be flat, and dividing by it would put a NaN box on
 * screen.
 */
function edgeAt(rect: Rect, point: Point): Edge | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const left = (point.x - rect.x) / rect.width;
  const right = (rect.x + rect.width - point.x) / rect.width;
  const top = (point.y - rect.y) / rect.height;
  const bottom = (rect.y + rect.height - point.y) / rect.height;
  const nearest = Math.min(left, right, top, bottom);
  if (nearest >= EDGE_BAND) return null;
  if (left === nearest) return "left";
  if (right === nearest) return "right";
  if (top === nearest) return "top";
  return "bottom";
}

/**
 * Would halving this tile on this edge leave both halves at or above the floor?
 *
 * This is `canSplit` asked of a RECT rather than of a tree, and it is the same
 * arithmetic for the same reason: `toRects` and `canSplit`'s own walk down the
 * tree compute a leaf's box from the same cumulative edges, so the box this
 * rect is and the box `canSplit` measures are the same numbers. Only the axis
 * the divider crosses is checked — a tile already shorter than the floor
 * because the window is short is not made shorter by a vertical divider, and
 * refusing there would make a small window refuse every drop rather than the
 * ones that would actually crush a terminal.
 *
 * Asking `canSplit` directly would mean handing this function the tree and the
 * container as well as the rects the caller already has, and it would still be
 * two expressions of one rule. The test pins them together instead: at every
 * tile and every edge of a real tree, a refusal here is a refusal there.
 */
function splitFits(rect: Rect, edge: Edge): boolean {
  const extent = edge === "left" || edge === "right" ? rect.width : rect.height;
  return extent / 2 >= MIN_TILE_PX - EPSILON;
}

/**
 * What a pointer over the tiles is asking for.
 *
 * Pure, and pure on purpose: no DOM, no tree, no container, just the position
 * and the rects the render layer already computed. Every case a person can
 * produce is then reachable from a table of numbers, which is the only way the
 * corners and the boundaries get checked at all — jsdom has no layout, so a hit
 * test that needed to measure anything could not be tested here.
 */
export function hitTest(point: Point, rects: readonly Rect[]): DropTarget {
  const rect = rects.find((r) => contains(r, point));
  if (!rect) return REMOVE;
  const edge = edgeAt(rect, point);
  if (!edge) return { kind: "replace", key: rect.key };
  if (!splitFits(rect, edge)) return { kind: "invalid", key: rect.key, edge };
  return { kind: "split", key: rect.key, edge };
}

/**
 * The region the dropped tile will occupy, for the translucent shadow, or null
 * when there is nothing to show.
 *
 * A `Box` rather than a `Rect`: the shadow has no session key of its own, since
 * the session it stands for is the one in the air and the caller already knows
 * which that is.
 *
 * HALF THE TILE IS NOT A GUESS. `splitAt` builds the new pair through `split()`
 * with no fractions, which is an even share, so the arriving tile gets exactly
 * half of the one it split. An `invalid` target draws the same half — the
 * caller paints it as refused rather than hiding it, so the shadow says what
 * was asked for and that it will not be given.
 */
export function previewBox(target: DropTarget, rects: readonly Rect[]): Box | null {
  if (target.kind === "remove") return null;
  const rect = rects.find((r) => r.key === target.key);
  if (!rect) return null;
  const whole: Box = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  if (target.kind === "replace") return whole;
  const half = { width: rect.width / 2, height: rect.height / 2 };
  switch (target.edge) {
    case "left":
      return { x: rect.x, y: rect.y, width: half.width, height: rect.height };
    case "right":
      return { x: rect.x + half.width, y: rect.y, width: half.width, height: rect.height };
    case "top":
      return { x: rect.x, y: rect.y, width: rect.width, height: half.height };
    case "bottom":
      return { x: rect.x, y: rect.y + half.height, width: rect.width, height: half.height };
  }
}

/**
 * The arrangement a finished drag leaves behind.
 *
 * Three return shapes, and the caller reads all three:
 *
 *   - a NEW tree, which is the drop landing;
 *   - the SAME tree by reference, which is a drop that asked for nothing — a
 *     refused split, a tile dropped back on its own edge, or a session from the
 *     sidebar let go outside the workspace. The caller writes nothing, and in
 *     the last of those the sidebar's own handling carries on untouched;
 *   - null, which is the last tile leaving: there is no workspace any more and
 *     the caller is looking at a single session again.
 *
 * Every duplicate-session question is already answered by the tree layer.
 * `splitAt` routes a session that is already on screen into `moveWithin` rather
 * than adding a second tile for it, and `replaceAt` closes the tile a dropped
 * session used to have. keepalive mounts exactly one live view per session, so
 * a second tile of one session would have no terminal in it and the two would
 * contend for that session's Grid continuously. Nothing here can produce one.
 */
export function applyDrop(
  tree: TreeNode,
  dragged: SessionKey,
  target: DropTarget,
): TreeNode | null {
  switch (target.kind) {
    case "split":
      return splitAt(tree, target.key, target.edge, dragged);
    case "replace":
      return replaceAt(tree, target.key, dragged);
    case "remove":
      return removeAt(tree, dragged);
    case "invalid":
      return tree;
  }
}

// ---------------------------------------------------------------------------
// The drag itself
// ---------------------------------------------------------------------------

/** What the canvas owes this module for the length of a drag. */
export interface TileDropDeps {
  /**
   * The session in the air as a keepalive key (`owner\0name`, `keyOf`), or null
   * when the drag carries none — a project header being reordered raises the
   * same start event and is not a session.
   *
   * Read ONCE, when the drag begins, and remembered for the rest of it. By the
   * time a drag ends, the library has reset its own state and `dnd/sidebar.ts`
   * has cleared its signals, in an order nothing here can depend on; the start
   * is the moment where the answer is unambiguous.
   */
  dragged: () => SessionKey | null;
  /** The tiles on screen, in the container's coordinates — `WorkspaceCanvas`'s
   *  `onRects`, which is also the visible set. */
  rects: () => readonly Rect[];
  /** The arrangement the drop applies to, or null when there is no workspace. */
  tree: () => TreeNode | null;
  /**
   * The one write. `null` means the workspace ended; anything else is the new
   * arrangement. Called at most once per drag, and never for a drop that asked
   * for nothing.
   */
  apply: (tree: TreeNode | null) => void | Promise<void>;
  /**
   * The store's poll pause, held for as long as the drag is in the air. A poll
   * landing mid-drag can drop a session that has just died, which changes the
   * rects under the pointer — so the shadow would be measured against one
   * arrangement and the drop applied to another.
   */
  hold: () => () => void;
}

/** The canvas currently taking drops, with what it gave us. One at a time:
 *  there is one workspace on screen, the way there is one sidebar. */
let canvas: { el: HTMLElement; deps: TileDropDeps } | null = null;

/** The preview the shadow is drawn from, live during a drag and null between. */
const [target, setTarget] = createSignal<DropTarget | null>(null);

/**
 * The last reading of this drag, kept as a plain variable rather than a signal
 * and deliberately NOT cleared when the drag ends.
 *
 * `dnd/sidebar.ts` reads it through {@link tileDropClaimed} inside its own
 * `onDragend`, and which of the two end handlers the browser calls first is not
 * something either module can pin down. Writing it on every pointer move rather
 * than at the end makes the ordering question disappear: by the time anything
 * ends, this already holds the answer.
 *
 * So it is cleared at the three moments that cannot race an end handler: when
 * any sidebar drag starts, when a tile drag starts, and when the canvas
 * unmounts. Clearing it AT the end instead is what a first draft does, and it
 * loses the race it was written to avoid. Leaving it to the next `begin` alone
 * is not enough either: a sidebar drag that starts with no workspace on screen
 * never reaches `begin`, and a claim left over from the last workspace would
 * then suppress an ordinary card reorder.
 */
let claim: DropTarget | null = null;

/** The drag this module has seen begin and not yet landed. A synthetic drag the
 *  platform cancels reaches its end twice (`dnd/sidebar.ts` carries the same
 *  latch for the same reason), and the second must not write again. */
let inFlight = false;

/** The session in the air, captured at the start of the drag. */
let dragKey: SessionKey | null = null;

/** The poll hold, released once the write has landed. */
let release: (() => void) | null = null;

/** The move and end listeners, installed for the length of a drag and taken
 *  down after it — a `pointermove` handler on the document outlives its welcome
 *  fast when the thing under the pointer is a terminal. */
let listeners: AbortController | null = null;

/** The drop the pointer is currently over, for the caller to draw a shadow
 *  from. Null between drags, and null while a drag carries no session. */
export function tileDropTarget(): DropTarget | null {
  return target();
}

/**
 * Is a tile taking this drop? What `dnd/sidebar.ts` asks before it writes a card
 * order down.
 *
 * True whenever the pointer was last seen over a tile, refused splits included:
 * a card let go over a tile was aimed at the workspace whatever the answer
 * turned out to be, and reordering the sidebar because the split was too small
 * would be a second surprise on top of the first. False once the pointer leaves
 * the tiles, which is the sidebar's own business again.
 */
export function tileDropClaimed(): boolean {
  return claim !== null && claim.kind !== "remove";
}

function point(event: MouseEvent): Point {
  const box = canvas?.el.getBoundingClientRect();
  return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
}

/** Two targets meaning the same thing, so a pointer moving within one band does
 *  not rewrite the signal sixty times a second. */
function sameTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  // Both halves of this test, though the kinds are already equal: matching one
  // union's kind tells the compiler nothing about the other's, and the two
  // together are what leave `key` and `edge` reachable below.
  if (a.kind === "remove" || b.kind === "remove") return true;
  if (a.key !== b.key) return false;
  const aEdge = a.kind === "replace" ? null : a.edge;
  const bEdge = b.kind === "replace" ? null : b.edge;
  return aEdge === bEdge;
}

function track(event: MouseEvent): void {
  if (!canvas) return;
  const next = hitTest(point(event), canvas.deps.rects());
  claim = next;
  if (!sameTarget(target(), next)) setTarget(next);
}

/**
 * Finish the drag: land the drop, or abandon it.
 *
 * `commit` is false for a gesture the platform took away rather than a person
 * letting go. That is `pointercancel` — an incoming call, a system gesture, or
 * a browser starting a native drag of its own — and Escape, which is what a
 * person reaches for when they change their mind mid-drag. Committing on a
 * cancel would be worse than dropping it: a native drag start raises
 * `pointercancel` on its way past, so a tile would land the instant a mouse
 * drag began.
 *
 * The preview is cleared only once the write has landed, not at the pointer's
 * release. `dnd/sidebar.ts` clears its live order on the same reasoning:
 * clearing any earlier lets one frame render the arrangement as it was before
 * the drop, with the shadow already gone.
 */
function end(commit: boolean): void {
  if (!inFlight) return;
  inFlight = false;
  listeners?.abort();
  listeners = null;
  const key = dragKey;
  dragKey = null;
  const done = () => {
    setTarget(null);
    release?.();
    release = null;
  };
  const deps = canvas?.deps;
  const tree = deps?.tree() ?? null;
  if (!commit || !deps || !tree || !key || !claim) return done();
  const next = applyDrop(tree, key, claim);
  if (next === tree) return done();
  void Promise.resolve(deps.apply(next)).finally(done);
}

/**
 * Arm the tracker for a drag carrying `key`.
 *
 * One drag at a time. A second gesture starting while one is in the air is the
 * sidebar's long press and a tile's own press overlapping, and the one already
 * being tracked is the one the person is making.
 */
function begin(key: SessionKey): void {
  if (inFlight || !canvas) return;
  inFlight = true;
  dragKey = key;
  claim = null;
  setTarget(null);
  release = canvas.deps.hold();
  listeners = new AbortController();
  // THE CAPTURE PHASE, AND IT IS NOT A DETAIL. `@formkit/drag-and-drop` ends a
  // drag from a listener on the dragged CARD and stops the event there:
  // `handleNodePointerup` and `handleDragend` both call `stopPropagation()`
  // before they finish it. A card is where an ordinary sidebar reorder is
  // released, so a bubble-phase listener on the document never saw that gesture
  // end at all. Measured in `test/dnd.tiles.claim.test.ts`: the poll hold never
  // came back, `inFlight` stayed true so no later drag could begin, and the
  // abandoned listeners left the previous `dragKey` armed — a second drag onto
  // a tile edge split the workspace with the session from the FIRST drag. The
  // capture phase runs document-first, before any node can stop it.
  const opts: AddEventListenerOptions = { signal: listeners.signal, capture: true };
  // Both paths the library can take. A finger gets a synthetic drag and reports
  // through pointer events; a mouse gets a native one, where the browser
  // suppresses pointer events for the length of the drag and reports the
  // position on `dragover` instead. The library itself listens for exactly this
  // pair on the document, which is why both reach us wherever the pointer is.
  document.addEventListener("pointermove", track, opts);
  document.addEventListener("dragover", track, opts);
  document.addEventListener("pointerup", () => end(true), opts);
  document.addEventListener("dragend", () => end(true), opts);
  document.addEventListener("drop", () => end(true), opts);
  document.addEventListener("pointercancel", () => end(false), opts);
  document.addEventListener(
    "keydown",
    (event: KeyboardEvent) => {
      if (event.key === "Escape") end(false);
    },
    opts,
  );
}

/**
 * Start dragging a tile that is already in the workspace.
 *
 * The tile header calls this from its own press. `@formkit/drag-and-drop` is
 * not used for this half and cannot be: it moves the dragged element into its
 * new parent when a drop lands, and a tile's element is the slot a live
 * terminal hangs off — the one node in this app that may never be moved or
 * reparented (ADR-0027). Nothing is lifted, cloned or transformed here. The
 * pointer is tracked, the shadow shows where the tile will go, and the tile
 * arrives there on release.
 */
export function beginTileDrag(key: SessionKey): void {
  begin(key);
}

/**
 * Take drops for the workspace drawn in `el`.
 *
 * `el` is the canvas, and it is here for one thing: the rects are pixels from
 * the container's top-left corner and the events carry client coordinates, so
 * its box is what translates between them. Pass the same element the rects were
 * computed for, or every band sits a few pixels off its tile.
 *
 * Registered immediately rather than on the next microtask. `dnd/sidebar.ts`
 * defers because the library counts a list's rendered rows against the values
 * it is given at registration; there is no list here and nothing to count.
 */
export function attachTileDrop(el: HTMLElement, deps: TileDropDeps): void {
  canvas = { el, deps };
  // The sidebar asks this before it writes a card order down. Handed over here
  // rather than imported there, because that import would close a cycle (see
  // the module docblock), and withdrawn below: with no canvas there is no
  // workspace, and every drag is the sidebar's own again.
  setTileDropClaim(tileDropClaimed);
  const onDragStart = () => {
    // Before the session test, not after: a group being reordered is not a
    // session and must still retire the last drag's claim, or the sidebar would
    // read a stale one in its own `onDragend`.
    claim = null;
    const key = deps.dragged();
    if (key) begin(key);
  };
  document.addEventListener(DRAG_START_EVENT, onDragStart);
  onCleanup(() => {
    document.removeEventListener(DRAG_START_EVENT, onDragStart);
    // A workspace unmounting mid-drag has nowhere to apply a drop to, so the
    // drag is abandoned rather than landed, and the poll hold goes back.
    end(false);
    claim = null;
    setTileDropClaim(null);
    canvas = null;
  });
}
