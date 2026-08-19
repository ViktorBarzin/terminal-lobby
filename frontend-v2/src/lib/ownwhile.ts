import { createEffect, onCleanup } from "solid-js";

/**
 * Hold a `window.__tl*` handle only while this view is the one on screen.
 *
 * These handles are how the lobby shell reaches into the session it is showing:
 * the ⌘/Ctrl-J toggle, find-in-session, paste, the terminal bridge. They used to
 * be claimed on mount and given back on unmount, which was exact while exactly
 * one `SessionView` existed at a time.
 *
 * Since 2026-08-19 the lobby keeps every session you have opened mounted
 * (store/keepalive.ts), so mount order stops meaning anything: three sessions
 * are mounted and only one is on screen. Claiming on `active` instead means the
 * handle follows the visible session.
 *
 * Handover is order-independent. When the selection moves from A to B, A's
 * cleanup and B's install can run either way round, because a cleanup only
 * restores the previous value if the handle is still ITS value — so an install
 * that already happened is never clobbered.
 */
type Global = Window & typeof globalThis;

export function ownWhile<K extends keyof Global>(
  active: () => boolean,
  key: K,
  value: Global[K],
): void {
  createEffect(() => {
    if (!active() || typeof window === "undefined") return;
    const prev = window[key];
    window[key] = value;
    onCleanup(() => {
      if (window[key] === value) window[key] = prev;
    });
  });
}
