import { createSignal, type Accessor } from "solid-js";
import { track } from "../telemetry/track";
import { lsGet, lsSet } from "../lib/storage";
import type { UndoStore } from "./undo";

/**
 * Per-browser collapse state for sidebar groups. Deliberately NOT roamed (it is
 * a view preference, not layout — see CONTEXT.md "Layout"): the vanilla app
 * keyed it `tmux-collapsed-<user>` in localStorage. Group keys are project names
 * plus two sentinels that can't collide with a project name (a project name
 * matches [a-zA-Z0-9_-]{1,32}, so a leading ':' is safe).
 */
export const UNGROUPED_KEY = ":ungrouped";
export const SHARED_KEY = ":shared";

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

  const set = (key: string, collapsed: boolean) => {
    sync();
    if (current.has(key) === collapsed) return;
    if (collapsed) current.add(key);
    else current.delete(key);
    persist(currentUser, current);
    setVersion((v) => v + 1);
  };

  return {
    isCollapsed: (key) => {
      version(); // track
      sync();
      return current.has(key);
    },
    toggle: (key) => {
      track("layout.group_toggled", { "tl.key": key });
      sync();
      const was = current.has(key);
      set(key, !was);
      // After the write, and carrying the user whose map it wrote: the key is a
      // project name and the map is per OS user, so the entry has to say which
      // sidebar it is about (store/undo.local.ts CollapseEntry).
      undo?.push({ kind: "collapse", user: currentUser, group: key, was });
    },
    set,
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
