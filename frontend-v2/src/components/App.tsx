import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  getOwner,
  onCleanup,
  onMount,
  runWithOwner,
  Show,
  untrack,
  type Component,
  type JSX,
} from "solid-js";
import { createLobbyStore, type NotifyKind, type SelectedSession } from "../store/lobby";
import { canActAs } from "../lib/mode";
import {
  emptyWorkspaces,
  MIN_WORKSPACE_MEMBERS,
  NAME_RE,
  sessionLabel,
  type Layout,
  type SessionTool,
  type Workspace,
  type WorkspaceMember,
  type Workspaces,
} from "../types/lobby";
import {
  EMPTY_KEEP,
  KEEP_TTL_MS,
  keepSelected,
  keyOf,
  pruneKept,
  type KeptSession,
  type Selected,
} from "../store/keepalive";
import { createPreloadStore } from "../store/preload";
import { createWorkspacesStore } from "../store/workspaces";
import {
  autoArrange,
  leaf,
  leafKeys,
  parseTreeNode,
  removeAt,
  sessionOf,
  setFractions,
  splitAt,
  type Rect,
  type SessionKey,
  type Size,
  type TreeNode,
} from "../store/workspace-tree";
import {
  createWorkspaceUndo,
  registerWorkspaceUndoHandler,
  WORKSPACE_SAVE_FAILED,
} from "../store/undo.workspace";
import { attachTileDrop, beginTileDrag, tileDropPreview } from "../dnd/tiles";
import { sessionDragActive } from "../dnd/sidebar";
import { newSessionId } from "../lib/session-id";
import { resolvedWatchFor } from "../store/watchmode";
import { TileHeader } from "./TileHeader";
import { WorkspaceCanvas } from "./WorkspaceCanvas";
import { TileFocusContext } from "../lib/ownwhile";
import { Sidebar } from "./Sidebar";
import { PreloadHoverContext } from "./SessionCard";
import { NewSessionComposer } from "./NewSessionComposer";
import { SessionView } from "./SessionView";
import { SettingsPanel, type PageId } from "./SettingsPanel";
import { openerAction } from "./settings/rail";
import { Toaster } from "./Toaster";
import { startNetworkWatch } from "../diagnostics/network";
import { createPrefsStore, modelChoiceFor } from "../store/prefs";
import { modelHarness, modelRequest } from "../lib/models";
import { createSkillsStore } from "../store/skills";
import { SkillsIcon } from "./Icons";
import { toasts } from "../store/toast";
import { createKeybindingEngine } from "../keybindings/engine";
import { keyContext } from "../keybindings/bindings.logic";
import { isEditingTarget } from "../keybindings/editing";
import { createUndoStore } from "../store/undo";
import { createPaletteController, type PaletteAction } from "../keybindings/palette-controller";
import { createRunAppCommand } from "../keybindings/commands";
import { refocusTerminal } from "../keybindings/refocus";
import { flatSessionOrder } from "../keybindings/navigation.logic";
import { opensOnContent, sessionBarOnScreen } from "./lobby.logic";
import { CommandPalette } from "./CommandPalette";
import { ShortcutsHelp, createHelpController } from "./ShortcutsHelp";
import { createNotificationSystem } from "../notify/notifications";
import type { TitleSession } from "../notify/title";
import { createGalleryStore } from "../store/gallery";
import { Gallery } from "./Gallery";
import { createDeployHealer } from "../deploy/healer";
import { createStatusStore, type ConnectionControl } from "../diagnostics/status-store";
import { buildProbes } from "../diagnostics/probes";
import { worst, type SseStatus, type TerminalReport } from "../diagnostics/status";
import { createDockStore } from "../store/dock";
import { createSidebarWidthStore } from "../store/sidebar-width";
import { createCoarsePointer, createMobileFlip, isMobileFlip } from "../mobile/pointer";
import { installSwipe } from "../mobile/swipe";
import { installViewportSync } from "../mobile/viewport";
import { installSoftKeysReserve } from "../mobile/softkeys-reserve";
import { installFocusReveal } from "../mobile/reveal";
import { Dock } from "./Dock";
import { SidebarGrip } from "./SidebarGrip";
import { track, tracker } from "../telemetry/track";
import { isCoarsePointer } from "../mobile/pointer";
import { actAsUrl, lensTarget } from "../lib/act-as";
import { ACT_AS } from "../lib/config";
import { availableCommands, getWorkspaces, listUsers, putWorkspaces } from "../lib/lobby-api";
import {
  effectiveCommand,
  NEW_SESSION_COMMANDS,
  type CommandAvailability,
} from "../lib/new-commands";

const SIDEBAR_KEY = "tmux-sidebar-collapsed";

function readInitialSelection(): SelectedSession | null {
  if (typeof window === "undefined") return null;
  try {
    const hash = window.location.hash.replace(/^#/, "");
    if (hash) {
      const at = hash.indexOf("@");
      if (at > 0) return { name: hash.slice(0, at), owner: hash.slice(at + 1) };
      if (NAME_RE.test(hash)) return { name: hash };
    }
    const q = new URLSearchParams(window.location.search).get("session");
    if (q && NAME_RE.test(q)) return { name: q };
  } catch {
    /* no URL */
  }
  return null;
}

function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * The base directory a session should be born in: the `dir` of the layout
 * project that owns it. /api/layout has carried a project dir all along and the
 * attach URL has an arg3 slot for it (terminal-url.ts) — the two were simply
 * never joined, so a session created inside a project started in $HOME. A
 * project with no dir, an ungrouped session, or an unknown name all yield
 * undefined and no arg3 is sent.
 */
export function projectDirFor(layout: Layout, session: string): string | undefined {
  const project = layout.projects.find((p) => p.sessions.includes(session));
  return project?.dir || undefined;
}

/**
 * The session mounts the shell renders, and the identity `<For>` keys them by.
 *
 * Two lists arrive here: the sessions `store/keepalive.ts` says to keep, and
 * the ONE `store/preload.ts` is holding for the pointer. They render from a
 * single `<For>` so that a preload PROMOTED by a click is the row it already
 * was — the same DOM node, the same TerminalNative, the same open socket, which
 * is the 627 ms the hover paid for in advance (ADR-0026).
 *
 * That only holds if the item `<For>` is keyed by does not change as a session
 * moves from one list to the other, and the two lists hand over different
 * objects for the same session. So this keeps one object per key and returns it
 * to both, and forgets it when the session leaves both — where a later hover on
 * the same name is a fresh mount, as it should be.
 *
 * Order is keepalive's, with the preload last: its list only ever grows at the
 * end, so nothing already mounted moves.
 */
type MountKey = {
  readonly key: string;
  readonly name: string;
  readonly owner?: string;
};

export function createMountList(): (
  kept: readonly KeptSession[],
  preloaded: MountKey | null,
) => KeptSession[] {
  const byKey = new Map<string, KeptSession>();
  return (kept, preloaded) => {
    const out: KeptSession[] = [];
    const live = new Set<string>();
    const take = (s: MountKey) => {
      if (live.has(s.key)) return; // kept AND preloaded is still one mount
      live.add(s.key);
      let slot = byKey.get(s.key);
      if (!slot) {
        slot = { key: s.key, name: s.name, owner: s.owner };
        byKey.set(s.key, slot);
      }
      out.push(slot);
    };
    for (const k of kept) take(k);
    if (preloaded) take(preloaded);
    for (const key of byKey.keys()) if (!live.has(key)) byKey.delete(key);
    return out;
  };
}

/**
 * How a mounted session that is not the one on screen is taken off it.
 *
 * THE TWO ANSWERS ARE NOT INTERCHANGEABLE, and which one a slot gets decides
 * what its terminal looks like in its first visible frame.
 *
 * `tl-hidden` is `display: none`, so the slot has no box at all. That is right
 * for a KEPT session: it was measured while it was on screen, xterm holds the
 * cell size and the grid it arrived at, and coming back changes neither.
 *
 * A PRELOAD has never been on screen, and `display: none` denies it the one
 * thing it needs. Measured on the deployed build on 2026-09-12: a preload
 * mounted hidden reported a 0 px char measurement, so xterm's DOM renderer set
 * its per-row `letter-spacing` to a whole cell and the click revealed one
 * frame of double-width, colourless text before a real measurement corrected
 * it — 90 to 200 ms of it, and 207 ms on the first open of a page load, where
 * the grid was xterm's constructed 80x24 as well. `tl-offstage` gives the slot
 * the pane's own box (app.css), so every one of those numbers is settled
 * before the click rather than after it.
 *
 * Nothing is hidden twice: a slot is the one on screen, or offstage, or
 * hidden.
 */
export function slotClasses(shown: boolean, preloading: boolean): Record<string, boolean> {
  return { "tl-hidden": !shown && !preloading, "tl-offstage": !shown && preloading };
}

/** The tiles of one Workspace, as the slot layer needs them: which workspace,
 *  and its members as the keepalive keys the mounted slots are keyed by. */
export interface WorkspaceTiles {
  id: string;
  keys: SessionKey[];
}

/** Everything the answer below depends on, so it can be decided without a DOM. */
export interface WorkspaceTilesInput {
  /** The server's membership document (ADR-0027's roaming half). */
  doc: Workspaces;
  /** The session the URL names, which is also the focused tile. */
  selected: SelectedSession | null;
  /**
   * The sessions that are alive, as keepalive KEYS, or null while the lobby has
   * not answered yet.
   *
   * Keys rather than names because a member carries an owner: a name is unique
   * only inside one user's tmux server, so `auth` of your own and emo's `auth`
   * are two terminals that may sit side by side as two tiles. Comparing names
   * would let either one answer for the other — the foreign tile would look
   * alive because you happen to have a session of the same name, and it would
   * keep its seat on a kill that never happened.
   */
  live: ReadonlySet<SessionKey> | null;
  /** One session at a time: a phone, by `FLIP_QUERY`. */
  solo: boolean;
}

/**
 * The Workspace the selected session sits in, or null when there is none to
 * draw — which is the ordinary lobby, one session on screen.
 *
 * Four ways to get null, and each is a real state rather than a guard:
 *
 *   - A PHONE. A coarse pointer at 720px or narrower sees no workspaces at all
 *     (ADR-0027): a tree of four columns describes a 32-inch monitor and is
 *     unrenderable here, so tapping a member opens that session alone, exactly
 *     as it does today. This is the `solo` flag, and it is deliberately the
 *     first thing read.
 *   - NOTHING SELECTED. The composer is on screen and there is no session to
 *     find a workspace for.
 *   - NO WORKSPACE HOLDS IT. Clicking a non-member leaves the workspace you
 *     were in, and this is how leaving happens: the selection moves, no
 *     workspace claims it, and one session is on screen again.
 *   - TOO FEW LIVE MEMBERS. A KILL KEEPS MEMBERSHIP, so a member may name a
 *     session that no longer exists and the frontend renders live sessions
 *     only. A workspace whose survivors are down to one is not a workspace
 *     (`MIN_WORKSPACE_MEMBERS`); that last session shows on its own, and
 *     restoring the others brings the tiles back because the server still
 *     lists them.
 *
 * SOMEBODY ELSE'S SESSION IS NOT ONE OF THEM, and that is the change ADR-0027
 * asks for rather than an omission: a member carries `{name, owner?}`
 * (types/lobby.ts, `WorkspaceMember`), so a session emo shared with you can sit
 * beside two of your own. Every comparison here is therefore against the
 * keepalive KEY, never the bare name — your `auth` and emo's `auth` are two
 * terminals, and a name-only lookup would hand one of them the other's tile.
 *
 * `live` is null before the first poll has ANSWERED, and that is not the same
 * as an empty set: until then every member looks dead, and filtering against
 * that would collapse every workspace on every page load for as long as the
 * first request takes.
 */
export function workspaceTilesFor(input: WorkspaceTilesInput): WorkspaceTiles | null {
  const { doc, selected, live, solo } = input;
  if (solo || !selected) return null;
  const want = keyOf(selected);
  const ws = doc.workspaces.find((w) => w.members.some((m) => keyOf(m) === want));
  if (!ws) return null;
  const keys = (live ? ws.members.filter((m) => live.has(keyOf(m))) : ws.members).map(keyOf);
  if (keys.length < MIN_WORKSPACE_MEMBERS) return null;
  if (!keys.includes(want)) return null;
  return { id: ws.id, keys };
}

/**
 * Which mounted sessions are on screen: the whole visible set, replacing the
 * single `k.key === selectedKey()` the shell asked before tiles existed.
 *
 * The tiles win when there are any, because a Workspace on screen IS the
 * answer to what is visible, focused tile included. With no tiles the selected
 * session is alone on screen, which is the lobby as it has always worked and
 * what a phone always gets. Nothing selected is the composer, and no session is
 * visible behind it.
 *
 * Every mounted slot asks this, so it is a set rather than a list: a tab can
 * hold a day's worth of mounts (store/keepalive.ts) and the answer is read once
 * per slot per change.
 */
export function visibleSet(
  tiles: readonly SessionKey[],
  selected: SessionKey | null,
): ReadonlySet<SessionKey> {
  if (tiles.length > 0) return new Set(tiles);
  return new Set(selected ? [selected] : []);
}

/** Everything a membership write decides from, so the two rules that make it
 *  interesting — exclusivity, and a kill keeping its seat — can be checked
 *  without a server, a DOM or a tree. */
export interface MembershipWrite {
  /** The document as it is now. */
  doc: Workspaces;
  /** The workspace being written. Absent from `doc` means it is being created,
   *  which is what the first split does. */
  id: string;
  /** The tiles this device now shows, in the tree's reading order, as the
   *  `{name, owner?}` the document stores. Fewer than `MIN_WORKSPACE_MEMBERS`
   *  of them ends the workspace. */
  tiles: readonly WorkspaceMember[];
  /** The sessions that are alive, as keepalive KEYS, or null before the first
   *  poll has answered. Keys rather than names for the reason
   *  {@link WorkspaceTilesInput.live} gives: one name under two owners is two
   *  terminals, and a kill of either must not take the other's seat. */
  live: ReadonlySet<SessionKey> | null;
}

/**
 * One workspace's new membership, folded into the document as it is NOW.
 *
 * An INVERSE-SHAPED write rather than a captured document, for the reason
 * `store/undo.layout.ts` opens with: `PUT /api/workspaces` replaces the whole
 * document and carries no version, so anything that re-sent a document captured
 * earlier would erase a workspace made on another device in between. This takes
 * the live document and changes one group in it.
 *
 * THREE RULES, and each of them is a promise made somewhere else:
 *
 *   - **A KILL KEEPS MEMBERSHIP.** A member the tree does not show is kept when
 *     it is not among the live sessions, so a killed session's seat survives and
 *     restoring it puts its tile back — the same thing `assignments/<user>.json`
 *     already does for project placement (ADR-0027). Only a deliberate close or
 *     a drag-out takes a seat away, and both act on a session that is alive.
 *   - **A SESSION BELONGS TO AT MOST ONE WORKSPACE.** Every tile this write
 *     claims leaves whichever group held it, in the same document, because
 *     tmux-api refuses one where two workspaces name the same session and
 *     there is no intermediate state to send.
 *   - **ONE TILE IS NOT A WORKSPACE.** A group left below two members is
 *     dropped rather than written, on either side of the move — the server
 *     rejects such a document on write and drops the entry on read.
 *
 * Order is preserved on both axes. The groups keep their places in the document
 * and a group's surviving members keep theirs, because that order is what a
 * device which has never seen this workspace auto-arranges from: a fresh laptop
 * and a fresh phone lay the same workspace out the same way, and a write that
 * shuffled it would move tiles on a screen nobody was touching.
 */
export function writeMembership({ doc, id, tiles, live }: MembershipWrite): Workspaces {
  // Every comparison below is on the keepalive KEY rather than on the member
  // object, because two members naming the same session are two distinct object
  // identities and a `Set<WorkspaceMember>` would hold both. The key is also
  // what makes one NAME under two owners two seats: yours and emo's `auth` are
  // two terminals, and either may be a tile without disturbing the other.
  const wanted: WorkspaceMember[] = [];
  const claimed = new Set<SessionKey>();
  for (const tile of tiles) {
    const key = keyOf(tile);
    if (claimed.has(key)) continue;
    claimed.add(key);
    wanted.push(tile);
  }
  const ending = wanted.length < MIN_WORKSPACE_MEMBERS;
  const held = doc.workspaces.find((w) => w.id === id)?.members ?? [];

  const members: WorkspaceMember[] = [];
  const seen = new Set<SessionKey>();
  if (!ending) {
    for (const member of held) {
      const key = keyOf(member);
      if (seen.has(key)) continue;
      // Known dead keeps its seat; anything else the tree no longer shows is
      // this write taking it out. `live` is null only before the first poll has
      // answered, and nothing can be closed or dragged out before there are
      // tiles to close, which needs an answered poll.
      if (!claimed.has(key) && !(live !== null && !live.has(key))) continue;
      seen.add(key);
      members.push(member);
    }
    for (const member of wanted) {
      const key = keyOf(member);
      if (seen.has(key)) continue;
      seen.add(key);
      members.push(member);
    }
  }

  const out: Workspace[] = [];
  let written = false;
  for (const w of doc.workspaces) {
    if (w.id === id) {
      if (!ending) {
        out.push({ id, members });
        written = true;
      }
      continue;
    }
    const kept = w.members.filter((m) => !claimed.has(keyOf(m)));
    if (kept.length >= MIN_WORKSPACE_MEMBERS) out.push({ id: w.id, members: kept });
  }
  if (!ending && !written) out.push({ id, members });
  return { version: doc.version, workspaces: out };
}

/**
 * The same groups, holding the same members in the same order.
 *
 * What a divider drag leaves behind: the arrangement moved and the membership
 * did not, so there is nothing for tmux-api to hear about. `PUT /api/workspaces`
 * is a whole-document write, and sending one per settle of a drag would be a
 * request a second saying the same thing.
 */
export function sameMembership(a: Workspaces, b: Workspaces): boolean {
  if (a.workspaces.length !== b.workspaces.length) return false;
  return a.workspaces.every((w, i) => {
    const other = b.workspaces[i];
    if (!other || other.id !== w.id || other.members.length !== w.members.length) return false;
    // By key, not by object identity: `writeMembership` rebuilds the array and
    // may carry the very same member objects through, but a document that came
    // back off the wire never does, and two `{name: "auth"}` are the same seat.
    return w.members.every((member, j) => {
      const mate = other.members[j];
      return mate !== undefined && keyOf(member) === keyOf(mate);
    });
  });
}

/**
 * The tile focus moves to when the one it was on has gone: the nearest surviving
 * neighbour in reading order, looking right first.
 *
 * A SELECTION NAMING A SESSION WITH NO TILE IS THE FAILURE THIS AVOIDS. The
 * visible set resolves against the selected key, so a selection left on a closed
 * tile shows a blank pane — which reads as a terminal fault rather than as the
 * bookkeeping one it is. The design says the same thing as an ordering rule:
 * focus moves before or atomically with the tree write, never after.
 *
 * Right before left because a row reads that way and closing the last tile in
 * one then lands on its left-hand neighbour, which is the only tile left to land
 * on. Null when nothing survives, which the caller reads as "leave the selection
 * alone" — the defensive arm for a close that emptied the workspace, unreachable
 * through the close control since a workspace of one has no tiles to close.
 */
export function nearestSurvivor(
  was: readonly SessionKey[],
  at: number,
  alive: ReadonlySet<SessionKey>,
): SessionKey | null {
  if (at < 0) return null;
  for (let step = 1; step <= was.length; step++) {
    for (const i of [at + step, at - step]) {
      const key = was[i];
      if (key !== undefined && alive.has(key)) return key;
    }
  }
  return null;
}

/** Same workspace, same members, same order. Keeps a tree from being rebuilt
 *  on every session poll, which re-emits rects and moves nothing. */
function sameTiles(a: WorkspaceTiles | null, b: WorkspaceTiles | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.id !== b.id || a.keys.length !== b.keys.length) return false;
  return a.keys.every((key, i) => key === b.keys[i]);
}

