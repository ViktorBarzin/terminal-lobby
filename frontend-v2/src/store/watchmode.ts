import { createEffect, createMemo, createSignal, type Accessor } from "solid-js";
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
 * that is resolved automatically: joining a session someone is already DRIVING
 * comes up watching, so a second device never takes the grid from the first.
 * That is why "I chose to drive" (`false`) has to be storable and distinct from
 * "I have never said" — otherwise clicking *take control* while your desktop is
 * still driving would be undone by the same rule that put you in watch mode,
 * and the button would look inert.
 *
 * The automatic case exists because the toggle could not, in practice, be set
 * before the attach: v2 is terminal-first (viewmode defaults to "terminal"), so
 * selecting a session shows the Terminal view and latches the attach in the
 * same tick. There was no moment in between to click anything.
 *
 * Storage: "ro" | "rw" | key absent. The shipped two-state version wrote "ro"
 * for watching and removed the key otherwise, so its values still read
 * correctly — an absent key simply now means "decide for me" rather than
 * "drive", which is the intended change.
 */

export const WATCH_KEY_PREFIX = "tl:watch:v1:";

/** undefined = no choice recorded; decide from whether the session is driven. */
export type WatchChoice = boolean | undefined;

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
}

/**
 * What this client should actually do: an explicit choice always wins; with no
 * choice recorded, join as a viewer when someone is already driving.
 *
 * `driven` is a courtesy signal, not an access decision — it comes from the
 * polled session list and can be a few seconds stale. Being wrong costs one
 * click: the toggle starts on the wrong side and nothing else.
 */
export function resolveWatch(choice: WatchChoice, driven: boolean): boolean {
  return choice ?? driven;
}

/**
 * Resolved watch state for the current session, plus a toggle that always
 * records an EXPLICIT choice (so the automatic rule cannot immediately undo it).
 */
export function createWatchMode(
  session: Accessor<string>,
  driven: Accessor<boolean>,
): [Accessor<boolean>, (w: boolean) => void, () => void] {
  const [choice, setChoice] = createSignal<WatchChoice>(loadWatch(session()));
  createEffect(() => setChoice(loadWatch(session())));

  const watch = createMemo(() => resolveWatch(choice(), driven()));

  const set = (w: boolean) => {
    setChoice(w);
    saveWatch(session(), w);
  };
  return [watch, set, () => set(!watch())];
}
