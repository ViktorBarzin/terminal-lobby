/**
 * The inverses of the per-browser VIEW state a person changes on purpose: a
 * sidebar group collapsed or expanded (store/collapse.ts), and watch mode
 * switched on a session (store/watchmode.ts).
 *
 * Neither reaches the server, so there is no document to fold an operation
 * into and no write that can fail. What these two still need is the VALUE, and
 * both entries carry both ends of their switch rather than deriving one from
 * the other. Watch mode is why: it has three states, not two (`true`, `false`,
 * and "nobody has said", whose distinctness store/watchmode.ts argues), and
 * `!undefined` is `true`, so an entry that remembered only the old value would
 * redo a switch to WATCHING after a person had chosen to drive.
 *
 * TWO KINDS, AND NOT FOUR. The scope this came from also named mark-seen and a
 * pin:
 *
 *   - MARK-SEEN is not a user action. store/visits.ts stamps a visit from the
 *     poll fold when a session is looked at, and nothing in this tree marks
 *     one unread, so an entry for it would mean Cmd+Z undoing "I read this",
 *     which eats the press that belongs to the kill or the retitle beneath.
 *   - a PIN has no feature behind it here at all.
 *
 * WATCH MODE IS NOT FREE TO UNDO. The choice decides how the terminal attaches
 * (`arg=ro`, lib/terminal-url.ts:96), so flipping it back detaches and
 * reattaches the session with a resize and an activity bump. Reversible, and
 * cheap enough to be worth a press, but not nothing: nobody should later read
 * this as a pure local toggle.
 *
 * AN INVERSE IS QUIET. It writes through the stores' plain setters
 * (`CollapseStore.set`, `applyWatch`) rather than the actions a person
 * clicks, for two reasons: the actions record onto the stack, so an undo that
 * used them would push an entry and wipe the redo half the press is about to
 * fill; and their telemetry (`layout.group_toggled`, `watch.switched`) counts
 * somebody reaching for that affordance, which a Cmd+Z press is not. Whatever
 * records an undo press belongs with the keybinding that reads it.
 *
 * Refusal messages are sentences a person reads after a lead-in, so they start
 * lower case and name what changed.
 */
import type { WatchChoice } from "./watchmode";
import {
  registerUndoHandler,
  type UndoEntryBase,
  type UndoHandler,
  type UndoHandlers,
} from "./undo";

/** A sidebar group collapsed or expanded from its header. */
export interface CollapseEntry extends UndoEntryBase {
  readonly kind: "collapse";
  /** Whose sidebar. The map is keyed per OS user (`tmux-collapsed-<user>`),
   *  and undoing this against a different one would flip a group in an account
   *  the entry says nothing about. */
  readonly user: string;
  /** The group key: a project name, or one of the two sentinels
   *  (store/collapse.ts UNGROUPED_KEY, SHARED_KEY). */
  readonly group: string;
  readonly was: boolean;
}

/** Watch mode switched on one session. */
export interface WatchEntry extends UndoEntryBase {
  readonly kind: "watch";
  readonly session: string;
  /** The choice before the switch. ABSENT means none was recorded, which is
   *  its own state: the session resolved automatically (resolveWatch). */
  readonly was?: boolean;
  /** What the switch chose. Absent for a switch back to no choice at all. */
  readonly to?: boolean;
  /** The act-as target the choice was written under, "" (absent) in an
   *  ordinary tab. Undo is off entirely in a lens today (store/undo.ts
   *  UndoStoreOptions), so this is the entry keeping its own half of the
   *  contract rather than a path a person can reach. */
  readonly as?: string;
}

/** What the local inverses need from the stores that own the actions. */
export interface LocalUndoPorts {
  /** Which OS user's collapse map is loaded right now. */
  collapseUser(): string;
  isCollapsed(group: string): boolean;
  /** Collapse or expand, with no entry recorded and no toggle event emitted
   *  (store/collapse.ts `set`). Idempotent. */
  setCollapsed(group: string, collapsed: boolean): void;
  watchChoice(session: string, as: string): WatchChoice;
  /** Write a choice with no entry and no switch event (store/watchmode.ts
   *  `applyWatch`). */
  setWatchChoice(session: string, choice: WatchChoice, as: string): void;
}

const OTHER_ACCOUNT = "that group is in another account's sidebar";
const WATCH_CHANGED = "watch mode changed for that session since";

function collapseHandler(ports: LocalUndoPorts): UndoHandler<CollapseEntry> {
  return {
    check(entry) {
      // The value itself is not worth testing: it is a boolean, so it is
      // always one end of this switch or the other, and both ends are
      // legitimate (one before the undo, one before the redo). A group
      // somebody expanded from another tab in between simply makes the press a
      // no-op, which `setCollapsed` absorbs. The ACCOUNT is the real question.
      return entry.user === ports.collapseUser() ? null : OTHER_ACCOUNT;
    },
    async undo(entry) {
      ports.setCollapsed(entry.group, entry.was);
    },
    async redo(entry) {
      ports.setCollapsed(entry.group, !entry.was);
    },
  };
}

function watchHandler(ports: LocalUndoPorts): UndoHandler<WatchEntry> {
  return {
    check(entry) {
      // Both ends pass, since `check` cannot see which way it is about to run
      // (store/undo.ts UndoHandler). A third value means somebody chose
      // again. The switch is on two surfaces (the session bar and the card's
      // menu) and the state is shared with every other tab in this browser,
      // so that is an ordinary thing to happen, and overwriting their choice
      // is not an undo of anything they asked for.
      const now = ports.watchChoice(entry.session, entry.as ?? "");
      return now === entry.to || now === entry.was ? null : WATCH_CHANGED;
    },
    async undo(entry) {
      ports.setWatchChoice(entry.session, entry.was, entry.as ?? "");
    },
    async redo(entry) {
      ports.setWatchChoice(entry.session, entry.to, entry.as ?? "");
    },
  };
}

/** Both local inverses, keyed by kind. A Map so a test can hand its own
 *  registry to createUndoStore and stay isolated from the module-wide one. */
export function localUndoHandlers(ports: LocalUndoPorts): UndoHandlers {
  return new Map<string, UndoHandler>([
    ["collapse", collapseHandler(ports)],
    ["watch", watchHandler(ports)],
  ]);
}

/** Teach the app-wide registry about them. Called at wiring time from the
 *  store that holds the collapse instance (store/lobby.ts). */
export function registerLocalUndoHandlers(ports: LocalUndoPorts): void {
  for (const [kind, handler] of localUndoHandlers(ports)) registerUndoHandler(kind, handler);
}
