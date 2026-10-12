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
 * A third view, "t3", is T3 Code's web client in a frame (docs/plans/
 * 2026-10-12-t3-view-design.md). It is offered only to an admin on their own
 * Claude session, so a stored "t3" is read through that offer: where it is not
 * offered the session shows the default, and the stored choice stays put for
 * the device and the moment it is offered again.
 */

export type ViewMode = "text" | "terminal" | "t3";

const isMode = (v: string | null): v is ViewMode => v === "text" || v === "terminal" || v === "t3";

const KEY_PREFIX = "tl:viewmode:v1:";

/**
 * The default view, everywhere. Kept as a function rather than inlined so the
 * rule has one name to change and one place to test.
 */
export function defaultMode(): ViewMode {
  return "text";
}

export function loadMode(session: string): ViewMode {
  const stored = lsGet(KEY_PREFIX + session);
  return isMode(stored) ? stored : defaultMode();
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
  if (!isMode(stored)) return;
  lsSet(KEY_PREFIX + from, null);
  lsSet(KEY_PREFIX + to, stored);
}

/**
 * The view a session shows, and the two ways to change it.
 *
 * `t3Offered` says whether this session may show the T3 view right now. While
 * it is false a stored "t3" reads as the default; nothing is written, so the
 * choice comes back when the offer does (the admin flag arrives with /whoami,
 * after the first paint).
 */
export function createViewMode(
  session: Accessor<string>,
  t3Offered: Accessor<boolean> = () => false,
): [Accessor<ViewMode>, (m: ViewMode) => void, () => void] {
  const [chosen, setChosen] = createSignal<ViewMode>(loadMode(session()));
  // Re-hydrate when the session changes (each session has its own last view).
  createEffect(() => setChosen(loadMode(session())));
  const mode = (): ViewMode => {
    const m = chosen();
    return m === "t3" && !t3Offered() ? defaultMode() : m;
  };

  const set = (m: ViewMode) => {
    setChosen(m);
    saveMode(session(), m);
  };
  const toggle = () => set(mode() === "text" ? "terminal" : "text");
  return [mode, set, toggle];
}
