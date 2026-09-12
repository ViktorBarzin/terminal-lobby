import { createSignal, onCleanup, Show, type Component } from "solid-js";
import { TerminalNative } from "./TerminalNative";
import { terminalFrameArgs } from "../lib/terminal-url";
import type { DockStore } from "../store/dock";

/**
 * The Ctrl/Cmd+J scratch shell, in a persistent panel under the session you are
 * working in (docs/2026-07-17-ctrl-j-shell-dock-design.md).
 *
 * It is a SECOND live terminal, not a view of the first: the session above
 * keeps its own terminal attached while you use the shell. Hiding the panel
 * leaves the shell running — that is why Ctrl+J cycles create → hide → show
 * rather than tearing the terminal down each time.
 *
 * Desktop only, and this is where that is decided: `d.allowed()` is false
 * under `(pointer: coarse)`, so the `Show` below builds no terminal at all.
 * CSS used to carry the whole answer (`.tl-dock { display: none }` under the
 * same query), which hid the panel while a second xterm and a second pty went
 * on running behind it. tmux sizes a window to its SMALLEST attached client,
 * so that hidden attach could shrink the window the person is looking at. The
 * CSS rule is gone; sidebar.css says so at `.tl-dock`.
 */
export const Dock: Component<{
  dock: DockStore;
}> = (props) => {
  const d = props.dock;
  const [dragging, setDragging] = createSignal(false);

  // Drag the gutter: the ratio is the DOCK's share of the content column, so a
  // drag upward grows it. The box it is measured against is the wrapper's
  // PARENT, `.tl-shell-body`, which is also what the panel's percentage height
  // resolves against. The window is the wrong ruler: it counts the shell bar
  // above the content column, and on a narrow screen the sidebar beside it.
  let wrapEl: HTMLDivElement | undefined;
  // Ending the drag has to be reachable from the component's own cleanup, and
  // that registration has to happen HERE. `onCleanup` called from inside the
  // pointerdown handler runs with no reactive owner, so Solid drops it (with
  // "cleanups created outside a `createRoot` or `render` will never be run" on
  // stderr) and a panel that goes away mid-drag left both window listeners
  // behind. Ctrl+J hiding the dock under a held pointer is exactly that case.
  let endDrag: (() => void) | null = null;
  onCleanup(() => endDrag?.());

  const onGutterDown = (e: PointerEvent): void => {
    e.preventDefault();
    // Whatever the last drag left behind goes first. A pointerdown can land
    // while an earlier drag is still live, which is what a second finger on the
    // gutter does, and `endDrag` holds ONE reference. Starting a drag without
    // ending the previous one is how the first one became unreachable.
    endDrag?.();
    setDragging(true);

    // One signal for every listener this drag adds, so ending the drag is a
    // single call that cannot miss one.
    //
    // What it replaces was a remover wired to `pointerup` alone. A cancelled
    // touch or pen drag (a scroll takeover, palm rejection, the page losing the
    // pointer) fires `pointercancel` and never `pointerup`, so both window
    // listeners stayed for the life of the page, each `pointermove` paying a
    // getBoundingClientRect (a forced layout) and a signal write for a drag
    // nobody is doing any more. `pointercancel` is the event that was missing,
    // but listening for one more ending only fixes the endings we thought of.
    // An AbortController makes the next one impossible to leak, including a
    // listener added here later.
    //
    // Pointer capture was the other candidate and is not used: it guarantees
    // the terminating event reaches the GUTTER, which is a different problem
    // (these listeners are on `window` on purpose, so a pointer dragged over
    // the terminal or out of the window still resizes), and capturing removes
    // nothing by itself, so the remover would still have to be right.
    //
    // The build targets safari15 (vite.config.ts) and the `signal` option
    // shipped in Safari 15.0, Chrome 90 and Firefox 86 (MDN compat data), so
    // this is on the baseline and needs nothing from baseline-polyfills.ts.
    const drag = new AbortController();
    const { signal } = drag;

    const move = (ev: PointerEvent): void => {
      const box = wrapEl?.parentElement?.getBoundingClientRect();
      if (!box || box.height <= 0) return;
      d.setRatio(((box.bottom - ev.clientY) / box.height) * 100);
    };
    const end = (): void => {
      endDrag = null;
      // `.tl-dock-dragging .tl-dock-body` is `pointer-events: none`
      // (sidebar.css), so a drag state left set by an ending we did not handle
      // leaves the docked terminal unclickable until the panel is rebuilt.
      setDragging(false);
      drag.abort();
    };

    endDrag = end;
    window.addEventListener("pointermove", move, { signal });
    window.addEventListener("pointerup", end, { signal });
    window.addEventListener("pointercancel", end, { signal });
  };

  return (
    <Show when={d.mounted()}>
      <div
        ref={wrapEl}
        class="tl-dock"
        classList={{ "tl-dock-dragging": dragging() }}
        style={{ height: `${d.ratio()}%` }}
      >
        <div
          class="tl-dock-gutter"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the shell panel"
          onPointerDown={onGutterDown}
        />
        <div class="tl-dock-head">
          <span class="tl-dock-title">{d.session()}</span>
          <span class="tl-dock-spacer" />
          <button
            class="tl-icon-btn"
            type="button"
            aria-label="Un-dock the shell"
            title="Un-dock — the shell keeps running as a session"
            onClick={() => void d.undock()}
          >
            ✕
          </button>
        </div>
        <div class="tl-dock-body">
          <TerminalNative
            // arg2 is a CREATE-only concern, so the shell command goes out only
            // while this dock is the thing bringing its tmux session into being
            // — a re-attach must not carry it, or `new-session -A` would
            // resurrect an exited shell as whatever this passed.
            args={terminalFrameArgs(d.session()!, {
              cmd: d.creating() ? "shell" : undefined,
            })}
            // The dock is rendered only while it is showing, so a mounted one
            // is on screen by construction.
            active
            // The primary session view owns the window bridges; a second
            // terminal installing them would point the soft keys, paste and the
            // focus handback at this shell instead of the session above it.
            // TerminalNative also reads this as its fit guard's `shown`
            // signal, which the dock does not need: it mounts with a box
            // already, so the host's ResizeObserver delivers the first fit.
            ownsBridges={false}
            // No connection badge and no attention route: the dock has no bar
            // of its own, and the lobby's tab badge speaks for the session
            // above it. A chord pressed in here needs no forwarding either —
            // this terminal is in the lobby's own document, so the keybinding
            // engine's capture-phase window listener sees the keydown.
          />
        </div>
      </div>
    </Show>
  );
};
