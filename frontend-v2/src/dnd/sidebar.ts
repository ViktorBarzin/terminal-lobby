/**
 * Dragging in the sidebar, over @formkit/drag-and-drop.
 *
 * What this replaced, and why. The sidebar used to carry two drags of its own:
 * HTML5 drag-and-drop for the mouse, and a hand-rolled pointer drag for a
 * finger (a lift transform, an `elementFromPoint` aim, an edge auto-scroll, and
 * a drop indicator each row drew for itself). They shared nothing but the store
 * call at the end, only one of them could reorder projects, and the mouse half
 * had stopped working: the file-drop overlay listens for `dragover` on the
 * window and set `dropEffect` to "copy" on every drag that passed, which
 * against a card's `effectAllowed` of "move" resolves to no operation at all,
 * so Chrome refused the drop and sent `dragleave` + `dragend` instead. The drop
 * line still painted, which is why it looked like it should have worked. That
 * listener started seeing the lobby's own drags when the terminal stopped being
 * an iframe on 2026-09-05; `clipboard/attach.ts` now leaves them alone and asks
 * `lobbyDragActive()` whether one is in the air.
 *
 * The library keeps a mouse on native drag events and gives a finger a
 * synthetic pointer drag with a cloned row, and `nativeDrag` is what chooses
 * between them. It has to be ON wherever a mouse might be used, because the
 * library's pointermove handler returns early for a mouse on a desktop, so
 * turning it off would leave a mouse with nothing to drag with. It has to be
 * OFF on a phone, because Android Chrome starts a native drag of its own from a
 * long press and that pre-empts the synthetic one (`isMobilePlatform`, which
 * has to answer exactly as the library's own copy of that check does).
 * Both paths land in the same callbacks, so what is left here is the part that
 * is ours — which elements may be dragged, what the list looks like while one
 * is in the air, and the single store call that writes the result down.
 *
 * The store stays the truth. The library is data-first: it calls `setValues`
 * with a list's new order on every crossing and expects the framework to render
 * it. So `setValues` writes a live order that exists only for the length of the
 * drag, and the layout is written once, when the pointer comes up.
 *
 * THE TILES GET FIRST REFUSAL ON THAT ONE WRITE. A card let go on a tile edge
 * was aimed at the workspace, and `dnd/tiles.ts` lands the split from the same
 * pointer release this module's `onDragend` fires on. Writing a card order as
 * well would move the session into whichever project's list the pointer crossed
 * on its way out — the split AND a reassignment nobody asked for. So the one
 * write asks {@link setTileDropClaim}'s reader first.
 */

import { animations, dragAndDrop, dragstartClasses, tearDown } from "@formkit/drag-and-drop";
import { createSignal, onCleanup } from "solid-js";
import type { DropAnchor } from "../components/lobby.logic";
import { isMobilePlatform } from "../mobile/pointer";
import { anchorFor, groupSeqTarget } from "./anchor";

/** One list's contents, keyed by group name; "" is Ungrouped. */
type Order = Record<string, string[]>;

/** What is being dragged, or null between drags. */
const [dragging, setRaw] = createSignal<"session" | "group" | null>(null);

/**
 * Record the drag on the root element as well as in the signal.
 *
 * CSS needs to know: an empty project's card list has no height, so there would
 * be nothing to aim a card at until it opens up (`.tl-group-body:empty` in
 * sidebar.css). An attribute is the cheapest way to say it once for the whole
 * page rather than threading a flag through every group.
 */
function setDragging(kind: "session" | "group" | null): void {
  setRaw(kind);
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (kind) {
    root.dataset.tlDrag = kind;
    // A row that has just been picked up may be carrying an open actions menu:
    // the same 450ms press opens the menu and arms the drag, by design. The
    // popup is `position: fixed` against the window, so it would hang over the
    // list while the row travelled underneath it. The card cannot close it from
    // its own pointer handlers — a touchscreen sends `pointercancel` to the row
    // the moment the browser hands the gesture over, which is exactly when the
    // drag begins, so the move that should have closed the menu never arrives
    // (measured on the Android emulator: the menu stayed open for the whole
    // drag). Announcing it here reaches every menu on the page at once.
    document.dispatchEvent(new CustomEvent(DRAG_START_EVENT));
  } else {
    delete root.dataset.tlDrag;
  }
}

