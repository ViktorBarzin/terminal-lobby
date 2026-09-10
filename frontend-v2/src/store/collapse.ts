import { createSignal, type Accessor } from "solid-js";
import { track } from "../telemetry/track";
import { lsGet, lsSet } from "../lib/storage";

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
      const flipped = current.has(key);
      return startsCollapsed(key) ? !flipped : flipped;
    },
    toggle: (key) => {
      track("layout.group_toggled", { "tl.key": key });
      sync();
      // Flipping membership flips the state whichever way round the key reads.
      if (current.has(key)) current.delete(key);
      else current.add(key);
      persist(currentUser, current);
      setVersion((v) => v + 1);
    },
    expand: (key) => {
      sync();
      // "Expanded" is the ABSENCE of the key for an ordinary group and its
      // PRESENCE for one that starts closed, so the auto-expand that follows a
      // selection has to write the flag rather than clear it.
      const open = startsCollapsed(key);
      if (current.has(key) !== open) {
        if (open) current.add(key);
        else current.delete(key);
        persist(currentUser, current);
        setVersion((v) => v + 1);
      }
    },
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
