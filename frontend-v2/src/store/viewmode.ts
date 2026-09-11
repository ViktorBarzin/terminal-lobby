import { createEffect, createSignal, type Accessor } from "solid-js";
import { track } from "../telemetry/track";
import { lsGet, lsSet } from "../lib/storage";

/**
 * Per-session, per-device view mode (design pillar #2 switch): persist just
 * `{mode}` keyed by session id in localStorage. Per-device is deliberate — the
 * same session may be terminal on a desktop and text on a phone (T3 template,
 * minus its terminalIds/groups/height).
 *
 * The DEFAULT is the terminal, on every device (Viktor, 2026-08-19). A phone
 * used to open in the text view, on the reasoning that a 390px screen cannot
 * render an 80-column pty; what daily use said is that a session is still opened
 * to drive the terminal, and the text view is a tap away on the bar.
 *
 * Storage records only a deviation from that default, so a browser holds "text"
 * for the sessions it was chosen for and inherits the terminal for the rest. The
 * values written before this change still read correctly — a phone that chose
 * text kept nothing, since text WAS its default, so those sessions now open in
 * the terminal, which is the point.
 */

export type ViewMode = "text" | "terminal";

const KEY_PREFIX = "tl:viewmode:v1:";

/**
 * The default view, everywhere. Kept as a function rather than inlined so the
 * rule has one name to change and one place to test.
 */
export function defaultMode(): ViewMode {
  return "terminal";
}

export function loadMode(session: string): ViewMode {
  const stored = lsGet(KEY_PREFIX + session);
  if (stored === "text" || stored === "terminal") return stored;
  return defaultMode();
}

export function saveMode(session: string, mode: ViewMode): void {
  track("view.switched", { "tl.to": mode, "tl.session": session });
  // Prune the default so storage only records deviations (T3 partialize idea).
  lsSet(KEY_PREFIX + session, mode === defaultMode() ? null : mode);
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
  if (stored !== "text" && stored !== "terminal") return;
  lsSet(KEY_PREFIX + from, null);
  lsSet(KEY_PREFIX + to, stored);
}

export function createViewMode(
  session: Accessor<string>,
): [Accessor<ViewMode>, (m: ViewMode) => void, () => void] {
  const [mode, setMode] = createSignal<ViewMode>(loadMode(session()));
  // Re-hydrate when the session changes (each session has its own last view).
  createEffect(() => setMode(loadMode(session())));

  const set = (m: ViewMode) => {
    setMode(m);
    saveMode(session(), m);
  };
  const toggle = () => set(mode() === "text" ? "terminal" : "text");
  return [mode, set, toggle];
}