/** Raised on the document when anything in the sidebar starts being dragged. */
export const DRAG_START_EVENT = "tl-drag-start";
/** What each session list looks like mid-drag; empty between drags. */
const [live, setLive] = createSignal<Order>({});
/** The group sequence mid-drag, when a project header is the thing moving. */
const [liveGroups, setLiveGroups] = createSignal<string[] | null>(null);

/**
 * Is something in the sidebar being dragged right now?
 *
 * The file-drop overlay asks before it claims a `dragover`: its job is files,
 * and neither a card nor a project header carries any.
 */
export function lobbyDragActive(): boolean {
  return dragging() !== null;
}

/** True while a SESSION is in the air — a collapsed group springs open for one. */
export function sessionDragActive(): boolean {
  return dragging() === "session";
}

/**
 * The order a group has WHILE something is being dragged through it, or
 * undefined when the model's own order is the one to draw.
 */
export function liveOrder(group: string): string[] | undefined {
  return live()[group];
}

/** The same, for the sequence of groups down the sidebar. */
export function liveGroupOrder(): string[] | null {
  return liveGroups();
}

/**
 * The drag the library has told us about but has not finished, or null.
 *
 * Deliberately a plain variable rather than a signal: a synthetic drag the
 * platform cancels (`pointercancel` — an incoming call, a system gesture)
 * reaches `onDragend` TWICE, once from the cancel handler and again from the
 * end it then runs, and the second must not write the layout again. The guard
 * has to close synchronously inside the handler, which a signal cleared in a
 * promise's `finally` cannot do.
 */
let inFlight = false;

/**
 * Whether the workspace's tiles are taking the drop that is ending, or null
 * whenever no workspace canvas is mounted — which is most of the app's life,
 * and means every drag is the list's own.
 *
 * A reader handed over rather than a function imported, and the direction is
 * forced rather than chosen. `dnd/tiles.ts` already imports `DRAG_START_EVENT`
 * from here, which is the right way round — the sidebar is what raises it — so
 * importing `tileDropClaimed` back would close a two-file cycle, and biome's
 * `noImportCycles` refuses one (measured: two errors, one for each edge of it).
 * The claim therefore travels the way the dependency already runs, from the
 * tiles into the sidebar, and `attachTileDrop` withdraws it with its canvas.
 */
let tileClaim: (() => boolean) | null = null;

/** Hand over the tiles' answer, or withdraw it with null. `dnd/tiles.ts` is the
 *  only caller; nothing else in the app knows what a tile is. */
export function setTileDropClaim(claimed: (() => boolean) | null): void {
  tileClaim = claimed;
}

/**
 * A press this long on a touchscreen lifts what is under it. It is the same
 * 450ms a card's actions menu opens on, deliberately: one press, and what
 * happens next is decided by whether the finger then moves. A shorter press
 * stays a swipe or a scroll, which is what keeps the list scrollable by
 * dragging it.
 */
const HOLD_MS = 450;

/** 150ms is a row's own transform transition (sidebar.css), so a row shuffling
 *  out of the way and a row springing back from a swipe move at one speed. */
const SLIDE_MS = 150;

/** The attribute a session list publishes so a drop can name its group. */
export const GROUP_ATTR = "data-group";
/** The attribute a group publishes so a drop can name it in the sequence. */
export const TOKEN_ATTR = "data-token";

/** Everything a group's card list needs to take part in a drag. */
export interface SessionListDeps {
  /** which group this list is; "" is Ungrouped. */
  group: () => string;
  /** the order the model has for it, between drags. */
  names: () => string[];
  /** the store's move — the only thing that writes a card order down. */
  move: (name: string, group: string, anchor?: DropAnchor) => Promise<void>;
  /** the store's poll pause, held for as long as a drag is in the air. */
  hold: () => () => void;
}

