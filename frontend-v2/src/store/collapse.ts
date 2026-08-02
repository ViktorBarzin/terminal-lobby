import { createSignal, type Accessor } from "solid-js";
import { track } from "../telemetry/track";

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
    const raw = localStorage.getItem(storageKey(user));
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function persist(user: string, set: Set<string>): void {
  try {
    localStorage.setItem(storageKey(user), JSON.stringify([...set]));
  } catch {
    /* private mode / no storage */
  }
}

export interface CollapseStore {
  isCollapsed: (key: string) => boolean;
  toggle: (key: string) => void;
  /** expand a group (used by auto-expand-on-activate). */
  expand: (key: string) => void;
  version: Accessor<number>;
}

/** Reactive collapse store for one OS user. `version` bumps on every change so
 *  memos that read isCollapsed re-run. */
export function createCollapseStore(user: () => string): CollapseStore {
  const [version, setVersion] = createSignal(0);
  let current = load(user());
  let currentUser = user();

  const sync = () => {
    if (user() !== currentUser) {
      currentUser = user();
      current = load(currentUser);
    }
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
      if (current.has(key)) current.delete(key);
      else current.add(key);
      persist(currentUser, current);
      setVersion((v) => v + 1);
    },
    expand: (key) => {
      sync();
      if (current.has(key)) {
        current.delete(key);
        persist(currentUser, current);
        setVersion((v) => v + 1);
      }
    },
    version,
  };
}
