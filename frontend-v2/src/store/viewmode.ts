import { createEffect, createSignal, type Accessor } from "solid-js";

/**
 * Per-session, per-device view mode (design pillar #2 switch): persist just
 * `{mode}` keyed by session id in localStorage. Per-device is deliberate — the
 * same session may be text on a phone and terminal on a desktop (T3 template,
 * minus its terminalIds/groups/height). Text is the default (primary view).
 */

export type ViewMode = "text" | "terminal";

const KEY_PREFIX = "tl:viewmode:v1:";

export function loadMode(session: string): ViewMode {
  try {
    return localStorage.getItem(KEY_PREFIX + session) === "terminal"
      ? "terminal"
      : "text";
  } catch {
    return "text";
  }
}

export function saveMode(session: string, mode: ViewMode): void {
  try {
    // Prune the default so storage only records deviations (T3 partialize idea).
    if (mode === "text") localStorage.removeItem(KEY_PREFIX + session);
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