/** Everything the sidebar needs to reorder its groups. */
export interface GroupListDeps {
  /** the tokens of the groups on screen, in render order. */
  visible: () => string[];
  /** every token the layout holds, including any the render hides. */
  sequence: () => string[];
  /** the store's group reorder, in raw sequence indices. */
  reorder: (from: number, to: number) => Promise<void>;
  hold: () => () => void;
}

/**
 * Register a list with the library on the next microtask, and tear it down with
 * the owner.
 *
 * Deferred because a `ref` runs before Solid has inserted the element's
 * children, and the library counts the rows it can see against the values it is
 * given the moment it is registered — registering in the same tick meant
 * counting zero against a full list, which it warns about and then skips. Its
 * MutationObserver would have caught up a tick later either way; this just
 * means the first reading is the true one.
 */
function register(el: HTMLElement, start: () => void, stop: () => void): void {
  let gone = false;
  onCleanup(() => {
    gone = true;
    tearDown(el);
    stop();
  });
  queueMicrotask(() => {
    if (!gone) start();
  });
}

/** Register a group's card list as a sortable, and unregister it on cleanup. */
export function attachSessionList(el: HTMLElement, deps: SessionListDeps): void {
  let release: (() => void) | null = null;
  const done = () => {
    setDragging(null);
    // Cleared only once the move has been applied locally, not at the pointer's
    // release: `store.move` writes the layout on its way into the PUT, and
    // clearing any earlier lets one frame render the list as it was before.
    setLive({});
    release?.();
    release = null;
  };

  register(
    el,
    () =>
      dragAndDrop<string>({
        parent: el,
        getValues: () => liveOrder(deps.group()) ?? deps.names(),
        setValues: (names) => setLive((prev) => ({ ...prev, [deps.group()]: names })),
        config: {
          group: "tl-sessions",
          nativeDrag: !isMobilePlatform(),
          longPress: true,
          longPressDuration: HOLD_MS,
          // Someone else's session is read-only here, and reordering it would ask
          // the layout to hold a name this account does not own.
          draggable: (child) =>
            child.classList.contains("tl-card") && !child.classList.contains("tl-card-foreign"),
          dragPlaceholderClass: "tl-card-dragging",
          synthDragPlaceholderClass: "tl-card-dragging",
          plugins: [animations({ duration: SLIDE_MS })],
          // Not `onDragstart`, which the library raises for a NATIVE drag only —
          // measured: a finger's synthetic drag reaches `onDragend` having raised
          // no start at all, so the poll was never held and the drop was thrown
          // away as a drag nobody had seen begin. This hook runs on both paths,
          // which is the whole reason it is the one used.
          dragstartClasses: (node, nodes, config, isSynth) => {
            dragstartClasses(node, nodes, config, isSynth);
            inFlight = true;
            setDragging("session");
            // A poll that rebuilt the list mid-drag would move the rows out from
            // under the pointer, taking the dragged node's own element with them.
            release ??= deps.hold();
          },
          onDragend: ({ parent, values, draggedNode }) => {
            if (!inFlight) return;
            inFlight = false;
            // The tiles first. A card they took is not also a card reorder: both
            // drags end on the same release, so without this the tile splits AND
            // the session is written into whichever project's list the pointer
            // last crossed on its way out to the workspace.
            //
            // The answer is read rather than worked out here, because neither
            // module can pin down which end handler the browser calls first. The
            // tiles write their claim on every pointer move, so it already holds by
            // the time either end runs — `dnd/tiles.ts` sets that out at length.
            if (tileClaim?.()) return done();
            const name = String(draggedNode.data.value);
            void landSession(name, parent.el, values as string[], deps).finally(done);
          },
        },
      }),
    () => {
      inFlight = false;
      release?.();
      release = null;
    },
  );
}

/**
 * Register the sidebar's scroller as the list of groups.
 *
 * The groups are dragged by their headers alone (`dragHandle`), so a press on a
 * card is not the start of a group drag — and because a card list is a parent
 * nested inside one of these nodes, the inner list claims that press first
 * either way.
 */
