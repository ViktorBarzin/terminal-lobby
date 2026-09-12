import { onCleanup, type Component } from "solid-js";
import type { SidebarWidthStore } from "../store/sidebar-width";
import { SIDEBAR_W_MAX, SIDEBAR_W_MIN, SIDEBAR_W_STEP } from "../store/sidebar-width.logic";

/**
 * The seam between the session list and the session, draggable.
 *
 * It is a child of `.tl-shell` and not of the sidebar, because it has to
 * straddle the border: `.tl-shell-sidebar` is `overflow: hidden`, so anything
 * inside it stops at the border it is meant to sit on. It rides on
 * `--tl-sidebar-w`, the same custom property the grid column reads, so the
 * handle and the column cannot disagree about where the seam is.
 *
 * Drag mechanics are Dock.tsx's, for the reasons Dock.tsx sets out at length:
 * window listeners so a pointer dragged over the terminal still resizes, one
 * AbortController so no ending can leak them, `pointercancel` listened for
 * alongside `pointerup`, and the ender reachable from a cleanup registered HERE
 * rather than inside the handler, where Solid would have no owner to hang it
 * on.
 *
 * Not rendered for a coarse pointer — a 7px target is a mouse target, and the
 * phone gives the list the whole screen anyway. sidebar.css draws that line,
 * in the same query as the rest of the phone layout.
 */
export const SidebarGrip: Component<{ sidebar: SidebarWidthStore }> = (props) => {
  const s = props.sidebar;
  let el: HTMLDivElement | undefined;

  let endDrag: (() => void) | null = null;
  onCleanup(() => endDrag?.());

  const onPointerDown = (e: PointerEvent): void => {
    // Keeps the pointerdown off the list underneath: no card takes focus, no
    // text selection starts, and xterm never sees a mousedown to begin a
    // selection with.
    e.preventDefault();
    endDrag?.();
    s.setDragging(true);

    const drag = new AbortController();
    const { signal } = drag;

    const move = (ev: PointerEvent): void => {
      // Measured from the SHELL's left edge, not the window's: the shell is
      // inset by the safe-area padding on a notched screen, and by whatever
      // the page around it grows later.
      const box = el?.parentElement?.getBoundingClientRect();
      if (!box) return;
      s.setWidth(ev.clientX - box.left);
    };
    const end = (): void => {
      endDrag = null;
      s.setDragging(false);
      drag.abort();
    };

    endDrag = end;
    window.addEventListener("pointermove", move, { signal });
    window.addEventListener("pointerup", end, { signal });
    window.addEventListener("pointercancel", end, { signal });
  };

  /** The window-splitter keys: arrows nudge, Home and End go to the stops. */
  const onKeyDown = (e: KeyboardEvent): void => {
    const w = s.width();
    if (e.key === "ArrowLeft") s.setWidth(w - SIDEBAR_W_STEP);
    else if (e.key === "ArrowRight") s.setWidth(w + SIDEBAR_W_STEP);
    else if (e.key === "Home") s.setWidth(SIDEBAR_W_MIN);
    else if (e.key === "End") s.setWidth(SIDEBAR_W_MAX);
    else return;
    e.preventDefault();
  };

  return (
    <div
      ref={el}
      class="tl-sidebar-grip"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the session list"
      aria-valuenow={s.width()}
      aria-valuemin={SIDEBAR_W_MIN}
      aria-valuemax={SIDEBAR_W_MAX}
      tabindex="0"
      title="Drag to resize the session list. Double-click to reset."
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDblClick={() => s.reset()}
    />
  );
};
