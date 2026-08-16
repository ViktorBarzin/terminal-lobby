import { createEffect, createSignal, type Accessor } from "solid-js";
import { track } from "../telemetry/track";

/**
 * Watch mode — per-session, per-device: attach this client read-only, so it
 * observes without driving and without ever moving the session's grid.
 *
 * WHY PER DEVICE. This is the two-device case: the phone watches the session
 * the desktop is driving. A server-side setting would make the session
 * read-only everywhere, which is the opposite of what is wanted — so the state
 * lives in localStorage and never leaves the browser. The server holds no watch
 * state at all; it only ever answers the request one individual attach makes,
 * and resolves it downgrade-only against what that caller is allowed.
 *
 * WHY DRIVING IS THE DEFAULT. Opening a session behaves exactly as it does
 * today; watching is opt-in and remembered as a deviation, so a device that has
 * never asked to watch is unaffected by this feature existing. Storage records
 * only the deviation (the key is removed when watch is turned off), which
 * matches how viewmode.ts persists its own default.
 *
 * The toggle has to be reachable BEFORE the Terminal view is first shown,
 * because that first show is what triggers the attach (TerminalView is lazy) —
 * and an attach that has already happened read-write has already claimed the
 * grid. SessionView therefore renders it in the session bar, visible from Text
 * mode.
 */

export const WATCH_KEY_PREFIX = "tl:watch:v1:";

/** The marker stored for a watching session. Any other value reads as driving,
 *  so a partially-written or hand-edited key fails safe toward today's
 *  behaviour rather than silently making a session read-only. */
const WATCH_MARKER = "ro";

export function loadWatch(session: string): boolean {
  try {
    return localStorage.getItem(WATCH_KEY_PREFIX + session) === WATCH_MARKER;
  } catch {
    return false;
  }
}

export function saveWatch(session: string, watch: boolean): void {
  track("watch.switched", {
    "tl.to": watch ? "ro" : "rw",
    "tl.session": session,
  });
  try {
    if (watch) localStorage.setItem(WATCH_KEY_PREFIX + session, WATCH_MARKER);
    else localStorage.removeItem(WATCH_KEY_PREFIX + session);
  } catch {
    /* private mode / no storage */
  }
}

/** Signal + setter + toggle for the current session's watch state, re-hydrating
 *  when the session changes (each session is remembered separately). */
export function createWatchMode(
  session: Accessor<string>,
): [Accessor<boolean>, (w: boolean) => void, () => void] {
  const [watch, setWatch] = createSignal<boolean>(loadWatch(session()));
  createEffect(() => setWatch(loadWatch(session())));

  const set = (w: boolean) => {
    setWatch(w);
    saveWatch(session(), w);
  };
  return [watch, set, () => set(!watch())];
}
