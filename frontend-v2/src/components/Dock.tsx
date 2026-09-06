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
    setDragging(true);
    const move = (ev: PointerEvent): void => {
      const box = wrapEl?.parentElement?.getBoundingClientRect();
      if (!box || box.height <= 0) return;
      d.setRatio(((box.bottom - ev.clientY) / box.height) * 100);
    };
    const up = (): void => {
      endDrag = null;
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    endDrag = up;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <Show when={d.allowed() && d.session() && d.visible()}>
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
