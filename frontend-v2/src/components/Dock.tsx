import { createSignal, onCleanup, Show, type Component } from "solid-js";
import { TerminalView } from "./TerminalView";
import type { DockStore } from "../store/dock";

/**
 * The Ctrl/Cmd+J scratch shell, in a persistent panel under the session you are
 * working in (docs/2026-07-17-ctrl-j-shell-dock-design.md).
 *
 * It is a SECOND live terminal, not a view of the first: the top frame keeps
 * its session attached while you use the shell. Hiding the panel leaves the
 * shell running — that is why Ctrl+J cycles create → hide → show rather than
 * tearing the terminal down each time.
 *
 * Desktop only. A phone has room for one terminal, and the vanilla page draws
 * the same line (coarse pointers ignore the dock entirely).
 */
export const Dock: Component<{ dock: DockStore }> = (props) => {
  const d = props.dock;
  const [dragging, setDragging] = createSignal(false);

  // Drag the gutter: the ratio is the DOCK's share of the content column, so a
  // drag upward grows it. Measured against the wrapper rather than the window,
  // which is what the sidebar's width would otherwise skew.
  let wrapEl: HTMLDivElement | undefined;
  const onGutterDown = (e: PointerEvent): void => {
    e.preventDefault();
    setDragging(true);
    const move = (ev: PointerEvent): void => {
      const box = wrapEl?.parentElement?.getBoundingClientRect();
      if (!box || box.height <= 0) return;
      d.setRatio(((box.bottom - ev.clientY) / box.height) * 100);
    };
    const up = (): void => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    onCleanup(up);
  };

  return (
    <Show when={d.session() && d.visible()}>
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
          <TerminalView
            session={d.session()!}
            active
            creating={d.creating()}
            newCommand={() => "shell"}
          />
        </div>
      </div>
    </Show>
  );
};
