/**
 * The inverse of every LAYOUT-shaped action: a session dragged between groups
 * or up and down its own, the group sequence reordered, a project created,
 * renamed or deleted, and the session-order mode.
 *
 * One handler per kind, each of them an INVERSE OPERATION re-applied to the
 * document as it is right now. PUT /api/layout replaces the whole document and
 * carries no etag or version (store/lobby.ts:828 saveLayout), so an undo that
 * re-PUT the layout its action was looking at would erase a session another
 * device created in the meantime, or a project somebody added on their phone.
 * Every undo here therefore reads `ports.layout()`, folds the inverse into it
 * with the same pure transform the forward action used
 * (components/lobby.logic.ts), and writes the result. Redo does the same with
 * the forward operation.
 *
 * The one exception is a switch INTO manual, which freezes the visible order
 * into the layout and so overwrites a whole arrangement at once. Its inverse
 * cannot be smaller than the document it replaced, so that entry carries both
 * halves and its `check` refuses unless the live document is still exactly the
 * one the freeze wrote. Guarded like that it is a restore, not a blind write.
 *
 * WHERE THE PRECONDITIONS LIVE. `check` is asked before both directions and
 * cannot see which way it is about to run (store/undo.ts UndoHandler), so it
 * holds the tests that read the same either way: is the session still where
 * this entry left it, does the group still exist, is the mode still one end of
 * the switch. It is deliberately TOLERANT of everything else. A session another
 * device created shifts every index below it and has nothing to do with the
 * entry, so refusing there would cost the user their undo for somebody else's
 * create. The tests that only make sense in one direction (a project
 * name taken back, a project already deleted) sit in `undo` and `redo`, which
 * know which way they run and refuse by throwing.
 *
 * Refusal messages are sentences a person reads after a lead-in, so they start
 * lower case and name what changed rather than what the code found.
 */
import {
  addProject,
  deleteProject,
  groupSeqTokens,
  moveSession,
  removeSessionFromLayout,
  renameProject,
  reorderGroups,
  sameLayout,
} from "../components/lobby.logic";
import type { SessionOrder } from "../logic/order.logic";
import type { Layout } from "../types/lobby";
import {
  registerUndoHandler,
  type UndoEntryBase,
  type UndoHandler,
  type UndoHandlers,
} from "./undo";

/** A session dragged into a group, or up and down the one it was already in. */
export interface MoveEntry extends UndoEntryBase {
  readonly kind: "move";
  readonly session: string;
  /** The group the document had it in ("" = ungrouped). ABSENT means the
   *  document did not name it at all, which is an ordinary state: a session the
   *  layout has never placed renders as a swept-in leftover (deriveSidebar), so
   *  the inverse of dragging one is to take its entry back out again. */
  readonly fromGroup?: string;
  /** Its raw index in that group's array; -1 when it had none. */
  readonly fromIndex: number;
  readonly toGroup: string;
  readonly toIndex: number;
  /** The ordering mode as it was BEFORE the drag, set only when the drop
   *  flipped it to manual (store/lobby.ts:1389, where a drop that names a
   *  position hands ordering back to the user, because a timestamp sort would
   *  put the card straight back). Undoing the drag without undoing that
   *  leaves the sidebar stuck in manual, with nothing on screen saying why. */
  readonly orderBefore?: SessionOrder;
}

/** A group dragged up or down the sidebar, or stepped with Move up/down. */
export interface ReorderGroupsEntry extends UndoEntryBase {
  readonly kind: "reorderGroups";
  readonly from: number;
  readonly to: number;
  /** Which token moved: "p:<project>", or "u" for the Ungrouped sentinel. The
   *  indices alone would not do. A project created since shifts them, and the
   *  inverse would then slide whatever group had taken that slot. */
  readonly group: string;
}

export interface ProjectCreateEntry extends UndoEntryBase {
  readonly kind: "projectCreate";
  readonly name: string;
  readonly dir?: string;
}

export interface ProjectRenameEntry extends UndoEntryBase {
  readonly kind: "projectRename";
  readonly from: string;
  readonly to: string;
}

export interface ProjectDeleteEntry extends UndoEntryBase {
  readonly kind: "projectDelete";
  readonly name: string;
  readonly dir?: string;
  /** Its slot in the group sequence (groupSeqTokens), so undo puts it back
   *  where it was rather than beside Ungrouped where a fresh project lands. */
  readonly index: number;
  /** Its members, in the order it held them. In the base field on purpose:
   *  `sessions` is one of the two places a session NAME may live, so a rename
   *  landing while this entry sits on the stack is carried under it
   *  (store/undo.ts UndoEntryBase, ADR-0022). */
  readonly sessions: readonly string[];
}