/**
 * This device's arrangement of a workspace whose members have MOVED: the stored
 * tree with the departed tiles closed and the arrivals added.
 *
 * A REBUILD IS NOT THE ANSWER TO A MEMBER LEAVING. The design says a dead
 * member's "tile closes and its siblings reflow", which is exactly `removeAt` —
 * the siblings share the space out in proportion to what they already had and
 * any nesting the close made pointless goes with it. Re-deriving through
 * `autoArrange` instead throws the whole arrangement away: a hand-dragged 2x2
 * with three dividers moved comes back as an even grid because one member of it
 * was killed, and the next divider drag persists that even grid, so restoring
 * the session does not bring the arrangement back either.
 *
 * A MEMBER ARRIVING SPLITS THE LAST TILE, bottom edge. Another device put it in
 * the workspace and this one has never seen it, so there is no stored place for
 * it; taking half of the last tile in reading order is where `autoArrange`
 * would have grown next anyway (its columns fill in order), and the BOTTOM edge
 * rather than a side because a terminal's WIDTH is what re-wraps its output —
 * halving a tile's height leaves every session in the workspace at the column
 * count it already had.
 *
 * `autoArrange` is still the answer when there is nothing to reconcile
 * against: no stored tree at all (a device that has never seen this workspace),
 * or one whose every tile has gone. Both are a fresh arrangement rather than a
 * changed one, and both are deterministic in the server's member order, which
 * is what makes a fresh laptop and a fresh phone lay one workspace out alike.
 *
 * Returns the stored tree BY REFERENCE when the members already match, which is
 * every poll: a new object would re-emit rects and move nothing.
 */
export function reconcileTree(
  stored: TreeNode | null,
  keys: readonly SessionKey[],
): TreeNode | null {
  if (!stored) return autoArrange(keys);
  const wanted = new Set(keys);
  let tree: TreeNode | null = stored;
  for (const key of leafKeys(stored)) {
    if (wanted.has(key)) continue;
    tree = removeAt(tree, key);
    if (!tree) break; // the last tile it held has gone
  }
  if (!tree) return autoArrange(keys);
  const held = new Set(leafKeys(tree));
  for (const key of keys) {
    if (held.has(key)) continue;
    const leaves = leafKeys(tree);
    const last = leaves[leaves.length - 1];
    tree = last === undefined ? leaf(key) : splitAt(tree, last, "bottom", key);
    held.add(key);
  }
  return tree;
}

/**
 * How far a press on a tile header travels before it is a drag.
 *
 * A tile header is both a label and the handle the tile is dragged by, so the
 * press that focuses a tile and the press that lifts it are the same press until
 * the pointer moves. 4px is the slack a hand resting on a button has; below it
 * the gesture stays a click, which is what focuses the tile it landed on.
 */
export const TILE_DRAG_SLOP_PX = 4;

/**
 * Watch a press on a tile header, and call `start` once it has become a drag.
 *
 * Written as a one-shot on the document rather than as handlers on the header,
 * because the pointer leaves the 24px strip within a few pixels of moving and a
 * `pointermove` bound to the header would stop arriving exactly when the gesture
 * becomes interesting. `setPointerCapture` would keep them coming and would also
 * take the pointer away from `dnd/tiles.ts`, which tracks the rest of the drag
 * on the document itself.
 *
 * Everything it installed comes down on the first of: the threshold being
 * crossed, the pointer lifting, or the platform taking the gesture away.
 */
export function watchTileDrag(event: PointerEvent, start: () => void): void {
  const from = { x: event.clientX, y: event.clientY };
  const done = new AbortController();
  const { signal } = done;
  document.addEventListener(
    "pointermove",
    (e: PointerEvent) => {
      const moved = Math.abs(e.clientX - from.x) + Math.abs(e.clientY - from.y);
      if (moved < TILE_DRAG_SLOP_PX) return;
      done.abort();
      start();
    },
    { signal },
  );
  document.addEventListener("pointerup", () => done.abort(), { signal });
  document.addEventListener("pointercancel", () => done.abort(), { signal });
}

/** A tile's rect as four inline pixel values. `.tl-tiled` (app.css) carries
 *  everything about a positioned slot that is not one of these numbers. */
function tileStyle(rect: Rect | undefined): JSX.CSSProperties | undefined {
  if (!rect) return undefined;
  return {
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  };
}

/**
 * The lobby shell: a sidebar of sessions/projects beside the selected session's
 * two-view surface. The lobby store owns the session list, layout, and all
 * mutations (tmux-api); selecting a card mounts a SessionView for it (remounted
 * per session so its SSE stream is scoped correctly). Store errors surface as
 * toasts; roamed prefs (prefsStore) + the theme picker live in the Settings
 * panel opened from the shell bar.
 */
