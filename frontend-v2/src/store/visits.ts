/**
 * Per-session SEEN/visit tracking (inventory Cat.2) — the store behind every
 * "unseen" affordance: the tab title's `(N✓)` badge, the favicon's green tick,
 * and (already reading the same key) the palette's recents-first sort.
 *
 * Ported from the vanilla frontend's `trackStateChanges` / `isUnseenDone`, and
 * T3's `hasUnseenCompletion` before it: a finished session stays emphasized only
 * while its completion is NEWER than the last time the user looked at it.
 *
 *   tl:session-states:v1  name → {state, at}  — epoch ms at which the session
 *       was first observed in its current state. No backend exposes a real
 *       state-change time, so this observation is the only anchor there is; it
 *       is persisted so a reload keeps the latch. **The lobby store owns the
 *       WRITES** (`store/lobby.ts`, which needs the same stamp for the working
 *       timer) — this store seeds from it and then keeps its own copy from the
 *       polls it sees, so it is correct on its own in tests and whatever list
 *       the caller feeds it (own + foreign sessions).
 *   tl:session-visits:v1  name → epoch ms of the last visit. **Owned here.**
 *       `keybindings/palette-controller.ts` already reads this shape.
 *
 * Both stores are per-browser (never roamed): "have I looked at this yet" is a
 * property of the device in front of you, and both are pruned to the live
 * session list so a killed session cannot leak an entry forever.
 *
 * A visit is stamped for the session the user is ATTACHED to while the tab is
 * VISIBLE — attached-but-hidden completions still earn their badge, which is the
 * whole point of the badge. `stamp()` is the immediate path for the moments the
 * poll would otherwise lag by up to 5s: coming back to the tab, or focusing it.
 */
import { createSignal, type Accessor } from "solid-js";

export const VISITS_KEY = "tl:session-visits:v1";
export const STATES_KEY = "tl:session-states:v1";

/** The only session fields this store needs. */
export type VisitSession = { name: string; state?: string };

interface StateStamp {
  state: string;
  at: number;
}

export interface VisitStore {
  /**
   * Fold one poll into the store: prune dead sessions, stamp state changes, and
   * mark the attached session seen (while the tab is visible). Safe to call
   * from inside the paint effect — see `revision`.
   */
  observe(sessions: readonly VisitSession[], active: string | null): void;
  /** Stamp a visit right now (visibility/focus return). No-op for null. */
  stamp(name: string | null): void;
  /** true when this session finished AFTER the user last looked at it. */
  isUnseen(s: VisitSession): boolean;
  /**
   * Bumps ONLY when the set of unseen sessions changes. The title/favicon effect
   * both reads this (so an out-of-band `stamp()` repaints immediately) and calls
   * `observe` (which stamps): a bump on every stamp would therefore loop, so a
   * repeat visit to an already-seen session deliberately does not bump.
   */
  revision: Accessor<number>;
}

export interface VisitStoreOptions {
  /** injectable clock (tests). */
  now?: () => number;
  /** is the tab on screen? default `!document.hidden`, as in the vanilla port. */
  visible?: () => boolean;
}

function readStore(key: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {}; // private mode / corrupt entry
  }
}

function loadVisits(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, at] of Object.entries(readStore(VISITS_KEY))) {
    if (typeof at === "number") out[name] = at;
  }
  return out;
}

function loadStates(): Record<string, StateStamp> {
  const out: Record<string, StateStamp> = {};
  for (const [name, rec] of Object.entries(readStore(STATES_KEY))) {
    if (!rec || typeof rec !== "object") continue;
    const { state, at } = rec as { state?: unknown; at?: unknown };
    if (typeof state === "string" && typeof at === "number") out[name] = { state, at };
  }
  return out;
}

function persistVisits(visits: Record<string, number>): void {
  try {
    localStorage.setItem(VISITS_KEY, JSON.stringify(visits));
  } catch {
    /* private mode / no storage */
  }
}

export function createVisitStore(opts: VisitStoreOptions = {}): VisitStore {
  const now = opts.now ?? (() => Date.now());
  const visible =
    opts.visible ?? (() => typeof document === "undefined" || !document.hidden);

  const visits = loadVisits();
  const states = loadStates();
  const [revision, setRevision] = createSignal(0);
  /** the last observed poll — what `stamp()` re-checks the unseen set against. */
  let known: readonly VisitSession[] = [];
  let signature = "";

  const isUnseen = (s: VisitSession): boolean => {
    if (s.state !== "done") return false;
    const rec = states[s.name];
    return (rec?.at ?? 0) > (visits[s.name] ?? 0);
  };

  /**
   * Bump the repaint counter only when the UNSEEN SET actually changed. A
   * session name is `[a-zA-Z0-9_-]{1,32}` (NAME_RE), so joining on a comma
   * cannot make two different sets look alike.
   */
  const sync = (): void => {
    let next = "";
    for (const s of known) if (isUnseen(s)) next += s.name + ",";
    if (next === signature) return;
    signature = next;
    setRevision((r) => r + 1);
  };

  const observe = (
    sessions: readonly VisitSession[],
    active: string | null,
  ): void => {
    const at = now();
    const live = new Set(sessions.map((s) => s.name));
    let dirty = false;
    for (const name of Object.keys(states)) {
      if (!live.has(name)) delete states[name];
    }
    for (const name of Object.keys(visits)) {
      if (!live.has(name)) {
        delete visits[name];
        dirty = true;
      }
    }
    for (const s of sessions) {
      const cur = s.state || "";
      const rec = states[s.name];
      if (!rec || rec.state !== cur) states[s.name] = { state: cur, at };
    }
    // The session on screen counts as seen — including the completion that just
    // landed while you were watching it (stamped with the same `at`, and the
    // unseen test is a STRICT >).
    if (active && live.has(active) && visible()) {
      visits[active] = at;
      dirty = true;
    }
    known = sessions;
    if (dirty) persistVisits(visits);
    sync();
  };

  const stamp = (name: string | null): void => {
    if (!name) return;
    visits[name] = now();
    persistVisits(visits);
    sync();
  };

  return { observe, stamp, isUnseen, revision };
}