/** What a switch into manual froze, and what it froze over. */
export interface OrderModeCapture {
  /** The arrangement the freeze replaced, which undo puts back. */
  readonly over: Layout;
  /** What the freeze wrote, which `check` compares the live document against
   *  so the restore is never a blind write. */
  readonly wrote: Layout;
}

export interface OrderModeEntry extends UndoEntryBase {
  readonly kind: "orderMode";
  readonly before: SessionOrder;
  readonly after: SessionOrder;
  /** Absent when the switch changed no arrangement. Leaving manual for a
   *  timestamp ordering writes no layout at all, since the arrangement stays in
   *  the document and the sort simply decides the order instead. */
  readonly capturedLayout?: OrderModeCapture;
}

/** What a layout inverse needs from the store that owns the actions. */
export interface LayoutUndoPorts {
  /** The document as it is NOW. Every inverse folds itself into this. */
  layout(): Layout;
  /** PUT it. false = the write did not land, and local state has been rolled
   *  back already (store/lobby.ts saveLayout, which also toasts). */
  save(next: Layout): Promise<boolean>;
  /** The session ordering mode, and how to change it. */
  order(): SessionOrder;
  setOrder(order: SessionOrder): void;
  /** The visible order folded into the layout: captureVisibleOrder over the
   *  live sidebar model, which is what a switch into manual freezes. */
  capture(): Layout;
  /** Collapse is keyed on the project NAME, a per-browser view preference
   *  rather than layout (store/lobby.ts:1522), so it travels with a rename and
   *  goes with a delete. */
  renameCollapse(from: string, to: string): void;
  removeCollapse(name: string): void;
}

const SAVE_FAILED = "the layout write did not go through";
const SESSION_MOVED = "that session has moved since";
const SESSION_GONE = "that session is gone";
const GROUP_GONE = "that group is gone";
const PROJECT_GONE = "that project is gone";
const PROJECT_ALREADY_GONE = "that project is already gone";
const PROJECT_NOT_EMPTY = "that project has sessions in it now";
const ORDER_CHANGED = "the session order changed elsewhere";
const ARRANGEMENT_CHANGED = "the sidebar arrangement changed since";

const taken = (name: string): string => `a project called "${name}" exists again`;

/**
 * Where the DOCUMENT has this session: its group ("" = ungrouped) and its raw
 * index in that group's array. null when no group names it, which is ordinary
 * rather than an error. deriveSidebar sweeps an unplaced session into the group
 * its own record claims, or into Ungrouped.
 *
 * The raw index, never a rendered one. The two diverge on purpose (dead refs
 * are filtered out of the render, leftovers swept in), and this is the space a
 * splice happens in.
 */
export function locate(layout: Layout, name: string): { group: string; index: number } | null {
  const u = layout.ungrouped.indexOf(name);
  if (u >= 0) return { group: "", index: u };
  for (const p of layout.projects) {
    const i = p.sessions.indexOf(name);
    if (i >= 0) return { group: p.name, index: i };
  }
  return null;
}

const hasProject = (layout: Layout, name: string): boolean =>
  layout.projects.some((p) => p.name === name);

/**
 * The two documents hold the same ARRANGEMENT: the same groups in the same
 * order, each with the same members in the same order.
 *
 * sameLayout with the dock lifted out of the comparison. Ctrl+J writes
 * layout.dock and has nothing to do with the order of anybody's cards, so a
 * scratch shell opened since a freeze is not a reason to refuse the undo of it.
 */
function sameArrangement(a: Layout, b: Layout): boolean {
  return sameLayout({ ...a, dock: b.dock }, b);
}

/**
 * Write a layout, moving the ordering mode with it when the entry says so.
 *
 * The mode changes BEFORE the write, the same order store/lobby.ts:1413 uses
 * and for the same reason: a frame rendered while the old ordering still ran
 * would sort the card straight back out of the seat the write just gave it. A
 * write that does not land takes the mode back with it.
 */
async function write(ports: LayoutUndoPorts, next: Layout, order?: SessionOrder): Promise<void> {
  const was = ports.order();
  const flip = order !== undefined && order !== was ? order : null;
  if (flip !== null) ports.setOrder(flip);
  if (await ports.save(next)) return;
  if (flip !== null) ports.setOrder(was);
  throw new Error(SAVE_FAILED);
}

