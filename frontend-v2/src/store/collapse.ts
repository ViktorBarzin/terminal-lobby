import { createSignal, type Accessor } from "solid-js";
import { track } from "../telemetry/track";
import { lsGet, lsSet } from "../lib/storage";
import type { UndoStore } from "./undo";

/**
 * Per-browser collapse state for sidebar groups. Deliberately NOT roamed (it is
 * a view preference, not layout — see CONTEXT.md "Layout"): the vanilla app
 * keyed it `tmux-collapsed-<user>` in localStorage. Group keys are project names
 * plus three sentinels that can't collide with a project name (a project name
 * matches [a-zA-Z0-9_-]{1,32}, so a leading ':' is safe).
 */
export const UNGROUPED_KEY = ":ungrouped";
export const SHARED_KEY = ":shared";
/** The System group. Its RenderGroup carries this string as its `name`
 *  (SYSTEM_GROUP_NAME in components/lobby.logic.ts), so every caller that keys
 *  the store by group name already lands here. */
export const SYSTEM_KEY = ":system";

/**
 * The keys that start CLOSED. Everything else starts open, which is what the
 * store meant when it held nothing but collapsed keys.
 *
 * System holds the sessions nobody asked for — harness fleets, strays — so it
 * opens closed and the count in its header is what says it is not empty. That
 * default cuts both ways and it is deliberate: a session that lands there
 * wrongly is behind one click rather than in front of you.
 */
const CLOSED_BY_DEFAULT = new Set<string>([SYSTEM_KEY]);

/**
 * The persisted set is "keys that DIFFER from their default", not "keys that
 * are collapsed".
 *
 * For every key with the old default the two readings are the same set, so
 * every device's existing file keeps meaning exactly what it meant. It is only
 * :system where membership reads the other way round — and since no stored file
 * has ever contained that key, absent correctly reads as collapsed on the first
 * boot after the upgrade with nothing to migrate.
 */
function startsCollapsed(key: string): boolean {
  return CLOSED_BY_DEFAULT.has(key);
}

function storageKey(user: string): string {
  return `tmux-collapsed-${user}`;
}

function load(user: string): Set<string> {
  try {
    const raw = lsGet(storageKey(user));
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function persist(user: string, set: Set<string>): void {
  lsSet(storageKey(user), JSON.stringify([...set]));
}

export interface CollapseStore {
  isCollapsed: (key: string) => boolean;
  toggle: (key: string) => void;
  /**
   * Collapse or expand, with no undo entry recorded and no toggle event
   * emitted. Idempotent.
   *
   * This is the path the inverse of a toggle runs on (store/undo.local.ts):
   * `toggle` records itself, so an undo that went through it would push an
   * entry and wipe the redo half the press is about to fill.
   */
  set: (key: string, collapsed: boolean) => void;
  /** expand a group (used by auto-expand-on-activate). */
  expand: (key: string) => void;
  /** follow a project rename — the key IS the project name, so a rename that
   *  leaves it behind pops the group open and hands the stale key to the next
   *  project that reuses the name. */
  rename: (from: string, to: string) => void;
  /** drop a deleted project's key, for the same reason. */
  remove: (key: string) => void;
  version: Accessor<number>;
}

/**
 * Reactive collapse store for one OS user. `version` bumps on every change so
 * memos that read isCollapsed re-run.
 *
 * `undo` is this tab's stack (store/undo.ts), passed by whoever holds it
 * (store/lobby.ts). Only `toggle` records, because only `toggle` is a person
 * collapsing something: auto-expand-on-activate and the inverse of a toggle
 * both go through the plain setters below. Omitted means nothing is recorded,
 * which is what every test of this store runs with.
 */
export function createCollapseStore(user: () => string, undo?: UndoStore): CollapseStore {
  const [version, setVersion] = createSignal(0);
  let current = load(user());
  let currentUser = user();

  const sync = () => {
    if (user() !== currentUser) {
      currentUser = user();
      current = load(currentUser);
    }
  };

  /**
   * The stored set is a FLIP flag, not a collapsed flag.
   *
   * For an ordinary group, holding the key means collapsed. For one that starts
   * closed (`startsCollapsed`), it means the opposite, because the flag records
   * a departure from the group's own default rather than a state. So expanding
   * a starts-closed group WRITES the key where expanding any other group clears
   * it, and every reader and writer has to go through this one conversion or
   * the two kinds of group drift apart.
   */
  const flagFor = (key: string, collapsed: boolean): boolean =>
    startsCollapsed(key) ? !collapsed : collapsed;
  const collapsedOf = (key: string): boolean => flagFor(key, current.has(key));

  const set = (key: string, collapsed: boolean) => {
    sync();
    const want = flagFor(key, collapsed);
    if (current.has(key) === want) return;
    if (want) current.add(key);
    else current.delete(key);
    persist(currentUser, current);
    setVersion((v) => v + 1);
  };

  return {
    isCollapsed: (key) => {
      version(); // track
      sync();
      return collapsedOf(key);
    },
    toggle: (key) => {
      track("layout.group_toggled", { "tl.key": key });
      sync();
      // The STATE before the flip, not the raw membership: an entry replays
      // through `setCollapsed` (store/undo.local.ts), which speaks collapsed
      // and expanded, and for a starts-closed group those are the opposite of
      // holding the key.
      const was = collapsedOf(key);
      set(key, !was);
      // After the write, and carrying the user whose map it wrote: the key is a
      // project name and the map is per OS user, so the entry has to say which
      // sidebar it is about (store/undo.local.ts CollapseEntry).
      undo?.push({ kind: "collapse", user: currentUser, group: key, was });
    },
    set,
    // Auto-expand-on-activate, and `set` is what makes it right for both kinds
    // of group: expanding one that starts closed writes the flag rather than
    // clearing it.
    expand: (key) => set(key, false),
    rename: (from, to) => {
      sync();
      if (!current.has(from)) return;
      current.delete(from);
      current.add(to);
      persist(currentUser, current);
      setVersion((v) => v + 1);
    },
    remove: (key) => {
      sync();
      if (!current.delete(key)) return;
      persist(currentUser, current);
      setVersion((v) => v + 1);
    },
    version,
  };
}
