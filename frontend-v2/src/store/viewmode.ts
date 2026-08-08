import { createEffect, createSignal, type Accessor } from "solid-js";
import { track } from "../telemetry/track";

/**
 * Per-session, per-device view mode (design pillar #2 switch): persist just
 * `{mode}` keyed by session id in localStorage. Per-device is deliberate — the
 * same session may be terminal on a desktop and text on a phone (T3 template,
 * minus its terminalIds/groups/height). Terminal is the default (the v1 primary
 * view); text mode is opt-in and remembered per session as a deviation.
 *
 * Storage records only a deviation from the default. Before the terminal-first
 * flip the default was text and only "terminal" was ever persisted ("text" was
 * pruned), so every pre-flip value still reads correctly against the new default
 * — the key is unchanged, no migration needed.
 */

export type ViewMode = "text" | "terminal";

const KEY_PREFIX = "tl:viewmode:v1:";

export function loadMode(session: string): ViewMode {
  try {
    return localStorage.getItem(KEY_PREFIX + session) === "text"
      ? "text"
      : "terminal";
  } catch {
    return "terminal";
  }
}

export function saveMode(session: string, mode: ViewMode): void {
  track("view.switched", { "tl.to": mode, "tl.session": session });
  try {
    // Prune the default so storage only records deviations (T3 partialize idea).
    if (mode === "terminal") localStorage.removeItem(KEY_PREFIX + session);
    else localStorage.setItem(KEY_PREFIX + session, mode);
  } catch {
    /* private mode / no storage */
  }
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