function moveHandler(ports: LayoutUndoPorts): UndoHandler<MoveEntry> {
  return {
    check(entry) {
      const at = locate(ports.layout(), entry.session);
      const group = at ? at.group : null;
      // The INDEX is deliberately not compared. Every session another device
      // creates or kills shifts the indices around this one, and an entry that
      // refused for that would refuse most of the time. The group is the slice
      // this entry owns: still in the group the drag put it in means the undo
      // is the next thing to happen to it, and back in the group it came from
      // means the undo already ran and a redo is pending.
      if (group === entry.toGroup) return null;
      if (group === (entry.fromGroup ?? null)) return null;
      return group === null ? SESSION_GONE : SESSION_MOVED;
    },
    async undo(entry) {
      const cur = ports.layout();
      const next =
        entry.fromGroup === undefined
          ? removeSessionFromLayout(cur, entry.session)
          : moveSession(cur, entry.session, entry.fromGroup, entry.fromIndex);
      await write(ports, next, entry.orderBefore);
    },
    async redo(entry) {
      const next = moveSession(ports.layout(), entry.session, entry.toGroup, entry.toIndex);
      // The forward action flipped the mode to manual whenever it recorded one,
      // so doing it again flips it the same way.
      await write(ports, next, entry.orderBefore === undefined ? undefined : "manual");
    },
  };
}

/** Slide one group token to `to`, reading its position from the live document. */
async function slide(ports: LayoutUndoPorts, token: string, to: number): Promise<void> {
  const cur = ports.layout();
  const at = groupSeqTokens(cur).indexOf(token);
  if (at < 0) throw new Error(GROUP_GONE);
  await write(ports, reorderGroups(cur, at, to));
}

function reorderGroupsHandler(ports: LayoutUndoPorts): UndoHandler<ReorderGroupsEntry> {
  return {
    check(entry) {
      // Only its existence. A project created or deleted since shifts every
      // token below it, so comparing the group's index against `to` would
      // refuse for a change that has nothing to do with this entry; the cost of
      // tolerating it is that the group can land a slot out when the sequence
      // has changed underneath, both slots being on screen either way.
      return groupSeqTokens(ports.layout()).includes(entry.group) ? null : GROUP_GONE;
    },
    async undo(entry) {
      await slide(ports, entry.group, entry.from);
    },
    async redo(entry) {
      await slide(ports, entry.group, entry.to);
    },
  };
}

function projectCreateHandler(ports: LayoutUndoPorts): UndoHandler<ProjectCreateEntry> {
  return {
    check(entry) {
      const project = ports.layout().projects.find((p) => p.name === entry.name);
      // Only the undo direction can find the project at all, a redo running
      // after the undo removed it, so a project that is there and no longer
      // empty is unambiguously an undo that would tip somebody's sessions into
      // Ungrouped. The drag that put them there is its own entry and comes off
      // the stack first, so the ordinary path never reaches this.
      return project && project.sessions.length > 0 ? PROJECT_NOT_EMPTY : null;
    },
    async undo(entry) {
      const cur = ports.layout();
      if (!hasProject(cur, entry.name)) throw new Error(PROJECT_ALREADY_GONE);
      await write(ports, deleteProject(cur, entry.name));
      ports.removeCollapse(entry.name);
    },
    async redo(entry) {
      const cur = ports.layout();
      if (hasProject(cur, entry.name)) throw new Error(taken(entry.name));
      await write(ports, addProject(cur, entry.name, entry.dir));
    },
  };
}

function projectRenameHandler(ports: LayoutUndoPorts): UndoHandler<ProjectRenameEntry> {
  return {
    check(entry) {
      const cur = ports.layout();
      const from = hasProject(cur, entry.from);
      const to = hasProject(cur, entry.to);
      // Both names taken blocks both directions: renameProject refuses a name
      // that already exists (and PUT /api/layout would too), so there is
      // nowhere for the rename to go either way.
      if (from && to) return taken(entry.from);
      if (!from && !to) return PROJECT_GONE;
      return null;
    },
    async undo(entry) {
      const cur = ports.layout();
      if (!hasProject(cur, entry.to)) throw new Error(PROJECT_GONE);
      await write(ports, renameProject(cur, entry.to, entry.from));
      ports.renameCollapse(entry.to, entry.from);
    },
    async redo(entry) {
      const cur = ports.layout();
      if (!hasProject(cur, entry.from)) throw new Error(PROJECT_GONE);
      await write(ports, renameProject(cur, entry.from, entry.to));
      ports.renameCollapse(entry.from, entry.to);
    },
  };
}