export const App: Component = () => {
  const notify = (message: string, kind: NotifyKind) => toasts.push({ kind, message });

  // Ahead of the lobby store, which reads the roamed session ordering out of it.
  const prefs = createPrefsStore();

  // Connection status (ADR-0016). Created before its providers so each can push
  // into it as it comes up; every channel starts `unknown`, which paints
  // nothing and claims nothing.
  const status = createStatusStore();

  // Whether the Ctrl+J dock can render here. The dock store answers the same
  // question from its own `allowed`, but it is built at :372 out of `store`, so
  // it cannot be handed to `store`'s own constructor. Both read one media query
  // through `watchQuery`, so the two accessors are views of a single browser
  // fact rather than two mechanisms that could drift; the drift this design
  // avoids is a CSS rule answering it alongside the JS, which is why the
  // `@media (pointer: coarse)` display:none came out.
  const dockCoarse = createCoarsePointer();

  /**
   * This tab's undo stack — the ONE instance, which is why it is built here and
   * not exported as a module singleton (store/undo.ts says so at length):
   * whether undo runs at all is a property of the PAGE, and only the shell
   * knows that.
   *
   * OFF IN A LENS TAB. `?as=bob` is a navigation in the same tab
   * (lib/act-as.ts), so the sessionStorage a lens page opens onto was written
   * by the previous identity in that tab. Reading it would offer to undo your
   * own actions against bob's account; writing it would hand your next page
   * life bob's history. A disabled store does neither and leaves the stored
   * document untouched. `ACT_AS` rather than the server-confirmed `lensTarget`
   * because the stack is built before /whoami answers and `enabled` is fixed
   * for the page life; acting as yourself therefore loses undo too, which is
   * the harmless side of that call.
   *
   * Handed to the lobby store, which registers every handler that knows how to
   * invert one of its actions and hands the instance back out as `store.undo`
   * for the dimmed card's arrow (SessionCard.tsx) and the two commands.
   */
  const undoStack = createUndoStore({ enabled: ACT_AS === "" });

  const store = createLobbyStore({
    initialSelected: readInitialSelection(),
    notify,
    undo: undoStack,
    // A phone renders no dock, so it must not hide the docked shell from the
    // list: `layout.dock` roams, and hiding a card that has no panel to hide
    // behind leaves the session running and unreachable.
    dockAllowed: () => !dockCoarse(),
    // Opening a session on a phone IS the navigation: show the terminal. Fires
    // even when the same session is re-tapped, which is how you get back to a
    // terminal you left to browse the list.
    //
    // And the session that was asked for takes the keyboard, because the click
    // that asked for it has just given it to the sidebar card. A selection that
    // MOVES is the terminal's own to answer (TerminalNative focuses itself when
    // it comes on screen), so what this adds is the re-pick of the session
    // already showing, where nothing moves at all. The mounted SessionView
    // decides what that means for the view it is showing: a text view's
    // composer keeps the keyboard, and a terminal still mounting focuses itself
    // when it boots.
    onActivate: () => {
      if (isMobileFlip()) setCollapsed(true);
      window.__tlFocusSession?.();
    },
    // Manual / created / last-active, roamed. The store owns the sort so the
    // cards, the Alt+1..0 chips and a drop's anchor all read one order; a drag
    // that names a position writes the visible order into the layout and hands
    // the list back to manual.
    sessionOrder: () => prefs.prefs().sidebar.order,
    setSessionOrder: (order) => prefs.setPref({ sidebar: { order } }),
  });
  onCleanup(() => store.dispose());

  // The skill manager's store (ADR-0011). Created here so it survives the panel
  // being closed and reopened, but it fetches nothing until the group renders.
  const skills = createSkillsStore();
  // What the Skills group needs to say which sessions still run an older skill
  // set: the live list, name and Claude state only.
  const skillSessions = createMemo(() =>
    store.sessions.map((s) => ({ name: s.name, state: s.state || "" })),
  );
  // What the Agent spend page needs to name a row: a session's title, keyed by
  // the name the spend store recorded it under. A name is an id and nobody
  // reads one (ADR-0019), so a row falls back to it only when there is nothing
  // better to show.
  const sessionTitles = createMemo(() =>
    store.sessions.map((s) => ({ name: s.name, title: s.title || "" })),
  );
  // One event per tab boot: the denominator every other count is read against.
  onMount(() => track("app.loaded", { "tl.kind": isCoarsePointer() ? "touch" : "desktop" }));
  onCleanup(() => {
    tracker.flushSync();
    tracker.dispose();
  });
  onMount(() => void prefs.bootSync());
  onCleanup(() => prefs.dispose());

  // Which network this device is on, which is what lets Data used separate a
  // month's cellular from its WiFi. Started at the shell so the answer is in
  // place before the first 60s window closes, and re-asked when the device
  // comes back online or the tab returns from a pocket.
  onMount(() => onCleanup(startNetworkWatch()));

  // ---- soft-keyboard plumbing (shell-wide) --------------------------------
  // Publishes --kb-offset / --sk-h / --app-vh, and re-reveals whatever field
  // has focus once the keyboard settles.
  //
  // At the SHELL, not per session. Two reasons, and the second is a bug this
  // fixes: SessionView mounts once per session kept in the tab, so the sync ran
  // as many times as there were open sessions; and it did not run at all until
  // a session was opened, which left the LIST screen with no live --kb-offset —
  // so the sidebar had no way to know a keyboard was covering its bottom third,
  // and a project's "new session" box opened underneath one.
  //
  // The terminal callbacks are global bridges TerminalNative owns while it is
  // mounted, so they no-op cleanly on the list screen.
  onMount(() => {
    const stopViewport = installViewportSync({
      onRefit: () => window.__tlRefitTerminal?.(),
      // The terminal reserves the keyboard's space on its own host element
      // rather than letting the container shrink — see .tl-kb-inline in
      // app.css and terminal/viewport.ts. Shrinking the container pulled the
      // terminal out from under the tap that had just opened the keyboard.
      onKeyboard: (px) => window.__tlKeyboardOffset?.(px),
    });
    const stopReveal = installFocusReveal();
    onCleanup(() => {
      stopViewport();
      stopReveal();
    });
  });

  // The soft-key height reservation, installed once for the app — see the
  // module for why it cannot live in SessionView.
  installSoftKeysReserve(createCoarsePointer());

  // ---- PWA notifications (pillar #2 — inventory Cat.9) ---------------------
  // A plain snapshot of the poll list feeds the tab title/favicon badge + the
  // foreground transition notifications. The system owns the header bell, web
  // push, and the attention latch the terminal feeds (terminal/attention.ts).
  const sessionSnapshot = createMemo<TitleSession[]>(() =>
    store.sessions.map((s) => ({
      name: s.name,
      // tmux's session id, so the visit store survives a rename made anywhere.
      id: s.id,
      // The tab title and the OS notification body speak in titles like every
      // other surface; the name still identifies the session underneath.
      title: s.title,
      state: s.state,
      pane_current_command: s.pane_current_command,
      // Only set for a session shared with you. The badge leaves those out.
      owner: s.owner,
    })),
  );
  const notifications = createNotificationSystem({
    sessions: sessionSnapshot,
    selected: () => store.selected()?.name ?? null,
    /**
     * EVERY VISIBLE TILE COUNTS AS OPEN (design, "Everything else, and what
     * changes"), so the unseen mark, the app-icon badge and the foreground
     * banner all follow the whole visible set rather than the focused tile.
     *
     * Without this a two-tile workspace with `auth` focused stamped `auth`
     * alone: `deploy` kept its unseen mark and raised the icon badge for a
     * session on screen in front of the reader, and a banner fired for output
     * they were watching arrive.
     *
     * BY NAME, because that is the vocabulary the whole notify layer speaks —
     * the poll list, the push sender and the tab title are all names. The
     * visible set is keyed by keepalive KEY, so `sessionOf` takes each one
     * apart; a foreign session shares a namespace with your own here, which is
     * a limitation this layer has everywhere rather than one introduced by
     * tiles.
     *
     * Declared below `visibleKeys` in source order but read lazily, so the
     * accessor is only called once the memo exists.
     */
    visible: () => [...visibleKeys()].map((key) => sessionOf(key).name),
    osUser: store.me,
    notifyPrefs: () => prefs.prefs().notify,
    loading: store.loading,
    polls: store.polls,
    toast: notify,
    onActivateSession: (name) => store.select(name),
  });
  onCleanup(() => notifications.dispose());

  // ---- connection status providers (ADR-0016) -----------------------------
  // Each of these already knew its own health and had nowhere to say it. The
  // effects read signals the providers were already writing, so nothing new is
  // polled and no channel is asked a question it was not already answering.
  //
  // The session list is the odd one: it is request/response, not a connection,
  // so its channel is fed by the poll's own bookkeeping rather than by an
  // open/closed edge. The effect re-runs whenever a poll returns or fails,
  // which is also the fastest anything could honestly change.
  createEffect(() => status.setSessions(store.pollHealth()));
  createEffect(() =>
    status.setNotifications({
      permission: notifications.permission(),
      // "checking" is the boot state, and it is exactly `unknown`: nothing is
      // known yet, and claiming either answer would be a guess.
      device:
        notifications.deviceState() === "checking"
          ? "unsupported"
          : (notifications.deviceState() as Exclude<
              ReturnType<typeof notifications.deviceState>,
              "checking"
            >),
      // Only Run check asks the server; the passive readout does not, because
      // it would mean a request per repaint for an answer that changes rarely.
      server: "unknown",
    }),
  );
  /**
   * THE CONNECTION CHANNELS ARE PER SLOT, AND THE SHELL READS THE FOCUSED ONE.
   *
   * There is one Right now panel, one connection badge and one Reconnect
   * button for the whole tab, and until 2026-09-12 each of these was a plain
   * module-scope `let` that every mounted view overwrote — so the last mount to
   * register won. With one session on screen that was invisible; with four
   * visible tiles it means Run check interrogates whichever tile finished
   * mounting last and Reconnect drops ITS ttyd socket, while the badge shows
   * whichever of four unrelated sessions reported most recently.
   *
   * A `focused()` GUARD ON THE WRITE WOULD NOT FIX IT, which is why these are
   * maps rather than guarded assignments. `SessionView` publishes on a change
   * of VISIBILITY, not of focus (its `status` effect reads `onScreen()`), so
   * moving focus between two tiles that are both already on screen publishes
   * nothing — and a guarded `let` would sit on the previous tile's report until
   * the newly focused socket happened to change state. Keyed by slot, the
   * answer moves with the focus the instant it moves, out of reports both tiles
   * have already made.
   *
   * A preload needs no guard here either. It is never the focused key — the
   * preload store refuses to hold the selected session (store/preload.ts) — so
   * its entries are inert until a click promotes it, which is the moment they
   * become the right ones to read.
   */
  const [terminalConn, setTerminalConn] = createSignal<
    ReadonlyMap<SessionKey, TerminalReport | null>
  >(new Map());
  const [transcriptConn, setTranscriptConn] = createSignal<
    ReadonlyMap<SessionKey, SseStatus | null>
  >(new Map());
  /** Ask a slot's terminal to re-report its socket, by slot. */
  const askConn = new Map<SessionKey, () => void>();
  /** Retry a slot's terminal socket. Only ever called from Reconnect. */
  const retryConn = new Map<SessionKey, () => void>();
  /** Waiting for the terminal's answer to one `ask`. */
  let awaitingConn: ((r: TerminalReport | null) => void) | null = null;

  /** One slot's terminal reported. `untrack` because this is called from
   *  SessionView's own effect, which must not subscribe to the selection. */
  const onTerminalConn = (key: SessionKey, report: TerminalReport | null): void => {
    setTerminalConn((held) => new Map(held).set(key, report));
    if (key !== untrack(selectedKey)) return;
    const waiting = awaitingConn;
    awaitingConn = null;
    waiting?.(report);
  };

  /** Forget a slot that has gone, so a stale report cannot be read back if the
   *  same session is opened again before a new mount has said anything. */
  const forgetConn = (key: SessionKey): void => {
    askConn.delete(key);
    retryConn.delete(key);
    setTerminalConn((held) => {
      const next = new Map(held);
      next.delete(key);
      return next;
    });
    setTranscriptConn((held) => {
      const next = new Map(held);
      next.delete(key);
      return next;
    });
  };

  const askTerminalConn = (): void => {
    const key = untrack(selectedKey);
    if (key !== null) askConn.get(key)?.();
  };
  const retryTerminalConn = (): void => {
    const key = untrack(selectedKey);
    if (key !== null) retryConn.get(key)?.();
  };

  /**
   * What the Right now panel is handed. The repairs are here rather than in the
   * panel because this is where the things being repaired live — and each is a
   * separate tap, never something the check does on its own.
   */
  const connControl: ConnectionControl = {
    channels: status.channels,
    log: status.log,
    lastCheck: status.lastCheck,
    checkedAt: status.checkedAt,
    checking: status.checking,
    bootedAt: status.bootedAt,
    // The machine's own figures and its hour of history. They ride here rather
    // than as props on the panel so that every row's facts arrive by the same
    // route: a reader who finds the machine row reads it the way they read the
    // other five. `watchMachine` is the panel-open fast poll, which returns its
    // own teardown — the panel owns its lifetime, because "faster while the
    // panel is open" has to stop being true when it closes.
    machine: status.machine,
    machineSeries: status.machineSeries,
    watchMachine: status.watchMachine,
    worstNow: () => worst(status.channels()),
    runCheck: async () => {
      await status.check(
        buildProbes({
          askTerminal: (signal) =>
            new Promise<TerminalReport | null>((resolve) => {
              // The check's own 5s cap is what ends this if no terminal ever
              // answers; aborting resolves early so nothing is left waiting.
              signal.addEventListener("abort", () => {
                awaitingConn = null;
                resolve(null);
              });
              awaitingConn = resolve;
              askTerminalConn();
            }),
          transcriptStatus: () => sessionStatus(),
          sessionsReport: () => store.pollHealth(),
          updateReady: () => status.channels().find((c) => c.id === "build")?.state === "degraded",
        }),
      );
    },
    repairLabel: (id) => {
      const c = status.channels().find((x) => x.id === id);
      if (!c || c.state === "working") return null;
      // Notifications are the one row whose `unknown` is still actionable: not
      // set up is not a fault (so it never colours the badge), but it is exactly
      // the state a Turn on button exists for. A browser-level refusal is the
      // exception — script cannot undo it, so offering a button would be a lie
      // and the row says "blocked by the browser" instead.
      if (id === "notifications") {
        return notifications.permission() === "denied" ? null : "Turn on";
      }
      if (c.state === "unknown") return null;
      if (id === "terminal") return "Reconnect";
      if (id === "sessions") return "Refresh";
      if (id === "build") return "Reload";
      // The transcript stream's own ladder is always running when it is not
      // open, so there is nothing here a person could usefully press.
      return null;
    },
    repair: async (id) => {
      if (id === "terminal") retryTerminalConn();
      else if (id === "sessions") await store.refresh();
      else if (id === "build") window.location.reload();
      else if (id === "notifications") await notifications.toggleBell();
    },
  };

  // ---- session image gallery (pillar #2 — inventory Cat.8) ----------------
  // The gallery is per-session but lives at the shell level so gallery.open
  // (palette action / 🖼 button / forwarded chord) opens it over any view. It
  // fetches the SELECTED session's images on open; switching sessions closes it.
  const gallery = createGalleryStore({
    session: () => store.selected()?.name ?? null,
    notify,
  });

  // ---- deploy self-heal (pillar #3 — inventory Cat.10) --------------------
  // The lobby is the ONLY deploy channel (no server build header): it polls its
  // own served bytes on a timer + on resume/bfcache, and on a real change owns
  // the SINGLE reload. A terminal is "attached" when a session is selected (a
  // SessionView is mounted) — the v2 analog of the vanilla `currentActive`;
  // that gates the immediate-vs-deferred reload policy. ONE document, ONE
  // stamp: the terminal used to hand its own build-stale verdict up here, and
  // there is no second document left to have one.
  const healer = createDeployHealer({
    hasAttachedTerminal: () => store.selected() !== null,
    onUpdatePending: (pending) => status.setBuild({ updateReady: pending }),
  });
  onCleanup(() => healer.dispose());

  // ---- Ctrl/Cmd+J scratch shell (the vanilla dock) ------------------------
  // A second live terminal under the session you are in, roamed as layout.dock,
  // rendered as a bottom panel by <Dock/> at the foot of .tl-shell-body.
  // Desktop only: a coarse pointer has room for one terminal, the same line the
  // vanilla page draws. `dock.allowed()` is that one reading (store/dock.ts) and
  // the mount reads it too, so the chord and the panel cannot disagree about
  // which devices have a dock.
  const dock = createDockStore({ store });
  const onDockKey = (e: KeyboardEvent): void => {
    if (!((e.metaKey || e.ctrlKey) && (e.key === "j" || e.key === "J"))) return;
    // `toggle` refuses on its own, but the chord must stay UNCLAIMED here: a
    // tablet with a keyboard is a coarse pointer that can still press Ctrl+J,
    // and preventDefault would swallow the 0x0A the pty is owed.
    if (!dock.allowed()) return;
    e.preventDefault();
    void dock.toggle();
  };
  onMount(() => window.addEventListener("keydown", onDockKey, true));
  onCleanup(() => window.removeEventListener("keydown", onDockKey, true));

  // ---- phone layout: one view at a time -----------------------------------
  // `collapsed` is re-read under the phone query as a VIEW, not a width:
  // false = BROWSING (the session list owns the screen), true = TERMINAL.
  const flip = createMobileFlip();
  // Boot: a phone opens on the content pane either way — the terminal when the
  // URL names a session, the new-session composer when it does not, so a fresh
  // phone opens ready to type rather than on a list of what already exists. The
  // list is one control away in the composer's header. The persisted desktop
  // collapse is deliberately ignored here: it is a width preference for a
  // device with room for both.
  const [collapsed, setCollapsed] = createSignal(
    opensOnContent({
      flip: isMobileFlip(),
      hasSelection: !!readInitialSelection(),
      savedCollapse: readSidebarCollapsed(),
    }),
  );
  /** Is a session bar — and so its connection badge — on screen? The sidebar's
   *  own badge reads this and stands down (rule + tests in lobby.logic.ts). */
  const barOnScreen = () =>
    sessionBarOnScreen({
      selected: store.selected() !== null,
      flip: flip(),
      collapsed: collapsed(),
    });

  const toggleSidebar = () => {
    const next = !collapsed();
    track("sidebar.toggled", { "tl.to": next ? "collapsed" : "expanded" });
    setCollapsed(next);
    // On a phone this is a VIEW, not a width preference — persisting it would
    // decide which screen the app opens on next time.
    if (flip()) return;
    try {
      localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
    } catch {
      /* no storage */
    }
  };

  // How WIDE that sidebar is, when it is showing. Published to CSS below as
  // `--tl-sidebar-w` and dragged by <SidebarGrip/>; per-browser, because a
  // width in pixels is an answer about a screen (store/sidebar-width.ts).
  const sidebarWidth = createSidebarWidthStore();

  const [settingsOpen, setSettingsOpen] = createSignal(false);
  // Skills is a page on the Settings rail, so both header buttons open the same
  // overlay. This is the page SHOWING — seeded by whoever opened it, then kept
  // honest by the panel's onPageChange, because the rail moves it afterwards
  // and a copy that ignored that would make the buttons lie.
  const [settingsPage, setSettingsPage] = createSignal<PageId | undefined>(undefined);
  /**
   * Open the panel, or act on it when it is already open. What a press means
   * with two buttons over one dialog is decided in rail.ts, where it is
   * testable; this wires the verdict up.
   */
  const openSettings = (page?: PageId): void => {
    const act = openerAction({
      isOpen: settingsOpen(),
      showing: settingsPage(),
      pressed: page,
    });
    if (act.kind === "close") {
      setSettingsOpen(false);
      return;
    }
    if (act.kind === "goto") {
      setSettingsPage(act.page);
      return;
    }
    // Skills has always been its own thing to reach for; counting it as a
    // Settings visit would overstate how often people open Settings.
    if (act.page !== "skills") track("settings.opened");
    setSettingsPage(act.page);
    setSettingsOpen(true);
  };
  const skillsOpen = () => settingsOpen() && settingsPage() === "skills";

  // --- act as another user (admin only) -------------------------------------
  //
  // actingAs comes from the SERVER's /whoami (realUser present ⇒ switched), not
  // from ACT_AS: the URL is only the ask, and a tab whose ?as= the server
  // refused must not paint itself as somebody else. ACT_AS is used solely to
  // pre-select the dropdown before whoami lands.
  const actingAs = createMemo(() => {
    const w = store.whoami();
    return w?.realUser ? w.osUser : "";
  });
  // canActAs, not admin alone: a single-user box has one account, so there is
  // nobody to act as even for someone the server calls an administrator.
  const isAdmin = createMemo(() => canActAs(store.whoami()));
  // Whose account this tab is a lens on ("" = an ordinary tab). It decides that
  // a session here opens WATCHING, and which namespace a take-control choice is
  // remembered under (lib/act-as.ts). Same derivation the sidebar's cards make
  // from the same /whoami, so the two surfaces cannot disagree.
  const lens = createMemo(() => lensTarget(store.whoami(), ACT_AS));
  const [actAsUsers, setActAsUsers] = createSignal<string[]>([]);
  createEffect(() => {
    if (!isAdmin() || actAsUsers().length > 0) return;
    const real = store.whoami()?.realUser ?? store.whoami()?.osUser ?? "";
    void listUsers().then((us) => setActAsUsers(us.filter((u) => u !== real)));
  });
  const switchToUser = (osUser: string): void => {
    if (osUser === actingAs()) return;
    track(osUser ? "admin.actas" : "admin.actas.exit", { "tl.to": osUser });
    window.location.href = actAsUrl(window.location.href, osUser);
  };
  const actAsControl = createMemo(() =>
    isAdmin() ? { users: actAsUsers, current: actingAs, switchTo: switchToUser } : undefined,
  );

  const selectedName = createMemo(() => store.selected()?.name ?? null);
  // Nothing selected — killed, the last session closed, or "new session" asked
  // for — shows the composer rather than an empty pane, on every device. The
  // phone used to be walked back to the list here, because the alternative was
  // a blank terminal whose only exit was the back control; the composer is a
  // screen with somewhere to go, and its header carries the route to the list.
  /**
   * Which project the composer creates into.
   *
   * The roamed `session.newProject` preference by default, so the next session
   * lands where the last one did. The `+` on a sidebar group overrides it for
   * one create by setting the preset; picking from the composer's own selector
   * writes the preference, because that is a deliberate choice about where work
   * goes rather than a shortcut for one session.
   *
   * A remembered project that no longer exists resolves to Ungrouped, and the
   * preference is left alone — recreating the project brings the choice back.
   */
  const [presetProject, setPresetProject] = createSignal<string | null>(null);
  const composerProject = createMemo(() => {
    const want = presetProject() ?? prefs.prefs().session.newProject;
    return want && store.layout().projects.some((p) => p.name === want) ? want : "";
  });
  /**
   * Show the composer, optionally preset to a project.
   *
   * Nothing selected IS the composer, so every route here deselects first. The
   * session that was open stays mounted and hidden (store/keepalive.ts), so
   * going back to it costs nothing.
   */
  const openComposer = (group?: string): void => {
    // A `+` on a group means THAT project; the plain route means the default,
    // so it clears the override rather than inheriting whichever group was
    // last opened from. Picking in the composer's own selector writes the
    // preference, so the default it falls back to is still the last choice.
    setPresetProject(group ?? null);
    store.deselect();
    if (flip()) setCollapsed(true); // the composer lives in the content pane
    // The composer mounts on the deselect above, so the focus request has to
    // wait for it — a listener that is not there yet hears nothing.
    queueMicrotask(() => window.dispatchEvent(new CustomEvent("tl:focus-new-session")));
  };

  // What this box can actually start. Fetched once — it changes when somebody
  // installs something, not while a page is open — and it costs a login shell
  // on the server, so it is not something to poll.
  const [cmdAvail, setCmdAvail] = createSignal<CommandAvailability>({});
  onMount(() => void availableCommands().then(setCmdAvail));
  // The command the terminal is actually told to run, which is why the fallback
  // lives here and not only in the dropdown: the same resolution has to hold for
  // a session started by the create row and one started from a restored
  // preference, or the row shows one thing and the attach does another.
  const newCommand = () =>
    effectiveCommand(prefs.prefs().session.newCommand, cmdAvail(), NEW_SESSION_COMMANDS);

  /**
   * The model and effort a session created right now would launch on, as FLAGS
   * on the process (lib/terminal-url.ts) rather than a `/model` driven into it
   * once it is up.
   *
   * Read here rather than carried from the composer because the attach is what
   * brings a session into being, and it happens after the composer has gone:
   * creating selects, and selecting unmounts it. The preference it wrote is
   * still the answer, and reading it at the moment of the attach is what makes
   * that true without passing anything along.
   *
   * Empty for a shell and for a default choice — both mean "add no flag".
   */
  const newLaunch = (): { model: string; effort: string } => {
    const h = modelHarness(newCommand() as SessionTool);
    if (!h) return { model: "", effort: "" };
    return (
      modelRequest(h, modelChoiceFor(prefs.prefs(), h)) ?? {
        model: "",
        effort: "",
      }
    );
  };

  // A selected session the poll has never returned does not exist in tmux yet:
  // `store.create` only writes the layout, and the session comes into being when
  // a terminal attaches. That one terminal must attach immediately; every other
  // session's waits for the Terminal view, because attaching resizes the tmux
  // WINDOW to whatever this client measures and would reflow a wide client
  // already using it.
  // `loading` covers the pre-first-poll window, where everything looks unseen.
  const selectedIsCreating = createMemo(() => {
    const name = selectedName();
    if (!name || store.loading()) return false;
    return !store.sessions.some((s) => s.name === name);
  });

  const selectedDir = createMemo(() => {
    const name = selectedName();
    return name ? projectDirFor(store.layout(), name) : undefined;
  });

  // ---- sessions kept mounted (store/keepalive.ts) --------------------------
  // A session you have opened stays mounted and hidden, so going back to it
  // shows what is already there instead of rebuilding an xterm, a ttyd socket
  // and an SSE stream — 1,797 ms of cover per switch, measured.
  const selectedSession = createMemo<Selected | null>(() => {
    const sel = store.selected();
    return sel ? { name: sel.name, owner: sel.owner } : null;
  });
  const [kept, setKept] = createSignal(EMPTY_KEEP);
  const selectedKey = createMemo(() => {
    const sel = selectedSession();
    return sel ? keyOf(sel) : null;
  });

  // The focused slot's two connection channels, published to the ONE status
  // model behind the badge and the Right now panel. Here rather than beside the
  // maps they read, because a memo runs the moment it is created and the key
  // they are keyed by is `selectedKey`, which is declared above this line and
  // below those.
  /** The focused tile's transcript stream, or null when nothing is open —
   *  which is `unknown` rather than a fault. */
  const sessionStatus = createMemo<SseStatus | null>(() => {
    const key = selectedKey();
    return key === null ? null : (transcriptConn().get(key) ?? null);
  });
  createEffect(() => status.setTranscript(sessionStatus()));
  createEffect(() => {
    const key = selectedKey();
    status.setTerminal(key === null ? null : (terminalConn().get(key) ?? null));
  });

  // ---- the Workspace on screen (ADR-0027) ---------------------------------
  // Several sessions visible at once as Tiles, arranged as a tree of rows and
  // columns. A workspace is split across two stores and both halves are read
  // here, because the shell is the only thing that holds the mounted sessions
  // and the box they are laid out in at the same time.
  //
  // THE SLOT LAYER IS NOT REORDERED BY ANY OF THIS. The `<For each={mounted()}>`
  // below is append-only and a live terminal never moves in the DOM; what a
  // workspace changes is which slots are on screen and what rectangle each one
  // is given. ADR-0027 is the record, and the 779 ms rebuild of an xterm, a
  // ttyd socket and a tmux attach is the reason.

  /**
   * Which sessions belong on screen together, per user, from tmux-api.
   *
   * Fetched once. Membership changes when somebody drags a session into or out
   * of a workspace, which is this tab's own action in the overwhelming case, so
   * there is nothing here worth a poll — the sessions poll already costs a
   * request every couple of seconds and this document changes a handful of
   * times a day.
   *
   * A FAILED FETCH KEEPS THE EMPTY DOCUMENT AND SAYS NOTHING. `getWorkspaces`
   * throws rather than degrading precisely so the two cases stay apart
   * (lib/lobby-api.ts), and this is the caller deciding what to do with that: an
   * unreachable tmux-api at boot means the sidebar marks nobody and a session
   * opens alone, which is the lobby as it worked last week. A toast about it
   * would fire on every reload during a restart and name a feature the user may
   * not be using.
   */
  const [workspaceDoc, setWorkspaceDoc] = createSignal<Workspaces>(emptyWorkspaces());

  /** Live session names, or null before the first poll has ANSWERED — which is
   *  a different question from `loading()`, since loading goes false even when
   *  /sessions rejected and every member looks dead in that window. */
  const liveNames = (): ReadonlySet<string> | null =>
    store.polls() > 0 ? new Set(store.sessions.map((s) => s.name)) : null;

  /**
   * The same answer as keepalive KEYS, which is what a workspace member is
   * compared by.
   *
   * A SEPARATE QUESTION FROM `liveNames`, not a spelling of it. Membership
   * carries an owner (types/lobby.ts, `WorkspaceMember`) so a session emo
   * shared with you can be a tile, and `auth` of your own and emo's `auth` are
   * two terminals: asked by name, emo's tile would look alive because YOU have
   * a session of that name, and killing yours would strike emo's off. Keepalive
   * still prunes by name, because its list is this tab's mounts and every entry
   * there already carries its own owner.
   *
   * Your own session is keyed with NO owner even though `/sessions` stamps one
   * on it, which is the convention `SessionCard` selects under
   * (`owner: foreign() ? s().owner : undefined`) and the one the document is
   * written in: `{name}` and `{name, owner: "wizard"}` would otherwise be two
   * spellings of one seat, and the tile would stop matching the mounted slot.
   */
  const liveKeys = (): ReadonlySet<SessionKey> | null =>
    store.polls() > 0
      ? new Set(
          store.sessions.map((s) =>
            keyOf(
              s.owner && s.owner !== store.me()
                ? { name: s.name, owner: s.owner }
                : { name: s.name },
            ),
          ),
        )
      : null;

  onMount(() => {
    void getWorkspaces()
      .then(setWorkspaceDoc)
      .catch(() => {
        /* keep the empty document: no workspaces, one session on screen */
      });
  });

  /**
   * FOLLOW A RENAME, which is the one thing that moves this document without
   * anybody touching a tile.
   *
   * Members are session NAMES, and a session is renamed as soon as its first
   * title lands (ADR-0022) — seconds into its first turn, and often while it is
   * a tile on screen. tmux-api rewrites its own copy (workspaces.go
   * `renameSession`, driven by rename_cascade.go), so the SERVER is right and
   * this browser's one-off fetch is the stale half. Left stale, the renamed
   * member reads as a session that is not alive, the workspace falls below two
   * live members, and the tiles collapse to one a few seconds after a session
   * was created.
   *
   * A member that is no longer a live session is the whole signal: it has been
   * renamed, killed or restored, and only the server can say which. The GET is
   * made once per CHANGE in that set rather than per poll — a killed member
   * keeps its seat by design, so it stays missing for as long as it is dead and
   * would otherwise ask again every couple of seconds.
   */
  let chasedMissing = "";
  createEffect(() => {
    const live = liveKeys();
    if (!live) return;
    const missing = untrack(workspaceDoc)
      .workspaces.flatMap((w) => w.members)
      .map(keyOf)
      .filter((key) => !live.has(key))
      .sort()
      .join(" ");
    if (missing === chasedMissing) return;
    chasedMissing = missing;
    if (missing === "") return;
    void getWorkspaces()
      .then(setWorkspaceDoc)
      .catch(() => {
        /* keep what is on screen: the tiles are attached either way */
      });
  });

  /** This browser's arrangements, one `tl:workspaces:v1` document. The tree
   *  layer is injected rather than imported by the store, so the node shape
   *  lives in exactly one file (store/workspaces.ts says why at length). */
  const workspaceGeometry = createWorkspacesStore({
    parseTree: parseTreeNode,
    sessionsOf: leafKeys,
  });
  onCleanup(() => workspaceGeometry.dispose());

  /** The workspace the selected session sits in, or null for a lone session. */
  const tiles = createMemo<WorkspaceTiles | null>(
    () =>
      workspaceTilesFor({
        doc: workspaceDoc(),
        selected: store.selected(),
        // `liveKeys()`, which is `polls() > 0`, and NOT `loading()`: loading
        // goes false on the failure path too (store/lobby.ts), so a reload
        // while tmux-api is restarting used to hand an EMPTY set here — every
        // member looks dead, every workspace collapses to a lone session, and a
        // drag in that window mints a new workspace whose write strips the real
        // one below two members and deletes it server-side.
        live: liveKeys(),
        solo: flip(),
      }),
    null,
    { equals: sameTiles },
  );

  /**
   * The arrangement this device draws, or null when there is no workspace.
   *
   * A stored tree wins whenever it holds exactly this workspace's live members,
   * however it has been dragged since, and a stored tree whose members have
   * MOVED is reconciled rather than replaced — {@link reconcileTree} carries
   * the reasoning. A device that has never seen this workspace auto-arranges
   * evenly in the SERVER's member order, which is why that order is
   * load-bearing: a fresh laptop and a fresh phone lay the same workspace out
   * the same way, and the first drag makes the arrangement this device's own.
   *
   * NOTHING IS WRITTEN HERE. The reconciled tree is what this device DRAWS; the
   * stored one still holds the dead member's place, so restoring it brings the
   * arrangement back whole. A drag is what persists (`setTree`), and a drag
   * made while a member is dead deliberately persists what is on screen.
   *
   * `version()` is read because the store's getters are plain reads over a
   * Map rather than signals; it bumps on every write, including another tab's.
   */
  const workspaceTree = createMemo<TreeNode | null>(() => {
    const group = tiles();
    if (!group) return null;
    workspaceGeometry.version();
    return reconcileTree(workspaceGeometry.treeFor(group.id), group.keys);
  });

  /**
   * The box the tree is laid out in, measured rather than assumed.
   *
   * `.tl-shell-body` is the positioned ancestor every tiled slot is absolute
   * against and the element `.tl-tiles` covers, so measuring it is what keeps a
   * divider on its tile's boundary. The dock comes off the bottom by the same
   * arithmetic the CSS uses: `--tl-dock-h` is the panel's own `height: <ratio>%`
   * of this element, so its pixels are that fraction of this height.
   */
  const [shellBox, setShellBox] = createSignal<Size>(
    { width: 0, height: 0 },
    { equals: (a, b) => a.width === b.width && a.height === b.height },
  );
  const tileArea = createMemo<Size>(() => {
    const box = shellBox();
    const dockPx = dock.mounted() ? (box.height * dock.ratio()) / 100 : 0;
    return { width: box.width, height: Math.max(0, box.height - dockPx) };
  });

  /**
   * The rects the canvas last emitted, WITH the tree they describe.
   *
   * The pair is the point. `onRects` arrives in an effect, one tick after the
   * tree it was computed from became the tree, so a bare rect list is briefly
   * the previous arrangement's — and reading the previous arrangement's rects
   * as the visible set would show the tiles of the workspace you just left.
   * Holding the tree beside them makes staleness detectable instead of
   * invisible, and {@link tileRects} answers with nothing until they match.
   */
  const [laid, setLaid] = createSignal<{ tree: TreeNode | null; rects: readonly Rect[] }>({
    tree: null,
    rects: [],
  });
  const tileRects = createMemo<ReadonlyMap<SessionKey, Rect>>(() => {
    const tree = workspaceTree();
    const current = laid();
    if (!tree || current.tree !== tree) return new Map<SessionKey, Rect>();
    return new Map(current.rects.map((r) => [r.key, r]));
  });

  /**
   * Which mounted sessions are on screen. One string compared against one
   * selection until 2026-09-12; a membership test now, and the whole of what
   * "splits are the view rather than a mode" costs the shell.
   *
   * The canvas's rects are the answer when it has them, because the rects are
   * also where the too-small fallback lives: a window too narrow for the tree
   * shows the focused tile alone, and that decision reaches the slot layer as a
   * single rect rather than through a second channel. The tree's own leaves
   * stand in for the one tick before the canvas has answered, so entering a
   * workspace never flickers through a frame with nothing on screen.
   */
  const visibleKeys = createMemo<ReadonlySet<SessionKey>>(() => {
    const tree = workspaceTree();
    if (!tree) return visibleSet([], selectedKey());
    const rects = tileRects();
    return visibleSet(rects.size > 0 ? [...rects.keys()] : leafKeys(tree), selectedKey());
  });

  /**
   * WHICH sessions are on screen, as one value that moves when that set does.
   *
   * Every visible tile re-claims its session's Grid when this changes
   * (SessionView, beside `claimGrid`), which is the design's "every visible tile
   * re-claims its grid after any change to the visible set". A sorted join
   * rather than the Set itself, because the Set is rebuilt on every poll and an
   * effect over the object would fire on changes that moved no tile — four
   * needless POSTs a second in a four-tile workspace.
   *
   * A divider drag and a window resize are deliberately NOT in here: those move
   * a tile's BOX, which the terminal's own ResizeObserver sees, and its
   * debounced fit claims the grid it lands on. That debounce is what makes the
   * claim land once the drag settles rather than per pointer move.
   */
  const visibleStamp = createMemo(() => [...visibleKeys()].sort().join("|"));

  // ---- writing a Workspace (both halves, one gesture) ----------------------

  /**
   * The undo stack's half of a workspace edit, with divider drags coalesced.
   *
   * Held here rather than inside the write below because the coalescing has a
   * timer in it: one divider drag reports forty rows of fractions a second and
   * the stack is 25 deep, so a drag pushed per frame would bury the close that
   * happened before it. Anything a person does deliberately flushes what is
   * held, so the order on the stack is the order things happened in.
   */
  const workspaceUndo = createWorkspaceUndo(undoStack);
  onCleanup(() => {
    workspaceUndo.flush();
    workspaceUndo.dispose();
  });

  /**
   * A workspace's id, minted by the client at its first split and kept for the
   * life of the group.
   *
   * `newSessionId`'s alphabet and length, prefixed, so it satisfies the charset
   * tmux-api validates ids against (`NAME_RE`) and can never be read as a
   * session name in a document that holds both. Workspaces are unnamed by
   * design — this is an identity, not a label, and nothing shows it to anyone.
   */
  const newWorkspaceId = (): string => `w${newSessionId()}`;

  /**
   * WRITE ONE WORKSPACE: this device's arrangement and the server's membership,
   * in that order, as one gesture.
   *
   * `raw` is whatever the tree layer handed back, which may be a workspace of
   * one — `removeAt` leaves a bare leaf when the second-to-last tile closes.
   * Fewer than two tiles is not a workspace (`MIN_WORKSPACE_MEMBERS`), so it
   * ends: the arrangement is forgotten here, the group is deleted there, and the
   * surviving leaf becomes the session on screen.
   *
   * FOCUS MOVES INSIDE THE SAME BATCH as the tree write, never after it. A
   * selection naming a tile that is no longer there resolves the visible set
   * against a dead key, and a blank pane reads as a terminal fault rather than
   * as bookkeeping.
   *
   * OPTIMISTIC, AND ROLLED BACK ON REFUSAL. The tiles are on screen and attached
   * whatever the server says; what a refusal costs is the promise that the other
   * tab and the next device will see the same grouping, so the local state goes
   * back to what it was and the person is told in those terms.
   *
   * `record` is the entry to put on the undo stack, or null for a write that IS
   * an undo — pushing there would clear the redo half the press is about to
   * fill, which is `store/undo.local.ts`'s "an inverse is quiet" rule.
   */
  /** The shell's own reactive owner, so a write that destroys the node it was
   *  dispatched from still has somewhere to live. See `landWorkspace`. */
  const shellOwner = getOwner();

  const writeWorkspace = async (
    id: string,
    raw: TreeNode | null,
    record: { from: TreeNode | null } | null,
  ): Promise<void> => {
    const leaves = raw ? leafKeys(raw) : [];
    const tree = leaves.length >= MIN_WORKSPACE_MEMBERS ? raw : null;
    if (!tree && record && !record.from) {
      // NO WORKSPACE BEFORE, NONE AFTER — and one tile left, which is the
      // middle-drop replace on a lone session: the pane is that session's only
      // tile, so "replaces what is in that tile" (the design's gesture table) is
      // "show the dropped session instead". There is nothing to group and
      // nothing to write; the selection IS the answer, the way it is for the
      // close that ends a workspace on its last tile.
      //
      // Zero leaves is the other half, and it really is a drop that asked for
      // nothing: a session dragged out of a lone session's pane, which was
      // never in a workspace to be taken out of.
      const only = leaves.length === 1 ? leaves[0] : undefined;
      if (only !== undefined && only !== selectedKey()) {
        const sel = sessionOf(only);
        store.select(sel.name, sel.owner);
      }
      return;
    }
    const wasDoc = workspaceDoc();
    const wasTree = workspaceGeometry.treeFor(id);
    const nextDoc = writeMembership({
      doc: wasDoc,
      id,
      // `sessionOf`, whole, rather than its `.name`: a tile key carries the
      // owner and the member the server stores wants it back. Dropping it here
      // would write emo's shared session into YOUR workspace as a session of
      // your own, which tmux-api then resolves to a name you do not have.
      tiles: tree ? leafKeys(tree).map(sessionOf) : [],
      live: liveKeys(),
    });
    // A LENS READS SOMEBODY ELSE'S MEMBERSHIP AND DOES NOT WRITE IT (the
    // design's `?as=` row). Every request this tab makes carries `?as=`, so the
    // PUT below would land in the TARGET's document, on every device they own,
    // from a tab they cannot see — which is the one thing a lens is not for.
    //
    // MEMBERSHIP ONLY, which is why this asks `sameMembership` rather than
    // `ACT_AS` alone. The split tree is this tab's own, per device by
    // construction (ADR-0027), so a lens may drag a divider, rearrange its
    // tiles and lay the group out however it likes; what it may not do is
    // decide which sessions are in the group. The refusal is here rather than
    // at the two gestures because both funnel through this one write, and
    // before the local batch because the arrangement must not move either — a
    // tile added locally and not in the document is one the next reconcile
    // takes away again, with nothing on screen to explain the flicker.
    //
    // The undo stack is already empty in a lens tab (`createUndoStore({
    // enabled: ACT_AS === "" })`), so there is nothing to unwind here.
    if (ACT_AS !== "" && !sameMembership(wasDoc, nextDoc)) {
      notify(
        "Acting as someone else: you can rearrange these tiles, not change whose sessions they are.",
        "warning",
      );
      return;
    }
    if (record) workspaceUndo.record(id, record.from, tree);
    batch(() => {
      // The survivor a close lands on, computed from the tree the tiles were in
      // rather than from the one left behind: "nearest" is a position in the
      // arrangement that is going away.
      const alive = new Set(tree ? leafKeys(tree) : leaves);
      const sel = selectedKey();
      if (alive.size > 0 && (sel === null || !alive.has(sel))) {
        const was = record?.from ? leafKeys(record.from) : [];
        const near =
          nearestSurvivor(was, sel === null ? -1 : was.indexOf(sel), alive) ?? [...alive][0];
        if (near !== undefined) {
          // Both halves of the key, like the middle-drop replace above: landing
          // the focus on a foreign tile by name alone selects a session of your
          // own that happens to share the name, or nothing at all.
          const parts = sessionOf(near);
          store.select(parts.name, parts.owner);
        }
      }
      if (tree) workspaceGeometry.setTree(id, tree);
      else workspaceGeometry.forget(id);
      setWorkspaceDoc(nextDoc);
    });
    // Nothing moved between groups — an undone divider drag is the case — so
    // there is nothing to tell tmux-api and no write that could fail.
    if (sameMembership(wasDoc, nextDoc)) return;
    try {
      await putWorkspaces(nextDoc);
    } catch {
      batch(() => {
        setWorkspaceDoc(wasDoc);
        if (wasTree) workspaceGeometry.setTree(id, wasTree);
        else workspaceGeometry.forget(id);
      });
      notify("That grouping was not saved. The tiles are still attached.", "error");
      throw new Error(WORKSPACE_SAVE_FAILED);
    }
  };

  /**
   * The same write for a gesture rather than for an undo: the refusal has
   * already been toasted and rolled back, so nothing is left to throw at.
   *
   * `dnd/tiles.ts` calls `apply` as `void Promise.resolve(...).finally(done)`,
   * where a rejection has nowhere to go and surfaces as an unhandled one.
   */
  const landWorkspace = (
    id: string,
    raw: TreeNode | null,
    from: TreeNode | null,
  ): Promise<void> => {
    // RUN UNDER THE SHELL'S OWNER, not the caller's.
    //
    // Every gesture that lands a workspace is dispatched from inside the thing
    // it is about to destroy: the ✕ lives in a `<Show when={rect()}>` whose
    // tile that very write removes, and a drop runs inside the slot it
    // re-tiles. `writeWorkspace` keeps reading after its `batch` — the
    // membership comparison, the PUT, the rollback — and by then the owner it
    // was called under has been disposed, so Solid answers a stale accessor
    // with "Attempting to access a stale value from <Show>" and the promise
    // rejects.
    //
    // Measured against the real app on 2026-09-12: pressing ✕ on a tile
    // focused it, closed nothing, sent no request and logged nothing, because
    // the rejection landed in the `.catch` below. The suite could not see it —
    // a test calls the handler directly, so it never runs under a doomed
    // owner.
    runWithOwner(shellOwner, () => {
      void writeWorkspace(id, raw, { from }).catch(() => {});
    });
    return Promise.resolve();
  };

  /**
   * Teach the undo stack how to take a workspace edit back.
   *
   * The ports are read live rather than captured, so an inverse folds itself
   * into the document and the arrangement as they are at the moment of the
   * press. `apply` is the same write every gesture goes through, minus the
   * record.
   */
  registerWorkspaceUndoHandler({
    // Read at the moment of the press, not reactively: an inverse is a one-shot
    // that folds itself into whatever the world is then.
    tree: (id) => workspaceGeometry.treeFor(id),
    // BY NAME, because that is what the entry holds: `undo.workspace.ts`
    // flattens its tiles to `sessionOf(key).name` so a rename can rewrite one
    // string and move every tile that names the session. A member matches on
    // its name alone here for the same reason, which does mean a foreign
    // session shares an answer with one of your own of the same name — the
    // narrower question needs the owner carried into the entry first.
    workspaceOf: (name) =>
      workspaceDoc().workspaces.find((w) => w.members.some((m) => m.name === name))?.id ?? null,
    apply: (id, tree) => writeWorkspace(id, tree, null),
  });

  /** Drop the arrangements of workspaces the server no longer lists. An EMPTY
   *  list is "nothing has answered yet" rather than "you have none", which the
   *  store's own `prune` already refuses to act on. */
  createEffect(() => workspaceGeometry.prune(workspaceDoc().workspaces.map((w) => w.id)));

  // ---- dragging a session into, around and out of the tiles ----------------

  /**
   * The arrangement a drop applies to, which is NOT the same question as the
   * arrangement on screen.
   *
   * A lone session is a workspace of one — "splits are the view rather than a
   * mode" — and it is the only thing a first split can split. So a drop sees a
   * bare leaf where there is no workspace yet, `splitAt` turns it into a pair,
   * and the write below mints the workspace that pair implies. Without this
   * there would be no way to make a workspace at all: the canvas is mounted only
   * once one exists, and the hit test would answer `remove` over the whole
   * screen.
   */
  const dropTree = (): TreeNode | null => {
    const tree = workspaceTree();
    if (tree) return tree;
    const key = selectedKey();
    return key === null ? null : leaf(key);
  };

  /** The tiles a drop is measured against, in the container's own coordinates.
   *  The canvas's rects when there is a workspace, and the whole tile area as
   *  one rect when a lone session is what a split would split. */
  const dropRects = (): readonly Rect[] => {
    if (workspaceTree()) return [...tileRects().values()];
    const key = selectedKey();
    const area = tileArea();
    if (key === null || area.width <= 0 || area.height <= 0) return [];
    return [{ key, x: 0, y: 0, width: area.width, height: area.height }];
  };

  /**
   * The session a sidebar card press is carrying, remembered from the press.
   *
   * `@formkit/drag-and-drop` announces a drag on the document with no payload
   * (`DRAG_START_EVENT`, dnd/sidebar.ts) and its own dragged-node state is not
   * populated until after that announcement, so the answer has to come from the
   * DOM. A card publishes its session as `data-name` and a foreign one is not
   * draggable at all, which makes the last card pressed the card being dragged
   * on both paths: a mouse gets a native drag from the same pointerdown, and a
   * finger gets a synthetic one from a long press on it.
   */
  let pressedCard: string | null = null;
  onMount(() => {
    const noteCard = (e: PointerEvent): void => {
      const el = e.target instanceof Element ? e.target.closest(".tl-card") : null;
      const own = el instanceof HTMLElement && !el.classList.contains("tl-card-foreign");
      pressedCard = own ? (el.dataset.name ?? null) : null;
    };
    document.addEventListener("pointerdown", noteCard, true);
    onCleanup(() => document.removeEventListener("pointerdown", noteCard, true));
  });

  /**
   * The shadow under a drag: where the tile will land, and whether the split it
   * asks for is one the 240px floor allows.
   *
   * Asked of `dnd/tiles.ts` whole rather than assembled here. The box depends on
   * the session in the air — a tile already in the workspace leaves its old
   * space to its siblings before the target is split, so the target is bigger
   * when it splits than it is on screen — and that session is the drag's own
   * captured key, which lives there. A memo only for the `<Show>` below, which
   * reads it four times per frame.
   */
  const dropShadow = createMemo(() => tileDropPreview());

  /** Take this tile out of the workspace. The session keeps running and keeps
   *  its place in the sidebar; only the tile goes. */
  const closeTile = (key: SessionKey): void => {
    const group = untrack(tiles);
    const before = untrack(workspaceTree);
    if (!group || !before) return;
    void landWorkspace(group.id, removeAt(before, key), before);
  };

  // ---- a member on its way out (design, "Death and restore") ---------------

  /**
   * Is any tile in the workspace on screen inside its kill window?
   *
   * The arming signal for the clock below, and nothing else reads it. By NAME
   * because that is what the kill register is keyed by (store/lobby.ts
   * `killingNames`), taken off the tile's key with `sessionOf` — the tree's
   * inverse of `keyOf`, which exists so a consumer that needs the name and the
   * owner separately can take them apart (design, "The tree contract").
   */
  const tileKilling = createMemo(() =>
    (tiles()?.keys ?? []).some((key) => store.killing(sessionOf(key).name)),
  );

  /**
   * THE COUNTDOWN'S CLOCK, one for the whole workspace, running only while a
   * kill is.
   *
   * `TileHeader` takes a `tick` rather than running its own interval, and the
   * reason is written out in its docblock: four tiles with four intervals are
   * four extra wakeups a second on a page already drawing four live terminals,
   * and four intervals started at four mount times count in four PHASES — so
   * one kill reads 5 on two tiles and 4 on two others at the same instant. One
   * signal here is what makes every tile subtract at the same moment.
   *
   * ARMED BY THE KILL rather than standing. The sidebar's own 1Hz tick
   * (Sidebar.tsx:186) is a component-private signal that drives every running
   * card's working timer, so it cannot be read from out here without a prop on
   * `Sidebar` — and a second STANDING interval is what TileHeader's note asks
   * us not to add. This one exists for the eight seconds a tiled session is
   * dying (store/lobby.ts GRACE_MS) and for no other moment: no workspace, or
   * no kill in it, and there is no interval at all.
   *
   * Its phase is the kill's, which is the closest the two surfaces can be
   * without sharing a signal: both this and the card derive their number from
   * `killingUntil` and `Date.now()` with the same `Math.ceil`, so the tick only
   * decides WHEN each one re-reads, and both re-read within the same second.
   */
  const [killTick, setKillTick] = createSignal(0);
  createEffect(() => {
    if (!tileKilling()) return;
    const timer = setInterval(() => setKillTick((t) => t + 1), 1000);
    onCleanup(() => clearInterval(timer));
  });

  /**
   * Take a tiled session's kill back, which is the `↺` arrow's press.
   *
   * THIS KILL'S OWN ENTRY, not the top of the undo stack — `takeBackKill`
   * presses the entry that kill pushed, so a group collapsed or a tile closed
   * during the eight seconds does not steal the press (store/lobby.ts). The
   * refusal toast belongs to the caller rather than the store (`UndoResult`),
   * which is why it is here and not in the header: a `reason` of null is the
   * deliberate silence of nothing to do.
   *
   * The same handler a sidebar card runs (`SessionCard.takeBack`), because it
   * is the same press on the same kill: the card and the tile are two drawings
   * of one session, and the arrow on either has to mean exactly one thing.
   */
  const undoTileKill = async (name: string): Promise<void> => {
    const r = await store.takeBackKill(name);
    if (!r.ok && r.reason) notify(`Can't undo: ${r.reason}`, "warning");
  };

  // ---- the session under the pointer (store/preload.ts, ADR-0026) ----------
  // Keepalive solved the SECOND open of a session. This is the same idea 250 ms
  // before the FIRST: a hover starts the real tmux attach, hidden, and the
  // click that follows reveals it instead of paying 627 ms for one. The store
  // decides; this wires it to the three facts it cannot see for itself.
  const preload = createPreloadStore({
    // A phone has no hover, so it preloads nothing. Read live rather than at
    // boot: a 2-in-1 crosses this query.
    isCoarsePointer: createCoarsePointer(),
    // Already mounted or already on screen: a kept session is attached and the
    // selected one is the view, so there is nothing left to buy.
    alreadyOpen: (sel) => {
      const key = keyOf(sel);
      return key === selectedKey() || kept().list.some((k) => k.key === key);
    },
    // Own sessions only. A foreign attach runs tmux-api's /internal/attach
    // authorization per connection — a round trip, a sudo and an audit line per
    // card the pointer crosses — and "" before /whoami answers preloads
    // nothing, which is the fail-closed direction.
    me: store.me,
  });
  onCleanup(() => preload.dispose());
  /** One mount per session: the kept ones, plus the preloaded one. */
  const mountList = createMountList();
  const mounted = createMemo(() => mountList(kept().list, preload.preloaded()));

  createEffect(() => {
    const sel = selectedSession();
    // ENTERING A WORKSPACE ATTACHES EVERY MEMBER, which is what makes a
    // workspace show four terminals rather than one terminal and three gaps.
    // The members are kept the same way the selection is, so they are ordinary
    // 24-hour mounts from here on: leaving the workspace leaves them attached
    // and coming back costs nothing, and the TTL collects them like any other.
    // Appended in the workspace's own member order, after the selection, so the
    // list still only ever grows at the end.
    const members = tiles()?.keys ?? [];
    // BOTH WRITES, IN THIS ORDER, IN ONE BATCH. Keepalive takes the session on
    // first and the preload slot empties second, so the mount list never sees a
    // moment where the promoted session is in neither — which would unmount the
    // row and throw away the attach the hover paid for. `select` reads nothing
    // reactive, so calling it here subscribes this effect to nothing new.
    batch(() => {
      setKept((state) => {
        const now = Date.now();
        let next = keepSelected(state, sel, now);
        for (const key of members) next = keepSelected(next, sessionOf(key), now);
        return next;
      });
      preload.select(sel);
      // A TILE IS A COMMITMENT, and the preload has to hear about it from here
      // because a drop does not move the selection: the session lands beside
      // the one you were already on, so the line above never speaks for it.
      //
      // What that costs while the slot still holds it: `claimGrid` refuses a
      // preload outright (SessionView's third refusal, ADR-0026), and the same
      // POST is what clears the client's ignore-size flag server-side. So a
      // tile dropped straight out of a hover keeps its session's window at
      // whatever size the last device left it at, inside a tile of a different
      // one — and tmux draws that smaller window into the corner with a border
      // and a field of its own dots, until a click on the tile finally commits.
      // Measured in Chrome on 2026-09-13 against the branch stack, where it is
      // the common case rather than an edge: the 250 ms dwell has almost always
      // fired on the card a drag then starts from.
      //
      // After the keep above, in the same batch, for the reason that ordering
      // already had: the mount list is keepalive's rows plus the one preload,
      // and emptying the slot first would leave the promoted session in neither
      // for an instant, which unmounts the row and throws away the attach.
      for (const key of members) preload.select(sessionOf(key));
    });
  });
  /**
   * Drop what is not worth holding: a day unvisited, or gone from the lobby.
   *
   * `liveNames()` for the same reason the tiles memo reads it — undefined means
   * "the lobby has not answered", and a list that never arrived is not a list
   * of everything that died. Asked as `loading()`, a reload during a tmux-api
   * restart unmounted every session in the tab except the selected one, taking
   * the other tiles of a workspace with it.
   */
  const prune = () =>
    setKept((state) =>
      pruneKept(state, selectedSession(), Date.now(), KEEP_TTL_MS, liveNames() ?? undefined),
    );
  createEffect(() => {
    // Re-run whenever the list changes, so a session killed from another device
    // loses its mount without waiting for the timer.
    store.sessions.length;
    prune();
  });
  // The TTL only bites in a tab left open for a day, which the timer covers.
  const pruneTimer = setInterval(prune, 5 * 60 * 1000);
  onCleanup(() => clearInterval(pruneTimer));

  // The mounted session's file-preview overlay, published up by SessionView.
  // A session switch disposes that view and the unsaved draft inside it, so the
  // keyboard routes into a switch have to know about it (the mouse route
  // already does — it goes through the overlay's own discard confirm).
  const [previewState, setPreviewState] = createSignal({
    open: false,
    dirty: false,
  });

  // ---- keybinding engine + command palette + shortcuts help (pillar #2) ----
  // The lobby SPA owns the sidebar, palette and session switching, and its one
  // capture-phase window keydown sees every chord in the page — the terminal's
  // included, since the terminal is drawn in this document.
  const engine = createKeybindingEngine();
  // Both overlays render OVER the terminal and take focus off it, so dismissing
  // one leaves focus on <body> and the pty deaf. refocusTerminal calls the
  // bridge the mounted TerminalNative publishes; it is a no-op with no session
  // selected or while the text view owns the keyboard.
  const help = createHelpController({ refocus: refocusTerminal });

  // Session rows for the palette (recents-first is applied inside the palette).
  const paletteSessions = () => {
    const m = store.model();
    // The id rides along so the recents-first sort can find a visit record that
    // is filed under it rather than under a name that may since have changed.
    const out: { name: string; id?: string; state?: string }[] = [];
    for (const g of m.groups)
      for (const s of g.sessions) out.push({ name: s.name, id: s.id, state: s.state || "" });
    for (const s of m.foreign) out.push({ name: s.name, id: s.id, state: s.state || "" });
    return out;
  };

  // `run` is assigned just below; the palette's action rows call it lazily.
  let run: (cmd: string) => void = () => {};
  const palette = createPaletteController({
    sessions: () => Promise.resolve(paletteSessions()),
    isUnseen: (sn) => notifications.isUnseen(sn),
    current: () => store.selected()?.name ?? null,
    attach: (name) => {
      if (store.selected()?.name === name) return;
      // Same guard the switch chords carry: the palette is reachable over the
      // open preview, and picking a session here would bin the draft too.
      if (previewState().dirty) {
        notify("Unsaved changes in the file editor — save or discard them first", "warning");
        return;
      }
      const t = flatSessionOrder(store.model()).find((s) => s.name === name);
      store.select(name, t?.owner);
    },
    refocus: refocusTerminal,
    actions: () => {
      const cur = store.selected()?.name ?? null;
      const acts: PaletteAction[] = [
        {
          label: "New session",
          hint: "name box",
          keepFocus: true,
          run: () => run("session.new"),
        },
        {
          label: "Keyboard shortcuts",
          hint: "/",
          run: () => run("shortcuts.help"),
        },
        {
          label: "Skills",
          hint: "install, disable, share",
          run: () => openSettings("skills"),
        },
      ];
      // Undo / redo, shown only when a press would do something — the same rule
      // the dimmed card's arrow follows (SessionCard.tsx). An empty stack means
      // no row rather than a row that answers with silence, and a lens tab,
      // whose stack is disabled and therefore always empty, shows neither.
      const mod = engine.isMac ? "Cmd" : "Ctrl";
      if (undoStack.canUndo()) {
        acts.push({
          label: "Undo",
          hint: `${mod}+Z`,
          run: () => run("edit.undo"),
        });
      }
      if (undoStack.canRedo()) {
        acts.push({
          label: "Redo",
          hint: `${mod}+Shift+Z`,
          run: () => run("edit.redo"),
        });
      }
      if (cur) {
        acts.push(
          {
            label: "Rename current session",
            hint: cur,
            run: () => run("session.rename.current"),
          },
          {
            label: "Open image gallery",
            hint: cur,
            run: () => run("gallery.open"),
          },
          {
            label: "Paste into terminal",
            hint: cur,
            run: () => run("terminal.paste"),
          },
          {
            label: "Kill current session",
            hint: cur,
            danger: true,
            run: () => run("session.kill.current"),
          },
        );
      }
      return acts;
    },
  });

  /**
   * Swipe left/right moves between sessions on a phone, so switching does not
   * require the round trip back to the list. It dispatches the SAME commands
   * the keyboard uses, so the order, the wrap and the foreign-session handling
   * are the sidebar's, in one place.
   */
  const installSessionSwipe = (el: HTMLElement): void => {
    const off = installSwipe(el, {
      enabled: () => flip() && !collapsed(),
      onSwipe: (dir) => run(dir === "next" ? "session.next" : "session.prev"),
    });
    onCleanup(off);
  };

  /**
   * THE SESSION BAR'S STRIP: one bar for the tab, above the shell body and
   * outside every session slot.
   *
   * The design's surface table — "session bar | one bar, showing the focused
   * tile's session. Its contents change as focus moves" — and this element is
   * the "one bar, in the shell" half of it. `SessionView` still writes the bar
   * (it reads that view's mode, watch state, picker, font controls and menus)
   * and portals it in here, so the MARKUP stays with its wiring and the BOX
   * belongs to this column.
   *
   * WHY IT CANNOT LIVE IN THE SLOT. The bar is `flex: 0 0 auto` at about 41px,
   * so a bar inside the focused slot is 41px that tile's terminal does not get.
   * Moving focus from tile A to tile B grew A's terminal host by 41px and
   * shrank B's by 41px — about two rows each — and a tile IS the size of its
   * tmux window: both hosts' ResizeObservers fire, both debounced fits land,
   * both call `claimGrid`, and two real windows resize for every device
   * attached to them. Clicking a tile is not a resize.
   *
   * BETWEEN `.tl-shellbar` AND `.tl-shell-body`, which is what keeps a lone
   * session byte-identical and the tiles honest at once. `.tl-shell-content` is
   * a flex column, so the bar sits exactly where it sat as the first child of
   * `.tl-session-view` — and because it is now OUTSIDE `.tl-shell-body`, the
   * box a Workspace is measured in (`shellBox`, below) already excludes it, so
   * every rect, divider and drop shadow lands inside the area the tiles
   * actually have. An offstage preload gets the same correction for free: it is
   * pinned to `.tl-shell-body` (app.css, `.tl-offstage`) and used to measure a
   * bar's height taller than the pane it would be revealed into — 49px, or
   * three terminal rows, in Chrome at 1440x900 on 2026-09-12.
   *
   * CREATED EAGERLY rather than through a `ref`, so it exists before the first
   * slot mounts. A host that arrived one tick late would have every bar render
   * in place and then move, which disposes and rebuilds it — a menu open across
   * that moment would close, and the boot frame would be 41px out.
   */
  const barHost = document.createElement("div");
  barHost.className = "tl-bar-host";

  /**
   * The shell body: the swipe surface, and the box a Workspace is laid out in.
   *
   * One ref for both because it is one element, and the measurement has to come
   * from THIS element rather than from the window: the sidebar takes width from
   * it, the shell bar takes height, and a tile positioned against the window
   * would sit a sidebar to the left of where its divider is drawn.
   *
   * `clientWidth`/`clientHeight` rather than the observer's own
   * `contentBoxSize`, so the first read and every later one come from the same
   * pair of numbers, and jsdom (which runs no layout and answers 0) gives an
   * empty tile area rather than a mixture.
   */
  const mountShellBody = (el: HTMLElement): void => {
    installSessionSwipe(el);
    // DROPS ARE TAKEN HERE, NOT ON THE CANVAS, and the difference is the only
    // way a workspace ever comes into existence. The canvas is mounted once
    // there IS one; the first split has to land while a lone session is on
    // screen, so the surface that takes it must exist then too. This element is
    // also the right one to measure against: every tiled slot is absolute
    // within it and `.tl-tiles` covers it exactly, so a pointer translated
    // through its box lands on the same numbers `toRects` produced.
    attachTileDrop(el, {
      // Read once, when the drag begins. A group header being reordered raises
      // the same start event and carries no session, which is what null means.
      dragged: () => (sessionDragActive() && pressedCard ? keyOf({ name: pressedCard }) : null),
      rects: dropRects,
      tree: dropTree,
      // The box `dropRects` is measured in, which is also what `WorkspaceCanvas`
      // lays the tree out in: a moved tile's landing arrangement is computed
      // from the tree, and it has to come out in the same coordinates.
      container: tileArea,
      apply: (next) => {
        const before = untrack(workspaceTree);
        const group = untrack(tiles);
        return landWorkspace(group?.id ?? newWorkspaceId(), next, before);
      },
      hold: () => store.hold(),
    });
    const measure = (): void => {
      setShellBox({ width: el.clientWidth, height: el.clientHeight });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  };

  run = createRunAppCommand({
    store,
    palette,
    help,
    toggleSidebar: () => toggleSidebar(),
    // The app icon counts awaiting plus unread-finished; Alt+Shift+U walks the
    // second half the way Alt+Shift+Enter walks the first.
    isUnseen: (sn) => notifications.isUnseen(sn),
    focusNewSession: () => openComposer(),
    notify,
    openGallery: () => void gallery.open(),
    pasteToTerminal: () => window.__tlDoPaste?.() ?? false,
    toggleDock: () => void dock.toggle(),
    // The same instance the lobby store carries, named here so the two undo
    // commands have a visible source rather than an inherited one.
    undo: undoStack,
  });

  // The shell's when-context, built in ONE place (keyContext) and read by every
  // key path: the engine's window keydown and the bare "/" listener below. Each
  // used to decide for itself what an open overlay meant, so a chord refused on
  // one path fired on another. SessionView's always-on Ctrl/Cmd+J was a third
  // reader until the dock reclaimed the chord; it still takes `overlayOpen` as
  // a prop and no longer reads it.
  //
  // NOT a memo, and the reason is the `editing` flag. Every other input is a
  // signal, but focus is a DOM fact that moves without one changing, so a
  // cached context would answer with whatever was focused the last time an
  // overlay opened. This is a plain function that reads `document.activeElement`
  // at the moment it is asked — which is the keydown, since the engine calls
  // `getContext` from its listener — and still tracks the signals it reads for
  // any reactive caller.
  const keyCtx = () =>
    keyContext({
      paletteOpen: palette.isOpen(),
      helpOpen: help.isOpen(),
      settingsOpen: settingsOpen(),
      galleryOpen: gallery.view() !== "closed",
      previewOpen: previewState().open,
      previewDirty: previewState().dirty,
      // The one chord a text field owns: keybindings/editing.ts says why the
      // field cannot simply win it downstream.
      editing: isEditingTarget(document.activeElement),
    });
  const overlayOpen = () => keyCtx().overlayOpen;

  engine.init({
    getContext: () => keyCtx(),
    runCommand: (cmd) => run(cmd),
  });
  onCleanup(() => engine.dispose());

  // The bare "/" or "?" help opener — lobby chrome only (never in a field, and
  // modifier combos fall through to the engine so Alt+/ still works). Lives here
  // so it works while the overlay is closed. Esc closes an open overlay.
  const onSlashKey = (e: KeyboardEvent) => {
    if (help.isOpen() && e.key === "Escape") {
      e.preventDefault();
      help.close();
      return;
    }
    if (e.key !== "/" && e.key !== "?") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable))
      return;
    // Another overlay owns the keyboard: opening this one over it is the same
    // context leak the chords carried. This overlay itself is exempt — "/" is
    // one of its own dismiss keys.
    if (overlayOpen() && !help.isOpen()) return;
    e.preventDefault();
    help.toggle();
  };
  onMount(() => window.addEventListener("keydown", onSlashKey, true));
  onCleanup(() => window.removeEventListener("keydown", onSlashKey, true));

  // The act-as chip, rendered into whichever bar is on screen alongside the
  // gear. With a full identity switch there is no server-side difference
  // between you and the person you are acting as, so this plus the tinted frame
  // is what separates a deliberate action from typing into the wrong tab.
  const actAsChip = () => (
    <Show when={actingAs()}>
      {(who) => (
        <button
          type="button"
          class="tl-actas-chip"
          title={`Acting as ${who()} — click to return to your own lobby`}
          aria-label={`Acting as ${who()}. Return to your own lobby`}
          onClick={() => switchToUser("")}
        >
          <span class="tl-actas-who">{who()}</span>
          <span class="tl-actas-x" aria-hidden="true">
            ✕
          </span>
        </button>
      )}
    </Show>
  );

  // The shell bar's Settings control. It carries a LABEL, not just the gear:
  // as a bare glyph it measured 23x18 in muted grey in the extreme top-right
  // corner of a 1440px bar, which is findable only if you already know it is
  // there. The bar has the room — everything else in it sits on the left — and
  // the label collapses back to the icon under 1000px via .tl-btn-label.
  //
  // The phone never renders this: its shell bar is hidden by the flip, and the
  // sidebar footer carries its own gear instead.
  const settingsButton = () => (
    <button
      class="tl-icon-btn tl-settings-btn"
      aria-label="Settings"
      title="Settings"
      aria-expanded={settingsOpen()}
      onClick={() => openSettings()}
    >
      ⚙<span class="tl-btn-label">Settings</span>
    </button>
  );

  // Beside Settings, and labelled for the same reason: a bare glyph in the far
  // corner of a wide bar is findable only if you already know it is there. It
  // opens the same overlay on its own page, so the one-click path to Skills
  // survives the move back into Settings.
  const skillsButton = () => (
    <button
      class="tl-icon-btn tl-skills-btn"
      aria-label="Skills"
      title="Skills"
      aria-expanded={skillsOpen()}
      onClick={() => openSettings("skills")}
    >
      <SkillsIcon />
      <span class="tl-btn-label">Skills</span>
    </button>
  );

  return (
    <div
      class="tl-shell"
      // The column width, for the grid track, the sidebar inside it and the
      // grip that drags it — one property, so the three cannot disagree. The
      // stacked layouts override it rather than read it (sidebar.css).
      style={{ "--tl-sidebar-w": `${sidebarWidth.width()}px` }}
      classList={{
        "tl-shell-collapsed": collapsed(),
        "tl-shell-resizing": sidebarWidth.dragging(),
        "tl-flip": flip(),
        // Paints the coloured frame + tinted bars. Driven by the server's
        // answer, so a refused ?as= leaves the tab looking exactly like yours.
        "tl-acting-as": !!actingAs(),
      }}
    >
      <aside class="tl-shell-sidebar">
        {/* The cards are the preload's only consumer: a pointer resting on
            one is what starts the attach, and the store it asks is the
            shell's (SessionCard's PreloadHoverContext). */}
        <PreloadHoverContext.Provider value={preload}>
          <Sidebar
            store={store}
            prefs={prefs}
            onNewSession={openComposer}
            altActive={engine.altActive}
            notifications={notifications}
            // ONE connection indicator at a time. This one exists for the screens
            // that have no session bar — the phone's list, which is the whole
            // viewport, and the desktop empty state — and it stands down whenever
            // the session bar's badge is on screen. Two dots 40px apart, scoped
            // differently, meant a dropped terminal showed amber in the bar and
            // green up here at the same time: individually correct, together a
            // contradiction (measured 2026-09-02).
            status={
              barOnScreen()
                ? undefined
                : {
                    channels: status.channels,
                    onOpen: () => openSettings("network"),
                  }
            }
            // The footer figure, which is the short answer to what the page it
            // opens says at length. Unlike the gear it is wired on every screen:
            // the shell bar has no room for a running total, and "what is this
            // session costing me" is asked from the desktop as often as from a
            // phone.
            onOpenSpend={() => openSettings("spend")}
            // The phone folds the shell bar (and with it the gear) into the
            // session bar, which only exists once a session is open. Without this
            // the sidebar's own screen has no route to Settings at all.
            onOpenSettings={flip() ? () => openSettings() : undefined}
            // The Skills panel needs the same phone route as Settings: its button
            // lives on the folded-away shell bar, and the session-bar menu that
            // also carries it is only there once a session is open.
            onOpenSkills={flip() ? () => openSettings("skills") : undefined}
            // Same reason as onOpenSettings: on a phone the shell bar that
            // carries the chip is folded away, so the list screen needs its own
            // one-tap route back to your own lobby.
            actAsChip={flip() ? actAsChip() : undefined}
            // The sidebar's half of a Workspace. It asks three questions and
            // the shell is the only thing that can answer any of them: which
            // group is on screen, which group holds a given session, and what a
            // click on one means.
            workspaces={{
              current: () => tiles()?.id ?? null,
              // THE SERVER'S DOCUMENT, not this device's geometry. Membership
              // roams and arrangements do not (ADR-0027), so a session can
              // belong to a workspace this browser has never laid out — and a
              // card that went unmarked for that would be a click that opened a
              // group with nothing on screen having said it was one.
              // By keepalive KEY, which is the identity the card hands over
              // (`SessionCard`: `owner: foreign() ? s().owner : undefined`).
              // A foreign session is a member like any other now, so there is
              // no owner check to bail on — and comparing names instead would
              // mark YOUR `auth` card for emo's `auth` sitting in a workspace.
              workspaceOf: (sel) => {
                const want = keyOf(sel);
                return (
                  workspaceDoc().workspaces.find((w) => w.members.some((m) => keyOf(m) === want))
                    ?.id ?? null
                );
              },
              // ENTERING AND LEAVING NEED NOTHING HERE, and that is worth saying
              // rather than leaving as an empty function. The workspace on
              // screen is derived from the SELECTION (`tiles`), and the card has
              // already moved that with `store.select` — so clicking a member
              // enters its group and clicking a non-member leaves the one you
              // were in, both without a second write. What this does add is the
              // one thing derivation cannot: a divider drag being held open for
              // coalescing is closed off by a deliberate act, so the undo stack
              // reads in the order things happened.
              onOpen: () => workspaceUndo.flush(),
            }}
          />
        </PreloadHoverContext.Provider>
      </aside>

      {/* The seam, draggable. Outside the <aside> because it straddles that
          element's border and the aside clips its own overflow. */}
      <SidebarGrip sidebar={sidebarWidth} />

      <div class="tl-shell-content">
        <div class="tl-shellbar">
          <button
            class="tl-icon-btn tl-sidebar-toggle"
            aria-label={collapsed() ? "Show sidebar" : "Hide sidebar"}
            title={collapsed() ? "Show sidebar" : "Hide sidebar"}
            onClick={toggleSidebar}
          >
            {collapsed() ? "›" : "‹"}
          </button>
          <span class="tl-brand">terminal-lobby</span>
          {/* The bell lives in the sidebar's lobby header, beside the title —
              where the vanilla page keeps it. The shell bar carries the
              collapse arrow, the brand and Settings. */}
          <span class="tl-shellbar-spacer" />
          {actAsChip()}
          {skillsButton()}
          {settingsButton()}
        </div>

        {/* ONE SESSION BAR FOR THE TAB, portaled in by whichever slot is
            focused and empty whenever nothing is open. `display: contents`
            (sidebar.css) so it takes no box of its own: the bar it holds is a
            direct flex child of this column, exactly as it was of
            `.tl-session-view`. See `barHost` above for why it is out here. */}
        {barHost}

        <div
          class="tl-shell-body"
          ref={(el) => mountShellBody(el)}
          // What an offstage preload has to leave out of its own box, so it is
          // measured against the pane a session actually gets rather than the
          // whole column (app.css, `.tl-offstage`). Zero whenever the panel is
          // not on screen, which is every phone and most desktops.
          style={{ "--tl-dock-h": dock.mounted() ? `${dock.ratio()}%` : "0px" }}
        >
          {/* Nothing selected is not an empty state any more: it is where a
              session is started. On a phone it is also the LANDING view, so its
              header carries the one control that gets to the list. */}
          <Show when={!selectedName()}>
            <NewSessionComposer
              store={store}
              prefs={prefs}
              available={cmdAvail}
              project={composerProject}
              onProject={(name) => {
                setPresetProject(name);
                prefs.setPref({ session: { newProject: name } });
              }}
              leading={
                <Show when={flip()}>
                  <button
                    class="tl-icon-btn tl-back-btn"
                    aria-label="Back to sessions"
                    onClick={() => setCollapsed(false)}
                  >
                    ‹<span class="tl-btn-label">Sessions</span>
                  </button>
                </Show>
              }
            />
          </Show>
          {/* Every session opened in this tab stays mounted, and the ones being
              read are the ones not hidden. The slots are appended and never
              reordered, so a live terminal is never moved in the DOM.

              THAT IS WHY A WORKSPACE IS POSITIONING AND NOT ARRANGEMENT
              (ADR-0027). The visible set decides which slots are on screen and
              `tileRects` decides where each one sits; neither touches this
              list's order, and neither reparents a slot. A tile crossing the
              screen is four numbers changing on a node that stays put.

              The session under the POINTER is in here too, hidden like the
              rest and attached with `pre` (ADR-0026). Clicking it is the
              cheapest thing this list does: the slot stops being a preload,
              loses `tl-hidden`, and the terminal it already has is what you
              are looking at. */}
          <For each={mounted()}>
            {(k) => {
              // This slot's connection channels go when the slot does. A row
              // leaves on the 24-hour TTL or on the session leaving the lobby,
              // and a report left behind would be answered to a later mount of
              // the same name that has not said anything yet.
              onCleanup(() => forgetConn(k.key));
              const shown = () => visibleKeys().has(k.key);
              /** Where the keystrokes are going. One tile at a time, and it is
               *  the selected session, so the URL, the session bar and the
               *  window handles cannot disagree about which one. */
              const focused = () => k.key === selectedKey();
              /** This slot's tile, or undefined when it is not in a workspace
               *  — which is the ordinary lobby and needs no positioning. */
              const rect = () => tileRects().get(k.key);
              /** Mounted by a hover, and nobody has asked to see it yet. */
              const preloading = () => preload.preloaded()?.key === k.key;
              /**
               * THIS tile's session, found BY KEY rather than by name.
               *
               * A tile is keyed owner+name because your `auth` and emo's `auth`
               * are two different terminals, and `store.sessions` holds both.
               * A `find` on the name alone returns whichever the poll listed
               * first, so a foreign tile could draw its own title, its own
               * state dot, its own watch marker and its own kill countdown from
               * somebody else's session. Normalised the way `liveKeys` does it
               * — an own session keys with no owner even though `/sessions`
               * stamps one on it — so the two sides compare in one space.
               */
              const tileSession = () =>
                store.sessions.find(
                  (s) =>
                    keyOf(
                      s.owner && s.owner !== store.me()
                        ? { name: s.name, owner: s.owner }
                        : { name: s.name },
                    ) === k.key,
                );
              const label = () => sessionLabel(tileSession() ?? { name: k.name });
              return (
                <div
                  class="tl-session-slot"
                  classList={{ ...slotClasses(shown(), preloading()), "tl-tiled": !!rect() }}
                  style={tileStyle(rect())}
                  // The presence of the attribute is the whole message: this
                  // slot is a speculative attach rather than a session somebody
                  // opened. It goes the moment a click promotes it.
                  data-preload={preloading() ? "" : undefined}
                  // CLICK A TILE TO FOCUS IT. Focus-follows-mouse was rejected
                  // in the design because a stray mouse movement sends the next
                  // keystrokes to a different agent, and in a terminal that
                  // means running them. A press is deliberate, so a press is
                  // what moves focus. Only inside a workspace: outside one the
                  // session on screen is the selected one by definition, and a
                  // select here would be a write on every click in a terminal.
                  //
                  // CAPTURE PHASE, and so a listener rather than `onPointerDown`.
                  // The press that has to move focus is a press INTO a live
                  // terminal, and xterm handles its own pointer events; Solid
                  // delegates `onPointerDown` to the document and runs it after
                  // the bubble, so anything inside that stops propagation would
                  // leave a tile you clicked unfocused with nothing on screen to
                  // explain it. Capture reaches this slot before any of it.
                  ref={(el) => {
                    const press = (e: PointerEvent): void => {
                      if (!rect()) return;
                      const on = e.target instanceof Element ? e.target : null;
                      // A BUTTON IN THE HEADER TAKES THE WHOLE PRESS, and this
                      // has to come BEFORE the select, which is where it sat
                      // until it was measured in a browser on 2026-09-12.
                      //
                      // A click is a pointerdown and a pointerup on the SAME
                      // element. Selecting here re-runs the `Show` that holds
                      // the header, which builds a new button, so the pointerup
                      // lands on a node that was not there for the pointerdown
                      // and no click is ever dispatched. Pressing ✕ on an
                      // unfocused tile therefore FOCUSED it and closed nothing,
                      // with no error and no request to explain it — measured
                      // against the real app, where the suite could not see it
                      // because a test clicks the button directly.
                      //
                      // Nothing is lost by returning: a control in the strip
                      // acts on the tile it is drawn on, so it does not need
                      // that tile focused first, and the drag below already
                      // declined a press on a button for its own reason.
                      if (on?.closest(".tl-tile-header") && on.closest("button")) return;
                      if (!focused()) store.select(k.name, k.owner);
                      // A TILE IS DRAGGED BY ITS HEADER, which is also the strip
                      // that names it, so the press that focuses a tile and the
                      // press that lifts it are one press until the pointer
                      // moves.
                      if (!on?.closest(".tl-tile-header")) return;
                      watchTileDrag(e, () => beginTileDrag(k.key));
                    };
                    el.addEventListener("pointerdown", press, true);
                    onCleanup(() => el.removeEventListener("pointerdown", press, true));
                  }}
                >
                  {/* The tile's own chrome: title, state, a watch marker when
                      this tile cannot type, and a close. Mounted only for a slot
                      the tree has given a rectangle to — a lone session has the
                      session bar above it and needs no second strip.

                      WATCHING IS READ FROM WHAT THE ATTACH ACTUALLY DID rather
                      than from the choice that was made. `SessionView` publishes
                      its resolved watch (store/watchmode.ts), and a tile that
                      does not claim its session's Grid is exactly a tile whose
                      attach came back read-only — so this marker and the
                      declined claim cannot disagree. */}
                  <Show when={rect()}>
                    <TileHeader
                      session={tileSession() ?? { name: k.name }}
                      focused={focused()}
                      watching={resolvedWatchFor(k.name) === true}
                      onClose={() => closeTile(k.key)}
                      // THE KILL WINDOW, drawn where the person is standing.
                      // Killing a tiled session dims the sidebar card and
                      // counts it down; until these four props were passed the
                      // TILE showed nothing at all and then vanished, which is
                      // the one surface the reader is actually looking at
                      // saying nothing about the eight seconds they have
                      // (design, "Death and restore"). All four are optional on
                      // the header, so the gap typechecked and drew nothing.
                      killing={store.killing(k.name)}
                      killingUntil={store.killingUntil(k.name)}
                      // The workspace's one clock, armed by the kill itself.
                      // Not a second interval per tile — see `killTick`.
                      tick={killTick}
                      onUndoKill={() => void undoTileKill(k.name)}
                    />
                  </Show>
                  <TileFocusContext.Provider value={focused}>
                    <SessionView
                      session={k.name}
                      label={label()}
                      // THE BAR IS NOT PART OF THIS SLOT. Passed to every
                      // mount, because any of them can become the focused one
                      // and the bar follows focus — only the focused view
                      // renders it, and it renders it into the shell's strip
                      // rather than inside this box. A tile therefore has no
                      // bar, and its rectangle does not change when focus does.
                      barHost={barHost}
                      owner={k.owner}
                      me={store.me}
                      lens={lens}
                      preloading={preloading}
                      // Only the slot this describes is listening; the store
                      // checks the key before it acts on either answer.
                      onPreload={(state) => {
                        const sel = { name: k.name, owner: k.owner };
                        if (state === "landed") preload.markLanded(sel);
                        else preload.markFailed(sel);
                      }}
                      otherSessions={() =>
                        flatSessionOrder(store.model())
                          .filter((o) => o.name !== k.name)
                          .map((o) => ({
                            ...o,
                            // Titled sessions read by their title here too.
                            label: sessionLabel(
                              store.sessions.find((s) => s.name === o.name) ?? { name: o.name },
                            ),
                          }))
                      }
                      // EVERY MOUNT SPEAKS, UNDER ITS OWN KEY, and the shell
                      // reads the focused one. Four of these were a single
                      // `let` or a single signal until 2026-09-12, so the last
                      // view to mount owned the connection badge, Run check and
                      // Reconnect for the whole tab — a bug older than tiles,
                      // which a preload could already win on a hover, and which
                      // a workspace makes ordinary: four visible tiles all
                      // report, and one of them is the session being read. The
                      // routing is at the top of this file, beside the maps.
                      status={{
                        channels: status.channels,
                        onOpen: () => openSettings("network"),
                        onTranscript: (s) =>
                          setTranscriptConn((held) => new Map(held).set(k.key, s)),
                        onTerminalConn: (r) => onTerminalConn(k.key, r),
                        askConn: (ask) => {
                          askConn.set(k.key, ask);
                        },
                        retryConn: (retry) => {
                          retryConn.set(k.key, retry);
                        },
                      }}
                      onSwitchSession={(n, owner) => store.select(n, owner)}
                      visible={shown() && (!flip() || collapsed())}
                      // A TILE IS THE SIZE THE SESSION IS, and a pinned tmux
                      // window only re-reads its clients on an attach, a detach
                      // or a resize — so a tile revealed beside another, or left
                      // behind when its neighbour closed, has to say its size
                      // again or the window keeps whatever the last tile to
                      // speak left it at. Passed to every mount, not only the
                      // ones in a workspace: leaving one is a change to the
                      // visible set for the session you are left looking at.
                      visibleSet={visibleStamp}
                      leading={
                        <Show when={flip()}>
                          <button
                            class="tl-icon-btn tl-back-btn"
                            aria-label="Back to sessions"
                            onClick={() => setCollapsed(false)}
                          >
                            ‹<span class="tl-btn-label">Sessions</span>
                          </button>
                        </Show>
                      }
                      menuExtra={
                        <Show when={flip()}>
                          <button
                            class="tl-menu-item"
                            role="menuitem"
                            onClick={() => openSettings("skills")}
                          >
                            Skills
                          </button>
                          <button
                            class="tl-menu-item"
                            role="menuitem"
                            onClick={() => openSettings()}
                          >
                            Settings
                          </button>
                        </Show>
                      }
                      driven={() =>
                        store.sessions.some((s) => s.name === k.name && s.driven === true)
                      }
                      background={() => store.sessions.find((s) => s.name === k.name)?.bg}
                      // THE SESSION'S OWN WINDOW SIZE, for a tile that is
                      // WATCHING: it never claims the Grid, so this is the only
                      // thing that can tell its terminal how big the session it
                      // is showing actually is, and drawing at that size is
                      // what puts dead space around it instead of tmux's own
                      // border and dots (design, "Watching tiles").
                      //
                      // BY KEY, through `tileSession`, for the reason that
                      // lookup exists: your `auth` and emo's `auth` are two
                      // rows in one list, and a find on the name alone would
                      // hand this tile the other session's size.
                      //
                      // Null unless BOTH numbers are real. tmux-api omits them
                      // when it could not read a size, and half a size is not
                      // one — `fitTarget` refuses either way, and saying so
                      // here keeps the shape honest.
                      grid={() => {
                        const s = tileSession();
                        return s?.cols && s?.rows ? { cols: s.cols, rows: s.rows } : null;
                      }}
                      // FOCUSED, NOT MERELY VISIBLE. Both of these describe the
                      // SELECTED session — the one the URL names — and four
                      // visible tiles would otherwise all be told that a
                      // session is being created and all be handed the selected
                      // session's project directory to be born in. Outside a
                      // workspace focused and visible are the same slot, which
                      // is what they meant when `shown()` was an equality test.
                      creating={focused() && selectedIsCreating()}
                      dir={focused() ? selectedDir() : undefined}
                      newCommand={newCommand}
                      newLaunch={newLaunch}
                      tool={() => store.sessions.find((s) => s.name === k.name)?.tool}
                      prefs={prefs}
                      notify={notify}
                      overlayOpen={overlayOpen}
                      // This reaches the LOBBY, so only the session on screen may
                      // speak: a hidden mount raising a badge would be a session
                      // acting from behind another.
                      onTerminalAttention={(kind, session) => {
                        if (shown()) notifications.onTerminalAttention(kind, session);
                      }}
                      onOpenGallery={() => void gallery.open()}
                      // One shell, one preview state, so the focused tile owns
                      // it: the switch chords read `dirty` before they move the
                      // selection, and a second visible tile reporting a clean
                      // editor would let a switch bin the draft in the tile you
                      // are actually typing in.
                      onPreviewState={(st) => focused() && setPreviewState(st)}
                    />
                  </TileFocusContext.Provider>
                </div>
              );
            }}
          </For>
          {/* THE SKELETON, over the slots and holding none of them. Nested
              @corvu/resizable nodes with nothing inside them, transparent
              except for the dividers, which is the only way a resize library
              can be used at all under ADR-0027: every one of them wants the
              panes as its own children and reparents one whenever the tree
              changes, and reparenting a pane here would dispose an xterm, a
              ttyd socket and a tmux attach.

              It is mounted only while there IS a workspace, so a lone session
              renders exactly the DOM it rendered last week. */}
          <Show when={workspaceTree()}>
            {(tree) => (
              <WorkspaceCanvas
                tree={tree()}
                container={tileArea()}
                focused={selectedKey()}
                // Recorded WITH the tree they describe, so a rect list left
                // over from the workspace you just left is detectable rather
                // than silently laid over the new one. `untrack` because the
                // canvas calls this from an effect: reading the memo here must
                // not subscribe that effect to it.
                onRects={(rects) => setLaid({ tree: untrack(workspaceTree), rects })}
                // A drag at a junction moves two axes at once, so two roots
                // report in the same frame and the second write has to see the
                // first one's tree. Reading `workspaceTree()` fresh is what
                // gives it that: `setTree` bumps the store's version, the memo
                // re-derives, and the second call reads the tree the first one
                // wrote.
                onFractions={(path, fractions) => {
                  const group = untrack(tiles);
                  const current = untrack(workspaceTree);
                  if (!group || !current) return;
                  const next = setFractions(current, path, fractions, untrack(tileArea));
                  if (next === current) return;
                  // GEOMETRY ONLY. A divider moves no session between groups, so
                  // the membership document is untouched and nothing goes to
                  // tmux-api — a drag would otherwise be a PUT per settle of a
                  // document that had not changed.
                  workspaceGeometry.setTree(group.id, next);
                  // The undo half, held open and folded into the rest of this
                  // drag. A handle reports forty rows of fractions a second and
                  // the stack is 25 deep, so one drag is one entry or it is the
                  // whole history (store/undo.workspace.ts).
                  workspaceUndo.record(group.id, current, next);
                }}
              />
            )}
          </Show>
          {/* WHERE THE TILE WILL LAND, and the whole of the feedback a drag
              gets. Tiles cannot slide around under the cursor: moving the node a
              session hangs off disposes its terminal, which is the 779 ms
              rebuild keepalive exists to avoid and the rule ADR-0027 makes
              binding. So nothing moves while you drag, a translucent shadow
              stands where the tile is going, and the tiles snap on release.

              DRAWN HERE RATHER THAN BY THE CANVAS, for the reason the drop
              surface is the shell body: the canvas is mounted only once a
              workspace exists, and the first split is made while a lone session
              is on screen. Inline styles for the same reason `WorkspaceCanvas`
              sets its pointer-events inline — a sheet over four live terminals
              must not depend on a stylesheet having loaded — and the colours are
              theme tokens, so all nine themes draw it. */}
          <Show when={dropShadow()}>
            {(shadow) => (
              <>
                {/* EVERY TILE'S POST-DROP RECT, not only the one in the air.
                    Viktor asked for what desktop window snapping gives you: a
                    picture of the arrangement you are about to get. The
                    neighbours a split is about to move are drawn as hollow
                    outlines, so the reflow is visible before it happens, and
                    the landing tile is filled and labelled so there is no doubt
                    which rectangle the session lands in. */}
                <For each={shadow().rects}>
                  {(r) => (
                    <Show when={!shadow().landing || r.key !== shadow().dragged}>
                      <div
                        class="tl-tile-ghost"
                        aria-hidden="true"
                        style={{
                          position: "absolute",
                          left: `${r.x}px`,
                          top: `${r.y}px`,
                          width: `${r.width}px`,
                          height: `${r.height}px`,
                          "z-index": "3",
                          "pointer-events": "none",
                          "border-radius": "var(--radius)",
                          outline: "2px dashed color-mix(in srgb, var(--accent) 85%, transparent)",
                          "outline-offset": "-2px",
                          // Darkened rather than tinted. A ghost sits over a
                          // live terminal that is still drawing, and a faint
                          // accent wash loses to the text underneath it; taking
                          // light OUT of the region is what makes the boundary
                          // read at a glance, which is the whole ask.
                          background: "color-mix(in srgb, var(--bg-page) 55%, transparent)",
                        }}
                      />
                    </Show>
                  )}
                </For>
                <div
                  class="tl-tile-shadow"
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    left: `${shadow().landing?.x ?? 0}px`,
                    top: `${shadow().landing?.y ?? 0}px`,
                    width: `${shadow().landing?.width ?? 0}px`,
                    height: `${shadow().landing?.height ?? 0}px`,
                    // Above the skeleton, which is above the slots, and above
                    // the ghosts so a landing rect that shares an edge with one
                    // still reads as the solid half of the pair.
                    "z-index": "4",
                    "pointer-events": "none",
                    "border-radius": "var(--radius)",
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "center",
                    // A refused split is drawn in the shape that was refused and
                    // marked as refused: a drop that silently did nothing would
                    // read as a broken drag rather than as a tile too small.
                    background: shadow().invalid
                      ? "color-mix(in srgb, var(--text-muted) 14%, transparent)"
                      : "color-mix(in srgb, var(--accent) 42%, transparent)",
                    outline: `3px ${shadow().invalid ? "dashed" : "solid"} var(${
                      shadow().invalid ? "--text-muted" : "--accent"
                    })`,
                    "outline-offset": "-3px",
                    "box-shadow": shadow().invalid
                      ? "none"
                      : "0 0 0 1px color-mix(in srgb, var(--bg-page) 60%, transparent), 0 8px 24px color-mix(in srgb, var(--accent) 22%, transparent)",
                  }}
                >
                  {/* The name of the thing being dropped, because at four tiles
                      a bare rectangle does not say WHICH session is about to
                      land in it. Hidden when the rectangle is too small to hold
                      a word without becoming the thing you are looking at. */}
                  <Show
                    when={
                      (shadow().landing?.width ?? 0) >= 180 && (shadow().landing?.height ?? 0) >= 64
                    }
                  >
                    <span class="tl-tile-shadow-label">
                      {shadow().invalid
                        ? "Too small to split"
                        : sessionLabel(
                            store.sessions.find(
                              (x) => x.name === sessionOf(shadow().dragged ?? "").name,
                            ) ?? { name: sessionOf(shadow().dragged ?? "").name },
                          )}
                    </span>
                  </Show>
                </div>
              </>
            )}
          </Show>
          <Dock dock={dock} />
        </div>
      </div>

      <Show when={settingsOpen()}>
        <SettingsPanel
          prefs={prefs}
          availableCommands={cmdAvail}
          onClose={() => setSettingsOpen(false)}
          initialPage={settingsPage()}
          onPageChange={setSettingsPage}
          keybindings={{
            enabled: engine.enabled,
            setEnabled: engine.setEnabled,
            altLabel: engine.altLabel,
          }}
          notifications={notifications}
          connection={connControl}
          actAs={actAsControl()}
          skills={skills}
          skillSessions={skillSessions}
          sessionTitles={sessionTitles}
        />
      </Show>

      <Show when={palette.isOpen()}>
        <CommandPalette controller={palette} />
      </Show>

      <Show when={help.isOpen()}>
        <ShortcutsHelp controller={help} altLabel={engine.altLabel} isMac={engine.isMac} />
      </Show>

      <Show when={gallery.view() !== "closed"}>
        <Gallery store={gallery} />
      </Show>

      {/* No update UI, by design (ADR-0007): a new build applies itself at the
          next open. Nothing to tap, nothing to dismiss. */}

      <Toaster controller={toasts} />
    </div>
  );
};
