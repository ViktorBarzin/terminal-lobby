import { createEffect, createSignal, type Accessor } from "solid-js";
import { track } from "../telemetry/track";
import { lsGet, lsSet } from "../lib/storage";

/**
 * Per-session, per-device view mode (design pillar #2 switch): persist just
 * `{mode}` keyed by session id in localStorage. Per-device is deliberate — the
 * same session may be terminal on a desktop and text on a phone (T3 template,
 * minus its terminalIds/groups/height).
 *
 * The DEFAULT is the text view, on every device (Viktor, 2026-10-03). It was
 * the terminal from 2026-08-19; before that a phone opened in text and a
 * desktop in the terminal. The terminal is a tap away on the bar.
 *
 * Storage records only a deviation from that default, so a browser holds
 * "terminal" for the sessions it was chosen for and inherits text for the rest.
 * Under the terminal default nothing was stored for a terminal session, so
 * those sessions now open in text; a stored "text" still reads as text and is
 * pruned the next time the switch is pressed.
 *
 * A third view, "t3", framed T3 Code's web client until ADR-0046 retired it.
 * A browser that used it may still hold "t3"; like any other value that is not
 * a mode, it reads as the default.
 */

export type ViewMode = "text" | "terminal";

const isMode = (v: string | null): v is ViewMode => v === "text" || v === "terminal";

const KEY_PREFIX = "tl:viewmode:v1:";

/**
 * The default view, everywhere. Kept as a function rather than inlined so the
 * rule has one name to change and one place to test.
 */
export function defaultMode(): ViewMode {
  return "text";
}

/**
 * The view a session opens in: what this device stored for it, or `fallback`.
 *
 * `fallback` is the default in force for THIS session, which is not always the
 * global one: a session with no Claude in it opens in the Terminal (Viktor,
 * 2026-11-23), because its Text view has nothing to show but a note pointing
 * there. SessionView decides which sessions those are.
 */
export function loadMode(session: string, fallback: ViewMode = defaultMode()): ViewMode {
  const stored = lsGet(KEY_PREFIX + session);
  return isMode(stored) ? stored : fallback;
}

export function saveMode(
  session: string,
  mode: ViewMode,
  fallback: ViewMode = defaultMode(),
): void {
  track("view.switched", { "tl.to": mode, "tl.session": session });
  // Prune the default so storage only records deviations (T3 partialize idea).
  // The default in force for this session, so picking the Text view on a
  // session that defaults to the Terminal is remembered.
  lsSet(KEY_PREFIX + session, mode === fallback ? null : mode);
}

/**
 * Move a session's view choice onto the name a rename gave it (ADR-0022).
 *
 * Storage records only a deviation from the default, so an absent key is a
 * session nobody chose for and there is nothing to move. Without this, reading
 * a session in the text view and having its first title land put the person
 * back in the terminal, with no way to tell what had happened.
 *
 * `lsSet` rather than `saveMode`, so a rename does not appear in the telemetry
 * as somebody pressing the switch.
 */
export function carryViewMode(from: string, to: string): void {
  if (from === to) return;
  const stored = lsGet(KEY_PREFIX + from);
  if (!isMode(stored)) return;
  lsSet(KEY_PREFIX + from, null);
  lsSet(KEY_PREFIX + to, stored);
}

export function createViewMode(
  session: Accessor<string>,
  /** This session's default view; the global one when absent. Read reactively,
   *  so a session whose Claude exits moves to the Terminal unless the person
   *  chose a view for it. */
  fallback: Accessor<ViewMode> = defaultMode,
): [Accessor<ViewMode>, (m: ViewMode) => void, () => void] {
  const [mode, setMode] = createSignal<ViewMode>(loadMode(session(), fallback()));
  // Re-hydrate when the session changes (each session has its own last view),
  // and when its default does.
  createEffect(() => setMode(loadMode(session(), fallback())));

  const set = (m: ViewMode) => {
    setMode(m);
    saveMode(session(), m, fallback());
  };
  const toggle = () => set(mode() === "text" ? "terminal" : "text");
  return [mode, set, toggle];
}
