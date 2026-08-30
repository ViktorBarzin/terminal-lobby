import type { Layout, Session } from "../types/lobby";

/**
 * The Ctrl/Cmd+J scratch-shell dock — pure decisions.
 *
 * Ported from the vanilla page (docs/2026-07-17-ctrl-j-shell-dock-design.md):
 * a plain shell in a persistent bottom panel under the session you are working
 * in, roamed as `layout.dock` so it follows you across devices, and desktop-only
 * because a phone has no room for two terminals.
 */

/** Split ratio (dock height, % of the content area), per-browser. */
export const DOCK_RATIO_KEY = "tl:dock-split:v1";
export const DOCK_RATIO_DEFAULT = 30;
const RATIO_MIN = 15;
const RATIO_MAX = 80;

export function clampRatio(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return DOCK_RATIO_DEFAULT;
  return Math.max(RATIO_MIN, Math.min(RATIO_MAX, Math.round(v)));
}

/**
 * The name a new scratch shell takes: `shell`, else `shell-2`, `shell-3`…
 * Verbatim from the vanilla `firstFreeShellName` so a dock created on either
 * page picks the same name, and reclaiming one created by the other works.
 */
export function firstFreeShellName(taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has("shell")) return "shell";
  for (let i = 2; i < 1000; i++) {
    if (!used.has(`shell-${i}`)) return `shell-${i}`;
  }
  return `shell-${Date.now()}`; // pathological fallback
}

/**
 * What Ctrl+J does next. Three states, one chord — create, then hide, then
 * show — so the shell keeps running behind a hidden panel rather than being
 * torn down and rebuilt on every toggle.
 */
export type DockAction =
  | { kind: "create"; name: string }
  | { kind: "hide" }
  | { kind: "show" };

export function nextDockAction(layout: Layout, taken: Iterable<string>): DockAction {
  const d = layout.dock;
  if (!d || !d.session) return { kind: "create", name: firstFreeShellName(taken) };
  return d.visible ? { kind: "hide" } : { kind: "show" };
}

/**
 * The docked shell is not a thread — keep it out of the sidebar, as the vanilla
 * page does. It comes back as an ordinary card the moment it is un-docked,
 * which is what ✕ does.
 */
export function hideDockedSession(sessions: Session[], layout: Layout): Session[] {
  const docked = layout.dock?.session;
  if (!docked) return sessions;
  return sessions.filter((s) => s.name !== docked);
}