function projectDeleteHandler(ports: LayoutUndoPorts): UndoHandler<ProjectDeleteEntry> {
  return {
    check() {
      // Nothing here reads the same in both directions. The project existing
      // means either that an undo has already put it back, so a redo is
      // pending, or that somebody recreated the name behind us, and only the
      // direction tells those apart. Both guards are in undo and redo below.
      return null;
    },
    async undo(entry) {
      const cur = ports.layout();
      if (hasProject(cur, entry.name)) throw new Error(taken(entry.name));
      let next = addProject(cur, entry.name, entry.dir);
      // addProject lands a fresh project beside the Ungrouped sentinel, which
      // is right for a project somebody just named and wrong for one coming
      // back: it has a seat of its own to return to.
      const at = groupSeqTokens(next).indexOf("p:" + entry.name);
      if (at >= 0 && at !== entry.index) next = reorderGroups(next, at, entry.index);
      // Only the members still sitting where the delete dropped them. One that
      // has been filed into another project since is not this entry's to take
      // back, and one that has been killed is not there to take.
      const back = entry.sessions.filter((name) => next.ungrouped.includes(name));
      back.forEach((name, i) => {
        next = moveSession(next, name, entry.name, i);
      });
      await write(ports, next);
    },
    async redo(entry) {
      const cur = ports.layout();
      if (!hasProject(cur, entry.name)) throw new Error(PROJECT_ALREADY_GONE);
      await write(ports, deleteProject(cur, entry.name));
      ports.removeCollapse(entry.name);
    },
  };
}

function orderModeHandler(ports: LayoutUndoPorts): UndoHandler<OrderModeEntry> {
  return {
    check(entry) {
      const cur = ports.order();
      // The mode roams (prefs `sidebar.order`), so another device can have
      // picked a third ordering since. Neither end of this switch then
      // describes the world, and flipping the mode would be a change the user
      // did not ask for rather than an undo.
      if (cur !== entry.before && cur !== entry.after) return ORDER_CHANGED;
      const cap = entry.capturedLayout;
      if (cap && cur === entry.after && !sameArrangement(ports.layout(), cap.wrote)) {
        return ARRANGEMENT_CHANGED;
      }
      return null;
    },
    async undo(entry) {
      const cap = entry.capturedLayout;
      // The guard AGAIN, here rather than only in `check`, because `check`
      // cannot see which direction it is about to run and this test only holds
      // for one of them. The undo below restores a whole document, so it may
      // only run while the live one is still the document the freeze wrote;
      // after an undo the live document is `cap.over` instead, which is
      // exactly what a redo starts from, so the same test in `check` would
      // refuse every redo.
      //
      // `check` therefore asks it only in the state it can be sure of
      // (`cur === entry.after`), and the hole that leaves is real: the mode
      // ROAMS through prefs `sidebar.order`, so another device can have moved
      // it back to `entry.before` while this tab still holds the entry. The
      // first leg of `check` then passes, the arrangement leg is skipped, and
      // without this line the undo would PUT a document captured before the
      // other device's session existed. PUT /api/layout replaces the whole
      // document with no version check (store/lobby.ts saveLayout), so that
      // one write is the blind write this whole file exists to avoid.
      if (cap && !sameArrangement(ports.layout(), cap.wrote)) {
        throw new Error(ARRANGEMENT_CHANGED);
      }
      // The mode first. After it the list is back on a timestamp ordering, so
      // the arrangement the write puts back is not on screen while it lands.
      const was = ports.order();
      ports.setOrder(entry.before);
      if (cap && !(await ports.save(cap.over))) {
        ports.setOrder(was);
        throw new Error(SAVE_FAILED);
      }
    },
    async redo(entry) {
      const cap = entry.capturedLayout;
      if (cap) {
        // Frozen from what is on screen NOW rather than replayed from the
        // entry, for the reason the whole file exists: the document has moved
        // on, and `cap.wrote` describes sessions that may no longer be there.
        const wrote = ports.capture();
        if (!sameLayout(ports.layout(), wrote) && !(await ports.save(wrote))) {
          throw new Error(SAVE_FAILED);
        }
      }
      ports.setOrder(entry.after);
    },
  };
}

/**
 * Every layout inverse, keyed by kind. A Map so a test can hand its own
 * registry to createUndoStore and stay isolated from the module-wide one.
 */
export function layoutUndoHandlers(ports: LayoutUndoPorts): UndoHandlers {
  return new Map<string, UndoHandler>([
    ["move", moveHandler(ports)],
    ["reorderGroups", reorderGroupsHandler(ports)],
    ["projectCreate", projectCreateHandler(ports)],
    ["projectRename", projectRenameHandler(ports)],
    ["projectDelete", projectDeleteHandler(ports)],
    ["orderMode", orderModeHandler(ports)],
  ]);
}

/** Teach the app-wide registry about all of them. Called from the store that
 *  owns the actions, at wiring time (store/lobby.ts). */
export function registerLayoutUndoHandlers(ports: LayoutUndoPorts): void {
  for (const [kind, handler] of layoutUndoHandlers(ports)) registerUndoHandler(kind, handler);
}
