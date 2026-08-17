import {
  createEffect,
  createMemo,
  createSignal,
  untrack,
  type Accessor,
} from "solid-js";
import { track } from "../telemetry/track";

/**
 * Watch mode — per-session, per-device: attach this client read-only, so it
 * observes without driving and without ever moving the session's grid.
 *
 * WHY PER DEVICE. This is the two-device case: the phone watches the session
 * the desktop is driving. A server-side setting would make the session
 * read-only everywhere, which is the opposite of what is wanted — so the state
 * lives in localStorage and never leaves the browser. The server holds no watch
 * state; it only ever answers the request one individual attach makes, and
 * resolves it downgrade-only against what that caller is allowed.
 *
 * THREE STATES, NOT TWO. A session nobody has chosen for is `undefined`, and
 * that resolves automatically: joining a session someone is already DRIVING
 * comes up watching, so a second device never takes the grid from the first.
 * "I chose to drive" (`false`) therefore has to be storable and distinct from
 * "I have never said" — otherwise *take control* on a session your desktop is
 * still driving would be undone by the same rule that put you in watch mode.
 *
 * Storage: "ro" | "rw" | key absent. The original two-state version wrote "ro"
 * for watching and removed the key otherwise, so its values still read
 * correctly; an absent key now means "decide for me" rather than "drive".
 */

export const WATCH_KEY_PREFIX = "tl:watch:v1:";

/** undefined = no choice recorded; decide from whether the session is driven. */
export type WatchChoice = boolean | undefined;

/** Bumped on every write so views and the sidebar re-read in step. localStorage
 *  is not reactive, and the choice is set from two places (the session bar's
 *  toggle and the sidebar card's menu). */
const [rev, setRev] = createSignal(0);

export function loadWatch(session: string): WatchChoice {
  try {
    const v = localStorage.getItem(WATCH_KEY_PREFIX + session);
    if (v === "ro") return true;
    if (v === "rw") return false;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Reactive read of the stored choice — re-runs when any choice changes. */
export function watchChoice(session: string): WatchChoice {
  rev();
  return loadWatch(session);
}

export function saveWatch(session: string, choice: WatchChoice): void {
  if (choice !== undefined) {
    track("watch.switched", {
      "tl.to": choice ? "ro" : "rw",
      "tl.session": session,
    });
  }
  try {
    if (choice === undefined) localStorage.removeItem(WATCH_KEY_PREFIX + session);
    else localStorage.setItem(WATCH_KEY_PREFIX + session, choice ? "ro" : "rw");
  } catch {
    /* private mode / no storage */
  }
  setRev((n) => n + 1);
}

/**
 * How a client should join: `locked` wins over everything, then an explicit
 * choice, and with none recorded join as a viewer when someone is already
 * driving.
 *
 * `locked` is the act-as case — a tab acting as someone else only ever watches,
 * so neither a stored choice nor the automatic rule gets a say (see
 * `watchLockedFor`).
 *
 * `driven` is a courtesy signal, not an access decision — it comes from the
 * polled session list and can be seconds stale. Being wrong costs one click.
 */
export function resolveWatch(
  choice: WatchChoice,
  driven: boolean,
  locked = false,
): boolean {
  if (locked) return true;
  return choice ?? driven;
}

// --- the live view's resolved state, for the sidebar --------------------------
//
// The card for the session this browser currently has OPEN cannot use `driven`:
// that count includes our own client, so a session we are driving reads as
// driven and the card would claim we will join it as a viewer. The live view
// publishes what it actually resolved, and the card prefers that.

const resolvedWatch = new Map<string, boolean>();

export function publishResolvedWatch(session: string, watching: boolean): void {
  if (resolvedWatch.get(session) === watching) return;
  resolvedWatch.set(session, watching);
  setRev((n) => n + 1);
}

export function clearResolvedWatch(session: string): void {
  if (resolvedWatch.delete(session)) setRev((n) => n + 1);
}

/** What the live view resolved for this session, or undefined if none is open
 *  on it. Reactive. */
export function resolvedWatchFor(session: string): boolean | undefined {
  rev();
  return resolvedWatch.get(session);
}

/**
 * Resolved watch state for the current session, plus a setter that always
 * records an EXPLICIT choice (so the automatic rule cannot immediately undo it).
 *
 * THE AUTOMATIC PART IS LATCHED, and that is the whole correctness argument.
 * `driven` counts every read-write client including our own, so a live
 * dependency on it feeds back on itself: attaching read-write makes the next
 * poll report the session as driven, which flips this client to watch, which
 * leaves only a read-only client, which makes driven false, which flips it
 * back — once per poll, re-navigating the terminal each time. That shipped, and
 * had to be reverted.
 *
 * Joining is a decision made ONCE, when this view takes a session on. It is
 * re-taken only when the view moves to a different session, or when the person
 * says otherwise.
 */
export function createWatchMode(
  session: Accessor<string>,
  driven: Accessor<boolean>,
  locked?: Accessor<boolean>,
): [Accessor<boolean>, (w: boolean) => void, () => void] {
  // THE LATCH: depends on `session` and reads `driven` UNTRACKED, so it is
  // re-taken when this view moves to another session and at no other time.
  //
  // A memo rather than an effect, deliberately: an effect is deferred to the end
  // of the update, leaving a window in which `watch()` still reports the
  // previous session's decision. A memo re-latches in the same tick as the
  // session change, so there is no such window to reason about.
  const joinedDriven = createMemo(() => {
    session();
    return untrack(() => driven());
  });

  const watch = createMemo(() =>
    resolveWatch(watchChoice(session()), joinedDriven(), locked?.() ?? false),
  );

  // Tell the sidebar what we actually resolved, so the card for an open session
  // reflects this view rather than a `driven` count that includes us.
  createEffect(() => publishResolvedWatch(session(), watch()));

  // A locked tab records NOTHING. The stored choice is keyed by session name
  // alone, so it is shared with your own session of that name — writing from a
  // lens would leave your own session watching (or driving) because of
  // something you did while looking at someone else's.
  const set = (w: boolean) => {
    if (locked?.()) return;
    saveWatch(session(), w);
  };
  return [watch, set, () => set(!watch())];
}
