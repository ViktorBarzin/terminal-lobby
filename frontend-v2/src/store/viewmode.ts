import { createEffect, createSignal, type Accessor } from "solid-js";
import { track } from "../telemetry/track";

/**
 * Per-session, per-device view mode (design pillar #2 switch): persist just
 * `{mode}` keyed by session id in localStorage. Per-device is deliberate — the
 * same session may be terminal on a desktop and text on a phone (T3 template,
 * minus its terminalIds/groups/height).
 *
 * The DEFAULT depends on the device: text on a phone, terminal on a desktop.
 * A structured, reflowing transcript is what a handset can actually render —
 * an 80-column pty on a 390px screen is not — while a desktop keeps booting
 * into the terminal, one Cmd/Ctrl-J away from the other.
 *
 * Storage records only a deviation from THAT device's default, so the same
 * browser can hold "text" for one session and inherit the default for the rest.
 * Pre-2026-08-16 values still read correctly: the only value ever written was
 * the non-default one, which is exactly what is written now.
 */

export type ViewMode = "text" | "terminal";

const KEY_PREFIX = "tl:viewmode:v1:";

/**
 * This device's default view. Coarse pointer (phone, tablet) → text.
 * PURE + parameterized so the rule is testable without a matchMedia.
 */
export function defaultMode(coarse: boolean): ViewMode {
  return coarse ? "text" : "terminal";
}

function deviceDefault(): ViewMode {
  if (typeof window === "undefined" || !window.matchMedia) return "terminal";
  try {
    return defaultMode(window.matchMedia("(pointer: coarse)").matches);
  } catch {
    return "terminal";
  }
}

export function loadMode(session: string): ViewMode {
  const fallback = deviceDefault();
  try {
    const stored = localStorage.getItem(KEY_PREFIX + session);
    if (stored === "text" || stored === "terminal") return stored;
    return fallback;
  } catch {
    return fallback;
  }
}

export function saveMode(session: string, mode: ViewMode): void {
  track("view.switched", { "tl.to": mode, "tl.session": session });
  try {
    // Prune the default so storage only records deviations (T3 partialize idea).
    if (mode === deviceDefault()) localStorage.removeItem(KEY_PREFIX + session);
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
