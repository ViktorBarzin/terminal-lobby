import { createContext, createEffect, onCleanup, useContext, type Accessor } from "solid-js";

/**
 * Which Tile the keystrokes are going to, read from inside that tile.
 *
 * The focused tile IS the selected session. The URL names one session, the
 * session bar shows one session, and clicking a tile selects it, so there is no
 * second piece of state here that could disagree with the URL about where a
 * paste is about to land. App.tsx provides this around each session slot as
 * `() => k.key === selectedKey()`.
 *
 * The default answers `true`, and that default is what keeps everything outside
 * a Workspace behaving exactly as it did before tiles existed: a lobby showing
 * one session, the Ctrl+J dock's own terminal, and every test that renders a
 * `SessionView` on its own all sit outside the provider, and a view that is not
 * in a workspace is not competing with anybody for a handle.
 */
export const TileFocusContext = createContext<Accessor<boolean>>(() => true);

/**
 * Hold a `window.__tl*` handle only while this view is the FOCUSED tile.
 *
 * These handles are how the lobby shell reaches into the session it is showing:
 * the ⌘/Ctrl-J toggle, find-in-session, paste, the terminal bridge. They used to
 * be claimed on mount and given back on unmount, which was exact while exactly
 * one `SessionView` existed at a time.
 *
 * Two changes have since made "exactly one" false, and each one moved the claim.
 *
 * 2026-08-19: the lobby keeps every session you have opened mounted
 * (store/keepalive.ts), so mount order stopped meaning anything — three
 * sessions are mounted and one is on screen. Claiming on `active` instead made
 * the handle follow the session being read.
 *
 * 2026-09-12: a Workspace puts several sessions on screen at once (ADR-0027),
 * so being on screen stopped picking out one view either. Four tiles all pass
 * `active`, all four claim, and the last one to mount wins a race nobody
 * arranged — a paste or a find meant for the session you are typing into lands
 * in whichever tile mounted last. So `active` is no longer the whole gate: a
 * claim also needs {@link TileFocusContext} to say this is the focused tile.
 * Exactly one tile is focused at a time, so exactly one claim stands, and a
 * view outside a workspace reads the default `true` and is gated on `active`
 * alone, as it always was.
 *
 * HOW FAR THE GATE REACHES is decided by where `ownWhile` is called from,
 * because the context is read at call time and Solid can only answer with an
 * owner in hand. `SessionView` and `MessagesTimeline` call it from their
 * component bodies, so the six handles they own are gated on focus.
 * `TerminalNative` claims its six from inside its async mount, after an
 * `await`, where there is no owner and `useContext` can only hand back the
 * default — those follow the `ownsBridges` prop `SessionView` passes them
 * instead, which is where narrowing them to the focused tile belongs.
 *
 * Handover is order-independent. When focus moves from A to B, A's cleanup and
 * B's install can run either way round, because a cleanup only restores the
 * previous value if the handle is still ITS value — so an install that already
 * happened is never clobbered.
 */
type Global = Window & typeof globalThis;

export function ownWhile<K extends keyof Global>(
  active: () => boolean,
  key: K,
  value: Global[K],
): void {
  // Read once, here, rather than inside the effect: `useContext` walks the
  // OWNER chain, and inside a `createEffect` that chain is the effect's own.
  // It resolves the same way today, and reading it at the call site is what
  // makes the "no owner, no gate" rule above a property of where the call is
  // written rather than of when the effect happens to run.
  const focused = useContext(TileFocusContext);
  createEffect(() => {
    if (!active() || !focused() || typeof window === "undefined") return;
    const prev = window[key];
    window[key] = value;
    onCleanup(() => {
      if (window[key] === value) window[key] = prev;
    });
  });
}