export function attachGroupList(el: HTMLElement, deps: GroupListDeps): void {
  let release: (() => void) | null = null;
  const done = () => {
    setDragging(null);
    setLiveGroups(null);
    release?.();
    release = null;
  };

  register(
    el,
    () =>
      dragAndDrop<string>({
        parent: el,
        getValues: () => liveGroupOrder() ?? deps.visible(),
        setValues: (tokens) => setLiveGroups(tokens),
        config: {
          group: "tl-groups",
          nativeDrag: !isMobilePlatform(),
          longPress: true,
          longPressDuration: HOLD_MS,
          dragHandle: ".tl-group-header",
          // The scroller also holds the skeletons, the empty-list message and the
          // read-only "Shared with me" group; only a group the layout can place
          // carries a token.
          draggable: (child) =>
            child.classList.contains("tl-group") && child.hasAttribute(TOKEN_ATTR),
          // The library disarms a native drag while focus sits inside a child of a
          // draggable node, so that a text field in a row can be clicked into
          // without the row being picked up. It listens for `focus` in the CAPTURE
          // phase, which for a group means every card inside it counts as that
          // child — and a card IS focusable (tabindex 0), so pressing one set the
          // group's `draggable` to false, and with it the card's own. Measured in
          // Chrome: pressing any row flipped draggable true then false in the same
          // event, and no `dragstart` ever followed. A group is dragged by its
          // header alone, and `dragHandle` already refuses a drag that began
          // anywhere else, so the guard has nothing left to protect here.
          handleNodeFocus: () => {},
          handleNodeBlur: () => {},
          dragPlaceholderClass: "tl-group-dragging",
          synthDragPlaceholderClass: "tl-group-dragging",
          plugins: [animations({ duration: SLIDE_MS })],
          // See the session list above for why this and not `onDragstart`.
          dragstartClasses: (node, nodes, config, isSynth) => {
            dragstartClasses(node, nodes, config, isSynth);
            inFlight = true;
            setDragging("group");
            release ??= deps.hold();
          },
          // No tile claim to ask about here, unlike the session list above: a
          // project header is not a session, so `attachTileDrop` retires the last
          // claim on this drag's start event and never begins a drag for it.
          onDragend: ({ values, draggedNode }) => {
            if (!inFlight) return;
            inFlight = false;
            const token = String(draggedNode.data.value);
            void landGroup(token, values as string[], deps).finally(done);
          },
        },
      }),
    () => {
      inFlight = false;
      release?.();
      release = null;
    },
  );
}

/** The one move a finished drag asks for, or null when it asks for nothing. */
export interface MovePlan {
  group: string;
  anchor?: DropAnchor;
}

/**
 * What a finished drag means, in the terms `store.move` takes.
 *
 * A drag that ended where it started asks for nothing, and asking anyway would
 * not be free: the layout PUT is what hands ordering over to "manual"
 * (store.move), so a press that wobbled must not change how the whole list
 * sorts. Anything else is a move against the neighbour the card came to rest
 * past — see `anchorFor` for why a neighbour rather than an index.
 */
export function planMove(
  from: { group: string; names: readonly string[] },
  to: { group: string; values: readonly string[] },
  name: string,
): MovePlan | null {
  if (from.group === to.group && sameOrder(from.names, to.values)) return null;
  return { group: to.group, anchor: anchorFor(to.values, name) };
}

/**
 * Write down where a card ended.
 *
 * `parent` is the list the pointer was over when it came up, which is not
 * necessarily the one the drag started in, so the group is read off the element
 * rather than off the deps that happen to own this callback (the library takes
 * both from the parent the drag STARTED in).
 */
async function landSession(
  name: string,
  parent: HTMLElement,
  values: string[],
  deps: SessionListDeps,
): Promise<void> {
  const group = parent.getAttribute(GROUP_ATTR);
  if (group === null) return;
  const plan = planMove({ group: deps.group(), names: deps.names() }, { group, values }, name);
  if (!plan) return;
  await deps.move(name, plan.group, plan.anchor);
}

/** The same, for a project header dropped somewhere in the sequence. */
async function landGroup(token: string, values: string[], deps: GroupListDeps): Promise<void> {
  const sequence = deps.sequence();
  const to = groupSeqTarget(sequence, values, token);
  if (to === null) return;
  await deps.reorder(sequence.indexOf(token), to);
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((n, i) => n === b[i]);
}
