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
 *
 * A LENS HAS ITS OWN NAMESPACE. A tab acting as another user is looking at
 * their sessions, and the key is otherwise the bare session name — shared with
 * YOUR session of that name. So every read and write carries the act-as target
 * (`as`, "" for an ordinary tab), and *take control* on emo's `code` decides
 * nothing about your own `code`. In a lens the default is to watch rather than
 * to follow the automatic rule (see `resolveWatch`).
 */

export const WATCH_KEY_PREFIX = "tl:watch:v1:";

/**
 * Where one session's choice lives. `as` is the act-as target — "" for an
 * ordinary tab, the target's OS user in a lens.
 *
 * No session name can reach the lens namespace: tmux-api, `tmux-attach.sh` and
 * sessionio all bound a name to `[a-zA-Z0-9_-]{1,32}`, so a name cannot contain
 * the colons.
 */
export function watchKey(session: string, as = ""): string {
  return as
    ? `${WATCH_KEY_PREFIX}as:${as}:${session}`
    : WATCH_KEY_PREFIX + session;
}

/** undefined = no choice recorded; decide from whether the session is driven. */
export type WatchChoice = boolean | undefined;

/** Bumped on every write so views and the sidebar re-read in step. localStorage
 *  is not reactive, and the choice is set from two places (the session bar's
 *  toggle and the sidebar card's menu). */
const [rev, setRev] = createSignal(0);

export function loadWatch(session: string, as = ""): WatchChoice {
  try {
    const v = localStorage.getItem(watchKey(session, as));
    if (v === "ro") return true;
    if (v === "rw") return false;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Reactive read of the stored choice — re-runs when any choice changes. */
export function watchChoice(session: string, as = ""): WatchChoice {
  rev();
  return loadWatch(session, as);
}

export function saveWatch(session: string, choice: WatchChoice, as = ""): void {
  if (choice !== undefined) {
    track("watch.switched", {
      "tl.to": choice ? "ro" : "rw",
      "tl.session": session,
      // Named, so "an admin chose to type in someone else's session" is one
      // query rather than a join against the switch event. The server's attach
      // line is the record; this is the intent that produced it.
      ...(as ? { "tl.as": as } : {}),
    });
  }
  try {
    if (choice === undefined) localStorage.removeItem(watchKey(session, as));
    else localStorage.setItem(watchKey(session, as), choice ? "ro" : "rw");
  } catch {
    /* private mode / no storage */
  }
  setRev((n) => n + 1);
}

/**
 * How a client should join: an explicit choice first, then the default for the
 * kind of tab this is.
 *
 * `lens` is the act-as case. Its default is to WATCH, because you opened
 * someone else's account to look at it, and because `driven` there describes
 * THEIR clients: a session nobody happens to be driving is still theirs, and
 * arriving read-write in it is the accident this prevents. Saying otherwise is
 * one click, and it is remembered under the target (see `watchKey`).
 *
 * `driven` is a courtesy signal, not an access decision — it comes from the
 * polled session list and can be seconds stale. Being wrong costs one click.
 */
export function resolveWatch(
  choice: WatchChoice,
  driven: boolean,
  lens = false,
): boolean {
  if (lens) return choice ?? true;
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
  lens?: Accessor<string>,
): [Accessor<boolean>, (w: boolean) => void, () => void] {
  /** The act-as target, "" in an ordinary tab. It picks both the default and
   *  the namespace the choice is kept under, so the two cannot disagree. */
  const as = () => lens?.() ?? "";
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
    resolveWatch(watchChoice(session(), as()), joinedDriven(), !!as()),
  );

  // Tell the sidebar what we actually resolved, so the card for an open session
  // reflects this view rather than a `driven` count that includes us.
  createEffect(() => publishResolvedWatch(session(), watch()));

  // A lens records under ITS OWN namespace. The key would otherwise be the
  // bare session name, shared with your own session of that name — so a
  // decision about emo's `code` would arrive, days later, on yours.
  const set = (w: boolean) => saveWatch(session(), w, as());
  return [watch, set, () => set(!watch())];
}
